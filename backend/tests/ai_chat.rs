//! Real PostgreSQL auth + loopback-only provider stub. Never loads a provider environment key.
#![cfg(feature = "ai-test-fixtures")]
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tower::ServiceExt;
use uuid::Uuid;
use xiaoq_backend::{AppState, ai::AiRuntime, app};

struct Harness {
    state: AppState,
    admin: PgPool,
    schema: String,
    calls: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<Value>>>,
    server: tokio::task::JoinHandle<()>,
}
impl Harness {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL")
            .expect("TEST_DATABASE_URL must point to the dedicated PostgreSQL test database");
        let admin = PgPool::connect(&url).await.unwrap();
        let schema = format!("q_ai_test_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let search_path = format!("SET search_path TO {schema}");
        let pool = PgPoolOptions::new()
            .max_connections(6)
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
        let calls = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (counter, captured) = (calls.clone(), requests.clone());
        let upstream = Router::new().route("/chat", post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let (counter, captured) = (counter.clone(), captured.clone());
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                assert_eq!(headers["authorization"], "Bearer q-ai-test-fixture-only");
                captured.lock().unwrap().push(body);
                ([("content-type", "text/event-stream")], "data: {\"choices\":[{\"delta\":{\"content\":\"Fixture answer\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2,\"total_tokens\":3}}\n\ndata: [DONE]\n\n").into_response()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/chat", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, upstream).await.unwrap();
        });
        let mut state = AppState::new(pool).await.unwrap();
        assert!(
            state.ai.is_none(),
            "AppState::new must never auto-load provider credentials"
        );
        state.ai = Some(Arc::new(
            AiRuntime::test_fixture(endpoint, Duration::from_secs(5), Duration::from_secs(2))
                .unwrap(),
        ));
        Self {
            state,
            admin,
            schema,
            calls,
            requests,
            server,
        }
    }
    fn router(&self) -> Router {
        app(
            self.state.clone(),
            vec!["http://localhost:8081".parse().unwrap()],
        )
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Response {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        if body.is_some() {
            request = request.header("content-type", "application/json");
        }
        self.router()
            .oneshot(
                request
                    .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    async fn register(&self, handle: &str) -> String {
        let response = self
            .request(
                "POST",
                "/v1/auth/register",
                None,
                Some(json!({"handle":handle,"password":"LocalQaPassword!","display_name":handle})),
            )
            .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        read_json(response).await["token"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    async fn finish(self) {
        self.server.abort();
        self.state.pool.close().await;
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
    }
}
async fn read_json(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await.unwrap()).unwrap()
}
fn request_body(content: &str) -> Value {
    json!({"model":"deepseek-flash","thinking":false,"messages":[{"role":"user","content":content}]})
}

#[tokio::test]
#[ignore = "requires a dedicated TEST_DATABASE_URL; only contacts a loopback fixture"]
async fn authenticated_streaming_is_isolated_and_status_exposes_only_public_metadata() {
    let mut h = Harness::new().await;
    let status = read_json(h.request("GET", "/v1/ai/status", None, None).await).await;
    assert_eq!(
        status,
        json!({"configured":true,"models":[{"id":"deepseek-flash","name":"DeepSeek Flash"},{"id":"deepseek-v4-pro","name":"DeepSeek Pro"}]})
    );
    let anonymous = h
        .request("POST", "/v1/ai/chat", None, Some(request_body("anonymous")))
        .await;
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    let alice = h.register("ai_alice").await;
    let bob = h.register("ai_bob").await;
    for (token, prompt) in [
        (&alice, "Only Alice supplied this"),
        (&bob, "Only Bob supplied this"),
    ] {
        let response = h
            .request(
                "POST",
                "/v1/ai/chat",
                Some(token),
                Some(request_body(prompt)),
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
        let wire = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(wire.contains("event: delta"));
        assert!(wire.contains("event: done"));
        assert!(!wire.contains(token));
    }
    let captured = h.requests.lock().unwrap().clone();
    assert_eq!(captured.len(), 2);
    assert_eq!(captured[0]["messages"].as_array().unwrap().len(), 2);
    assert_eq!(
        captured[0]["messages"][1]["content"],
        "Only Alice supplied this"
    );
    assert_eq!(
        captured[1]["messages"][1]["content"],
        "Only Bob supplied this"
    );
    assert!(
        captured
            .iter()
            .all(|request| request.get("user_id").is_none())
    );
    let ledger_before: i64 = sqlx::query_scalar("SELECT count(*) FROM ledger_entries")
        .fetch_one(&h.state.pool)
        .await
        .unwrap();
    assert_eq!(
        ledger_before, 4,
        "chat must never debit or mutate the demo ledger"
    );
    let logout = h
        .request("POST", "/v1/auth/logout", Some(&alice), None)
        .await;
    assert_eq!(logout.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        h.request(
            "POST",
            "/v1/ai/chat",
            Some(&alice),
            Some(request_body("revoked"))
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 2);
    h.state.ai = None;
    let disabled = h
        .request(
            "POST",
            "/v1/ai/chat",
            Some(&bob),
            Some(request_body("disabled")),
        )
        .await;
    assert_eq!(disabled.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        read_json(disabled).await["error"]["code"],
        "AI_NOT_CONFIGURED"
    );
    let status = read_json(h.request("GET", "/v1/ai/status", None, None).await).await;
    assert_eq!(status["configured"], false);
    assert_eq!(status.as_object().unwrap().len(), 2);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires a dedicated TEST_DATABASE_URL; only contacts a loopback fixture"]
async fn invalid_requests_are_rejected_before_provider_and_ai_has_its_own_body_limit() {
    let h = Harness::new().await;
    let token = h.register("ai_validation").await;
    for invalid in [
        json!({"model":"deepseek-chat","thinking":false,"messages":[{"role":"user","content":"x"}]}),
        json!({"model":"deepseek-flash","thinking":false,"messages":[{"role":"system","content":"x"}]}),
        json!({"model":"deepseek-flash","thinking":false,"messages":[{"role":"user","content":"x"}],"user_id":Uuid::new_v4()}),
        request_body(&"x".repeat(12_001)),
        request_body(&"x".repeat(130 * 1024)),
    ] {
        let response = h
            .request("POST", "/v1/ai/chat", Some(&token), Some(invalid))
            .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            read_json(response).await["error"]["code"],
            "VALIDATION_ERROR"
        );
    }
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    let large_valid = json!({"model":"deepseek-v4-pro","thinking":true,"messages":[{"role":"user","content":"🙂".repeat(12_000)},{"role":"user","content":"好".repeat(12_000)}]});
    let response = h
        .request("POST", "/v1/ai/chat", Some(&token), Some(large_valid))
        .await;
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "AI route must accept its 128 KiB limit instead of the legacy 16 KiB default"
    );
    let wire = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    assert!(String::from_utf8_lossy(&wire).contains("event: done"));
    let captured = h.requests.lock().unwrap().clone();
    assert_eq!(captured[0]["model"], "deepseek-v4-pro");
    assert_eq!(captured[0]["thinking"]["type"], "enabled");
    assert_eq!(captured[0]["max_tokens"], 8192);
    h.finish().await;
}
