use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Request, State},
    http::{HeaderValue, Method, header},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
};
use serde::Serialize;
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::sync::Semaphore;
use tower_http::cors::CorsLayer;

pub mod account_lifecycle;
pub mod ai;
pub mod ai_history;
pub mod banking;
pub mod client_ip;
pub mod content_policy;
pub mod error;
pub mod identity;
pub mod ledger;
pub mod plugins;
pub mod profiles;
pub mod social;
pub mod validation;
pub mod video;

use error::{ApiError, ApiResult};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    password_slots: Arc<Semaphore>,
    dummy_hash: Arc<String>,
    limiter: Arc<Mutex<AuthLimiter>>,
    pub trusted_client_ips: client_ip::TrustedClientIpPolicy,
    pub video: Option<Arc<video::VideoRuntime>>,
    pub ai: Option<Arc<ai::AiRuntime>>,
    pub plugins: Option<Arc<plugins::PluginRuntime>>,
}

impl AppState {
    pub async fn new(pool: PgPool) -> ApiResult<Self> {
        let password_slots = Arc::new(Semaphore::new(4));
        let dummy_hash = Arc::new(
            identity::hash_password(uuid::Uuid::new_v4().to_string(), password_slots.clone())
                .await?,
        );
        Ok(Self {
            pool,
            password_slots,
            dummy_hash,
            limiter: Arc::new(Mutex::new(AuthLimiter::default())),
            trusted_client_ips: client_ip::TrustedClientIpPolicy::default(),
            video: None,
            ai: None,
            plugins: None,
        })
    }
    fn limit_auth(&self, key: String, limit: u32) -> ApiResult<()> {
        self.limiter
            .lock()
            .map_err(|_| ApiError::internal())?
            .check(key, limit, Instant::now())
    }
}

#[derive(Default)]
struct AuthLimiter {
    buckets: HashMap<String, (Instant, u32)>,
}
impl AuthLimiter {
    fn check(&mut self, key: String, limit: u32, now: Instant) -> ApiResult<()> {
        let window = Duration::from_secs(60);
        self.buckets
            .retain(|_, (start, _)| now.duration_since(*start) < window);
        if self.buckets.len() >= 10_000 && !self.buckets.contains_key(&key) {
            return Err(ApiError::rate_limited());
        }
        let bucket = self.buckets.entry(key).or_insert((now, 0));
        if bucket.1 >= limit {
            return Err(ApiError::rate_limited());
        }
        bucket.1 += 1;
        Ok(())
    }
}

async fn throttle_auth(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> ApiResult<Response> {
    // Forwarded addresses are accepted only from explicitly configured proxies.
    let peer = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| {
            state
                .trusted_client_ips
                .resolve(info.0.ip(), req.headers())
                .to_string()
        })
        .unwrap_or_else(|| "local-test".into());
    state.limit_auth(format!("ip:{peer}"), 30)?;
    Ok(next.run(req).await)
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
    mode: &'static str,
}
async fn health(State(state): State<AppState>) -> ApiResult<Json<Health>> {
    sqlx::query("SELECT 1").execute(&state.pool).await?;
    Ok(Json(Health {
        status: "ok",
        mode: "demo",
    }))
}

async fn private_response(req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub fn app(state: AppState, allowed_origins: Vec<HeaderValue>) -> Router {
    let auth_routes = Router::new()
        .route("/v1/auth/register", post(identity::register))
        .route("/v1/auth/login", post(identity::login))
        .route_layer(middleware::from_fn_with_state(state.clone(), throttle_auth));
    let cors = CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);
    Router::new()
        .merge(auth_routes)
        .merge(social::router())
        .route("/health", get(health))
        .route("/v1/auth/logout", post(identity::logout))
        .merge(
            Router::new()
                .route("/v1/account/deletions", post(account_lifecycle::delete))
                .route(
                    "/v1/account/deletions/status",
                    post(account_lifecycle::status),
                )
                .route_layer(middleware::from_fn_with_state(state.clone(), throttle_auth))
                .layer(middleware::from_fn(private_response)),
        )
        .route("/v1/me", get(profiles::me).patch(profiles::patch))
        .route("/v1/users/lookup", get(profiles::lookup))
        .route("/v1/wallet", get(ledger::wallet))
        .route("/v1/wallet/transactions", get(ledger::history))
        .route("/v1/wallet/transfers", post(ledger::transfer))
        .route(
            "/v1/video/connections",
            get(video::connections).post(video::create_connection),
        )
        .route(
            "/v1/video/connections/{id}",
            axum::routing::delete(video::revoke_connection),
        )
        .route("/v1/video/jobs", get(video::jobs).post(video::create_job))
        .route("/v1/video/jobs/{id}", get(video::job))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .merge(
            Router::new()
                .route("/v1/ai/status", get(ai::status))
                .route("/v1/ai/chat", post(ai::chat))
                .layer(DefaultBodyLimit::max(128 * 1024)),
        )
        .merge(
            Router::new()
                .route("/v1/ai/conversations", get(ai_history::list))
                .route(
                    "/v1/ai/conversations/{id}",
                    get(ai_history::detail).post(ai_history::save),
                )
                .layer(DefaultBodyLimit::max(5 * 1024 * 1024))
                .layer(middleware::from_fn(private_response)),
        )
        .merge(plugins::routes())
        .merge(banking::router().layer(middleware::from_fn(private_response)))
        .layer(cors)
        .with_state(state)
}

pub async fn connect_and_migrate(
    database_url: &str,
) -> Result<PgPool, Box<dyn std::error::Error + Send + Sync>> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect(database_url)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn auth_throttle_enforces_limit_and_expires_old_buckets() {
        let mut limiter = AuthLimiter::default();
        let now = Instant::now();
        assert!(limiter.check("ip:a".into(), 2, now).is_ok());
        assert!(limiter.check("ip:a".into(), 2, now).is_ok());
        assert_eq!(
            limiter.check("ip:a".into(), 2, now).unwrap_err().code,
            "RATE_LIMITED"
        );
        assert!(limiter.check("ip:b".into(), 2, now).is_ok());
        assert!(
            limiter
                .check("ip:a".into(), 2, now + Duration::from_secs(61))
                .is_ok()
        );
    }
}
