use axum::{
    Json,
    extract::{FromRequest, Request},
};
use serde::de::DeserializeOwned;

use crate::error::{ApiError, ApiResult};

pub fn handle(value: &str) -> ApiResult<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if !(3..=24).contains(&normalized.len())
        || !normalized
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        || normalized == "xiaoq"
    {
        return Err(ApiError::validation(
            "Use a handle of 3–24 letters, numbers or underscores. The handle xiaoq is reserved.",
        ));
    }
    Ok(normalized)
}

pub fn text(value: &str, min: usize, max: usize, message: &'static str) -> ApiResult<()> {
    if !(min..=max).contains(&value.chars().count()) || value.contains('\0') {
        return Err(ApiError::validation(message));
    }
    Ok(())
}

pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;
    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(req, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|_| {
                ApiError::validation(
                    "The request body is invalid. Check the field types and values.",
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handles_have_one_canonical_form() {
        assert_eq!(handle("  KaI_01 ").unwrap(), "kai_01");
        for bad in ["a", "用户123", "abc-123", "foo\0bar", "xiaoq"] {
            assert!(handle(bad).is_err());
        }
    }
    #[test]
    fn limits_count_unicode_characters_and_reject_nul() {
        assert!(text("小林", 1, 2, "bad").is_ok());
        assert!(text("小林好", 1, 2, "bad").is_err());
        assert!(text("a\0", 1, 2, "bad").is_err());
    }
}
