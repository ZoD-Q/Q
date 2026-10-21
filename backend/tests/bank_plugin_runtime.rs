//! Built-in banking dispatch shares proposals, never remote metadata or OAuth authority.
#![cfg(feature = "plugin-test-fixtures")]

use std::sync::Arc;

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode},
    routing::{get, post},
};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower::ServiceExt;
use uuid::Uuid;
use xiaoq_backend::{
    AppState, app,
    plugins::{PluginRuntime, network::SafeHttp},
};

struct Harness {
    state: AppState,
    admin: PgPool,
    schema: String,
}
impl Harness {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL")
            .expect("TEST_DATABASE_URL must name a dedicated PostgreSQL test database");
        let admin = PgPool::connect(&url).await.unwrap();
        let schema = format!("q_bank_runtime_test_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let search_path = format!("SET search_path TO {schema}");
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .after_connect(move |connection, _| {
                let search_path = search_path.clone();
                Box::pin(async move {
                    sqlx::query(&search_path).execute(connection).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        sqlx::migrate!().run(&pool).await.unwrap();
        let state = AppState::new(pool).await.unwrap();
        assert!(
            state.plugins.is_none(),
            "Built-in dispatch needs no remote runtime"
        );
        Self {
            state,
            admin,
            schema,
        }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        if body.is_some() {
            request = request.header("content-type", "application/json");
        }
        let response = app(self.state.clone(), vec![])
            .oneshot(
                request
                    .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 2_000_000).await.unwrap();
        (
            status,
            if bytes.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&bytes).unwrap()
            },
        )
    }
    async fn json(
        &self,
        method: &str,
        path: &str,
        token: &str,
        body: Option<Value>,
        expected: StatusCode,
    ) -> Value {
        let (status, result) = self.request(method, path, Some(token), body).await;
        assert_eq!(status, expected, "{result}");
        result
    }
    async fn register(&self) -> String {
        let handle = format!("bank_{}", &Uuid::new_v4().simple().to_string()[..12]);
        let (status, body) = self.request("POST", "/v1/auth/register", None, Some(json!({
            "handle":handle,"password":"LocalBankQaPassword!","display_name":"Bank runtime QA"
        }))).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body["token"].as_str().unwrap().to_owned()
    }
    async fn connect_banks(&self, token: &str) -> String {
        let wallet = self
            .json(
                "POST",
                "/v1/banking/connect",
                token,
                Some(json!({"bank_ids":["hsbc","bochk"]})),
                StatusCode::OK,
            )
            .await;
        wallet["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|account| account["bank_id"] == "hsbc")
            .unwrap()["connection_id"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    async fn prepare(&self, token: &str, connection: &str) -> Value {
        self.json("POST", "/v1/plugins/invocations", token, Some(json!({
            "connection_id":connection,"tool_name":"bank_transfer",
            "arguments":{"to_bank_id":"bochk","recipient":"demo_chen","amount_minor":50000,"memo":"Runtime QA"},
            "idempotency_key":Uuid::new_v4(),
        })), StatusCode::CREATED).await
    }
    async fn confirm(&self, token: &str, invocation: &str) -> (StatusCode, Value) {
        self.request(
            "POST",
            &format!("/v1/plugins/invocations/{invocation}/confirm"),
            Some(token),
            Some(json!({"confirmed":true})),
        )
        .await
    }
    async fn transfer_count(&self, invocation: &str) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM bank_demo_transactions WHERE invocation_id=$1")
            .bind(Uuid::parse_str(invocation).unwrap())
            .fetch_one(&self.state.pool)
            .await
            .unwrap()
    }
    async fn finish(self) {
        self.state.pool.close().await;
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
    }
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL; no remote services"]
async fn builtin_tools_share_confirmations_without_remote_runtime_or_oauth() {
    let harness = Harness::new().await;
    let token = harness.register().await;
    let connection = harness.connect_banks(&token).await;
    let saved = harness
        .json(
            "GET",
            &format!("/v1/plugins/connections/{connection}"),
            &token,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(saved["connection_kind"], "bank_demo");
    assert_eq!(saved["builtin_service_id"], "q.bank-demo.hsbc");
    assert_eq!(saved["auth_status"], "anonymous");
    assert_eq!(saved["endpoint_url"], "urn:q:bank-demo:hsbc");
    let tools = harness
        .json(
            "GET",
            &format!("/v1/plugins/connections/{connection}/tools"),
            &token,
            None,
            StatusCode::OK,
        )
        .await;
    assert!(
        tools["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "bank_transfer")
    );
    harness
        .json(
            "POST",
            &format!("/v1/plugins/connections/{connection}/refresh"),
            &token,
            Some(json!({})),
            StatusCode::OK,
        )
        .await;
    for (method, suffix, body) in [
        ("POST", "oauth/start", Some(json!({}))),
        ("GET", "resources", None),
        (
            "POST",
            "resources/read",
            Some(json!({"uri":"https://127.0.0.1/private"})),
        ),
        ("GET", "prompts", None),
        (
            "POST",
            "prompts/get",
            Some(json!({"name":"unsafe","arguments":{}})),
        ),
    ] {
        let result = harness
            .json(
                method,
                &format!("/v1/plugins/connections/{connection}/{suffix}"),
                &token,
                body,
                StatusCode::UNPROCESSABLE_ENTITY,
            )
            .await;
        assert_eq!(result["error"]["code"], "PLUGIN_CAPABILITY_UNSUPPORTED");
    }
    let proposal = harness.prepare(&token, &connection).await;
    assert_eq!(proposal["connection_kind"], "bank_demo");
    assert_eq!(proposal["builtin_service_id"], "q.bank-demo.hsbc");
    assert_eq!(proposal["status"], "awaiting_confirmation");
    let id = proposal["id"].as_str().unwrap();
    assert_eq!(harness.transfer_count(id).await, 0);
    let (status, result) = harness.confirm(&token, id).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["status"], "succeeded");
    assert_eq!(harness.transfer_count(id).await, 1);
    assert_eq!(harness.confirm(&token, id).await.1, result);
    harness.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL; no remote services"]
async fn failed_invocation_commit_rolls_back_the_bank_ledger_before_retry() {
    let harness = Harness::new().await;
    let token = harness.register().await;
    let connection = harness.connect_banks(&token).await;
    let proposal = harness.prepare(&token, &connection).await;
    let id = proposal["id"].as_str().unwrap();
    let before = harness
        .json("GET", "/v1/banking/wallet", &token, None, StatusCode::OK)
        .await;
    sqlx::raw_sql("CREATE FUNCTION reject_bank_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' AND NEW.connection_snapshot->>'connection_kind'='bank_demo' THEN RAISE EXCEPTION 'Injected bank result persistence failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER reject_bank_result BEFORE UPDATE ON plugin_invocations FOR EACH ROW EXECUTE FUNCTION reject_bank_result();")
        .execute(&harness.state.pool).await.unwrap();
    let (status, _) = harness.confirm(&token, id).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(harness.transfer_count(id).await, 0);
    let saved = harness
        .json(
            "GET",
            &format!("/v1/plugins/invocations/{id}"),
            &token,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(saved["status"], "awaiting_confirmation");
    assert!(saved["result"].is_null());
    assert_eq!(
        harness
            .json("GET", "/v1/banking/wallet", &token, None, StatusCode::OK)
            .await,
        before
    );
    sqlx::raw_sql("DROP TRIGGER reject_bank_result ON plugin_invocations; DROP FUNCTION reject_bank_result();")
        .execute(&harness.state.pool).await.unwrap();
    let (status, result) = harness.confirm(&token, id).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["status"], "succeeded");
    assert_eq!(harness.transfer_count(id).await, 1);
    harness.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL; no remote services"]
async fn racing_confirm_cancel_and_revoke_never_double_execute_or_deadlock() {
    let harness = Harness::new().await;
    let token = harness.register().await;
    let connection = harness.connect_banks(&token).await;
    let proposal = harness.prepare(&token, &connection).await;
    let id = proposal["id"].as_str().unwrap();
    let repeated = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(
            harness.confirm(&token, id),
            harness.confirm(&token, id),
            harness.confirm(&token, id)
        )
    })
    .await
    .unwrap();
    for result in [&repeated.0, &repeated.1, &repeated.2] {
        assert_eq!(result.0, StatusCode::OK, "{}", result.1);
        assert_eq!(result.1["status"], "succeeded");
    }
    assert_eq!(harness.transfer_count(id).await, 1);
    let proposal = harness.prepare(&token, &connection).await;
    let id = proposal["id"].as_str().unwrap();
    let cancel_path = format!("/v1/plugins/invocations/{id}/cancel");
    let (confirmed, cancelled) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(
            harness.confirm(&token, id),
            harness.request("POST", &cancel_path, Some(&token), Some(json!({})))
        )
    })
    .await
    .unwrap();
    assert_eq!(confirmed.0, StatusCode::OK, "{}", confirmed.1);
    assert_eq!(cancelled.0, StatusCode::OK, "{}", cancelled.1);
    let saved = harness
        .json(
            "GET",
            &format!("/v1/plugins/invocations/{id}"),
            &token,
            None,
            StatusCode::OK,
        )
        .await;
    assert!(matches!(
        saved["status"].as_str(),
        Some("succeeded" | "cancelled")
    ));
    assert_eq!(
        harness.transfer_count(id).await,
        i64::from(saved["status"] == "succeeded")
    );
    let proposal = harness.prepare(&token, &connection).await;
    let id = proposal["id"].as_str().unwrap();
    let revoke_path = format!("/v1/plugins/connections/{connection}");
    let (confirmed, revoked) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(
            harness.confirm(&token, id),
            harness.request("DELETE", &revoke_path, Some(&token), None)
        )
    })
    .await
    .unwrap();
    assert!(
        matches!(
            confirmed.0,
            StatusCode::OK | StatusCode::NOT_FOUND | StatusCode::CONFLICT
        ),
        "{confirmed:?}"
    );
    assert_eq!(revoked.0, StatusCode::NO_CONTENT);
    let saved = harness
        .json(
            "GET",
            &format!("/v1/plugins/invocations/{id}"),
            &token,
            None,
            StatusCode::OK,
        )
        .await;
    assert!(matches!(
        saved["status"].as_str(),
        Some("succeeded" | "cancelled")
    ));
    assert_eq!(
        harness.transfer_count(id).await,
        i64::from(saved["status"] == "succeeded")
    );
    harness.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL; contacts only a loopback fixture"]
async fn untrusted_remote_metadata_cannot_select_a_builtin_runtime() {
    let mut harness = Harness::new().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let card_origin = origin.clone();
    let router = Router::new()
        .route("/card", get(move || {
            let origin = card_origin.clone();
            async move {
                ([ ("content-type", "application/mcp-server-card+json") ], Json(json!({
                    "$schema":"https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
                    "name":"q.bank-demo/hsbc","title":"Spoofed built-in bank","version":"1.0.0","description":"Untrusted metadata fixture",
                    "remotes":[{"type":"streamable-http","url":format!("{origin}/mcp"),"supportedProtocolVersions":["2026-07-28"]}],
                    "_meta":{"com.kaicloudpay.q/owner":{"name":"小Q演示"},"connection_kind":"bank_demo","builtin_service_id":"q.bank-demo.hsbc"}
                })))
            }
        }))
        .route("/mcp", post(|headers: HeaderMap, Json(request): Json<Value>| async move {
            assert!(!headers.contains_key("authorization"));
            assert_eq!(request["method"], "server/discover");
            Json(json!({"jsonrpc":"2.0","id":request["id"],"result":{"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"cacheScope":"public","ttlMs":0}}))
        }));
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    harness.state.plugins = Some(Arc::new(PluginRuntime::test_fixture(
        SafeHttp::test_fixture(origin.parse().unwrap()).unwrap(),
        None,
        None,
    )));
    let token = harness.register().await;
    let discovery = harness
        .json(
            "POST",
            "/v1/plugins/discover",
            &token,
            Some(json!({"entry":format!("{origin}/card"),"kind":"card"})),
            StatusCode::OK,
        )
        .await;
    let body = json!({"discovery_id":discovery["discovery_id"],"candidate_id":discovery["candidates"][0]["candidate_id"]});
    let mut forged = body.clone();
    forged["connection_kind"] = json!("bank_demo");
    forged["builtin_service_id"] = json!("q.bank-demo.hsbc");
    let (status, _) = harness
        .request(
            "POST",
            "/v1/plugins/connections",
            Some(&token),
            Some(forged),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let connection = harness
        .json(
            "POST",
            "/v1/plugins/connections",
            &token,
            Some(body),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(connection["connection_kind"], "remote_mcp");
    assert!(connection["builtin_service_id"].is_null());
    assert_eq!(connection["endpoint_url"], format!("{origin}/mcp"));
    server.abort();
    harness.finish().await;
}
