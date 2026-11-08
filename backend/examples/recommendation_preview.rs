//! Native UI QA against an isolated database and a loopback-only model fixture.
//! This is not a provider-quality evaluation or a real financial integration.
#[cfg(not(feature = "ai-test-fixtures"))]
fn main() {
    eprintln!("Enable --features ai-test-fixtures for the local recommendation preview.");
}

#[cfg(feature = "ai-test-fixtures")]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use axum::{Json, Router, response::IntoResponse, routing::post};
    use serde_json::{Value, json};
    use sqlx::{PgPool, postgres::PgPoolOptions};
    use std::{sync::Arc, time::Duration};
    use xiaoq_backend::{AppState, ai::AiRuntime, app, identity};

    let database = std::env::var("TEST_DATABASE_URL")?;
    let parsed = reqwest::Url::parse(&database)?;
    if !matches!(parsed.scheme(), "postgres" | "postgresql")
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.path() != "/q_recommendations_preview"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "Preview requires dedicated loopback q_recommendations_preview database".into(),
        );
    }
    let fixture = Router::new().route("/chat", post(|Json(body): Json<Value>| async move {
        if body["stream"] == false {
            let input: Value = body["messages"][1]["content"].as_str()
                .and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default();
            let ids = input["candidates"].as_array().and_then(|items| items.first())
                .map_or_else(Vec::new, |item| vec![item["id"].clone()]);
            return Json(json!({"choices":[{"message":{"content":json!({"ids":ids}).to_string()}}],"usage":{"total_tokens":1}})).into_response();
        }
        let wire = format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            json!({"choices":[{"delta":{"content":"本地验收响应：你的问题已保留，可从下方入口继续。此内容来自测试替身，不是实际模型或金融服务。"},"finish_reason":null}]}),
            json!({"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}));
        ([("content-type","text/event-stream")],wire).into_response()
    }));
    let provider = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}/chat", provider.local_addr()?).parse()?;
    let task = tokio::spawn(async move { axum::serve(provider, fixture).await });
    // Each run gets its own schema; retain old QA data and never reset a database.
    let admin = PgPool::connect(&database).await?;
    let schema = std::env::var("Q_RECOMMENDATION_PREVIEW_SCHEMA")
        .unwrap_or_else(|_| format!("q_preview_{}", uuid::Uuid::new_v4().simple()));
    if schema.strip_prefix("q_preview_").is_none_or(|suffix| {
        suffix.len() != 32 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err("Preview schema must be q_preview_ followed by 32 hexadecimal digits".into());
    }
    sqlx::query(&format!("CREATE SCHEMA IF NOT EXISTS {schema}"))
        .execute(&admin)
        .await?;
    let search_path = format!("SET search_path TO {schema}");
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .after_connect(move |connection, _| {
            let search_path = search_path.clone();
            Box::pin(async move {
                sqlx::query(&search_path).execute(connection).await?;
                Ok(())
            })
        })
        .connect(&database)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    admin.close().await;
    let mut state = AppState::new(pool.clone())
        .await
        .map_err(|error| error.code)?;
    state.recommendations_enabled = true;
    state.ai = Some(Arc::new(AiRuntime::test_fixture(
        endpoint,
        Duration::from_secs(10),
        Duration::from_secs(3),
    )?));
    identity::seed_demo(&state)
        .await
        .map_err(|error| error.code)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8789").await?;
    eprintln!(
        "Recommendation UI fixture: http://127.0.0.1:8789 ; schema {schema} ; no real model or bank requests"
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
    task.abort();
    pool.close().await;
    Ok(())
}
