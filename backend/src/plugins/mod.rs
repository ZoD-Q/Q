//! User-owned MCP connections. External content is data, never Q authorization or code.
use std::{env, sync::Arc};

use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::{RngCore, rngs::OsRng};
use reqwest::Url;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AppState,
    error::{ApiError, ApiResult},
};
pub mod discovery;
pub mod invocations;
pub mod network;
pub mod oauth;
pub mod protocol;
pub mod store;
pub mod types;
pub use invocations::{Invocation, get_invocation, prepare_invocation};
use network::SafeHttp;
use protocol::McpClient;
pub use store::{Connection, load_tools_for_user};
use types::{ErrorCategory, McpError, PROTOCOL_VERSION};

pub struct PluginRuntime {
    pub(crate) http: SafeHttp,
    pub(crate) client: McpClient,
    key: Option<[u8; 32]>,
    pub(crate) public_base: Option<String>,
}
impl PluginRuntime {
    /// Anonymous plugin networking works without OAuth hosting or an encryption key.
    pub fn from_env() -> Result<Self, &'static str> {
        let key = match env::var("Q_MCP_ENCRYPTION_KEY") {
            Err(env::VarError::NotPresent) => None,
            Err(_) => return Err("Invalid Q_MCP_ENCRYPTION_KEY configuration"),
            Ok(value) => Some(
                STANDARD
                    .decode(value)
                    .map_err(|_| "Q_MCP_ENCRYPTION_KEY must encode 32 bytes")?
                    .try_into()
                    .map_err(|_| "Q_MCP_ENCRYPTION_KEY must encode 32 bytes")?,
            ),
        };
        let public_base = match env::var("Q_MCP_PUBLIC_BASE_URL") {
            Err(env::VarError::NotPresent) => None,
            Err(_) => return Err("Invalid Q_MCP_PUBLIC_BASE_URL configuration"),
            Ok(value) if value.trim().is_empty() => None,
            Ok(value) => {
                let url = Url::parse(&value)
                    .map_err(|_| "Q_MCP_PUBLIC_BASE_URL must be an HTTPS origin")?;
                if url.scheme() != "https"
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                    || url.path() != "/"
                {
                    return Err("Q_MCP_PUBLIC_BASE_URL must be an HTTPS origin");
                }
                Some(url.origin().ascii_serialization())
            }
        };
        let http = configured_http(env::var_os("Q_MCP_LOCAL_FIXTURE_ORIGIN"))?;
        Ok(Self {
            client: McpClient::new(http.clone()),
            http,
            key,
            public_base,
        })
    }
    #[cfg(feature = "plugin-test-fixtures")]
    pub fn test_fixture(
        http: SafeHttp,
        key: Option<[u8; 32]>,
        public_base: Option<String>,
    ) -> Self {
        Self {
            client: McpClient::new(http.clone()),
            http,
            key,
            public_base,
        }
    }
    pub(crate) fn oauth_configured(&self) -> bool {
        self.key.is_some() && self.public_base.is_some()
    }
    pub(crate) fn seal(
        &self,
        user: Uuid,
        id: Uuid,
        purpose: &str,
        value: &Value,
    ) -> ApiResult<Vec<u8>> {
        let key = self.key.as_ref().ok_or_else(oauth_unconfigured)?;
        let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| ApiError::internal())?;
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let aad = format!("q.plugins.v1:{user}:{id}:{purpose}");
        let plain = serde_json::to_vec(value).map_err(|_| ApiError::internal())?;
        let sealed = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plain,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| ApiError::internal())?;
        let mut result = nonce.to_vec();
        result.extend(sealed);
        Ok(result)
    }
    pub(crate) fn open(
        &self,
        user: Uuid,
        id: Uuid,
        purpose: &str,
        sealed: &[u8],
    ) -> ApiResult<Value> {
        if sealed.len() <= 28 {
            return Err(auth_required());
        }
        let key = self.key.as_ref().ok_or_else(oauth_unconfigured)?;
        let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| ApiError::internal())?;
        let aad = format!("q.plugins.v1:{user}:{id}:{purpose}");
        let plain = cipher
            .decrypt(
                Nonce::from_slice(&sealed[..12]),
                Payload {
                    msg: &sealed[12..],
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| auth_required())?;
        serde_json::from_slice(&plain).map_err(|_| auth_required())
    }
}
fn configured_http(fixture: Option<std::ffi::OsString>) -> Result<SafeHttp, &'static str> {
    if let Some(value) = fixture {
        #[cfg(all(feature = "plugin-test-fixtures", debug_assertions))]
        {
            let value = value.to_str().ok_or("Invalid local MCP fixture origin")?;
            let origin = Url::parse(value).map_err(|_| "Invalid local MCP fixture origin")?;
            return SafeHttp::test_fixture(origin)
                .map_err(|_| "MCP fixture must be one exact literal loopback origin with a port");
        }
        #[cfg(not(all(feature = "plugin-test-fixtures", debug_assertions)))]
        {
            let _ = value;
            return Err("Local MCP fixtures require a debug build with plugin-test-fixtures");
        }
    }
    Ok(SafeHttp::default())
}
pub(crate) fn runtime(state: &AppState) -> ApiResult<Arc<PluginRuntime>> {
    state.plugins.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "PLUGIN_UNAVAILABLE",
            "Plugin connections are unavailable.",
        )
    })
}
pub(crate) fn oauth_unconfigured() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "PLUGIN_OAUTH_NOT_CONFIGURED",
        "Public OAuth hosting and encryption are not configured.",
    )
}
pub(crate) fn auth_required() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "PLUGIN_AUTH_REQUIRED",
        "This plugin needs authorization. Your Q session is unchanged.",
    )
}
pub(crate) fn not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "PLUGIN_NOT_FOUND",
        "The plugin connection or record was not found.",
    )
}
pub(crate) fn changed() -> ApiError {
    ApiError::conflict(
        "PLUGIN_RECONFIRM_REQUIRED",
        "The plugin changed. Review and confirm its updated connection or tools.",
    )
}
pub(crate) fn mcp_error(error: McpError) -> ApiError {
    if error.category == ErrorCategory::Authorization || matches!(error.status, Some(401 | 403)) {
        return auth_required();
    }
    let status = match error.category {
        ErrorCategory::Validation | ErrorCategory::UnsafeNetwork => StatusCode::BAD_REQUEST,
        ErrorCategory::Unsupported => StatusCode::UNPROCESSABLE_ENTITY,
        ErrorCategory::Timeout => StatusCode::GATEWAY_TIMEOUT,
        _ => StatusCode::BAD_GATEWAY,
    };
    ApiError::new(status, error.code, error.message)
}
pub(crate) fn hash(value: &[u8]) -> Vec<u8> {
    Sha256::digest(value).to_vec()
}
pub(crate) fn fingerprint(value: &Value) -> ApiResult<String> {
    let bytes = serde_json::to_vec(value).map_err(|_| ApiError::internal())?;
    Ok(hash(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
pub(crate) fn auth_binding(issuer: &str, resource: &str) -> String {
    hash(format!("{issuer}\n{resource}").as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
async fn status(State(state): State<AppState>) -> Json<Value> {
    Json(
        json!({"available":state.plugins.is_some(),"oauth_configured":state.plugins.as_ref().is_some_and(|runtime| runtime.oauth_configured()),"protocol_version":PROTOCOL_VERSION}),
    )
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/plugins/status", get(status))
        .route("/v1/plugins/discover", post(store::discover))
        .route(
            "/v1/plugins/connections",
            get(store::connections).post(store::add_connection),
        )
        .route(
            "/v1/plugins/connections/{id}",
            get(store::connection).delete(store::revoke),
        )
        .route("/v1/plugins/connections/{id}/refresh", post(store::refresh))
        .route(
            "/v1/plugins/connections/{id}/accept-update",
            post(store::accept_update),
        )
        .route("/v1/plugins/connections/{id}/tools", get(store::tools))
        .route(
            "/v1/plugins/connections/{id}/resources",
            get(store::resources),
        )
        .route(
            "/v1/plugins/connections/{id}/resources/read",
            post(store::read_resource),
        )
        .route("/v1/plugins/connections/{id}/prompts", get(store::prompts))
        .route(
            "/v1/plugins/connections/{id}/prompts/get",
            post(store::get_prompt),
        )
        .route(
            "/v1/plugins/connections/{id}/oauth/start",
            post(oauth::start),
        )
        .route("/v1/plugins/oauth/attempts/{id}", get(oauth::attempt))
        .route("/oauth/client-metadata.json", get(oauth::client_metadata))
        .route("/v1/plugins/oauth/callback", get(oauth::callback))
        .route("/oauth/complete", get(oauth::complete))
        .route(
            "/v1/plugins/invocations",
            get(invocations::list).post(invocations::prepare),
        )
        .route("/v1/plugins/invocations/{id}", get(invocations::read))
        .route(
            "/v1/plugins/invocations/{id}/confirm",
            post(invocations::confirm),
        )
        .route(
            "/v1/plugins/invocations/{id}/cancel",
            post(invocations::cancel),
        )
        .layer(DefaultBodyLimit::max(128 * 1024))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_credentials_are_owner_connection_and_purpose_bound() {
        let http = SafeHttp::default();
        let runtime = PluginRuntime {
            client: McpClient::new(http.clone()),
            http,
            key: Some([19; 32]),
            public_base: Some("https://q.example".into()),
        };
        let user = Uuid::new_v4();
        let connection = Uuid::new_v4();
        let payload = json!({"access_token":"TEST_TOKEN_NOT_REAL"});
        let encrypted = runtime.seal(user, connection, "tokens", &payload).unwrap();
        assert_eq!(
            runtime
                .open(user, connection, "tokens", &encrypted)
                .unwrap(),
            payload
        );
        assert_ne!(
            encrypted,
            runtime.seal(user, connection, "tokens", &payload).unwrap()
        );
        assert!(
            runtime
                .open(Uuid::new_v4(), connection, "tokens", &encrypted)
                .is_err()
        );
        assert!(
            runtime
                .open(user, Uuid::new_v4(), "tokens", &encrypted)
                .is_err()
        );
        assert!(runtime.open(user, connection, "pkce", &encrypted).is_err());
        assert!(!String::from_utf8_lossy(&encrypted).contains("TEST_TOKEN_NOT_REAL"));
    }
    #[test]
    fn local_network_exception_is_explicit_and_build_gated() {
        assert!(configured_http(None).is_ok());
        for origin in [
            "http://localhost:8794",
            "http://192.168.1.1:8794",
            "http://127.0.0.1:8794/path",
            "https://public.example:443",
        ] {
            assert!(configured_http(Some(origin.into())).is_err());
        }
        #[cfg(all(feature = "plugin-test-fixtures", debug_assertions))]
        assert!(configured_http(Some("http://127.0.0.1:8794".into())).is_ok());
        #[cfg(not(all(feature = "plugin-test-fixtures", debug_assertions)))]
        assert!(configured_http(Some("http://127.0.0.1:8794".into())).is_err());
    }
}
