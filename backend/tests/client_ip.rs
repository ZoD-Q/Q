//! Exercise real authentication middleware without opening a database connection.
//! Deliberately invalid request bodies stop at validation after admission.
use std::net::{IpAddr, SocketAddr};

use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;
use xiaoq_backend::{AppState, app, client_ip::TrustedClientIpPolicy};

async fn test_app(proxy: &str) -> Router {
    let pool = PgPoolOptions::new()
        .connect_lazy("postgresql://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let mut state = AppState::new(pool).await.unwrap();
    state.trusted_client_ips = TrustedClientIpPolicy::parse(proxy).unwrap();
    app(state, vec![])
}

async fn attempt(router: &Router, peer: &str, forwarded: &[&str], register: bool) -> StatusCode {
    let mut request = Request::post(if register {
        "/v1/auth/register"
    } else {
        "/v1/auth/login"
    })
    .header("content-type", "application/json")
    .body(Body::from("{}"))
    .unwrap();
    request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        peer.parse::<IpAddr>().unwrap(),
        12345,
    )));
    for value in forwarded {
        request
            .headers_mut()
            .append("x-forwarded-for", value.parse().unwrap());
    }
    router.clone().oneshot(request).await.unwrap().status()
}

#[tokio::test]
async fn proxied_clients_have_separate_buckets_shared_by_login_and_registration() {
    let router = test_app("192.0.2.10").await;
    for index in 0..30 {
        assert_eq!(
            attempt(&router, "192.0.2.10", &["198.51.100.1"], index % 2 == 0).await,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        attempt(&router, "192.0.2.10", &["198.51.100.1"], false).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    for index in 0..30 {
        assert_eq!(
            attempt(&router, "192.0.2.10", &["198.51.100.2"], index % 2 == 0).await,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        attempt(&router, "192.0.2.10", &["198.51.100.2"], true).await,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn direct_spoofing_cannot_rotate_buckets_with_default_or_explicit_policy() {
    for proxy in ["", "192.0.2.10"] {
        let router = test_app(proxy).await;
        for index in 0..31 {
            let forged = format!("198.51.100.{}", index + 1);
            assert_eq!(
                attempt(&router, "192.0.2.11", &[&forged], false).await,
                if index < 30 {
                    StatusCode::BAD_REQUEST
                } else {
                    StatusCode::TOO_MANY_REQUESTS
                }
            );
        }
    }
}

#[tokio::test]
async fn missing_repeated_and_malformed_proxy_headers_share_the_peer_bucket() {
    let router = test_app("192.0.2.10").await;
    let cases: &[&[&str]] = &[
        &[],
        &["198.51.100.1", "198.51.100.2"],
        &["198.51.100.1, 198.51.100.2"],
        &["unknown"],
        &["198.51.100.1:443"],
    ];
    for index in 0..31 {
        assert_eq!(
            attempt(
                &router,
                "::ffff:192.0.2.10",
                cases[index % cases.len()],
                false,
            )
            .await,
            if index < 30 {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::TOO_MANY_REQUESTS
            }
        );
    }
}
