//! Real PostgreSQL plus an explicit loopback Kling fixture. No paid vendor calls.
#![cfg(feature = "video-test-fixtures")]

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Path, State},
    http::{HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::Notify;
use tower::ServiceExt;
use uuid::Uuid;
use xiaoq_backend::{AppState, app, video::VideoRuntime};

#[derive(Default)]
struct Vendor {
    posts: AtomicUsize,
    polls: AtomicUsize,
    trapped: AtomicUsize,
    tasks: Mutex<HashMap<String, String>>,
    rejection_started: Notify,
    release_rejection: Notify,
    next_poll: Mutex<Option<Value>>,
    hold_next_poll: AtomicBool,
    held_poll_started: Notify,
    release_held_poll: Notify,
}
async fn submit(
    State(vendor): State<Arc<Vendor>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    vendor.posts.fetch_add(1, Ordering::SeqCst);
    assert_eq!(headers["authorization"], "Bearer fixture-secret-api-key");
    assert_eq!(body["model_name"], "kling-v2-6");
    assert_eq!(body["mode"], "pro");
    assert_eq!(body["sound"], "off");
    assert!(body.get("callback_url").is_none());
    let external = body["external_task_id"].as_str().unwrap().to_owned();
    Uuid::parse_str(&external).unwrap();
    let prompt = body["prompt"].as_str().unwrap();
    if prompt == "delayed reject" {
        vendor.rejection_started.notify_one();
        vendor.release_rejection.notified().await;
        return (StatusCode::BAD_REQUEST, Json(json!({"code":1200}))).into_response();
    }
    if prompt == "reject" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"code":123,"message":"supplier secret details"})),
        )
            .into_response();
    }
    if prompt == "redirect" {
        return (StatusCode::TEMPORARY_REDIRECT, [("location", "/trapped")]).into_response();
    }
    let task_id = format!("vendor-{}", Uuid::new_v4());
    vendor
        .tasks
        .lock()
        .unwrap()
        .insert(external, task_id.clone());
    if prompt == "missing result" {
        return Json(json!({"code":0,"data":{"task_id":task_id,"task_status":"succeed"}}))
            .into_response();
    }
    if prompt == "unsupported result" {
        return Json(json!({"code":0,"data":{"task_id":task_id,"task_status":"succeed","task_result":{"videos":[{"url":"https://untrusted.example/video.mp4"}]}}})).into_response();
    }
    if prompt == "unknown" {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    if prompt == "oversized" {
        return (StatusCode::OK, "x".repeat(300_000)).into_response();
    }
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    Json(json!({"code":0,"data":{"task_id":task_id,"task_status":"submitted"}})).into_response()
}
async fn poll(
    State(vendor): State<Arc<Vendor>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let revision = vendor.polls.fetch_add(1, Ordering::SeqCst) + 1;
    assert_eq!(headers["authorization"], "Bearer fixture-secret-api-key");
    let response = {
        if let Some(response) = vendor.next_poll.lock().unwrap().take() {
            Json(response).into_response()
        } else {
            let tasks = vendor.tasks.lock().unwrap();
            let task = tasks
                .get(&id)
                .or_else(|| tasks.values().find(|task| *task == &id));
            match task {
                Some(task_id) => Json(json!({"code":0,"data":{"task_id":task_id,"task_status":"succeed","task_result":{"videos":[{"url":format!("https://v1.klingai.com/generated.mp4?signature=fixture-{revision}")}]}}})).into_response(),
                None => StatusCode::NOT_FOUND.into_response(),
            }
        }
    };
    if vendor.hold_next_poll.swap(false, Ordering::SeqCst) {
        vendor.held_poll_started.notify_one();
        vendor.release_held_poll.notified().await;
    }
    response
}
async fn trapped(State(vendor): State<Arc<Vendor>>) -> StatusCode {
    vendor.trapped.fetch_add(1, Ordering::SeqCst);
    StatusCode::OK
}

