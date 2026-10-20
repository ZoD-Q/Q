//! Isolated PostgreSQL acceptance; never point TEST_DATABASE_URL at a business DB.
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::time::Duration;
use tower::ServiceExt;
use uuid::Uuid;
use xiaoq_backend::{AppState, account_lifecycle, app};

const PASSWORD: &str = "LifecycleAcceptance123!";

struct Account {
    id: Uuid,
    handle: String,
    token: String,
}

struct Harness {
    router: Router,
    pool: PgPool,
    admin: PgPool,
    schema: String,
}

impl Harness {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL")
            .expect("TEST_DATABASE_URL must designate an isolated PostgreSQL test database");
        let admin = PgPool::connect(&url).await.unwrap();
        let schema = format!("q_lifecycle_test_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let search_path = format!("SET search_path TO {schema}");
        let application_name = schema.clone();
        let pool = PgPoolOptions::new()
            .max_connections(12)
            .after_connect(move |connection, _| {
                let search_path = search_path.clone();
                let application_name = application_name.clone();
                Box::pin(async move {
                    sqlx::query(&search_path).execute(&mut *connection).await?;
                    sqlx::query("SELECT set_config('application_name',$1,false)")
                        .bind(application_name)
                        .execute(&mut *connection)
                        .await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        sqlx::migrate!().run(&pool).await.unwrap();
        let router = app(AppState::new(pool.clone()).await.unwrap(), vec![]);
        Self {
            router,
            pool,
            admin,
            schema,
        }
    }

    async fn finish(self) {
        self.pool.close().await;
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(path);
        if let Some(token) = token {
            builder = builder.header("Authorization", format!("Bearer {token}"));
        }
        if body.is_some() {
            builder = builder.header("Content-Type", "application/json");
        }
        let request = builder
            .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
            .unwrap();
        let response = tokio::time::timeout(
            Duration::from_secs(15),
            self.router.clone().oneshot(request),
        )
        .await
        .expect("request exceeded bounded lifecycle lock timeout")
        .unwrap();
        let status = response.status();
        if path.starts_with("/v1/account/deletions") {
            assert_eq!(
                response
                    .headers()
                    .get("cache-control")
                    .and_then(|value| value.to_str().ok()),
                Some("no-store"),
                "deletion and capability responses, including errors, must not be cached"
            );
        }
        let bytes = to_bytes(response.into_body(), 2_000_000).await.unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, value)
    }

    async fn register(&self, name: &str) -> Account {
        let (status, body) = self
            .request(
                "POST",
                "/v1/auth/register",
                None,
                Some(json!({"handle":name,"display_name":name,"password":PASSWORD})),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        Account {
            id: Uuid::parse_str(body["user"]["id"].as_str().unwrap()).unwrap(),
            handle: name.into(),
            token: body["token"].as_str().unwrap().into(),
        }
    }

    async fn ok(&self, method: &str, path: &str, user: &Account, body: Value) -> Value {
        let (status, response) = self
            .request(method, path, Some(&user.token), Some(body))
            .await;
        assert!(status.is_success(), "{method} {path}: {status} {response}");
        response
    }

    async fn friends(&self, from: &Account, to: &Account) -> Uuid {
        let request = self
            .ok(
                "POST",
                "/v1/social/requests",
                from,
                json!({"user_id":to.id,"note":"Hello"}),
            )
            .await;
        self.ok(
            "POST",
            &format!(
                "/v1/social/requests/{}/respond",
                request["id"].as_str().unwrap()
            ),
            to,
            json!({"accept":true}),
        )
        .await;
        sqlx::query_scalar(
            "SELECT id FROM social_conversations WHERE user_low=least($1,$2) AND user_high=greatest($1,$2) AND active",
        ).bind(from.id).bind(to.id).fetch_one(&self.pool).await.unwrap()
    }

    async fn wait_for_locked_statement(&self, statement: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let blocked: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND query=$2 AND wait_event_type='Lock')",
                ).bind(&self.schema).bind(statement).fetch_one(&self.admin).await.unwrap();
                if blocked {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("expected transaction lock barrier was never reached");
    }

    fn cli(&self, args: &[&str]) -> std::process::Output {
        let url = std::env::var("TEST_DATABASE_URL").unwrap();
        let delimiter = if url.contains('?') { '&' } else { '?' };
        let isolated_url = format!("{url}{delimiter}options=-csearch_path%3D{}", self.schema);
        std::process::Command::new(env!("CARGO_BIN_EXE_account-admin"))
            .args(args)
            .env("DATABASE_URL", isolated_url)
            .env_remove("Q_ACCOUNT_ADMIN_MUTATIONS")
            .output()
            .unwrap()
    }
}

fn deletion() -> Value {
    json!({
        "request_id":Uuid::new_v4(),
        "recovery_token":URL_SAFE_NO_PAD.encode(rand::random::<[u8;32]>()),
        "password":PASSWORD,
        "confirmation":"DELETE",
    })
}

fn recovery(request: &Value) -> Value {
    json!({"request_id":request["request_id"],"recovery_token":request["recovery_token"]})
}

async fn private_provider_fixture(pool: &PgPool, user: Uuid) -> (Uuid, Uuid) {
    let connection = Uuid::new_v4();
    let service = Uuid::new_v4();
    let invocation = Uuid::new_v4();
    let video = Uuid::new_v4();
    let job = Uuid::new_v4();
    sqlx::query("INSERT INTO video_connections(id,user_id,name,region,encrypted_credentials) VALUES($1,$2,'Private provider','cn',$3)")
        .bind(video).bind(user).bind(vec![19_u8;40]).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO video_jobs(id,user_id,connection_id,idempotency_key,prompt,model_name,mode,duration,aspect_ratio,status) VALUES($1,$2,$3,$4,'Private video prompt','kling-v2-6','pro','5','16:9','unknown')")
        .bind(job).bind(user).bind(video).bind(Uuid::new_v4()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO plugin_services(id,card_url,card_url_hash,anonymous_card) VALUES($1,'https://example.com/card',$2,'{}')")
        .bind(service).bind(Sha256::digest(service.as_bytes()).to_vec()).execute(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO plugin_connections(id,user_id,service_id,candidate) VALUES($1,$2,$3,'{}')",
    )
    .bind(connection)
    .bind(user)
    .bind(service)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO plugin_invocations(id,user_id,connection_id,connection_revision,idempotency_key,request_fingerprint,tool_name,arguments,tool_snapshot,connection_snapshot,schema_fingerprint,status,expires_at) VALUES($1,$2,$3,1,$4,$5,'private_tool','{\"secret\":\"private argument\"}','{}','{}','schema','unknown',clock_timestamp()+interval '1 hour')")
        .bind(invocation).bind(user).bind(connection).bind(Uuid::new_v4()).bind(vec![1_u8;32]).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO plugin_oauth_tokens(connection_id,user_id,connection_revision,issuer,resource,token_endpoint,client_id,encrypted_tokens,scopes,expires_at) VALUES($1,$2,1,'https://example.com','https://example.com/mcp','https://example.com/token','https://q.example/client',$3,'{}',clock_timestamp()+interval '1 hour')")
        .bind(connection).bind(user).bind(vec![23_u8;40]).execute(pool).await.unwrap();
    (connection, invocation)
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn deletion_erases_owned_payloads_recovers_without_session_and_preserves_counterparty_and_ledger()
 {
    let h = Harness::new().await;
    let a = h.register("lifecycle_sender").await;
    let b = h.register("lifecycle_deleted").await;
    let conversation = h.friends(&a, &b).await;
    let path = format!("/v1/social/conversations/{conversation}/messages");
    h.ok(
        "POST",
        &path,
        &a,
        json!({"client_message_id":Uuid::new_v4(),"body":"Counterparty owned history","ttl_seconds":null}),
    ).await;
    h.ok(
        "POST",
        &path,
        &b,
        json!({"client_message_id":Uuid::new_v4(),"body":"Delete this personal history","ttl_seconds":null}),
    ).await;
    h.ok(
        "POST",
        &path,
        &b,
        json!({"client_message_id":Uuid::new_v4(),"body":"Delete this ephemeral body","ttl_seconds":30}),
    ).await;
    private_provider_fixture(&h.pool, b.id).await;
    private_provider_fixture(&h.pool, a.id).await;
    let transfer = json!({"recipient_handle":b.handle,"amount_minor":100,"memo":"Immutable memo disclosed as retained","idempotency_key":Uuid::new_v4()});
    let posted = h
        .ok("POST", "/v1/wallet/transfers", &a, transfer.clone())
        .await;
    let ledger_before: Value =
        sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM ledger_transactions t")
            .fetch_one(&h.pool)
            .await
            .unwrap();
    let entries_before: Value =
        sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM ledger_entries t")
            .fetch_one(&h.pool)
            .await
            .unwrap();

    let request = deletion();
    let receipt = h
        .ok("POST", "/v1/account/deletions", &b, request.clone())
        .await;
    assert_eq!(receipt["status"], "deleted");
    assert_eq!(receipt["request_id"], request["request_id"]);
    assert_eq!(receipt.as_object().unwrap().len(), 3);
    let (status, recovered) = h
        .request(
            "POST",
            "/v1/account/deletions/status",
            None,
            Some(recovery(&request)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{recovered}");
    assert_eq!(receipt, recovered);
    assert_eq!(
        h.request("GET", "/v1/me", Some(&b.token), None).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        h.request(
            "POST",
            "/v1/auth/login",
            None,
            Some(json!({"handle":b.handle,"password":PASSWORD}))
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let retired = h
        .request(
            "POST",
            "/v1/auth/register",
            None,
            Some(json!({"handle":b.handle,"password":PASSWORD,"display_name":"Do not reuse"})),
        )
        .await;
    assert_eq!(retired.0, StatusCode::CONFLICT, "{}", retired.1);
    for table in [
        "sessions",
        "video_connections",
        "video_jobs",
        "plugin_connections",
        "plugin_invocations",
        "plugin_oauth_tokens",
    ] {
        let count: i64 =
            sqlx::query_scalar(&format!("SELECT count(*) FROM {table} WHERE user_id=$1"))
                .bind(b.id)
                .fetch_one(&h.pool)
                .await
                .unwrap();
        assert_eq!(count, 0, "{table}");
    }
    let peer_data: i64 =
        sqlx::query_scalar("SELECT count(*) FROM plugin_invocations WHERE user_id=$1")
            .bind(a.id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(peer_data, 1);
    let messages: Vec<(Uuid, Option<String>)> = sqlx::query_as(
        "SELECT sender_id,body FROM social_messages WHERE conversation_id=$1 ORDER BY seq",
    )
    .bind(conversation)
    .fetch_all(&h.pool)
    .await
    .unwrap();
    assert_eq!(messages[0].1.as_deref(), Some("Counterparty owned history"));
    assert_eq!(
        messages[1].1.as_deref(),
        Some("[Message removed after account deletion]")
    );
    assert!(messages[2].1.is_none());
    let payloads: i64 = sqlx::query_scalar("SELECT count(*) FROM social_ephemeral_payloads")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(payloads, 0);
    let tombstones: i64 =
        sqlx::query_scalar("SELECT count(*) FROM account_erased_operations WHERE user_id=$1")
            .bind(b.id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(tombstones, 2);
    let history = h.request("GET", &path, Some(&a.token), None).await;
    assert_eq!(history.0, StatusCode::OK);

    let replay = h
        .ok("POST", "/v1/wallet/transfers", &a, transfer.clone())
        .await;
    assert_eq!(replay["transfer_id"], posted["transfer_id"]);
    assert_eq!(replay["replayed"], true);
    let anonymous: String = sqlx::query_scalar("SELECT handle FROM identities WHERE id=$1")
        .bind(b.id)
        .fetch_one(&h.pool)
        .await
        .unwrap();
    let mut altered = transfer.clone();
    altered["recipient_handle"] = json!(anonymous);
    let result = h
        .request(
            "POST",
            "/v1/wallet/transfers",
            Some(&a.token),
            Some(altered),
        )
        .await;
    assert_eq!(result.0, StatusCode::CONFLICT);
    assert_eq!(result.1["error"]["code"], "IDEMPOTENCY_CONFLICT");
    let mut fresh = transfer;
    fresh["idempotency_key"] = json!(Uuid::new_v4());
    let result = h
        .request("POST", "/v1/wallet/transfers", Some(&a.token), Some(fresh))
        .await;
    assert_eq!(result.0, StatusCode::NOT_FOUND);
    let ledger_after: Value =
        sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM ledger_transactions t")
            .fetch_one(&h.pool)
            .await
            .unwrap();
    let entries_after: Value =
        sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM ledger_entries t")
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(ledger_after, ledger_before);
    assert_eq!(entries_after, entries_before);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn deletion_requires_password_explicit_confirmation_and_secret_receipt_is_ownerless_but_private()
 {
    let h = Harness::new().await;
    let a = h.register("lifecycle_confirm").await;
    let b = h.register("lifecycle_other").await;
    let request = deletion();
    let mut wrong = request.clone();
    wrong["confirmation"] = json!("yes");
    assert_eq!(
        h.request("POST", "/v1/account/deletions", Some(&a.token), Some(wrong))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let mut wrong = request.clone();
    wrong["password"] = json!("incorrect password");
    assert_eq!(
        h.request("POST", "/v1/account/deletions", Some(&a.token), Some(wrong))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        h.request("POST", "/v1/account/deletions", None, Some(request.clone()))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let before = h
        .request(
            "POST",
            "/v1/account/deletions/status",
            None,
            Some(recovery(&request)),
        )
        .await;
    assert_eq!(before.0, StatusCode::NOT_FOUND);
    h.ok("POST", "/v1/account/deletions", &a, request.clone())
        .await;
    let mut wrong_secret = recovery(&request);
    wrong_secret["recovery_token"] = json!(URL_SAFE_NO_PAD.encode([33_u8; 32]));
    let wrong_result = h
        .request(
            "POST",
            "/v1/account/deletions/status",
            Some(&b.token),
            Some(wrong_secret),
        )
        .await;
    assert_eq!(wrong_result, before);
    let mut unknown_id = recovery(&request);
    unknown_id["request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        h.request(
            "POST",
            "/v1/account/deletions/status",
            None,
            Some(unknown_id)
        )
        .await,
        before
    );
    let mut reused = request;
    reused["password"] = json!(PASSWORD);
    let conflict = h
        .request(
            "POST",
            "/v1/account/deletions",
            Some(&b.token),
            Some(reused),
        )
        .await;
    assert_eq!(conflict.0, StatusCode::CONFLICT);
    assert_eq!(conflict.1["error"]["code"], "IDEMPOTENCY_CONFLICT");
    assert_eq!(
        h.request("GET", "/v1/me", Some(&b.token), None).await.0,
        StatusCode::OK
    );
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn old_writes_cannot_recreate_credentials_and_suspended_operator_deletion_cannot_be_reinstated()
 {
    let h = Harness::new().await;
    let a = h.register("lifecycle_suspended").await;
    let (connection, _) = private_provider_fixture(&h.pool, a.id).await;
    account_lifecycle::operator_status(&h.pool, a.id, true)
        .await
        .unwrap();
    assert_eq!(
        h.request("GET", "/v1/me", Some(&a.token), None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let session = sqlx::query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    )
    .bind(vec![3_u8; 32])
    .bind(a.id)
    .execute(&h.pool)
    .await;
    assert!(
        session.is_err(),
        "late login must not create a suspended user's session"
    );
    let refreshed =
        sqlx::query("UPDATE plugin_oauth_tokens SET encrypted_tokens=$2 WHERE connection_id=$1")
            .bind(connection)
            .bind(vec![5_u8; 40])
            .execute(&h.pool)
            .await;
    assert!(
        refreshed.is_err(),
        "late OAuth refresh must not rewrite a suspended user's credentials"
    );
    account_lifecycle::operator_delete(&h.pool, a.id)
        .await
        .unwrap();
    assert!(
        account_lifecycle::operator_status(&h.pool, a.id, false)
            .await
            .is_err()
    );
    let session = sqlx::query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    )
    .bind(vec![4_u8; 32])
    .bind(a.id)
    .execute(&h.pool)
    .await;
    assert!(session.is_err());
    let discovery = sqlx::query("INSERT INTO plugin_discoveries(id,user_id,entry_kind,entry_url,candidates,expires_at) VALUES($1,$2,'card','https://example.com/card','[]',now()+interval '1 day')")
        .bind(Uuid::new_v4()).bind(a.id).execute(&h.pool).await;
    assert!(
        discovery.is_err(),
        "late discovery must not restore a private URL"
    );
    let status: String = sqlx::query_scalar("SELECT status FROM identities WHERE id=$1")
        .bind(a.id)
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(status, "deleted");
    let records: i64 =
        sqlx::query_scalar("SELECT count(*) FROM account_operator_audit WHERE user_id=$1")
            .bind(a.id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(records, 2);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn both_participants_can_delete_concurrently_without_erasure_leaking_back_into_records() {
    let h = Harness::new().await;
    let a = h.register("lifecycle_parallel_a").await;
    let b = h.register("lifecycle_parallel_b").await;
    let conversation = h.friends(&a, &b).await;
    let request_a = deletion();
    let request_b = deletion();
    let (first, second) = tokio::join!(
        h.request(
            "POST",
            "/v1/account/deletions",
            Some(&a.token),
            Some(request_a.clone())
        ),
        h.request(
            "POST",
            "/v1/account/deletions",
            Some(&b.token),
            Some(request_b.clone())
        ),
    );
    assert_eq!(first.0, StatusCode::OK, "{}", first.1);
    assert_eq!(second.0, StatusCode::OK, "{}", second.1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM account_deletion_receipts")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
    let active: bool = sqlx::query_scalar("SELECT active FROM social_conversations WHERE id=$1")
        .bind(conversation)
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert!(!active);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn reports_keep_original_expiry_and_filter_blocks_only_new_publications() {
    let h = Harness::new().await;
    let a = h.register("lifecycle_report_a").await;
    let b = h.register("lifecycle_report_b").await;
    let conversation = h.friends(&a, &b).await;
    let path = format!("/v1/social/conversations/{conversation}/messages");
    let denied = h.request("POST",&path,Some(&a.token),Some(json!({"client_message_id":Uuid::new_v4(),"body":"I will kill you","ttl_seconds":null}))).await;
    assert_eq!(denied.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(denied.1["error"]["code"], "CONTENT_BLOCKED");
    // A previously accepted message may predate this local phrase policy. Its
    // retry is recovery of the original ID, not another publication.
    let original_id = Uuid::new_v4();
    let original_client_id = Uuid::new_v4();
    sqlx::query("INSERT INTO social_messages(id,conversation_id,seq,sender_id,client_message_id,kind,body) VALUES($1,$2,1,$3,$4,'text','I will kill you')")
        .bind(original_id).bind(conversation).bind(a.id).bind(original_client_id).execute(&h.pool).await.unwrap();
    sqlx::query("UPDATE social_conversations SET last_seq=1 WHERE id=$1")
        .bind(conversation)
        .execute(&h.pool)
        .await
        .unwrap();
    let recovered = h.ok("POST",&path,&a,json!({"client_message_id":original_client_id,"body":"I will kill you","ttl_seconds":null})).await;
    assert_eq!(recovered["id"], json!(original_id));
    let message = h.ok("POST",&path,&b,json!({"client_message_id":Uuid::new_v4(),"body":"Reported evidence","ttl_seconds":null})).await;
    let report_request = json!({"client_report_id":Uuid::new_v4(),"user_id":b.id,"message_id":message["id"],"reason":"Private report reason","include_evidence":true});
    h.ok("POST", "/v1/social/reports", &a, report_request).await;
    let (report_id, original_expiry): (Uuid, chrono::DateTime<chrono::Utc>) =
        sqlx::query_as("SELECT id,expires_at FROM social_reports")
            .fetch_one(&h.pool)
            .await
            .unwrap();
    let default_view = h.cli(&["report", &report_id.to_string()]);
    assert!(
        default_view.status.success(),
        "{}",
        String::from_utf8_lossy(&default_view.stderr)
    );
    let metadata: Value = serde_json::from_slice(&default_view.stdout).unwrap();
    assert!(metadata["reason"].is_null());
    assert!(metadata["evidence"].is_null());
    let content_view = h.cli(&["report", &report_id.to_string(), "--include-content"]);
    assert!(content_view.status.success());
    let content: Value = serde_json::from_slice(&content_view.stdout).unwrap();
    assert_eq!(content["reason"], "Private report reason");
    assert_eq!(content["evidence"], "Reported evidence");
    assert!(
        !h.cli(&["suspend", &b.id.to_string(), "--confirm", &b.id.to_string()])
            .status
            .success(),
        "operator mutation must require its explicit environment gate"
    );
    account_lifecycle::operator_resolve_report(&h.pool, report_id, true)
        .await
        .unwrap();
    let expiry: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT expires_at FROM social_reports WHERE id=$1")
            .bind(report_id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(expiry, original_expiry);
    let audit: Value =
        sqlx::query_scalar("SELECT to_jsonb(a) FROM account_operator_audit a WHERE report_id=$1")
            .bind(report_id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert!(!audit.to_string().contains("Private report reason"));
    assert!(!audit.to_string().contains("Reported evidence"));
    h.ok("POST", "/v1/account/deletions", &b, deletion()).await;
    let retained: String =
        sqlx::query_scalar("SELECT body FROM social_report_evidence WHERE report_id=$1")
            .bind(report_id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(
        retained, "Reported evidence",
        "a counterparty's independent report retains its original expiry"
    );
    h.ok("POST", "/v1/account/deletions", &a, deletion()).await;
    let reports: i64 = sqlx::query_scalar("SELECT count(*) FROM social_reports")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(
        reports, 0,
        "deleting the reporter erases their report and cascading evidence"
    );
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn late_oauth_write_and_delete_lock_cycle_rolls_back_then_recovers_original_deletion() {
    let h = Harness::new().await;
    let a = h.register("lifecycle_lock_cycle").await;
    let (connection, _) = private_provider_fixture(&h.pool, a.id).await;
    let mut old_write = h.pool.begin().await.unwrap();
    sqlx::query("SELECT connection_id FROM plugin_oauth_tokens WHERE connection_id=$1 FOR UPDATE")
        .bind(connection)
        .execute(&mut *old_write)
        .await
        .unwrap();
    let request = deletion();
    let deletion_request = h.request(
        "POST",
        "/v1/account/deletions",
        Some(&a.token),
        Some(request.clone()),
    );
    let late_write = async {
        h.wait_for_locked_statement("DELETE FROM plugin_oauth_tokens WHERE user_id=$1")
            .await;
        // A late network completion already owns its business row; the trigger
        // now competes with deletion's identity lock. Either entire transaction
        // may be selected as the deadlock victim.
        let result = sqlx::query(
            "UPDATE plugin_oauth_tokens SET encrypted_tokens=$2 WHERE connection_id=$1",
        )
        .bind(connection)
        .bind(vec![43_u8; 40])
        .execute(&mut *old_write)
        .await;
        if result.is_ok() {
            old_write.commit().await.unwrap();
        } else {
            old_write.rollback().await.unwrap();
        }
    };
    let (result, ()) = tokio::join!(deletion_request, late_write);
    if result.0 == StatusCode::CONFLICT {
        assert_eq!(result.1["error"]["code"], "ACCOUNT_BUSY");
        let unknown = h
            .request(
                "POST",
                "/v1/account/deletions/status",
                None,
                Some(recovery(&request)),
            )
            .await;
        assert_eq!(unknown.0, StatusCode::NOT_FOUND);
        h.ok("POST", "/v1/account/deletions", &a, request.clone())
            .await;
    } else {
        assert_eq!(result.0, StatusCode::OK, "{}", result.1);
    }
    let complete = h
        .request(
            "POST",
            "/v1/account/deletions/status",
            None,
            Some(recovery(&request)),
        )
        .await;
    assert_eq!(complete.0, StatusCode::OK);
    let (receipts,tokens):(i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM account_deletion_receipts WHERE user_id=$1),(SELECT count(*) FROM plugin_oauth_tokens WHERE user_id=$1)")
        .bind(a.id).fetch_one(&h.pool).await.unwrap();
    assert_eq!((receipts, tokens), (1, 0));
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn expired_reports_cannot_be_read_or_resolved_and_profile_writes_cannot_undo_deletion() {
    let h = Harness::new().await;
    let a = h.register("lifecycle_profile").await;
    let b = h.register("lifecycle_expired_report").await;
    h.ok(
        "POST",
        "/v1/social/reports",
        &a,
        json!({
            "client_report_id":Uuid::new_v4(),"user_id":b.id,"message_id":null,
            "reason":"Private expired report","include_evidence":false
        }),
    )
    .await;
    let report_id: Uuid = sqlx::query_scalar("SELECT id FROM social_reports")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE social_reports SET created_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1")
        .bind(report_id).execute(&h.pool).await.unwrap();
    assert!(
        !h.cli(&["report", &report_id.to_string(), "--include-content"])
            .status
            .success()
    );
    assert!(
        account_lifecycle::operator_resolve_report(&h.pool, report_id, true)
            .await
            .is_err()
    );
    let mut old_profile = h.pool.begin().await.unwrap();
    sqlx::query("SELECT user_id FROM profiles WHERE user_id=$1 FOR UPDATE")
        .bind(a.id)
        .execute(&mut *old_profile)
        .await
        .unwrap();
    let request = deletion();
    let deletion_request = h.request(
        "POST",
        "/v1/account/deletions",
        Some(&a.token),
        Some(request.clone()),
    );
    let release_old_profile = async {
        h.wait_for_locked_statement("UPDATE profiles SET display_name='Deleted account',avatar='orbit',bio='',theme='warm',locale='zh-CN' WHERE user_id=$1").await;
        sqlx::query("UPDATE profiles SET bio='late private profile body' WHERE user_id=$1")
            .bind(a.id)
            .execute(&mut *old_profile)
            .await
            .unwrap();
        old_profile.commit().await.unwrap();
    };
    let (result, ()) = tokio::join!(deletion_request, release_old_profile);
    assert_eq!(result.0, StatusCode::OK, "{}", result.1);
    let stale = h
        .request(
            "PATCH",
            "/v1/me",
            Some(&a.token),
            Some(json!({"bio":"must not return"})),
        )
        .await;
    assert_eq!(stale.0, StatusCode::UNAUTHORIZED);
    let bio: String = sqlx::query_scalar("SELECT bio FROM profiles WHERE user_id=$1")
        .bind(a.id)
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(bio, "");
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn one_deletion_request_id_cannot_erase_two_accounts_and_retired_handles_cannot_race_registration()
 {
    let h = Harness::new().await;
    let a = h.register("lifecycle_id_collision_a").await;
    let b = h.register("lifecycle_id_collision_b").await;
    let request = deletion();
    let (first, second) = tokio::join!(
        h.request(
            "POST",
            "/v1/account/deletions",
            Some(&a.token),
            Some(request.clone())
        ),
        h.request(
            "POST",
            "/v1/account/deletions",
            Some(&b.token),
            Some(request.clone())
        ),
    );
    let statuses = [first.0, second.0];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::CONFLICT)
            .count(),
        1,
        "{first:?} {second:?}"
    );
    let active: i64 = sqlx::query_scalar("SELECT count(*) FROM identities WHERE status='active'")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(active, 1);
    let surviving = if first.0 == StatusCode::OK { &b } else { &a };
    let last_request = deletion();
    let (deleted, registered) = tokio::join!(
        h.request("POST","/v1/account/deletions",Some(&surviving.token),Some(last_request)),
        h.request("POST","/v1/auth/register",None,Some(json!({"handle":surviving.handle,"password":PASSWORD,"display_name":"No handle reassignment"}))),
    );
    assert_eq!(deleted.0, StatusCode::OK, "{}", deleted.1);
    assert_eq!(registered.0, StatusCode::CONFLICT, "{}", registered.1);
    let active: i64 = sqlx::query_scalar("SELECT count(*) FROM identities WHERE status='active'")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(active, 0);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn operator_queue_skips_resolved_reports_and_paginates_all_unresolved_reports() {
    let h = Harness::new().await;
    let a = h.register("lifecycle_queue_a").await;
    let b = h.register("lifecycle_queue_b").await;
    let mut ids = Vec::new();
    for index in 0..205_i32 {
        let report_id = Uuid::new_v4();
        sqlx::query("INSERT INTO social_reports(id,reporter_id,reported_id,reason,include_evidence,created_at,expires_at) VALUES($1,$2,$3,'Private queue fixture',false,clock_timestamp()-interval '20 minutes'+($4 * interval '1 second'),clock_timestamp()+interval '29 days')")
            .bind(report_id).bind(a.id).bind(b.id).bind(index).execute(&h.pool).await.unwrap();
        if index < 100 {
            account_lifecycle::operator_resolve_report(&h.pool, report_id, false)
                .await
                .unwrap();
        }
        ids.push(report_id);
    }
    let first = h.cli(&["reports"]);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let first: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(first["has_more"], true);
    let items = first["items"].as_array().unwrap();
    assert_eq!(items.len(), 100);
    assert_eq!(items[0]["id"], json!(ids[100]));
    assert_eq!(items[99]["id"], json!(ids[199]));
    assert!(
        items
            .iter()
            .all(|item| item["reason"].is_null() && item["evidence"].is_null())
    );
    let cursor = first["next_cursor"].as_str().unwrap();
    let second = h.cli(&["reports", "--after", cursor]);
    assert!(second.status.success());
    let second: Value = serde_json::from_slice(&second.stdout).unwrap();
    assert_eq!(second["has_more"], false);
    assert!(second["next_cursor"].is_null());
    let items = second["items"].as_array().unwrap();
    assert_eq!(items.len(), 5);
    assert_eq!(items[0]["id"], json!(ids[200]));
    assert_eq!(items[4]["id"], json!(ids[204]));
    let old = h.cli(&["report", &ids[0].to_string()]);
    assert!(
        old.status.success(),
        "resolved report remains available by ID until expiry"
    );
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn report_resolution_rechecks_expiry_after_waiting_for_the_report_lock() {
    let h = Harness::new().await;
    let a = h.register("lifecycle_expiry_lock_a").await;
    let b = h.register("lifecycle_expiry_lock_b").await;
    h.ok(
        "POST",
        "/v1/social/reports",
        &a,
        json!({
            "client_report_id":Uuid::new_v4(),"user_id":b.id,"message_id":null,
            "reason":"Expiry lock fixture","include_evidence":false
        }),
    )
    .await;
    let report_id:Uuid = sqlx::query_scalar("UPDATE social_reports SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()+interval '1 second' RETURNING id")
        .fetch_one(&h.pool).await.unwrap();
    let mut hold = h.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM social_reports WHERE id=$1 FOR UPDATE")
        .bind(report_id)
        .execute(&mut *hold)
        .await
        .unwrap();
    let resolve = account_lifecycle::operator_resolve_report(&h.pool, report_id, true);
    let release_after_expiry = async {
        h.wait_for_locked_statement("SELECT expires_at FROM social_reports WHERE id=$1 FOR UPDATE")
            .await;
        loop {
            let expired: bool = sqlx::query_scalar(
                "SELECT expires_at<=clock_timestamp() FROM social_reports WHERE id=$1",
            )
            .bind(report_id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
            if expired {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        hold.commit().await.unwrap();
    };
    let (result, ()) = tokio::join!(resolve, release_after_expiry);
    assert_eq!(result.unwrap_err().code, "SOCIAL_REPORT_EXPIRED");
    let decisions: i64 =
        sqlx::query_scalar("SELECT count(*) FROM account_operator_audit WHERE report_id=$1")
            .bind(report_id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(decisions, 0);
    h.finish().await;
}
