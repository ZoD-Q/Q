//! Reserved insurance integration boundary. No provider, persistence or outbound requests.
use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::Authenticated,
    validation::{self, ApiJson},
};
use axum::{
    Json, Router,
    http::StatusCode,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct InsuranceStatus {
    conversation_available: bool,
    inquiry_available: bool,
    accepts_personal_data: bool,
}

pub async fn status() -> Json<InsuranceStatus> {
    Json(InsuranceStatus {
        conversation_available: false,
        inquiry_available: false,
        accepts_personal_data: false,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InquiryTopic {
    Coverage,
    Eligibility,
    Claims,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InquiryRequest {
    pub topic: InquiryTopic,
    pub question: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationRequest {
    pub message: String,
}

fn unavailable(code: &'static str) -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        code,
        "Insurance service is not connected. Nothing was saved or sent.",
    )
}

pub async fn inquiry(
    _auth: Authenticated,
    ApiJson(input): ApiJson<InquiryRequest>,
) -> ApiResult<()> {
    validation::text(
        input.question.trim(),
        1,
        1000,
        "Question must contain 1–1000 characters.",
    )?;
    Err(unavailable("INSURANCE_INQUIRY_UNAVAILABLE"))
}

pub async fn conversation(
    _auth: Authenticated,
    ApiJson(input): ApiJson<ConversationRequest>,
) -> ApiResult<()> {
    validation::text(
        input.message.trim(),
        1,
        1000,
        "Message must contain 1–1000 characters.",
    )?;
    Err(unavailable("INSURANCE_SUPPORT_UNAVAILABLE"))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/insurance/status", get(status))
        .route("/v1/insurance/inquiries", post(inquiry))
        .route("/v1/insurance/conversations", post(conversation))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    #[tokio::test]
    async fn public_status_never_advertises_a_provider() {
        let response = Router::new()
            .route("/status", get(status))
            .oneshot(
                Request::builder()
                    .uri("/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"conversation_available":false,"inquiry_available":false,"accepts_personal_data":false})
        );
    }

    #[tokio::test]
    async fn reservations_require_q_identity_before_accepting_input() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgresql://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        let app = router().with_state(AppState::new(pool).await.unwrap());
        for path in ["/v1/insurance/inquiries", "/v1/insurance/conversations"] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(path)
                        .header("content-type", "application/json")
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
    }

    #[test]
    fn requests_reject_unknown_topics_and_private_profile_fields() {
        assert!(
            serde_json::from_value::<InquiryRequest>(
                serde_json::json!({"topic":"quote","question":"help"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<InquiryRequest>(
                serde_json::json!({"topic":"claims","question":"help","id_card":"private"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<ConversationRequest>(
                serde_json::json!({"message":"help","user_id":"other"})
            )
            .is_err()
        );
    }

    #[test]
    fn reserved_services_cannot_return_fake_success() {
        for code in [
            "INSURANCE_INQUIRY_UNAVAILABLE",
            "INSURANCE_SUPPORT_UNAVAILABLE",
        ] {
            let error = unavailable(code);
            assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(error.code, code);
        }
    }
}
