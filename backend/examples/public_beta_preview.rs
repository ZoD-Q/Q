//! Explicit loopback UI fixture. Uses a dedicated test database and never calls an AI provider.
#[cfg(not(feature = "ai-test-fixtures"))]
fn main() {
    eprintln!("Enable --features ai-test-fixtures for this local-only preview.");
}

#[cfg(feature = "ai-test-fixtures")]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use axum::{
        Json, Router,
        body::Body,
        extract::State,
        response::Response,
        routing::{get, post},
    };
    use std::{
        convert::Infallible,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };
    use xiaoq_backend::{AppState, ai::AiRuntime, app, connect_and_migrate, identity};

    async fn answer(State(calls): State<Arc<AtomicUsize>>) -> Response {
        calls.fetch_add(1, Ordering::SeqCst);
        let stream = async_stream::stream! {
            yield Ok::<_, Infallible>("data: {\"choices\":[{\"delta\":{\"content\":\"本地验收响应：\"},\"finish_reason\":null}]}\n\n");
            tokio::time::sleep(Duration::from_millis(400)).await;
            yield Ok::<_, Infallible>("data: {\"choices\":[{\"delta\":{\"content\":\"消息已收到。此响应来自测试替身，不是 DeepSeek。\"},\"finish_reason\":null}]}\n\n");
            yield Ok::<_, Infallible>("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\ndata: [DONE]\n\n");
        };
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(stream))
            .unwrap()
    }
    let database = std::env::var("DATABASE_URL")?;
    let parsed = reqwest::Url::parse(&database)?;
    if !matches!(parsed.scheme(), "postgres" | "postgresql")
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.path() != "/xiaoq_public_beta_preview"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "Preview requires dedicated loopback xiaoq_public_beta_preview database".into(),
        );
    }
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let provider_origin = format!("http://{}", provider.local_addr()?);
    let fixture = Router::new()
        .route("/chat", post(answer))
        .route(
            "/calls",
            get(|State(calls): State<Arc<AtomicUsize>>| async move {
                Json(serde_json::json!({"calls": calls.load(Ordering::SeqCst)}))
            }),
        )
        .with_state(calls);
    let provider_task = tokio::spawn(async move { axum::serve(provider, fixture).await });
    let pool = connect_and_migrate(&database).await?;
    let mut state = AppState::new(pool.clone()).await.map_err(|e| e.code)?;
    state.ai = Some(Arc::new(AiRuntime::test_fixture(
        format!("{provider_origin}/chat").parse()?,
        Duration::from_secs(10),
        Duration::from_secs(3),
    )?));
    identity::seed_demo(&state).await.map_err(|e| e.code)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    eprintln!(
        "LOCAL PUBLIC-BETA FIXTURE http://{} ; metrics {provider_origin}/calls ; no provider calls",
        listener.local_addr()?
    );
    let cleanup = xiaoq_backend::social::spawn_cleanup(pool.clone());
    axum::serve(
        listener,
        app(
            state,
            vec![
                "http://localhost:8768".parse()?,
                "http://127.0.0.1:8768".parse()?,
            ],
        )
        .into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    cleanup.abort();
    provider_task.abort();
    pool.close().await;
    Ok(())
}
