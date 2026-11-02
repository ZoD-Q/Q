//! Frozen CNY checkout quotes, verified provider evidence and maker/checker HKD credit.
mod approval;
pub mod config;
pub mod jobs;
pub mod qixiang;
mod routes;
mod store;
pub use config::{PaymentPolicy, PaymentRuntime, RateSnapshot};

/// Customer and operator endpoints share Q identity; provider callbacks use protocol verification.
pub fn router() -> axum::Router<crate::AppState> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route("/v1/payments/capabilities", get(routes::capabilities))
        .route("/v1/payments/wallet", get(routes::wallet))
        .route("/v1/payments/quotes", post(routes::quote))
        .route(
            "/v1/payments/orders",
            get(routes::orders).post(routes::create),
        )
        .route("/v1/payments/orders/active", get(routes::active))
        .route(
            "/v1/payments/orders/by-client-key/{key}",
            get(routes::by_key),
        )
        .route("/v1/payments/orders/{id}", get(routes::detail))
        .route("/v1/payments/orders/{id}/detach", post(routes::detach))
        .route(
            "/v1/payments/orders/{id}/proposals",
            post(approval::proposal),
        )
        .route(
            "/v1/payments/orders/{id}/approvals",
            post(approval::approve),
        )
        .route("/v1/payments/ledger", get(routes::ledger))
        .route("/v1/payments/qixiang/notify", get(routes::notify))
        .route("/v1/payments/return", get(routes::browser_return))
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
}
