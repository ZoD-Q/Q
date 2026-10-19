//! Contract-level social API acceptance against a real, isolated PostgreSQL schema.
//! TEST_DATABASE_URL=postgresql://... cargo test --test social -- --ignored

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    collections::HashSet,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tower::ServiceExt;
use uuid::Uuid;
use xiaoq_backend::{AppState, app};

struct Account {
    token: String,
    id: Uuid,
    handle: String,
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
            .expect("Set TEST_DATABASE_URL to an isolated PostgreSQL test database");
        let admin = PgPool::connect(&url).await.unwrap();
        let schema = format!("q_social_test_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let search_path = format!("SET search_path TO {schema}");
        let pool = PgPoolOptions::new()
            .max_connections(12)
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
        let state = AppState::new(pool.clone()).await.unwrap();
        let router = app(state, vec!["http://localhost:8081".parse().unwrap()]);
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
            .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
            .unwrap();
        let response = tokio::time::timeout(
            Duration::from_secs(15),
            self.router.clone().oneshot(request),
        )
        .await
        .expect("social request timed out; possible lock deadlock")
        .unwrap();
        if path.starts_with("/v1/social/") {
            assert_eq!(
                response
                    .headers()
                    .get("cache-control")
                    .and_then(|v| v.to_str().ok()),
                Some("no-store"),
                "private social response must not be cached: {method} {path}"
            );
        }
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 2_000_000).await.unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, value)
    }

    async fn register(&self, handle: &str) -> Account {
        let (status, body) = self
            .request(
                "POST",
                "/v1/auth/register",
                None,
                Some(json!({
                    "handle": handle,
                    "password": "SocialAcceptance123!",
                    "display_name": handle
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        Account {
            token: body["token"].as_str().unwrap().to_owned(),
            id: Uuid::parse_str(body["user"]["id"].as_str().unwrap()).unwrap(),
            handle: body["user"]["handle"].as_str().unwrap().to_owned(),
        }
    }

    async fn ok(&self, method: &str, path: &str, account: &Account, body: Option<Value>) -> Value {
        let (status, value) = self.request(method, path, Some(&account.token), body).await;
        assert_eq!(status, StatusCode::OK, "{method} {path}: {value}");
        value
    }

    async fn snapshot(&self, account: &Account) -> Value {
        self.ok("GET", "/v1/social/snapshot", account, None).await
    }

    async fn request_friend(&self, from: &Account, to: &Account) -> Value {
        let (status, body) = self
            .request(
                "POST",
                "/v1/social/requests",
                Some(&from.token),
                Some(json!({"user_id":to.id,"note":"Social acceptance request"})),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(body["from_user"]["id"], from.id.to_string());
        assert_eq!(body["to_user"]["handle"], to.handle);
        body
    }

    async fn befriend(&self, from: &Account, to: &Account) -> Uuid {
        let request = self.request_friend(from, to).await;
        self.ok(
            "POST",
            &format!(
                "/v1/social/requests/{}/respond",
                request["id"].as_str().unwrap()
            ),
            to,
            Some(json!({"accept":true})),
        )
        .await;
        let snapshot = self.snapshot(from).await;
        uuid(&friend(&snapshot, to.id)["conversation_id"])
    }

    async fn send(
        &self,
        from: &Account,
        conversation: Uuid,
        body: &str,
        ttl: Option<i64>,
    ) -> Value {
        let (status, value) = self
            .request(
                "POST",
                &messages_path(conversation),
                Some(&from.token),
                Some(message_request(Uuid::new_v4(), body, ttl)),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{value}");
        value
    }

    async fn messages(
        &self,
        account: &Account,
        conversation: Uuid,
        after: i64,
        limit: i64,
    ) -> Value {
        self.ok(
            "GET",
            &format!(
                "{}?after_seq={after}&limit={limit}",
                messages_path(conversation)
            ),
            account,
            None,
        )
        .await
    }

    async fn open(&self, account: &Account, message: &Value) -> Value {
        self.ok("POST", &open_path(message), account, Some(json!({})))
            .await
    }
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn blocking_clears_pending_requests_and_serializes_against_sending() {
    let h = Harness::new().await;
    let alice = h.register("alice").await;
    let bob = h.register("bob").await;
    let outsider = h.register("outsider").await;
    let chat = h.befriend(&alice, &bob).await;
    h.request_friend(&outsider, &alice).await;
    h.ok(
        "POST",
        "/v1/social/blocks",
        &alice,
        Some(json!({"user_id":outsider.id})),
    )
    .await;
    assert!(
        h.snapshot(&outsider).await["requests"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        h.snapshot(&alice).await["requests"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_error(
        h.request(
            "POST",
            "/v1/social/requests",
            Some(&outsider.token),
            Some(json!({"user_id":alice.id,"note":"blocked retry"})),
        )
        .await,
        StatusCode::FORBIDDEN,
        "SOCIAL_BLOCKED",
    );

    let preserved = h
        .send(
            &alice,
            chat,
            "ordinary history survives removing friend",
            None,
        )
        .await;
    let ephemeral = h
        .send(&alice, chat, "no opening after block", Some(300))
        .await;
    let race_path = messages_path(chat);
    let (send, block) = tokio::join!(
        h.request(
            "POST",
            &race_path,
            Some(&alice.token),
            Some(message_request(Uuid::new_v4(), "racing block", None))
        ),
        h.request(
            "POST",
            "/v1/social/blocks",
            Some(&bob.token),
            Some(json!({"user_id":alice.id}))
        )
    );
    assert_eq!(block.0, StatusCode::OK, "{}", block.1);
    assert!(
        [StatusCode::CREATED, StatusCode::FORBIDDEN].contains(&send.0),
        "{}",
        send.1
    );
    for account in [&alice, &bob] {
        let denied = h
            .request(
                "POST",
                &messages_path(chat),
                Some(&account.token),
                Some(message_request(
                    Uuid::new_v4(),
                    "must not be committed",
                    None,
                )),
            )
            .await;
        assert_eq!(denied.0, StatusCode::FORBIDDEN, "{}", denied.1);
    }
    let denied_open = h
        .request(
            "POST",
            &open_path(&ephemeral),
            Some(&bob.token),
            Some(json!({})),
        )
        .await;
    assert_eq!(denied_open.0, StatusCode::FORBIDDEN, "{}", denied_open.1);
    assert_eq!(
        conversation(&h.snapshot(&alice).await, chat)["active"],
        false
    );
    let history = h.messages(&bob, chat, 0, 100).await;
    assert_eq!(history["items"][0]["id"], preserved["id"]);
    assert_eq!(
        history["items"].as_array().unwrap().len(),
        if send.0 == StatusCode::CREATED { 3 } else { 2 }
    );
    assert!(!history.to_string().contains("must not be committed"));
    h.ok(
        "POST",
        "/v1/social/blocks",
        &bob,
        Some(json!({"user_id":alice.id})),
    )
    .await;
    h.ok(
        "DELETE",
        &format!("/v1/social/blocks/{}", alice.id),
        &bob,
        None,
    )
    .await;
    assert!(
        h.snapshot(&bob).await["friends"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_error(
        h.request(
            "POST",
            &messages_path(chat),
            Some(&alice.token),
            Some(message_request(
                Uuid::new_v4(),
                "unblocking does not re-add",
                None,
            )),
        )
        .await,
        StatusCode::FORBIDDEN,
        "SOCIAL_FRIEND_REQUIRED",
    );
    let new_chat = h.befriend(&alice, &bob).await;
    assert_ne!(new_chat, chat);
    assert_eq!(
        friend(&h.snapshot(&alice).await, bob.id)["intimacy_score"],
        0
    );
    assert!(
        h.messages(&alice, new_chat, 0, 100).await["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let old_open = h
        .request(
            "POST",
            &open_path(&ephemeral),
            Some(&bob.token),
            Some(json!({})),
        )
        .await;
    assert_eq!(old_open.0, StatusCode::FORBIDDEN, "{}", old_open.1);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn ephemeral_open_is_explicit_receiver_only_atomic_and_never_leaks_into_lists() {
    let h = Harness::new().await;
    let alice = h.register("alice").await;
    let bob = h.register("bob").await;
    let outsider = h.register("outsider").await;
    let chat = h.befriend(&alice, &bob).await;
    let short = h
        .send(&alice, chat, "SECRET_EPHEMERAL_30_SECONDS", Some(30))
        .await;
    let medium = h
        .send(&alice, chat, "SECRET_EPHEMERAL_300_SECONDS", Some(300))
        .await;
    let long = h
        .send(&alice, chat, "SECRET_EPHEMERAL_86400_SECONDS", Some(86400))
        .await;
    for message in [&short, &medium, &long] {
        assert_eq!(message["body"], Value::Null);
        assert_eq!(message["kind"], "ephemeral");
        assert_eq!(message["opened_at"], Value::Null);
        let created =
            chrono::DateTime::parse_from_rfc3339(message["created_at"].as_str().unwrap()).unwrap();
        let expiry =
            chrono::DateTime::parse_from_rfc3339(message["unopened_expires_at"].as_str().unwrap())
                .unwrap();
        // The app deadline and PostgreSQL insertion timestamp can differ by milliseconds.
        assert!((604_799..=604_800).contains(&(expiry - created).num_seconds()));
    }
    let sender_open = h
        .request(
            "POST",
            &open_path(&short),
            Some(&alice.token),
            Some(json!({})),
        )
        .await;
    assert_eq!(sender_open.0, StatusCode::FORBIDDEN, "{}", sender_open.1);
    assert_error(
        h.request(
            "POST",
            &open_path(&short),
            Some(&outsider.token),
            Some(json!({})),
        )
        .await,
        StatusCode::NOT_FOUND,
        "SOCIAL_NOT_FOUND",
    );
    h.ok(
        "POST",
        &format!("/v1/social/conversations/{chat}/read"),
        &bob,
        Some(json!({"through_seq":3})),
    )
    .await;
    let unopened = h.messages(&bob, chat, 0, 100).await;
    assert!(
        unopened["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["opened_at"].is_null())
    );
    let opening_path = open_path(&short);
    let openings = futures_util::future::join_all(
        (0..6).map(|_| h.request("POST", &opening_path, Some(&bob.token), Some(json!({})))),
    )
    .await;
    let mut deadlines = HashSet::new();
    for (status, body) in openings {
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["body"], "SECRET_EPHEMERAL_30_SECONDS");
        deadlines.insert(body["expires_at"].as_str().unwrap().to_owned());
        let now =
            chrono::DateTime::parse_from_rfc3339(body["server_time"].as_str().unwrap()).unwrap();
        let expiry =
            chrono::DateTime::parse_from_rfc3339(body["expires_at"].as_str().unwrap()).unwrap();
        assert!((25..=30).contains(&(expiry - now).num_seconds()));
    }
    assert_eq!(
        deadlines.len(),
        1,
        "concurrent opens must share one deadline"
    );
    for (message, seconds) in [(&medium, 300), (&long, 86400)] {
        let opened = h.open(&bob, message).await;
        let expiry =
            chrono::DateTime::parse_from_rfc3339(opened["expires_at"].as_str().unwrap()).unwrap();
        let now =
            chrono::DateTime::parse_from_rfc3339(opened["server_time"].as_str().unwrap()).unwrap();
        assert!((seconds - 2..=seconds).contains(&(expiry - now).num_seconds()));
    }
    let retry = h.open(&bob, &short).await;
    assert!(deadlines.contains(retry["expires_at"].as_str().unwrap()));
    for account in [&alice, &bob] {
        let snapshot = h.snapshot(account).await;
        let messages = h.messages(account, chat, 0, 100).await;
        assert!(!snapshot.to_string().contains("SECRET_EPHEMERAL_"));
        assert!(!messages.to_string().contains("SECRET_EPHEMERAL_"));
        assert!(
            messages["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["body"].is_null())
        );
    }
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn expired_or_missing_ephemeral_content_cannot_be_read_replayed_or_recreated() {
    let h = Harness::new().await;
    let alice = h.register("alice").await;
    let bob = h.register("bob").await;
    let chat = h.befriend(&alice, &bob).await;
    let unopened = h
        .send(&alice, chat, "unopened seven-day expiry", Some(300))
        .await;
    let opened = h
        .send(&alice, chat, "opened deadline expiry", Some(300))
        .await;
    let restored = h
        .send(&alice, chat, "missing payload after restore", Some(300))
        .await;
    h.open(&bob, &opened).await;
    sqlx::query("UPDATE social_messages SET created_at=clock_timestamp()-interval '8 days',unopened_expires_at=clock_timestamp()-interval '1 day' WHERE id=$1")
        .bind(uuid(&unopened["id"])).execute(&h.pool).await.unwrap();
    sqlx::query("UPDATE social_messages SET opened_at=clock_timestamp()-interval '301 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1")
        .bind(uuid(&opened["id"])).execute(&h.pool).await.unwrap();
    sqlx::query("DELETE FROM social_ephemeral_payloads WHERE message_id=$1")
        .bind(uuid(&restored["id"]))
        .execute(&h.pool)
        .await
        .unwrap();
    // Verify immediately, before maintenance, so deletion is not the authorization boundary.
    for message in [&unopened, &opened, &restored] {
        assert_error(
            h.request(
                "POST",
                &open_path(message),
                Some(&bob.token),
                Some(json!({})),
            )
            .await,
            StatusCode::GONE,
            "SOCIAL_MESSAGE_EXPIRED",
        );
        assert_error(
            h.request(
                "POST",
                &messages_path(chat),
                Some(&alice.token),
                Some(message_request(
                    uuid(&message["client_message_id"]),
                    "attempt to reconstruct",
                    Some(300),
                )),
            )
            .await,
            StatusCode::GONE,
            "SOCIAL_MESSAGE_EXPIRED",
        );
        let lookup = h
            .ok(
                "GET",
                &format!(
                    "/v1/social/messages/by-client/{}",
                    message["client_message_id"].as_str().unwrap()
                ),
                &alice,
                None,
            )
            .await;
        assert_eq!(lookup["id"], message["id"]);
        assert_eq!(lookup["expired"], true);
        assert_eq!(lookup["body"], Value::Null);
    }
    let items = h.messages(&bob, chat, 0, 100).await;
    assert!(
        items["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|message| message["expired"] == true && message["body"].is_null())
    );
    xiaoq_backend::social::cleanup(&h.pool).await.unwrap();
    let payloads: i64 = sqlx::query_scalar("SELECT count(*) FROM social_ephemeral_payloads")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(payloads, 0);
    let envelopes: i64 = sqlx::query_scalar("SELECT count(*) FROM social_messages")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(
        envelopes, 3,
        "expired tombstones must not be rewritten or duplicated"
    );
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn intimacy_requires_both_directions_and_opt_out_has_no_backfill_or_ephemeral_points() {
    let h = Harness::new().await;
    let alice = h.register("alice").await;
    let bob = h.register("bob").await;
    let carol = h.register("carol").await;
    let ab = h.befriend(&alice, &bob).await;
    h.send(&alice, ab, "one way only", None).await;
    assert_eq!(
        friend(&h.snapshot(&alice).await, bob.id)["intimacy_score"],
        0
    );
    h.send(&bob, ab, "both participated", None).await;
    assert_eq!(
        friend(&h.snapshot(&alice).await, bob.id)["intimacy_score"],
        1
    );
    for account in [&alice, &bob, &alice, &bob] {
        h.send(account, ab, "same UTC day", None).await;
    }
    assert_eq!(
        friend(&h.snapshot(&bob).await, alice.id)["intimacy_score"],
        1
    );

    let ac = h.befriend(&alice, &carol).await;
    h.send(&alice, ac, "pending ordinary activity", None).await;
    h.ok(
        "PATCH",
        &format!("/v1/social/friends/{}", alice.id),
        &carol,
        Some(json!({"intimacy_enabled":false})),
    )
    .await;
    h.send(&carol, ac, "reply while opted out", None).await;
    h.send(&alice, ac, "send while peer opted out", None).await;
    assert_eq!(
        friend(&h.snapshot(&alice).await, carol.id)["intimacy_score"],
        0
    );
    assert_eq!(
        friend(&h.snapshot(&alice).await, carol.id)["peer_intimacy_enabled"],
        false
    );
    h.ok(
        "PATCH",
        &format!("/v1/social/friends/{}", alice.id),
        &carol,
        Some(json!({"intimacy_enabled":true})),
    )
    .await;
    h.send(
        &carol,
        ac,
        "still only one direction since reenabling",
        None,
    )
    .await;
    assert_eq!(
        friend(&h.snapshot(&alice).await, carol.id)["intimacy_score"],
        0
    );
    h.send(&alice, ac, "new mutual activity", None).await;
    assert_eq!(
        friend(&h.snapshot(&carol).await, alice.id)["intimacy_score"],
        1
    );

    let bc = h.befriend(&bob, &carol).await;
    let first = h
        .send(&bob, bc, "ephemeral must not score", Some(300))
        .await;
    let second = h
        .send(&carol, bc, "ephemeral reply must not score", Some(300))
        .await;
    h.open(&carol, &first).await;
    h.open(&bob, &second).await;
    assert_eq!(
        friend(&h.snapshot(&bob).await, carol.id)["intimacy_score"],
        0
    );
    let activity: i64 =
        sqlx::query_scalar("SELECT count(*) FROM social_daily_activity WHERE conversation_id=$1")
            .bind(bc)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(
        activity, 0,
        "ephemeral messages must not leave an intimacy activity row"
    );
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn reports_require_explicit_evidence_consent_and_have_fixed_idempotent_retention() {
    let h = Harness::new().await;
    let alice = h.register("alice").await;
    let bob = h.register("bob").await;
    let outsider = h.register("outsider").await;
    let chat = h.befriend(&alice, &bob).await;
    let ordinary = h
        .send(&bob, chat, "ordinary evidence selected by reporter", None)
        .await;
    let ephemeral = h
        .send(&bob, chat, "PRIVATE_EPHEMERAL_REPORT_EVIDENCE", Some(300))
        .await;
    let report_body = |key: Uuid, message: &Value, include: bool| {
        json!({
            "client_report_id":key,"user_id":bob.id,"message_id":message["id"],
            "reason":"PRIVATE_REPORT_REASON","include_evidence":include
        })
    };
    let metadata_key = Uuid::new_v4();
    h.ok(
        "POST",
        "/v1/social/reports",
        &alice,
        Some(report_body(metadata_key, &ordinary, false)),
    )
    .await;
    let metadata_report: Uuid = sqlx::query_scalar(
        "SELECT report_id FROM social_report_receipts WHERE reporter_id=$1 AND client_report_id=$2",
    )
    .bind(alice.id)
    .bind(metadata_key)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    let no_evidence: i64 =
        sqlx::query_scalar("SELECT count(*) FROM social_report_evidence WHERE report_id=$1")
            .bind(metadata_report)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(
        no_evidence, 0,
        "reporting without consent must not copy message content"
    );

    let ordinary_key = Uuid::new_v4();
    let ordinary_report = report_body(ordinary_key, &ordinary, true);
    h.ok(
        "POST",
        "/v1/social/reports",
        &alice,
        Some(ordinary_report.clone()),
    )
    .await;
    let (report_id, original_expiry): (Uuid, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
        "SELECT report_id,expires_at FROM social_report_receipts WHERE reporter_id=$1 AND client_report_id=$2")
        .bind(alice.id).bind(ordinary_key).fetch_one(&h.pool).await.unwrap();
    let (evidence_body, evidence_expiry): (String, chrono::DateTime<chrono::Utc>) =
        sqlx::query_as("SELECT body,expires_at FROM social_report_evidence WHERE report_id=$1")
            .bind(report_id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(evidence_body, "ordinary evidence selected by reporter");
    assert_eq!(evidence_expiry, original_expiry);
    let lifetime: i64 = sqlx::query_scalar(
        "SELECT extract(epoch FROM expires_at-created_at)::bigint FROM social_reports WHERE id=$1",
    )
    .bind(report_id)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(lifetime, 30 * 24 * 60 * 60);
    let replayed = futures_util::future::join_all((0..4).map(|_| {
        h.request(
            "POST",
            "/v1/social/reports",
            Some(&alice.token),
            Some(ordinary_report.clone()),
        )
    }))
    .await;
    assert!(replayed.iter().all(|(status, _)| *status == StatusCode::OK));
    let persisted_expiry: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT expires_at FROM social_reports WHERE id=$1")
            .bind(report_id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(
        persisted_expiry, original_expiry,
        "retry must not start a new retention period"
    );
    let report_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM social_reports WHERE reporter_id=$1")
            .bind(alice.id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(report_count, 2);
    let mut changed = ordinary_report.clone();
    changed["reason"] = json!("changed reason under same key");
    assert_error(
        h.request(
            "POST",
            "/v1/social/reports",
            Some(&alice.token),
            Some(changed),
        )
        .await,
        StatusCode::CONFLICT,
        "IDEMPOTENCY_CONFLICT",
    );
    assert_error(
        h.request(
            "POST",
            "/v1/social/reports",
            Some(&outsider.token),
            Some(report_body(Uuid::new_v4(), &ordinary, true)),
        )
        .await,
        StatusCode::NOT_FOUND,
        "SOCIAL_NOT_FOUND",
    );
    let mut wrong_author = report_body(Uuid::new_v4(), &ordinary, true);
    wrong_author["user_id"] = json!(outsider.id);
    assert_error(
        h.request(
            "POST",
            "/v1/social/reports",
            Some(&alice.token),
            Some(wrong_author),
        )
        .await,
        StatusCode::NOT_FOUND,
        "SOCIAL_NOT_FOUND",
    );
    let unopened_report = h
        .request(
            "POST",
            "/v1/social/reports",
            Some(&alice.token),
            Some(report_body(Uuid::new_v4(), &ephemeral, true)),
        )
        .await;
    assert_eq!(
        unopened_report.0,
        StatusCode::FORBIDDEN,
        "{}",
        unopened_report.1
    );
    h.open(&alice, &ephemeral).await;
    let ephemeral_key = Uuid::new_v4();
    let ephemeral_report = report_body(ephemeral_key, &ephemeral, true);
    h.ok(
        "POST",
        "/v1/social/reports",
        &alice,
        Some(ephemeral_report.clone()),
    )
    .await;
    let evidence_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM social_report_evidence WHERE body=$1")
            .bind("PRIVATE_EPHEMERAL_REPORT_EVIDENCE")
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(evidence_count, 1);
    for account in [&alice, &bob, &outsider] {
        let snapshot = h.snapshot(account).await.to_string();
        assert!(!snapshot.contains("PRIVATE_REPORT_REASON"));
        assert!(!snapshot.contains("PRIVATE_EPHEMERAL_REPORT_EVIDENCE"));
    }
    sqlx::query("UPDATE social_messages SET opened_at=clock_timestamp()-interval '301 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1")
        .bind(uuid(&ephemeral["id"])).execute(&h.pool).await.unwrap();
    assert_error(
        h.request(
            "POST",
            "/v1/social/reports",
            Some(&alice.token),
            Some(report_body(Uuid::new_v4(), &ephemeral, true)),
        )
        .await,
        StatusCode::GONE,
        "SOCIAL_MESSAGE_EXPIRED",
    );
    // An already-consented report may replay, but cannot create another evidence copy.
    h.ok("POST", "/v1/social/reports", &alice, Some(ephemeral_report))
        .await;
    xiaoq_backend::social::cleanup(&h.pool).await.unwrap();
    let evidence_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM social_report_evidence WHERE body=$1")
            .bind("PRIVATE_EPHEMERAL_REPORT_EVIDENCE")
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(
        evidence_count, 1,
        "explicit report evidence has its own disclosed retention"
    );

    sqlx::query("UPDATE social_reports SET created_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1")
        .bind(report_id).execute(&h.pool).await.unwrap();
    sqlx::query("UPDATE social_report_evidence SET expires_at=clock_timestamp()-interval '1 day' WHERE report_id=$1")
        .bind(report_id).execute(&h.pool).await.unwrap();
    sqlx::query("UPDATE social_report_receipts SET expires_at=clock_timestamp()-interval '1 day' WHERE report_id=$1")
        .bind(report_id).execute(&h.pool).await.unwrap();
    xiaoq_backend::social::cleanup(&h.pool).await.unwrap();
    assert_error(
        h.request(
            "POST",
            "/v1/social/reports",
            Some(&alice.token),
            Some(ordinary_report),
        )
        .await,
        StatusCode::GONE,
        "SOCIAL_REPORT_EXPIRED",
    );
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM social_reports WHERE id=$1")
        .bind(report_id)
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0);
    let evidence: i64 =
        sqlx::query_scalar("SELECT count(*) FROM social_report_evidence WHERE report_id=$1")
            .bind(report_id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(evidence, 0);
    let receipt: i64 =
        sqlx::query_scalar("SELECT count(*) FROM social_report_receipts WHERE report_id=$1")
            .bind(report_id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(
        receipt, 1,
        "minimal expiry receipt prevents retry from restarting retention"
    );
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn request_races_and_validation_do_not_create_implicit_friends_or_invalid_messages() {
    let h = Harness::new().await;
    let alice = h.register("alice").await;
    let bob = h.register("bob").await;
    let requests = futures_util::future::join_all((0..5).map(|_| {
        h.request(
            "POST",
            "/v1/social/requests",
            Some(&alice.token),
            Some(json!({"user_id":bob.id,"note":"concurrent request"})),
        )
    }))
    .await;
    assert_eq!(
        requests
            .iter()
            .filter(|(status, _)| *status == StatusCode::CREATED)
            .count(),
        1
    );
    assert!(
        requests
            .iter()
            .all(|(status, _)| [StatusCode::CREATED, StatusCode::OK].contains(status))
    );
    let ids: HashSet<_> = requests
        .iter()
        .map(|(_, body)| body["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 1);
    assert!(
        h.snapshot(&alice).await["friends"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        h.snapshot(&bob).await["requests"].as_array().unwrap().len(),
        1
    );
    h.ok(
        "POST",
        &format!(
            "/v1/social/requests/{}/respond",
            requests[0].1["id"].as_str().unwrap()
        ),
        &bob,
        Some(json!({"accept":true})),
    )
    .await;
    let chat = uuid(&friend(&h.snapshot(&alice).await, bob.id)["conversation_id"]);
    for body in [
        message_request(Uuid::new_v4(), "  \n\t", None),
        message_request(Uuid::new_v4(), &"界".repeat(2001), None),
        message_request(Uuid::new_v4(), "invalid timer", Some(1)),
    ] {
        assert_error(
            h.request("POST", &messages_path(chat), Some(&alice.token), Some(body))
                .await,
            StatusCode::BAD_REQUEST,
            "VALIDATION_ERROR",
        );
    }
    for suffix in ["?after_seq=-1", "?limit=0", "?limit=101"] {
        assert_error(
            h.request(
                "GET",
                &format!("{}{suffix}", messages_path(chat)),
                Some(&bob.token),
                None,
            )
            .await,
            StatusCode::BAD_REQUEST,
            "VALIDATION_ERROR",
        );
    }
    assert_error(
        h.request(
            "POST",
            "/v1/social/requests",
            Some(&alice.token),
            Some(json!({"user_id":alice.id,"note":"self"})),
        )
        .await,
        StatusCode::BAD_REQUEST,
        "VALIDATION_ERROR",
    );
    assert_error(
        h.request(
            "POST",
            "/v1/social/blocks",
            Some(&alice.token),
            Some(json!({"user_id":alice.id})),
        )
        .await,
        StatusCode::BAD_REQUEST,
        "VALIDATION_ERROR",
    );
    assert_error(
        h.request(
            "PATCH",
            &format!("/v1/social/friends/{}", bob.id),
            Some(&alice.token),
            Some(json!({"remark":"界".repeat(41)})),
        )
        .await,
        StatusCode::BAD_REQUEST,
        "VALIDATION_ERROR",
    );
    let unicode = "界".repeat(2000);
    let valid = h.send(&alice, chat, &unicode, None).await;
    assert_eq!(valid["body"], unicode);
    assert_eq!(
        valid["seq"], 1,
        "rejected messages must not consume a committed sequence"
    );
    let snapshot = h.snapshot(&bob).await;
    let preview = conversation(&snapshot, chat)["last_message"]["body"]
        .as_str()
        .unwrap();
    assert_eq!(
        preview.chars().count(),
        160,
        "snapshot previews must be bounded by Unicode characters"
    );
    assert_eq!(
        h.messages(&bob, chat, 0, 100).await["items"][0]["body"],
        unicode,
        "preview truncation must not truncate stored message history"
    );
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn report_retries_do_not_recreate_missing_or_expired_evidence() {
    let h = Harness::new().await;
    let alice = h.register("alice").await;
    let bob = h.register("bob").await;
    let chat = h.befriend(&alice, &bob).await;
    let message = h
        .send(&bob, chat, "separately retained report evidence", None)
        .await;
    for remove_evidence in [true, false] {
        let client_id = Uuid::new_v4();
        let input = json!({"client_report_id":client_id,"user_id":bob.id,"message_id":message["id"],
            "reason":"explicit report retention test","include_evidence":true});
        h.ok("POST", "/v1/social/reports", &alice, Some(input.clone()))
            .await;
        let (report_id,deadline):(Uuid,chrono::DateTime<chrono::Utc>) = sqlx::query_as(
            "SELECT report_id,expires_at FROM social_report_receipts WHERE reporter_id=$1 AND client_report_id=$2")
            .bind(alice.id).bind(client_id).fetch_one(&h.pool).await.unwrap();
        if remove_evidence {
            sqlx::query("DELETE FROM social_report_evidence WHERE report_id=$1")
                .bind(report_id)
                .execute(&h.pool)
                .await
                .unwrap();
        } else {
            sqlx::query("UPDATE social_report_evidence SET expires_at=clock_timestamp()-interval '1 second' WHERE report_id=$1")
                .bind(report_id).execute(&h.pool).await.unwrap();
        }
        assert_error(
            h.request(
                "POST",
                "/v1/social/reports",
                Some(&alice.token),
                Some(input),
            )
            .await,
            StatusCode::GONE,
            "SOCIAL_REPORT_EXPIRED",
        );
        let current_deadline: chrono::DateTime<chrono::Utc> =
            sqlx::query_scalar("SELECT expires_at FROM social_report_receipts WHERE report_id=$1")
                .bind(report_id)
                .fetch_one(&h.pool)
                .await
                .unwrap();
        assert_eq!(deadline, current_deadline);
        let live_evidence:i64 = sqlx::query_scalar("SELECT count(*) FROM social_report_evidence WHERE report_id=$1 AND expires_at>clock_timestamp()")
            .bind(report_id).fetch_one(&h.pool).await.unwrap();
        assert_eq!(
            live_evidence, 0,
            "a retry must not reconstruct already unavailable evidence"
        );
        let reports: i64 = sqlx::query_scalar("SELECT count(*) FROM social_reports WHERE id=$1")
            .bind(report_id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
        assert_eq!(
            reports, 1,
            "replay failure must not recreate or replace report metadata"
        );
    }
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn required_nullable_fields_cannot_silently_change_message_retention() {
    let h = Harness::new().await;
    let alice = h.register("alice").await;
    let bob = h.register("bob").await;
    let chat = h.befriend(&alice, &bob).await;
    let missing_ttl = h
        .request(
            "POST",
            &messages_path(chat),
            Some(&alice.token),
            Some(json!({"client_message_id":Uuid::new_v4(),"body":"retention choice missing"})),
        )
        .await;
    let missing_message=h.request("POST","/v1/social/reports",Some(&alice.token),
        Some(json!({"client_report_id":Uuid::new_v4(),"user_id":bob.id,"reason":"missing explicit nullable field","include_evidence":false}))).await;
    assert_eq!(
        (missing_ttl.0, missing_message.0),
        (StatusCode::BAD_REQUEST, StatusCode::BAD_REQUEST),
        "OpenAPI requires explicit ttl_seconds/message_id, including null: send={}, report={}",
        missing_ttl.1,
        missing_message.1
    );
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn ephemeral_state_refresh_updates_old_envelopes_without_leaking_foreign_messages() {
    let h = Harness::new().await;
    let alice = h.register("alice").await;
    let bob = h.register("bob").await;
    let outsider = h.register("outsider").await;
    let chat = h.befriend(&alice, &bob).await;
    let other_chat = h.befriend(&alice, &outsider).await;
    let first = h
        .send(&alice, chat, "REFRESH_PRIVATE_EPHEMERAL", Some(300))
        .await;
    let second = h
        .send(&alice, chat, "REFRESH_SECOND_EPHEMERAL", Some(86400))
        .await;
    let ordinary = h.send(&alice, chat, "ordinary envelope", None).await;
    let foreign = h
        .send(&alice, other_chat, "FOREIGN_PRIVATE_EPHEMERAL", Some(300))
        .await;
    let endpoint = format!("/v1/social/conversations/{chat}/ephemeral-state");
    let path = format!(
        "{endpoint}?message_ids={},{}",
        first["id"].as_str().unwrap(),
        second["id"].as_str().unwrap()
    );
    let before = h.ok("GET", &path, &bob, None).await;
    assert_eq!(before["items"].as_array().unwrap().len(), 2);
    assert!(
        before["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["opened_at"].is_null() && item["body"].is_null())
    );
    let opened = h.open(&bob, &first).await;
    let after = h.ok("GET", &path, &bob, None).await;
    let refreshed = after["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == first["id"])
        .unwrap();
    assert_eq!(refreshed["expires_at"], opened["expires_at"]);
    assert!(!refreshed["opened_at"].is_null());
    assert_eq!(refreshed["body"], Value::Null);
    assert!(!after.to_string().contains("REFRESH_PRIVATE_EPHEMERAL"));
    assert!(
        h.messages(&bob, chat, 3, 100).await["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(conversation(&h.snapshot(&bob).await, chat)["last_seq"], 3);
    for bad_id in [
        foreign["id"].as_str().unwrap().to_owned(),
        ordinary["id"].as_str().unwrap().to_owned(),
        Uuid::new_v4().to_string(),
    ] {
        assert_error(
            h.request(
                "GET",
                &format!(
                    "{endpoint}?message_ids={},{}",
                    first["id"].as_str().unwrap(),
                    bad_id
                ),
                Some(&bob.token),
                None,
            )
            .await,
            StatusCode::NOT_FOUND,
            "SOCIAL_NOT_FOUND",
        );
    }
    assert_error(
        h.request("GET", &path, Some(&outsider.token), None).await,
        StatusCode::NOT_FOUND,
        "SOCIAL_NOT_FOUND",
    );
    assert_error(
        h.request(
            "GET",
            &format!(
                "{endpoint}?message_ids={},{}",
                first["id"].as_str().unwrap(),
                first["id"].as_str().unwrap()
            ),
            Some(&bob.token),
            None,
        )
        .await,
        StatusCode::BAD_REQUEST,
        "VALIDATION_ERROR",
    );

    // Opening establishes a new TTL independent of the old unopened deadline.
    let long_open = h.open(&bob, &second).await;
    sqlx::query("UPDATE social_messages SET created_at=clock_timestamp()-interval '8 days',unopened_expires_at=clock_timestamp()-interval '1 day' WHERE id=$1")
        .bind(uuid(&second["id"])).execute(&h.pool).await.unwrap();
    sqlx::query("UPDATE social_messages SET opened_at=clock_timestamp()-interval '301 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1")
        .bind(uuid(&first["id"])).execute(&h.pool).await.unwrap();
    xiaoq_backend::social::cleanup(&h.pool).await.unwrap();
    let expired = h.ok("GET", &path, &bob, None).await;
    let items = expired["items"].as_array().unwrap();
    assert_eq!(
        items.iter().find(|item| item["id"] == first["id"]).unwrap()["expired"],
        true
    );
    let still_live = items
        .iter()
        .find(|item| item["id"] == second["id"])
        .unwrap();
    assert_eq!(still_live["expired"], false);
    assert_eq!(still_live["expires_at"], long_open["expires_at"]);
    assert_eq!(
        h.open(&bob, &second).await["expires_at"],
        long_open["expires_at"]
    );
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn report_receipts_are_owner_only_content_free_and_never_extend_retention() {
    let h = Harness::new().await;
    let alice = h.register("alice").await;
    let bob = h.register("bob").await;
    let outsider = h.register("outsider").await;
    let chat = h.befriend(&alice, &bob).await;
    let message = h
        .send(&bob, chat, "PRIVATE_REPORT_RECEIPT_EVIDENCE", None)
        .await;
    let known_key = Uuid::new_v4();
    let known_path = format!("/v1/social/reports/by-client/{known_key}");
    let report_body = |key, include| {
        json!({
            "client_report_id":key,"user_id":bob.id,"message_id":message["id"],
            "reason":"PRIVATE_REPORT_RECEIPT_REASON","include_evidence":include
        })
    };
    h.ok(
        "POST",
        "/v1/social/reports",
        &alice,
        Some(report_body(known_key, false)),
    )
    .await;
    let original_expiry: chrono::DateTime<chrono::Utc> = sqlx::query_scalar(
        "SELECT expires_at FROM social_report_receipts WHERE reporter_id=$1 AND client_report_id=$2")
        .bind(alice.id).bind(known_key).fetch_one(&h.pool).await.unwrap();
    for _ in 0..3 {
        let receipt = h.ok("GET", &known_path, &alice, None).await;
        let fields: HashSet<_> = receipt
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            fields,
            HashSet::from(["client_report_id", "status", "expires_at", "server_time"])
        );
        assert_eq!(receipt["client_report_id"], known_key.to_string());
        assert_eq!(receipt["status"], "accepted");
        let expiry = chrono::DateTime::parse_from_rfc3339(receipt["expires_at"].as_str().unwrap())
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(expiry, original_expiry);
        assert!(
            chrono::DateTime::parse_from_rfc3339(receipt["server_time"].as_str().unwrap()).is_ok()
        );
        for private in [
            "PRIVATE_REPORT_RECEIPT_REASON",
            "PRIVATE_REPORT_RECEIPT_EVIDENCE",
            bob.id.to_string().as_str(),
            message["id"].as_str().unwrap(),
        ] {
            assert!(
                !receipt.to_string().contains(private),
                "receipt leaked private report data"
            );
        }
    }
    for account in [&bob, &outsider] {
        assert_error(
            h.request("GET", &known_path, Some(&account.token), None)
                .await,
            StatusCode::NOT_FOUND,
            "SOCIAL_NOT_FOUND",
        );
    }
    assert_error(
        h.request("GET", &known_path, None, None).await,
        StatusCode::UNAUTHORIZED,
        "UNAUTHORIZED",
    );
    assert_error(
        h.request(
            "GET",
            &format!("/v1/social/reports/by-client/{}", Uuid::new_v4()),
            Some(&alice.token),
            None,
        )
        .await,
        StatusCode::NOT_FOUND,
        "SOCIAL_NOT_FOUND",
    );

    for scenario in [
        "missing_report",
        "missing_evidence",
        "expired_report",
        "expired_evidence",
        "expired_receipt",
    ] {
        let client_id = Uuid::new_v4();
        h.ok(
            "POST",
            "/v1/social/reports",
            &alice,
            Some(report_body(client_id, true)),
        )
        .await;
        let report_id: Uuid = sqlx::query_scalar("SELECT report_id FROM social_report_receipts WHERE reporter_id=$1 AND client_report_id=$2")
            .bind(alice.id).bind(client_id).fetch_one(&h.pool).await.unwrap();
        let statement = match scenario {
            "missing_report" => "DELETE FROM social_reports WHERE id=$1",
            "missing_evidence" => "DELETE FROM social_report_evidence WHERE report_id=$1",
            "expired_report" => {
                "UPDATE social_reports SET created_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1"
            }
            "expired_evidence" => {
                "UPDATE social_report_evidence SET expires_at=clock_timestamp()-interval '1 second' WHERE report_id=$1"
            }
            "expired_receipt" => {
                "UPDATE social_report_receipts SET expires_at=clock_timestamp()-interval '1 second' WHERE report_id=$1"
            }
            _ => unreachable!(),
        };
        sqlx::query(statement)
            .bind(report_id)
            .execute(&h.pool)
            .await
            .unwrap();
        let before: chrono::DateTime<chrono::Utc> =
            sqlx::query_scalar("SELECT expires_at FROM social_report_receipts WHERE report_id=$1")
                .bind(report_id)
                .fetch_one(&h.pool)
                .await
                .unwrap();
        let result = h
            .request(
                "GET",
                &format!("/v1/social/reports/by-client/{client_id}"),
                Some(&alice.token),
                None,
            )
            .await;
        assert_eq!(result.0, StatusCode::GONE, "{scenario}: {}", result.1);
        assert_eq!(
            result.1["error"]["code"], "SOCIAL_REPORT_EXPIRED",
            "{scenario}"
        );
        let after: chrono::DateTime<chrono::Utc> =
            sqlx::query_scalar("SELECT expires_at FROM social_report_receipts WHERE report_id=$1")
                .bind(report_id)
                .fetch_one(&h.pool)
                .await
                .unwrap();
        assert_eq!(before, after, "receipt query extended expiry in {scenario}");
    }
    let final_expiry: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT expires_at FROM social_report_receipts WHERE reporter_id=$1 AND client_report_id=$2")
        .bind(alice.id).bind(known_key).fetch_one(&h.pool).await.unwrap();
    assert_eq!(final_expiry, original_expiry);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn forbidden_unopened_evidence_permanently_rejects_its_original_report_id() {
    let h = Harness::new().await;
    let alice = h.register("alice").await;
    let bob = h.register("bob").await;
    let chat = h.befriend(&alice, &bob).await;
    let message = h
        .send(
            &bob,
            chat,
            "unopened evidence must not be copied",
            Some(300),
        )
        .await;
    let rejected_id = Uuid::new_v4();
    let request = |client_id| {
        json!({
            "client_report_id":client_id,"user_id":bob.id,"message_id":message["id"],
            "reason":"explicit consent does not bypass opening","include_evidence":true
        })
    };
    assert_error(
        h.request(
            "POST",
            "/v1/social/reports",
            Some(&alice.token),
            Some(request(rejected_id)),
        )
        .await,
        StatusCode::FORBIDDEN,
        "SOCIAL_FORBIDDEN",
    );
    let reports: i64 = sqlx::query_scalar("SELECT count(*) FROM social_reports")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    let evidence: i64 = sqlx::query_scalar("SELECT count(*) FROM social_report_evidence")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(reports, 0, "rejection may not create report metadata");
    assert_eq!(evidence, 0, "rejection may not copy message evidence");
    let (tombstone_id, deadline): (Uuid, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
        "SELECT report_id,expires_at FROM social_report_receipts WHERE reporter_id=$1 AND client_report_id=$2")
        .bind(alice.id).bind(rejected_id).fetch_one(&h.pool).await.unwrap();
    let rejected_path = format!("/v1/social/reports/by-client/{rejected_id}");
    assert_error(
        h.request("GET", &rejected_path, Some(&alice.token), None)
            .await,
        StatusCode::GONE,
        "SOCIAL_REPORT_EXPIRED",
    );
    h.open(&alice, &message).await;
    // A delayed duplicate of the rejected request must never become a new accepted report.
    assert_error(
        h.request(
            "POST",
            "/v1/social/reports",
            Some(&alice.token),
            Some(request(rejected_id)),
        )
        .await,
        StatusCode::GONE,
        "SOCIAL_REPORT_EXPIRED",
    );
    assert_error(
        h.request("GET", &rejected_path, Some(&alice.token), None)
            .await,
        StatusCode::GONE,
        "SOCIAL_REPORT_EXPIRED",
    );
    let after: (Uuid, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
        "SELECT report_id,expires_at FROM social_report_receipts WHERE reporter_id=$1 AND client_report_id=$2")
        .bind(alice.id).bind(rejected_id).fetch_one(&h.pool).await.unwrap();
    assert_eq!(after, (tombstone_id, deadline));
    let reports: i64 = sqlx::query_scalar("SELECT count(*) FROM social_reports")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    let evidence: i64 = sqlx::query_scalar("SELECT count(*) FROM social_report_evidence")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(reports, 0);
    assert_eq!(evidence, 0);

    // A separate, explicitly authorized report can now succeed, and its accepted receipt
    // still wins over later source-message expiry on retries.
    let accepted_id = Uuid::new_v4();
    h.ok(
        "POST",
        "/v1/social/reports",
        &alice,
        Some(request(accepted_id)),
    )
    .await;
    sqlx::query("UPDATE social_messages SET opened_at=clock_timestamp()-interval '301 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1")
        .bind(uuid(&message["id"])).execute(&h.pool).await.unwrap();
    xiaoq_backend::social::cleanup(&h.pool).await.unwrap();
    h.ok(
        "POST",
        "/v1/social/reports",
        &alice,
        Some(request(accepted_id)),
    )
    .await;
    let accepted = h
        .ok(
            "GET",
            &format!("/v1/social/reports/by-client/{accepted_id}"),
            &alice,
            None,
        )
        .await;
    assert_eq!(accepted["status"], "accepted");
    let reports: i64 = sqlx::query_scalar("SELECT count(*) FROM social_reports")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    let evidence: i64 = sqlx::query_scalar("SELECT count(*) FROM social_report_evidence")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(reports, 1, "accepted replay must not duplicate metadata");
    assert_eq!(evidence, 1, "accepted replay must not duplicate evidence");
    h.finish().await;
}

fn uuid(value: &Value) -> Uuid {
    Uuid::parse_str(value.as_str().unwrap()).unwrap()
}

fn friend(snapshot: &Value, user: Uuid) -> &Value {
    snapshot["friends"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["user"]["id"] == user.to_string())
        .expect("expected active friend in complete snapshot")
}

fn conversation(snapshot: &Value, id: Uuid) -> &Value {
    snapshot["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == id.to_string())
        .expect("expected conversation in complete snapshot")
}

fn messages_path(conversation: Uuid) -> String {
    format!("/v1/social/conversations/{conversation}/messages")
}

fn open_path(message: &Value) -> String {
    format!(
        "/v1/social/messages/{}/open",
        message["id"].as_str().unwrap()
    )
}

fn message_request(id: Uuid, body: &str, ttl: Option<i64>) -> Value {
    json!({"client_message_id":id,"body":body,"ttl_seconds":ttl})
}

fn assert_error(result: (StatusCode, Value), expected_status: StatusCode, expected_code: &str) {
    assert_eq!(result.0, expected_status, "{}", result.1);
    assert_eq!(result.1["error"]["code"], expected_code, "{}", result.1);
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn friend_requests_private_preferences_and_mutual_relationship_labels() {
    let h = Harness::new().await;
    assert_error(
        h.request("GET", "/v1/social/snapshot", None, None).await,
        StatusCode::UNAUTHORIZED,
        "UNAUTHORIZED",
    );
    let alice = h.register("alice").await;
    let bob = h.register("bob").await;
    let outsider = h.register("outsider").await;
    let request = h.request_friend(&alice, &bob).await;
    let request_path = format!(
        "/v1/social/requests/{}/respond",
        request["id"].as_str().unwrap()
    );
    let repeated = h
        .ok(
            "POST",
            "/v1/social/requests",
            &alice,
            Some(json!({"user_id":bob.id,"note":"Social acceptance request"})),
        )
        .await;
    assert_eq!(repeated["id"], request["id"]);
    assert_error(
        h.request(
            "POST",
            "/v1/social/requests",
            Some(&bob.token),
            Some(json!({"user_id":alice.id,"note":"reverse"})),
        )
        .await,
        StatusCode::CONFLICT,
        "SOCIAL_REQUEST_PENDING",
    );
    assert_error(
        h.request(
            "POST",
            &request_path,
            Some(&outsider.token),
            Some(json!({"accept":true})),
        )
        .await,
        StatusCode::NOT_FOUND,
        "SOCIAL_NOT_FOUND",
    );
    assert!(
        h.snapshot(&outsider).await["requests"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    h.ok("POST", &request_path, &bob, Some(json!({"accept":false})))
        .await;
    assert!(
        h.snapshot(&alice).await["friends"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        h.snapshot(&bob).await["requests"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let chat = h.befriend(&alice, &bob).await;
    assert_error(
        h.request(
            "POST",
            "/v1/social/requests",
            Some(&alice.token),
            Some(json!({"user_id":bob.id,"note":"again"})),
        )
        .await,
        StatusCode::CONFLICT,
        "SOCIAL_ALREADY_FRIENDS",
    );
    h.ok(
        "PATCH",
        &format!("/v1/social/friends/{}", bob.id),
        &alice,
        Some(json!({"remark":"Only Alice sees this","muted":true})),
    )
    .await;
    let alice_snapshot = h.snapshot(&alice).await;
    let bob_snapshot = h.snapshot(&bob).await;
    assert_eq!(
        friend(&alice_snapshot, bob.id)["remark"],
        "Only Alice sees this"
    );
    assert_eq!(friend(&alice_snapshot, bob.id)["muted"], true);
    assert_eq!(friend(&bob_snapshot, alice.id)["remark"], "");
    assert_eq!(friend(&bob_snapshot, alice.id)["muted"], false);
    assert!(!bob_snapshot.to_string().contains("Only Alice sees this"));
    let social_user = friend(&alice_snapshot, bob.id)["user"].as_object().unwrap();
    assert_eq!(social_user.len(), 4);
    assert!(social_user.contains_key("handle") && social_user.contains_key("avatar"));

    let propose = format!("/v1/social/friends/{}/label", bob.id);
    h.ok("POST", &propose, &alice, Some(json!({"label":"couple"})))
        .await;
    let snapshot = h.snapshot(&bob).await;
    assert_eq!(
        friend(&snapshot, alice.id)["relationship_label"],
        Value::Null
    );
    assert_eq!(friend(&snapshot, alice.id)["proposed_label"], "couple");
    assert_eq!(
        friend(&snapshot, alice.id)["proposed_by"],
        alice.id.to_string()
    );
    let own_response = h
        .request(
            "POST",
            &format!("{propose}/respond"),
            Some(&alice.token),
            Some(json!({"accept":true})),
        )
        .await;
    assert_error(own_response, StatusCode::CONFLICT, "SOCIAL_LABEL_PENDING");
    h.ok(
        "POST",
        &format!("/v1/social/friends/{}/label/respond", alice.id),
        &bob,
        Some(json!({"accept":true})),
    )
    .await;
    assert_eq!(
        friend(&h.snapshot(&alice).await, bob.id)["relationship_label"],
        "couple"
    );
    h.ok("POST", &propose, &alice, Some(json!({"label":null})))
        .await;
    assert_eq!(
        friend(&h.snapshot(&bob).await, alice.id)["relationship_label"],
        Value::Null
    );

    let snapshot = h.snapshot(&bob).await;
    let notification = &snapshot["notifications"][0];
    let read_path = format!(
        "/v1/social/notifications/{}/read",
        notification["id"].as_str().unwrap()
    );
    assert_error(
        h.request("POST", &read_path, Some(&outsider.token), Some(json!({})))
            .await,
        StatusCode::NOT_FOUND,
        "SOCIAL_NOT_FOUND",
    );
    h.ok("POST", &read_path, &bob, Some(json!({}))).await;
    h.ok("POST", &read_path, &bob, Some(json!({}))).await;
    assert!(
        h.snapshot(&outsider).await["notifications"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let removal = format!("/v1/social/friends/{}", bob.id);
    h.ok("DELETE", &removal, &alice, None).await;
    h.ok("DELETE", &removal, &alice, None).await;
    assert_eq!(conversation(&h.snapshot(&bob).await, chat)["active"], false);
    assert!(
        h.snapshot(&bob).await["friends"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn messages_are_private_durable_idempotent_and_read_positions_are_monotonic() {
    let mut h = Harness::new().await;
    let alice = h.register("alice").await;
    let bob = h.register("bob").await;
    let outsider = h.register("outsider").await;
    let chat = h.befriend(&alice, &bob).await;
    let other_chat = h.befriend(&alice, &outsider).await;
    let client_id = Uuid::new_v4();
    let body = message_request(client_id, "ordinary private message", None);
    let (status, original) = h
        .request(
            "POST",
            &messages_path(chat),
            Some(&alice.token),
            Some(body.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{original}");
    assert_eq!(original["seq"], 1);
    assert_eq!(original["body"], "ordinary private message");
    let replay = h
        .ok("POST", &messages_path(chat), &alice, Some(body.clone()))
        .await;
    assert_eq!(replay, original);
    for conflicting in [
        message_request(client_id, "different text", None),
        message_request(client_id, "ordinary private message", Some(30)),
    ] {
        assert_error(
            h.request(
                "POST",
                &messages_path(chat),
                Some(&alice.token),
                Some(conflicting),
            )
            .await,
            StatusCode::CONFLICT,
            "IDEMPOTENCY_CONFLICT",
        );
    }
    assert_error(
        h.request(
            "POST",
            &messages_path(other_chat),
            Some(&alice.token),
            Some(body.clone()),
        )
        .await,
        StatusCode::CONFLICT,
        "IDEMPOTENCY_CONFLICT",
    );
    let by_client = format!("/v1/social/messages/by-client/{client_id}");
    assert_eq!(h.ok("GET", &by_client, &alice, None).await, original);
    assert_error(
        h.request("GET", &by_client, Some(&bob.token), None).await,
        StatusCode::NOT_FOUND,
        "SOCIAL_NOT_FOUND",
    );
    assert_error(
        h.request("GET", &messages_path(chat), Some(&outsider.token), None)
            .await,
        StatusCode::NOT_FOUND,
        "SOCIAL_NOT_FOUND",
    );
    assert_error(
        h.request(
            "POST",
            &messages_path(chat),
            Some(&outsider.token),
            Some(message_request(Uuid::new_v4(), "intruder", None)),
        )
        .await,
        StatusCode::NOT_FOUND,
        "SOCIAL_NOT_FOUND",
    );
    assert_eq!(
        conversation(&h.snapshot(&bob).await, chat)["unread_count"],
        1
    );
    assert_eq!(
        conversation(&h.snapshot(&alice).await, chat)["unread_count"],
        0
    );
    let read_path = format!("/v1/social/conversations/{chat}/read");
    h.ok("POST", &read_path, &bob, Some(json!({"through_seq":1})))
        .await;
    assert_eq!(
        conversation(&h.snapshot(&bob).await, chat)["unread_count"],
        0
    );
    assert_eq!(
        conversation(&h.snapshot(&alice).await, chat)["peer_read_seq"],
        1
    );

    // A different owner may independently use the same client ID.
    let (status, reply) = h
        .request("POST", &messages_path(chat), Some(&bob.token), Some(body))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{reply}");
    assert_eq!(reply["seq"], 2);
    for index in 0..5 {
        h.send(&alice, chat, &format!("page item {index}"), None)
            .await;
    }
    let mut cursor = 0;
    let mut sequences = Vec::new();
    loop {
        let page = h.messages(&bob, chat, cursor, 2).await;
        let items = page["items"].as_array().unwrap();
        assert!(items.len() <= 2);
        sequences.extend(items.iter().map(|item| item["seq"].as_i64().unwrap()));
        let next = page["next_after_seq"].as_i64().unwrap();
        assert!(next >= cursor);
        cursor = next;
        if page["has_more"] == false {
            break;
        }
    }
    assert_eq!(sequences, (1..=7).collect::<Vec<_>>());
    h.ok("POST", &read_path, &bob, Some(json!({"through_seq":7})))
        .await;
    h.ok("POST", &read_path, &bob, Some(json!({"through_seq":1})))
        .await;
    assert_eq!(conversation(&h.snapshot(&bob).await, chat)["read_seq"], 7);
    assert_error(
        h.request(
            "POST",
            &read_path,
            Some(&bob.token),
            Some(json!({"through_seq":8})),
        )
        .await,
        StatusCode::BAD_REQUEST,
        "VALIDATION_ERROR",
    );
    let empty = h.messages(&bob, chat, 7, 2).await;
    assert!(empty["items"].as_array().unwrap().is_empty());
    assert_eq!(empty["next_after_seq"], 7);
    assert_eq!(empty["has_more"], false);

    // Rebuild application state against persisted rows, including the existing session.
    h.router = app(
        AppState::new(h.pool.clone()).await.unwrap(),
        vec!["http://localhost:8081".parse().unwrap()],
    );
    assert_eq!(
        h.messages(&bob, chat, 0, 100).await["items"]
            .as_array()
            .unwrap()
            .len(),
        7
    );
    assert_eq!(conversation(&h.snapshot(&bob).await, chat)["read_seq"], 7);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn concurrent_sends_have_gap_free_committed_cursors_and_one_same_key_winner() {
    let h = Harness::new().await;
    let alice = h.register("alice").await;
    let bob = h.register("bob").await;
    let chat = h.befriend(&alice, &bob).await;
    let done = AtomicBool::new(false);
    let sending = async {
        let results = futures_util::future::join_all((0..20).map(|index| {
            let account = if index % 2 == 0 { &alice } else { &bob };
            let harness = &h;
            let path = messages_path(chat);
            async move {
                harness
                    .request(
                        "POST",
                        &path,
                        Some(&account.token),
                        Some(message_request(
                            Uuid::new_v4(),
                            &format!("concurrent {index}"),
                            None,
                        )),
                    )
                    .await
            }
        }))
        .await;
        done.store(true, Ordering::Release);
        results
    };
    let receiving = async {
        let mut cursor = 0;
        let mut received = Vec::new();
        loop {
            let page = h.messages(&bob, chat, cursor, 3).await;
            received.extend(
                page["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|item| item["seq"].as_i64().unwrap()),
            );
            cursor = page["next_after_seq"].as_i64().unwrap();
            if done.load(Ordering::Acquire) && page["has_more"] == false {
                // One final read closes the race between the query snapshot and done.
                let final_page = h.messages(&bob, chat, cursor, 100).await;
                received.extend(
                    final_page["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|item| item["seq"].as_i64().unwrap()),
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
        received
    };
    let (sent, received) = tokio::join!(sending, receiving);
    for (status, body) in sent {
        assert_eq!(status, StatusCode::CREATED, "{body}");
    }
    assert_eq!(received, (1..=20).collect::<Vec<_>>());

    let same_key = Uuid::new_v4();
    let repeated = futures_util::future::join_all((0..8).map(|_| {
        let harness = &h;
        let account = &alice;
        let path = messages_path(chat);
        async move {
            harness
                .request(
                    "POST",
                    &path,
                    Some(&account.token),
                    Some(message_request(same_key, "same-key race", None)),
                )
                .await
        }
    }))
    .await;
    assert_eq!(
        repeated
            .iter()
            .filter(|(status, _)| *status == StatusCode::CREATED)
            .count(),
        1
    );
    assert!(
        repeated
            .iter()
            .all(|(status, _)| [StatusCode::CREATED, StatusCode::OK].contains(status))
    );
    let ids: HashSet<_> = repeated
        .iter()
        .map(|(_, body)| body["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 1);
    assert_eq!(
        h.messages(&bob, chat, 20, 100).await["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    h.finish().await;
}
