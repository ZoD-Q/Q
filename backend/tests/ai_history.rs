//! Isolated PostgreSQL persistence, replay and account isolation checks.
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    response::Response,
};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower::ServiceExt;
use uuid::Uuid;
use xiaoq_backend::{AppState, app};
struct Harness {
    state: AppState,
    admin: PgPool,
    schema: String,
}
impl Harness {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("dedicated test database required");
        let admin = PgPool::connect(&url).await.unwrap();
        let schema = format!("q_history_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let path = format!("SET search_path TO {schema}");
        let pool = PgPoolOptions::new()
            .max_connections(6)
            .after_connect(move |c, _| {
                let path = path.clone();
                Box::pin(async move {
                    sqlx::query(&path).execute(c).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        sqlx::migrate!().run(&pool).await.unwrap();
        let state = AppState::new(pool).await.unwrap();
        Self {
            state,
            admin,
            schema,
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
        let response = self
            .router()
            .oneshot(
                request
                    .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                    .unwrap(),
            )
            .await
            .unwrap();
        if path.starts_with("/v1/ai/conversations") {
            assert_eq!(response.headers()["cache-control"], "no-store");
        }
        response
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

fn snapshot(revision: i64) -> Value {
    json!({"request_id":Uuid::new_v4(),"expected_revision":revision,"title":"Saved","messages":[{"id":"message-1","role":"user","content":"persistent text","status":"complete"},{"id":"message-2","role":"assistant","content":"","status":"pending"}]})
}
#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn durable_history_is_owner_scoped_versioned_bounded_and_erased() {
    let h = Harness::new().await;
    let a = h.register("history_a").await;
    let b = h.register("history_b").await;
    let id = Uuid::new_v4();
    let path = format!("/v1/ai/conversations/{id}");
    let first = snapshot(0);
    for invalid in [
        "/v1/ai/conversations?cursor=invalid",
        "/v1/ai/conversations?limit=abc",
        "/v1/ai/conversations/invalid",
    ] {
        let response = h.request("GET", invalid, Some(&a), None).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            read_json(response).await["error"]["code"],
            "VALIDATION_ERROR"
        );
    }
    assert_eq!(
        h.request("POST", &path, None, Some(first.clone()))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let saved = read_json(
        h.request("POST", &path, Some(&a), Some(first.clone()))
            .await,
    )
    .await;
    assert_eq!(saved["revision"], 1);
    assert_eq!(
        read_json(
            h.request("POST", &path, Some(&a), Some(first.clone()))
                .await
        )
        .await,
        saved
    );
    assert_eq!(
        h.request("GET", &path, Some(&b), None).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        read_json(
            h.request("GET", "/v1/ai/conversations", Some(&b), None)
                .await
        )
        .await["items"],
        json!([])
    );
    let mut reused = first.clone();
    reused["title"] = json!("Changed");
    assert_eq!(
        h.request("POST", &path, Some(&a), Some(reused))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        h.request("POST", &path, Some(&a), Some(snapshot(0)))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let second = snapshot(1);
    assert_eq!(
        read_json(h.request("POST", &path, Some(&a), Some(second)).await).await["revision"],
        2
    );
    assert_eq!(
        h.request("POST", &path, Some(&a), Some(first))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let restored = read_json(h.request("GET", &path, Some(&a), None).await).await;
    assert_eq!(restored["messages"][0]["content"], "persistent text");
    assert_eq!(restored["messages"][1]["status"], "pending");
    let mut invalid = snapshot(2);
    invalid["messages"][0]["content"] = json!("x".repeat(1024 * 1024 + 1));
    assert_eq!(
        h.request("POST", &path, Some(&a), Some(invalid))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let id2 = Uuid::new_v4();
    assert_eq!(
        h.request(
            "POST",
            &format!("/v1/ai/conversations/{id2}"),
            Some(&a),
            Some(snapshot(0))
        )
        .await
        .status(),
        StatusCode::OK
    );
    let page = read_json(
        h.request("GET", "/v1/ai/conversations?limit=1", Some(&a), None)
            .await,
    )
    .await;
    assert_eq!(page["items"][0]["id"], id2.to_string());
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    let cursor = page["next_cursor"].as_str().unwrap();
    let next = read_json(
        h.request(
            "GET",
            &format!("/v1/ai/conversations?limit=1&cursor={cursor}"),
            Some(&a),
            None,
        )
        .await,
    )
    .await;
    assert_ne!(page["items"][0]["id"], next["items"][0]["id"]);
    assert!(next["next_cursor"].is_null());
    assert_eq!(
        h.request(
            "GET",
            &format!("/v1/ai/conversations?cursor={id2}"),
            Some(&b),
            None
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    // Editing an old conversation does not move its immutable pagination key.
    assert_eq!(
        h.request("POST", &path, Some(&a), Some(snapshot(2)))
            .await
            .status(),
        StatusCode::OK
    );
    let page = read_json(
        h.request("GET", "/v1/ai/conversations?limit=1", Some(&a), None)
            .await,
    )
    .await;
    assert_eq!(page["items"][0]["id"], id2.to_string());
    sqlx::query("UPDATE ai_conversations SET created_at='2026-10-21T00:00:00Z'")
        .execute(&h.state.pool)
        .await
        .unwrap();
    let page = read_json(
        h.request("GET", "/v1/ai/conversations?limit=1", Some(&a), None)
            .await,
    )
    .await;
    assert_eq!(page["items"][0]["id"], std::cmp::max(id, id2).to_string());
    let left = h.request("POST", &path, Some(&a), Some(snapshot(3)));
    let right = h.request("POST", &path, Some(&a), Some(snapshot(3)));
    let (left, right) = tokio::join!(left, right);
    let mut statuses = [left.status().as_u16(), right.status().as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    let recovery = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    let deleted=h.request("POST","/v1/account/deletions",Some(&a),Some(json!({"request_id":Uuid::new_v4(),"recovery_token":recovery,"password":"LocalQaPassword!","confirmation":"DELETE"}))).await;
    assert_eq!(deleted.status(), StatusCode::OK);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM ai_conversations")
        .fetch_one(&h.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    h.finish().await;
}