struct Harness {
    router: Router,
    state: AppState,
    admin: PgPool,
    schema: String,
    vendor: Arc<Vendor>,
    server: tokio::task::JoinHandle<()>,
}
impl Harness {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL")
            .expect("TEST_DATABASE_URL must identify the dedicated PostgreSQL test database");
        let admin = PgPool::connect(&url).await.unwrap();
        let schema = format!("q_video_test_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let search_path = format!("SET search_path TO {schema}");
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .after_connect(move |conn, _| {
                let search_path = search_path.clone();
                Box::pin(async move {
                    sqlx::query(&search_path).execute(conn).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        sqlx::migrate!().run(&pool).await.unwrap();
        let vendor = Arc::new(Vendor::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let vendor_router = Router::new()
            .route("/v1/videos/text2video", post(submit))
            .route("/v1/videos/text2video/{id}", get(poll))
            .route("/trapped", post(trapped).get(trapped))
            .with_state(vendor.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, vendor_router).await.unwrap();
        });
        let runtime = VideoRuntime::new([7; 32])
            .unwrap()
            .with_test_fixture(format!("http://{address}/").parse().unwrap())
            .unwrap();
        let mut state = AppState::new(pool).await.unwrap();
        state.video = Some(Arc::new(runtime));
        let router = app(
            state.clone(),
            vec!["http://localhost:8081".parse().unwrap()],
        );
        Self {
            router,
            state,
            admin,
            schema,
            vendor,
            server,
        }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        send(&self.router, method, path, token, body).await
    }
    async fn register(&self, handle: &str) -> (String, Uuid) {
        let (status, body) = self
            .request(
                "POST",
                "/v1/auth/register",
                None,
                Some(json!({"handle":handle,"password":"TestPassword123!","display_name":handle})),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        (
            body["token"].as_str().unwrap().to_owned(),
            Uuid::parse_str(body["user"]["id"].as_str().unwrap()).unwrap(),
        )
    }
    async fn connection(&self, token: &str) -> Uuid {
        let (status, body) = self
            .request(
                "POST",
                "/v1/video/connections",
                Some(token),
                Some(
                    json!({"name":"My Kling","region":"global","api_key":"fixture-secret-api-key"}),
                ),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert!(body.get("api_key").is_none());
        assert!(!body.to_string().contains("fixture-secret"));
        Uuid::parse_str(body["id"].as_str().unwrap()).unwrap()
    }
    async fn allow_poll(&self, id: &str) {
        sqlx::query("UPDATE video_jobs SET last_poll_at=now()-interval '4 seconds' WHERE id=$1")
            .bind(Uuid::parse_str(id).unwrap())
            .execute(&self.state.pool)
            .await
            .unwrap();
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
async fn send(
    router: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    if body.is_some() {
        req = req.header("Content-Type", "application/json");
    }
    let response = router
        .clone()
        .oneshot(
            req.body(body.map_or_else(Body::empty, |v| Body::from(v.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    (
        status,
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        },
    )
}
fn job_body(connection: Uuid, key: Uuid, prompt: &str) -> Value {
    json!({"connection_id":connection,"idempotency_key":key,"prompt":prompt,"model_name":"kling-v2-6","mode":"pro","duration":"5","aspect_ratio":"16:9"})
}

#[tokio::test]
#[ignore = "requires a dedicated TEST_DATABASE_URL; uses only a loopback provider fixture"]
async fn video_connection_job_recovery_isolation_and_revocation() {
    let h = Harness::new().await;
    assert_eq!(
        h.request("GET", "/v1/video/connections", None, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (alice, alice_id) = h.register("alice").await;
    let (bob, _) = h.register("bob").await;
    let connection = h.connection(&alice).await;
    let encrypted: Vec<u8> =
        sqlx::query_scalar("SELECT encrypted_credentials FROM video_connections WHERE id=$1")
            .bind(connection)
            .fetch_one(&h.state.pool)
            .await
            .unwrap();
    assert!(
        !encrypted
            .windows(b"fixture-secret-api-key".len())
            .any(|b| b == b"fixture-secret-api-key")
    );
    let (_, list) = h
        .request("GET", "/v1/video/connections", Some(&bob), None)
        .await;
    assert_eq!(list["items"], json!([]));
    assert_eq!(
        h.request(
            "DELETE",
            &format!("/v1/video/connections/{connection}"),
            Some(&bob),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.request(
            "POST",
            "/v1/video/jobs",
            Some(&bob),
            Some(job_body(connection, Uuid::new_v4(), "safe"))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let key = Uuid::new_v4();
    let body = job_body(connection, key, "safe");
    let (a, b, c) = tokio::join!(
        h.request("POST", "/v1/video/jobs", Some(&alice), Some(body.clone())),
        h.request("POST", "/v1/video/jobs", Some(&alice), Some(body.clone())),
        h.request("POST", "/v1/video/jobs", Some(&alice), Some(body.clone()))
    );
    for response in [&a, &b, &c] {
        assert!(
            matches!(response.0, StatusCode::OK | StatusCode::ACCEPTED),
            "{response:?}"
        );
        assert_eq!(response.1["id"], a.1["id"]);
    }
    assert_eq!(h.vendor.posts.load(Ordering::SeqCst), 1);
    let id = a.1["id"].as_str().unwrap();
    assert_eq!(
        h.request("GET", &format!("/v1/video/jobs/{id}"), Some(&bob), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.request(
            "POST",
            "/v1/video/jobs",
            Some(&alice),
            Some(job_body(connection, key, "changed"))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, immediate) = h
        .request("GET", &format!("/v1/video/jobs/{id}"), Some(&alice), None)
        .await;
    assert_eq!(immediate["status"], "submitted");
    assert_eq!(h.vendor.polls.load(Ordering::SeqCst), 0);
    h.allow_poll(id).await;
    let (_, done) = h
        .request("GET", &format!("/v1/video/jobs/{id}"), Some(&alice), None)
        .await;
    assert_eq!(done["status"], "succeeded");
    assert!(done["video_url"].as_str().unwrap().starts_with("https://"));
    assert!(!done.to_string().contains("fixture-secret"));

    // Unknown writes recover by external_task_id even after re-creating application state.
    let unknown_key = Uuid::new_v4();
    let unknown_body = job_body(connection, unknown_key, "unknown");
    let (_, unknown) = h
        .request(
            "POST",
            "/v1/video/jobs",
            Some(&alice),
            Some(unknown_body.clone()),
        )
        .await;
    assert_eq!(unknown["status"], "unknown");
    assert_eq!(unknown["error_code"], "VIDEO_SUBMISSION_UNKNOWN");
    assert!(unknown["provider_task_id"].is_null());
    let unknown_id = unknown["id"].as_str().unwrap();
    h.allow_poll(unknown_id).await;
    let mut restarted = AppState::new(h.state.pool.clone()).await.unwrap();
    restarted.video = h.state.video.clone();
    let restarted = app(restarted, vec![]);
    let (_, recovered) = send(
        &restarted,
        "GET",
        &format!("/v1/video/jobs/{unknown_id}"),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(recovered["status"], "succeeded");
    let posts = h.vendor.posts.load(Ordering::SeqCst);
    let (_, replay) = send(
        &restarted,
        "POST",
        "/v1/video/jobs",
        Some(&alice),
        Some(unknown_body),
    )
    .await;
    assert_eq!(replay["id"], unknown["id"]);
    assert_eq!(h.vendor.posts.load(Ordering::SeqCst), posts);
    for (prompt, code) in [
        ("missing result", "VIDEO_RESULT_UNAVAILABLE"),
        ("unsupported result", "VIDEO_RESULT_URL_UNSUPPORTED"),
    ] {
        let (_, result) = h
            .request(
                "POST",
                "/v1/video/jobs",
                Some(&alice),
                Some(job_body(connection, Uuid::new_v4(), prompt)),
            )
            .await;
        assert_eq!(result["status"], "succeeded");
        assert!(result["video_url"].is_null());
        assert_eq!(result["error_code"], code);
        let result_id = result["id"].as_str().unwrap();
        h.allow_poll(result_id).await;
        let posts = h.vendor.posts.load(Ordering::SeqCst);
        let (_, repaired) = h
            .request(
                "GET",
                &format!("/v1/video/jobs/{result_id}"),
                Some(&alice),
                None,
            )
            .await;
        assert_eq!(repaired["status"], "succeeded");
        assert!(repaired["video_url"].is_string());
        assert!(repaired["error_code"].is_null());
        assert_eq!(h.vendor.posts.load(Ordering::SeqCst), posts);
    }
    for prompt in ["redirect", "oversized"] {
        let (_, job) = h
            .request(
                "POST",
                "/v1/video/jobs",
                Some(&alice),
                Some(job_body(connection, Uuid::new_v4(), prompt)),
            )
            .await;
        assert_eq!(job["status"], "unknown", "{job}");
    }
    assert_eq!(h.vendor.trapped.load(Ordering::SeqCst), 0);
    let (_, rejected) = h
        .request(
            "POST",
            "/v1/video/jobs",
            Some(&alice),
            Some(job_body(connection, Uuid::new_v4(), "reject")),
        )
        .await;
    assert_eq!(rejected["status"], "failed");
    assert_eq!(rejected["error_code"], "VIDEO_PROVIDER_REJECTED");
    assert!(!rejected.to_string().contains("supplier secret"));

    let (_, pending) = h
        .request(
            "POST",
            "/v1/video/jobs",
            Some(&alice),
            Some(job_body(connection, Uuid::new_v4(), "pending")),
        )
        .await;
    let pending_id = pending["id"].as_str().unwrap();
    h.allow_poll(pending_id).await;
    assert_eq!(
        h.request(
            "DELETE",
            &format!("/v1/video/connections/{connection}"),
            Some(&alice),
            None
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let erased: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT encrypted_credentials FROM video_connections WHERE id=$1 AND user_id=$2",
    )
    .bind(connection)
    .bind(alice_id)
    .fetch_one(&h.state.pool)
    .await
    .unwrap();
    assert!(erased.is_none());
    let polls = h.vendor.polls.load(Ordering::SeqCst);
    let (_, preserved) = h
        .request(
            "GET",
            &format!("/v1/video/jobs/{pending_id}"),
            Some(&alice),
            None,
        )
        .await;
    assert_eq!(preserved["status"], "submitted");
    assert_eq!(h.vendor.polls.load(Ordering::SeqCst), polls);
    let (status, error) = h
        .request(
            "POST",
            "/v1/video/jobs",
            Some(&alice),
            Some(job_body(connection, Uuid::new_v4(), "after revoke")),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "VIDEO_CONNECTION_REVOKED");
    let (_, history) = h.request("GET", "/v1/video/jobs", Some(&alice), None).await;
    assert_eq!(history["items"].as_array().unwrap().len(), 8);
    let (_, empty) = h.request("GET", "/v1/video/jobs", Some(&bob), None).await;
    assert_eq!(empty["items"], json!([]));
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires a dedicated TEST_DATABASE_URL; never contacts a real provider"]
async fn missing_configuration_fails_closed_and_old_contract_fields_rejected() {
    let h = Harness::new().await;
    let (alice, _) = h.register("alice").await;
    let disabled = app(AppState::new(h.state.pool.clone()).await.unwrap(), vec![]);
    let (status, body) = send(
        &disabled,
        "POST",
        "/v1/video/connections",
        Some(&alice),
        Some(json!({"name":"Kling","region":"global","api_key":"secret"})),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "VIDEO_UNAVAILABLE");
    assert_eq!(h.vendor.posts.load(Ordering::SeqCst), 0);
    assert_eq!(h.request("POST","/v1/video/connections",Some(&alice),Some(json!({"name":"Kling","region":"global","api_key":"secret","endpoint":"http://127.0.0.1/"}))).await.0,StatusCode::BAD_REQUEST);
    assert!(
        VideoRuntime::new([7; 32])
            .unwrap()
            .with_test_fixture("http://example.com/".parse().unwrap())
            .is_err()
    );
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires a dedicated TEST_DATABASE_URL; uses only a coordinated loopback fixture"]
async fn definitive_submission_rejection_resolves_an_early_unknown_lookup() {
    let h = Harness::new().await;
    let (alice, _) = h.register("alice").await;
    let connection = h.connection(&alice).await;
    let router = h.router.clone();
    let owner = alice.clone();
    let body = job_body(connection, Uuid::new_v4(), "delayed reject");
    let submission = tokio::spawn(async move {
        send(&router, "POST", "/v1/video/jobs", Some(&owner), Some(body)).await
    });
    h.vendor.rejection_started.notified().await;
    let (_, history) = h.request("GET", "/v1/video/jobs", Some(&alice), None).await;
    let id = history["items"][0]["id"].as_str().unwrap();
    // Simulates the production 15s request remaining in flight beyond the 3s poll interval.
    h.allow_poll(id).await;
    let (_, early) = h
        .request("GET", &format!("/v1/video/jobs/{id}"), Some(&alice), None)
        .await;
    h.vendor.release_rejection.notify_one();
    let (_, final_job) = submission.await.unwrap();
    let posts = h.vendor.posts.load(Ordering::SeqCst);
    h.finish().await;
    assert_eq!(early["status"], "unknown");
    assert_eq!(
        final_job["status"], "failed",
        "A definitive rejection must resolve the prior missing lookup: {final_job}"
    );
    assert_eq!(final_job["error_code"], "VIDEO_PROVIDER_REJECTED");
    assert_eq!(posts, 1);
}

#[tokio::test]
#[ignore = "requires a dedicated TEST_DATABASE_URL; never fetches the fixture media URL"]
async fn completed_job_refreshes_signed_media_without_creating_another_task() {
    let h = Harness::new().await;
    let (alice, _) = h.register("alice").await;
    let connection = h.connection(&alice).await;
    let (_, created) = h
        .request(
            "POST",
            "/v1/video/jobs",
            Some(&alice),
            Some(job_body(connection, Uuid::new_v4(), "safe")),
        )
        .await;
    let id = created["id"].as_str().unwrap();
    h.allow_poll(id).await;
    let (_, first) = h
        .request("GET", &format!("/v1/video/jobs/{id}"), Some(&alice), None)
        .await;
    h.allow_poll(id).await;
    let (_, refreshed) = h
        .request("GET", &format!("/v1/video/jobs/{id}"), Some(&alice), None)
        .await;
    let provider_id = refreshed["provider_task_id"].as_str().unwrap();
    *h.vendor.next_poll.lock().unwrap() = Some(
        json!({"code":0,"data":{"task_id":provider_id,"task_status":"succeed","task_result":{"videos":[{"url":"https://untrusted.example/video.mp4"}]}}}),
    );
    h.allow_poll(id).await;
    let (_, unsafe_result) = h
        .request("GET", &format!("/v1/video/jobs/{id}"), Some(&alice), None)
        .await;
    *h.vendor.next_poll.lock().unwrap() =
        Some(json!({"code":0,"data":{"task_id":provider_id,"task_status":"processing"}}));
    h.allow_poll(id).await;
    let (_, stale_result) = h
        .request("GET", &format!("/v1/video/jobs/{id}"), Some(&alice), None)
        .await;
    *h.vendor.next_poll.lock().unwrap() = Some(json!({"invalid_response":true}));
    h.allow_poll(id).await;
    let (_, unavailable) = h
        .request("GET", &format!("/v1/video/jobs/{id}"), Some(&alice), None)
        .await;
    let posts = h.vendor.posts.load(Ordering::SeqCst);
    let polls = h.vendor.polls.load(Ordering::SeqCst);
    h.finish().await;
    assert_eq!(first["status"], "succeeded");
    assert_eq!(refreshed["status"], "succeeded");
    assert_ne!(
        first["video_url"], refreshed["video_url"],
        "An explicit refresh must replace an expired signed URL"
    );
    assert_eq!(unsafe_result["video_url"], refreshed["video_url"]);
    assert_eq!(unsafe_result["error_code"], "VIDEO_RESULT_URL_UNSUPPORTED");
    assert_eq!(stale_result["status"], "succeeded");
    assert_eq!(stale_result["video_url"], refreshed["video_url"]);
    assert_eq!(unavailable["status"], "succeeded");
    assert_eq!(unavailable["video_url"], refreshed["video_url"]);
    assert_eq!(unavailable["error_code"], "VIDEO_POLL_UNAVAILABLE");
    assert_eq!(polls, 5);
    assert_eq!(posts, 1);
}

#[tokio::test]
#[ignore = "requires a dedicated TEST_DATABASE_URL; uses only coordinated loopback reads"]
async fn delayed_poll_cannot_overwrite_a_more_recent_signed_url() {
    let h = Harness::new().await;
    let (alice, _) = h.register("alice").await;
    let connection = h.connection(&alice).await;
    let (_, created) = h
        .request(
            "POST",
            "/v1/video/jobs",
            Some(&alice),
            Some(job_body(connection, Uuid::new_v4(), "safe")),
        )
        .await;
    let id = created["id"].as_str().unwrap();
    let path = format!("/v1/video/jobs/{id}");
    h.allow_poll(id).await;
    h.request("GET", &path, Some(&alice), None).await;
    h.allow_poll(id).await;
    h.vendor.hold_next_poll.store(true, Ordering::SeqCst);
    let router = h.router.clone();
    let owner = alice.clone();
    let pending_path = path.clone();
    let earlier =
        tokio::spawn(async move { send(&router, "GET", &pending_path, Some(&owner), None).await });
    h.vendor.held_poll_started.notified().await;
    h.allow_poll(id).await;
    let (_, newest) = h.request("GET", &path, Some(&alice), None).await;
    h.vendor.release_held_poll.notify_one();
    let (_, delayed) = earlier.await.unwrap();
    let (_, stored) = h.request("GET", &path, Some(&alice), None).await;
    let posts = h.vendor.posts.load(Ordering::SeqCst);
    h.finish().await;
    assert_eq!(
        stored["video_url"], newest["video_url"],
        "A late response must not restore an older signed URL"
    );
    assert_eq!(delayed["video_url"], newest["video_url"]);
    assert_eq!(stored["status"], "succeeded");
    assert_eq!(posts, 1);
}
