use std::fmt;

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: &str = "2026-07-28";
pub const CARD_SCHEMA: &str =
    "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
pub const MAX_RESULT_BYTES: usize = 1024 * 1024;
pub type McpResult<T> = Result<T, McpError>;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    Validation,
    UnsafeNetwork,
    Discovery,
    Authorization,
    Protocol,
    Unsupported,
    Tool,
    Timeout,
    Network,
    Limit,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthChallenge {
    pub resource_metadata: Option<String>,
    pub scope: Option<String>,
}

/// Error text is controlled by Q; never attach remote bodies, headers, or credentials.
#[derive(Clone, Debug, Serialize)]
pub struct McpError {
    pub code: &'static str,
    pub message: &'static str,
    pub category: ErrorCategory,
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_challenge: Option<AuthChallenge>,
}
impl McpError {
    pub fn new(code: &'static str, category: ErrorCategory, message: &'static str) -> Self {
        Self {
            code,
            message,
            category,
            status: None,
            auth_challenge: None,
        }
    }
    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }
    pub fn validation() -> Self {
        Self::new(
            "MCP_INVALID_INPUT",
            ErrorCategory::Validation,
            "The plugin input is invalid.",
        )
    }
    pub fn protocol() -> Self {
        Self::new(
            "MCP_INVALID_RESPONSE",
            ErrorCategory::Protocol,
            "The plugin returned an invalid protocol response.",
        )
    }
    pub fn limit() -> Self {
        Self::new(
            "MCP_LIMIT_EXCEEDED",
            ErrorCategory::Limit,
            "The plugin response exceeds the supported limits.",
        )
    }
    pub fn unsupported() -> Self {
        Self::new(
            "MCP_UNSUPPORTED",
            ErrorCategory::Unsupported,
            "The plugin requires a capability not supported by Q.",
        )
    }
    pub fn unsafe_url() -> Self {
        Self::new(
            "MCP_UNSAFE_URL",
            ErrorCategory::UnsafeNetwork,
            "The plugin network destination is not permitted.",
        )
    }
    pub fn timeout() -> Self {
        Self::new(
            "MCP_TIMEOUT",
            ErrorCategory::Timeout,
            "The plugin request timed out; its result may be unknown.",
        )
    }
    pub fn network() -> Self {
        Self::new(
            "MCP_NETWORK_ERROR",
            ErrorCategory::Network,
            "The plugin could not be reached.",
        )
    }
}
impl fmt::Display for McpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}
impl std::error::Error for McpError {}

/// A remote OAuth token bound to one exact MCP endpoint, never a Q session token.
#[derive(Clone)]
pub struct RemoteBearer {
    token: String,
    endpoint: String,
}
impl RemoteBearer {
    pub fn new(token: String, endpoint: &str) -> McpResult<Self> {
        let url = Url::parse(endpoint).map_err(|_| McpError::unsafe_url())?;
        if token.is_empty()
            || token.len() > 8192
            || !token.bytes().all(|byte| byte.is_ascii_graphic())
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || !matches!(url.scheme(), "https" | "http")
        {
            return Err(McpError::validation());
        }
        Ok(Self {
            token,
            endpoint: url.to_string(),
        })
    }
    pub(crate) fn token_for(&self, url: &Url) -> McpResult<&str> {
        if self.endpoint != url.as_str() {
            return Err(McpError::unsafe_url());
        }
        Ok(&self.token)
    }
}
impl fmt::Debug for RemoteBearer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RemoteBearer([REDACTED])")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Candidate {
    pub card_url: String,
    pub discovery_url: String,
    pub card_origin: String,
    pub endpoint_url: String,
    pub name: String,
    pub title: String,
    pub version: String,
    pub description: String,
    pub fingerprint: String,
    pub card_json: Value,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Domain,
    Page,
    Catalog,
    Card,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Discovery {
    pub supported_versions: Vec<String>,
    pub capabilities: Value,
    pub server_info: Option<Value>,
    pub instructions: Option<String>,
    pub ttl_ms: u64,
    pub cache_scope: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
    #[serde(rename = "outputSchema", skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Value>,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}
