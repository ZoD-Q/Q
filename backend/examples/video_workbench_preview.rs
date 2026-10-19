//! Explicit local UI fixture; never contacts Kling or produces a generated video.
#[cfg(not(feature = "video-test-fixtures"))]
fn main() {
    eprintln!("Enable --features video-test-fixtures for this local-only preview.");
}

#[cfg(feature = "video-test-fixtures")]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use axum::{
        Json, Router,
        extract::{Path, State},
        routing::{get, post},
    };
    use serde_json::{Value, json};
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };
    use xiaoq_backend::{AppState, app, connect_and_migrate, identity, video::VideoRuntime};
    type Tasks = Arc<Mutex<HashMap<String, (String, usize)>>>;
    async fn submit(State(tasks): State<Tasks>, Json(body): Json<Value>) -> Json<Value> {
        let id = body["external_task_id"]
            .as_str()
            .unwrap_or("invalid")
            .to_owned();
        tasks.lock().unwrap().insert(
            id.clone(),
            (body["prompt"].as_str().unwrap_or_default().to_owned(), 0),
        );
        Json(json!({"code":0,"data":{"task_id":id,"task_status":"submitted"}}))
    }
    async fn poll(State(tasks): State<Tasks>, Path(id): Path<String>) -> Json<Value> {
        let mut tasks = tasks.lock().unwrap();
        let Some((prompt, count)) = tasks.get_mut(&id) else {
            return Json(json!({"code":1201,"message":"Fixture task not found"}));
        };
        *count += 1;
        let state = if *count < 2 {
            "processing"
        } else if prompt.contains("fail") {
            "failed"
        } else {
            "succeed"
        };
        // Empty video output deliberately exercises the honest 'no playable result' state.
        Json(
            json!({"code":0,"data":{"task_id":id,"task_status":state,"task_result":{"videos":[]}}}),
        )
    }
    let database = std::env::var("DATABASE_URL")?;
    let parsed = reqwest::Url::parse(&database)?;
    if parsed.path() != "/xiaoq_video_preview"
        || parsed.host_str() != Some("127.0.0.1")
        || !matches!(parsed.scheme(), "postgres" | "postgresql")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Preview requires the dedicated loopback xiaoq_video_preview database".into());
    }
    let runtime = VideoRuntime::from_env()?.ok_or("Set a local Q_VIDEO_ENCRYPTION_KEY")?;
    let vendor = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}/", vendor.local_addr()?);
    let routes = Router::new()
        .route("/v1/videos/text2video", post(submit))
        .route("/v1/videos/text2video/{id}", get(poll))
        .with_state(Tasks::default());
    let vendor_task = tokio::spawn(async move { axum::serve(vendor, routes).await });
    let pool = connect_and_migrate(&database).await?;
    let mut state = AppState::new(pool.clone()).await.map_err(|e| e.code)?;
    state.video = Some(Arc::new(runtime.with_test_fixture(origin.parse()?)?));
    identity::seed_demo(&state).await.map_err(|e| e.code)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8792").await?;
    eprintln!(
        "LOCAL FIXTURE http://127.0.0.1:8792: no Kling calls, no real generated video; use a placeholder API key only."
    );
    axum::serve(
        listener,
        app(
            state,
            vec![
                "http://localhost:8092".parse()?,
                "http://127.0.0.1:8092".parse()?,
            ],
        )
        .into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    vendor_task.abort();
    pool.close().await;
    Ok(())
}
