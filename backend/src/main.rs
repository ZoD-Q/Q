use std::{env, net::SocketAddr, sync::Arc};

use axum::http::HeaderValue;
use tracing_subscriber::EnvFilter;
use xiaoq_backend::{
    AppState, ai::AiRuntime, app, connect_and_migrate, identity, plugins::PluginRuntime,
    video::VideoRuntime,
};

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
    let mut state = AppState::new(pool.clone())
        .await
        .map_err(|e| format!("Initialization failed: {}", e.code))?;
    state.trusted_client_ips = xiaoq_backend::client_ip::TrustedClientIpPolicy::parse(
        &env::var("Q_TRUSTED_PROXY_IPS").unwrap_or_default(),
    )?;
    state.video = VideoRuntime::from_env()?.map(Arc::new);
    // Environment-backed provider configuration is deliberately limited to executable startup.
    state.ai = AiRuntime::from_env()?.map(Arc::new);
    state.plugins = Some(Arc::new(PluginRuntime::from_env()?));
    state.payments = xiaoq_backend::payments::PaymentRuntime::from_env()?.map(Arc::new);
    if let Some(runtime) = state.payments.as_deref() {
        xiaoq_backend::payments::operator::sync_operator_policy(&pool, runtime).await?;
        xiaoq_backend::payments::fx::bootstrap(&pool, runtime).await?;
    }
    if env::var("Q_SEED_DEMO").as_deref() == Ok("true") {
        identity::seed_demo(&state)
            .await
            .map_err(|e| format!("Demo seed failed: {}", e.code))?;
        tracing::info!("explicit local demo seed enabled; existing accounts are preserved");
    }
    let listener = tokio::net::TcpListener::bind(bind).await?;
    let social_cleanup = xiaoq_backend::social::spawn_cleanup(pool.clone());
    let market_news_worker = xiaoq_backend::market_data::spawn(pool.clone())?;
    let payments_worker = state
        .payments
        .clone()
        .map(|runtime| xiaoq_backend::payments::jobs::spawn(pool.clone(), runtime));
    let payment_fx_worker = state
        .payments
        .clone()
        .map(|runtime| xiaoq_backend::payments::fx::spawn(pool.clone(), runtime));
    tracing::info!(%bind, mode = "demo", "小Q API listening");
    axum::serve(
        listener,
        app(state, origins).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    social_cleanup.abort();
    let _ = social_cleanup.await;
    market_news_worker.abort();
    let _ = market_news_worker.await;
    if let Some(worker) = payments_worker {
        worker.abort();
        let _ = worker.await;
    }
    if let Some(worker) = payment_fx_worker {
        worker.abort();
        let _ = worker.await;
    }
    pool.close().await;
    Ok(())
}
