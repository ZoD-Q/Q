//! A small, local pre-publication rule set. This is not semantic moderation.
//! No text is logged or sent to another service by this module.
use axum::http::StatusCode;

use crate::error::{ApiError, ApiResult};

const BLOCKED_PHRASES: &[&str] = &[
    "buy child porn",
    "sell child porn",
    "selling child porn",
    "child sexual abuse material for sale",
    "i will kill you",
    "i am going to kill you",
    "出售儿童色情",
    "购买儿童色情",
    "贩卖儿童色情",
    "我要杀了你",
    "我会杀了你",
];

pub fn validate_content(text: &str) -> ApiResult<()> {
    let normalized = text.to_lowercase();
    let normalized = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    let compact: String = normalized
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    if BLOCKED_PHRASES.iter().any(|phrase| {
        if phrase.is_ascii() {
            normalized.contains(phrase)
        } else {
            compact.contains(phrase)
        }
    }) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "CONTENT_BLOCKED",
            "This text cannot be published. Edit it before trying again.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_content;

    #[test]
    fn rejects_explicit_threats_and_exploitation_without_rejecting_normal_chat() {
        for text in [
            "I WILL  KILL YOU",
            "Someone is selling child porn here",
            "我 要 杀 了 你",
            "购买儿童色情内容",
        ] {
            assert_eq!(validate_content(text).unwrap_err().code, "CONTENT_BLOCKED");
        }
        for text in [
            "你好，明天见。",
            "Please help me report abuse.",
            "I killed time reading.",
        ] {
            assert!(validate_content(text).is_ok());
        }
    }
}
