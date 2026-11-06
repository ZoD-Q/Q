//! Frozen CNY checkout quotes, verified provider evidence and maker/checker HKD credit.
mod approval;
pub mod config;
pub mod fx;
pub mod jobs;
pub mod operator;
pub mod qixiang;
pub mod refunds;
mod routes;
pub mod settlement;
mod store;
pub use config::{PaymentPolicy, PaymentRuntime, RateSnapshot};

/// Customer and operator endpoints share Q identity; provider callbacks use protocol verification.
pub fn router() -> axum::Router<crate::AppState> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route("/v1/payments/capabilities", get(routes::capabilities))
        .route("/v1/payments/fx/status", get(routes::fx_status))
        .route("/v1/payments/fx/activations", post(routes::fx_activate))
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
        .merge(
            axum::Router::new()
                .route("/v1/payments/operator/me", get(operator::me))
                .route("/v1/payments/operator/audit", get(operator::audit_list))
                .route("/v1/payments/operator/orders", get(operator::orders))
                .route("/v1/payments/operator/orders/{id}", get(operator::detail))
                .route(
                    "/v1/payments/operator/orders/{id}/refunds",
                    post(refunds::create),
                )
                .route("/v1/payments/operator/refunds/{id}", get(refunds::detail))
                .route(
                    "/v1/payments/operator/refunds/{id}/document",
                    get(refunds::document),
                )
                .route(
                    "/v1/payments/operator/refunds/{id}/approve",
                    post(refunds::approve),
                )
                .route(
                    "/v1/payments/operator/refunds/{id}/evidence",
                    get(refunds::evidence_history).post(refunds::evidence),
                )
                .route(
                    "/v1/payments/operator/refunds/{id}/evidence-rejections",
                    post(refunds::reject_evidence),
                )
                .route(
                    "/v1/payments/operator/refunds/{id}/verify",
                    post(refunds::verify),
                )
                .route(
                    "/v1/payments/operator/refunds/{id}/unknown",
                    post(refunds::unknown),
                )
                .route(
                    "/v1/payments/operator/settlements",
                    get(settlement::list).post(settlement::import),
                )
                .route(
                    "/v1/payments/operator/settlements/by-client-key/{key}",
                    get(settlement::by_client_key),
                )
                .route(
                    "/v1/payments/operator/settlements/{id}",
                    get(settlement::detail),
                )
                .route(
                    "/v1/payments/operator/settlements/{id}/verify",
                    post(settlement::verify),
                )
                .route(
                    "/v1/payments/operator/settlements/{id}/rechecks",
                    post(settlement::recheck),
                )
                .route(
                    "/v1/payments/operator/settlements/{id}/checks",
                    get(settlement::checks),
                )
                .route(
                    "/v1/payments/operator/settlements/{id}/document",
                    get(settlement::document),
                )
                .layer(axum::extract::DefaultBodyLimit::max(768 * 1024)),
        )
}
