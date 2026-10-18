use std::{env, net::SocketAddr};

use axum::http::HeaderValue;
use tracing_subscriber::EnvFilter;
use xiaoq_backend::{AppState, app, connect_and_migrate, identity};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("xiaoq_backend=info")),
        )
        .init();
    let database_url = env::var("DATABASE_URL").map_err(
        |_| "DATABASE_URL must point to a PostgreSQL database; no in-memory fallback is supported.",
    )?;
    let bind: SocketAddr = env::var("Q_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8787".into())
        .parse()?;
    let origins = env::var("Q_CORS_ORIGINS")
        .unwrap_or_else(|_| "http://localhost:8081,http://127.0.0.1:8081".into())
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::parse::<HeaderValue>)
        .collect::<Result<Vec<_>, _>>()?;
    let pool = connect_and_migrate(&database_url).await?;
    let state = AppState::new(pool.clone())
        .await
        .map_err(|e| format!("Initialization failed: {}", e.code))?;
    if env::var("Q_SEED_DEMO").as_deref() == Ok("true") {
        identity::seed_demo(&state)
            .await
            .map_err(|e| format!("Demo seed failed: {}", e.code))?;
        tracing::info!("explicit local demo seed enabled; existing accounts are preserved");
    }
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(%bind, mode = "demo", "小Q API listening");
    axum::serve(
        listener,
        app(state, origins).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    pool.close().await;
    Ok(())
}
