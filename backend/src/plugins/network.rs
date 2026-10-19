use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use futures_util::StreamExt;
use reqwest::{
    Method, Url,
    header::{self, HeaderMap, HeaderValue},
};
use serde_json::Value;

use super::types::{AuthChallenge, ErrorCategory, McpError, McpResult, RemoteBearer};

const MAX_HTTP_BYTES: usize = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_REDIRECTS: usize = 3;
type BodyObserver = Box<dyn FnMut(&[u8], &str) -> bool + Send>;
struct RequestPlan<'a> {
    url: &'a str,
    method: Method,
    body: Option<Vec<u8>>,
    bearer: Option<&'a RemoteBearer>,
    headers: HeaderMap,
    redirects: usize,
    observer: Option<BodyObserver>,
}

#[derive(Clone, Default)]
pub struct SafeHttp {
    #[cfg(any(test, feature = "plugin-test-fixtures"))]
    fixture_origins: Vec<String>,
}

/// Intentionally not Debug: OAuth token responses can contain secrets.
pub struct HttpResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
    pub final_url: String,
}
impl HttpResponse {
    pub fn json(&self) -> McpResult<Value> {
        serde_json::from_slice(&self.body).map_err(|_| McpError::protocol())
    }
    pub fn media_type(&self) -> &str {
        self.headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
    }
}

fn secret_query(url: &Url) -> bool {
    url.query_pairs().any(|(name, _)| {
        matches!(
            name.to_ascii_lowercase().replace('-', "_").as_str(),
            "token"
                | "access_token"
                | "refresh_token"
                | "id_token"
                | "api_key"
                | "apikey"
                | "key"
                | "secret"
                | "client_secret"
                | "password"
                | "authorization"
                | "auth"
                | "credential"
                | "credentials"
                | "session"
                | "session_id"
                | "signature"
                | "sig"
                | "x_amz_credential"
                | "x_amz_signature"
        )
    })
}

fn syntax_url(value: &str) -> McpResult<Url> {
    if value.len() > 8192 || value.trim() != value || value.chars().any(char::is_control) {
        return Err(McpError::unsafe_url());
    }
    let url = Url::parse(value).map_err(|_| McpError::unsafe_url())?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || secret_query(&url)
    {
        return Err(McpError::unsafe_url());
    }
    Ok(url)
}

/// Conservative global-unicast policy: special-purpose, transition and private blocks fail closed.
pub fn is_public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0 && (c == 0 || c == 2))
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            (segments[0] & 0xe000) == 0x2000
                && !(segments[0] == 0x2001 && segments[1] <= 0x01ff)
                && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
                && segments[0] != 0x2002
                && !(segments[0] == 0x3fff && (segments[1] & 0xf000) == 0)
        }
    }
}

impl SafeHttp {
    #[cfg(any(test, feature = "plugin-test-fixtures"))]
    pub fn test_fixture(origin: Url) -> McpResult<Self> {
        Self::test_fixtures(&[origin])
    }

    #[cfg(any(test, feature = "plugin-test-fixtures"))]
    pub fn test_fixtures(origins: &[Url]) -> McpResult<Self> {
        if origins.is_empty() || origins.len() > 4 {
            return Err(McpError::unsafe_url());
        }
        let mut allowed = Vec::new();
        for url in origins {
            if !matches!(url.scheme(), "http" | "https")
                || url.port().is_none()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
                || !matches!(url.host_str(), Some("127.0.0.1" | "[::1]"))
            {
                return Err(McpError::unsafe_url());
            }
            allowed.push(url.origin().ascii_serialization());
        }
        Ok(Self {
            fixture_origins: allowed,
        })
    }

    fn fixture(&self, url: &Url) -> bool {
        #[cfg(any(test, feature = "plugin-test-fixtures"))]
        {
            self.fixture_origins
                .contains(&url.origin().ascii_serialization())
        }
        #[cfg(not(any(test, feature = "plugin-test-fixtures")))]
        {
            let _ = url;
            false
        }
    }

    pub fn canonical_url(&self, value: &str) -> McpResult<String> {
        let url = syntax_url(value)?;
        if url.scheme() != "https" && !(url.scheme() == "http" && self.fixture(&url)) {
            return Err(McpError::unsafe_url());
        }
        if let Ok(ip) = url
            .host_str()
            .unwrap_or("")
            .trim_matches(['[', ']'])
            .parse::<IpAddr>()
            && !is_public_address(ip)
            && !self.fixture(&url)
        {
            return Err(McpError::unsafe_url());
        }
        Ok(url.to_string())
    }

    async fn addresses(&self, url: &Url) -> McpResult<Vec<SocketAddr>> {
        let host = url
            .host_str()
            .ok_or_else(McpError::unsafe_url)?
            .trim_matches(['[', ']']);
        let port = url
            .port_or_known_default()
            .ok_or_else(McpError::unsafe_url)?;
        let mut addresses = if let Ok(ip) = host.parse::<IpAddr>() {
            vec![SocketAddr::new(ip, port)]
        } else {
            tokio::time::timeout(
                Duration::from_secs(5),
                tokio::net::lookup_host((host, port)),
            )
            .await
            .map_err(|_| McpError::timeout())?
            .map_err(|_| McpError::network())?
            .collect::<Vec<_>>()
        };
        addresses.sort_unstable();
        addresses.dedup();
        if addresses.is_empty()
            || addresses.len() > 16
            || addresses
                .iter()
                .any(|address| !is_public_address(address.ip()) && !self.fixture(url))
        {
            return Err(McpError::unsafe_url());
        }
        Ok(addresses)
    }

    pub async fn validate_destination(&self, value: &str) -> McpResult<()> {
        let url = Url::parse(&self.canonical_url(value)?).map_err(|_| McpError::unsafe_url())?;
        self.addresses(&url).await.map(|_| ())
    }

    pub async fn get(&self, url: &str) -> McpResult<HttpResponse> {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, HeaderValue::from_static("application/json, application/ai-catalog+json, application/mcp-server-card+json, text/html"));
        self.get_with_headers(url, headers).await
    }

    pub async fn get_with_headers(&self, url: &str, headers: HeaderMap) -> McpResult<HttpResponse> {
        self.bounded_request(RequestPlan {
            url,
            method: Method::GET,
            body: None,
            bearer: None,
            headers,
            redirects: MAX_REDIRECTS,
            observer: None,
        })
        .await
    }

    pub async fn post_json(
        &self,
        url: &str,
        body: &Value,
        bearer: Option<&RemoteBearer>,
        mut headers: HeaderMap,
    ) -> McpResult<HttpResponse> {
        let body = serde_json::to_vec(body).map_err(|_| McpError::validation())?;
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        self.bounded_request(RequestPlan {
            url,
            method: Method::POST,
            body: Some(body),
            bearer,
            headers,
            redirects: 0,
            observer: None,
        })
        .await
    }

    pub(crate) async fn post_json_until<F>(
        &self,
        url: &str,
        body: &Value,
        bearer: Option<&RemoteBearer>,
        mut headers: HeaderMap,
        observer: F,
    ) -> McpResult<HttpResponse>
    where
        F: FnMut(&[u8], &str) -> bool + Send + 'static,
    {
        let body = serde_json::to_vec(body).map_err(|_| McpError::validation())?;
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        self.bounded_request(RequestPlan {
            url,
            method: Method::POST,
            body: Some(body),
            bearer,
            headers,
            redirects: 0,
            observer: Some(Box::new(observer)),
        })
        .await
    }

    pub async fn post_form(
        &self,
        url: &str,
        form: &[(String, String)],
        mut headers: HeaderMap,
    ) -> McpResult<HttpResponse> {
        if form.len() > 32
            || form
                .iter()
                .any(|(name, value)| name.len() > 128 || value.len() > 16384)
        {
            return Err(McpError::limit());
        }
        let mut encoded =
            Url::parse("https://form.invalid/").map_err(|_| McpError::validation())?;
        encoded.query_pairs_mut().extend_pairs(
            form.iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        );
        let body = encoded.query().unwrap_or("").as_bytes().to_vec();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/x-www-form-urlencoded"),
        );
        self.bounded_request(RequestPlan {
            url,
            method: Method::POST,
            body: Some(body),
            bearer: None,
            headers,
            redirects: 0,
            observer: None,
        })
        .await
    }

    async fn bounded_request(&self, plan: RequestPlan<'_>) -> McpResult<HttpResponse> {
        if plan
            .body
            .as_ref()
            .is_some_and(|value| value.len() > MAX_REQUEST_BYTES)
        {
            return Err(McpError::limit());
        }
        validate_headers(&plan.headers)?;
        tokio::time::timeout(Duration::from_secs(30), self.request_inner(plan))
            .await
            .map_err(|_| McpError::timeout())?
    }

    async fn request_inner(&self, plan: RequestPlan<'_>) -> McpResult<HttpResponse> {
        let RequestPlan {
            url: value,
            method,
            body,
            bearer,
            headers,
            redirects,
            mut observer,
        } = plan;
        let mut url =
            Url::parse(&self.canonical_url(value)?).map_err(|_| McpError::unsafe_url())?;
        for hop in 0..=redirects {
            let pinned = self.addresses(&url).await?;
            let host = url
                .host_str()
                .ok_or_else(McpError::unsafe_url)?
                .trim_matches(['[', ']']);
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .referer(false)
                .http1_only()
                .pool_max_idle_per_host(0)
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(25))
                .resolve_to_addrs(host, &pinned)
                .build()
                .map_err(|_| McpError::network())?;
            let mut request = client
                .request(method.clone(), url.clone())
                .headers(headers.clone());
            if let Some(token) = bearer {
                request = request.bearer_auth(token.token_for(&url)?);
            }
            if let Some(bytes) = &body {
                request = request.body(bytes.clone());
            }
            let response = request.send().await.map_err(|error| {
                if error.is_timeout() {
                    McpError::timeout()
                } else {
                    McpError::network()
                }
            })?;
            if !response
                .remote_addr()
                .is_some_and(|actual| pinned.contains(&actual))
            {
                return Err(McpError::unsafe_url());
            }
            if response.status().is_redirection() && redirects > 0 {
                if method != Method::GET || bearer.is_some() || hop == redirects {
                    return Err(McpError::new(
                        "MCP_REDIRECT_BLOCKED",
                        ErrorCategory::UnsafeNetwork,
                        "The plugin redirect was not followed.",
                    ));
                }
                let location = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(McpError::protocol)?;
                let next = url.join(location).map_err(|_| McpError::unsafe_url())?;
                url = Url::parse(&self.canonical_url(next.as_str())?)
                    .map_err(|_| McpError::unsafe_url())?;
                continue;
            }
            let status = response.status().as_u16();
            if response
                .content_length()
                .is_some_and(|length| length > MAX_HTTP_BYTES as u64)
            {
                return Err(McpError::limit());
            }
            let response_headers = response.headers().clone();
            let media_type = response_headers
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_owned();
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| {
                    if error.is_timeout() {
                        McpError::timeout()
                    } else {
                        McpError::network()
                    }
                })?;
                if bytes.len().saturating_add(chunk.len()) > MAX_HTTP_BYTES {
                    return Err(McpError::limit());
                }
                bytes.extend_from_slice(&chunk);
                if observer
                    .as_mut()
                    .is_some_and(|observer| observer(&chunk, &media_type))
                {
                    break;
                }
            }
            return Ok(HttpResponse {
                status,
                headers: response_headers,
                body: bytes,
                final_url: url.to_string(),
            });
        }
        Err(McpError::protocol())
    }
}

fn validate_headers(headers: &HeaderMap) -> McpResult<()> {
    if headers.len() > 40 {
        return Err(McpError::limit());
    }
    let mut total = 0;
    for (name, value) in headers {
        let name = name.as_str();
        if !(matches!(
            name,
            "accept" | "content-type" | "if-none-match" | "if-modified-since"
        ) || name.starts_with("mcp-"))
            || value.as_bytes().len() > 8192
        {
            return Err(McpError::validation());
        }
        total += value.as_bytes().len();
        if total > 32768 {
            return Err(McpError::limit());
        }
    }
    Ok(())
}

fn challenge_parts(value: &str) -> Option<Vec<String>> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if quoted && character == '\\' {
            current.push(character);
            escaped = true;
            continue;
        }
        if character == '"' {
            quoted = !quoted;
        }
        if character == ',' && !quoted {
            parts.push(current.trim().to_owned());
            current.clear();
        } else {
            current.push(character);
        }
    }
    if quoted || escaped {
        return None;
    }
    parts.push(current.trim().to_owned());
    Some(parts)
}

fn quoted_value(value: &str) -> Option<String> {
    let value = value.trim();
    if !value.starts_with('"') {
        return (!value.is_empty()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_graphic() && byte != b',' && byte != b'"'))
        .then(|| value.to_owned());
    }
    let inner = value.strip_prefix('"')?.strip_suffix('"')?;
    let mut decoded = String::new();
    let mut chars = inner.chars();
    while let Some(character) = chars.next() {
        if character == '\\' {
            decoded.push(chars.next()?);
        } else if character == '"' {
            return None;
        } else {
            decoded.push(character);
        }
    }
    Some(decoded)
}

/// Parse only; callers must use SafeHttp again before fetching any returned metadata URL.
pub fn parse_auth_challenge(headers: &HeaderMap) -> Option<AuthChallenge> {
    let mut found = false;
    let mut metadata = None;
    let mut scope = None;
    for header in headers.get_all(header::WWW_AUTHENTICATE) {
        let value = header.to_str().ok()?;
        if value.len() > 8192 {
            return None;
        }
        let mut bearer = false;
        for part in challenge_parts(value)? {
            let mut parameter = part.as_str();
            if let Some((scheme, rest)) = parameter.split_once(char::is_whitespace) {
                if !scheme.contains('=') {
                    bearer = scheme.eq_ignore_ascii_case("Bearer");
                    found |= bearer;
                    parameter = rest.trim_start();
                }
            } else if !parameter.contains('=') {
                bearer = parameter.eq_ignore_ascii_case("Bearer");
                found |= bearer;
                continue;
            }
            if !bearer {
                continue;
            }
            let (name, value) = parameter.split_once('=')?;
            let value = quoted_value(value)?;
            match name.trim().to_ascii_lowercase().as_str() {
                "resource_metadata" => {
                    let url = syntax_url(&value).ok()?;
                    if !matches!(url.scheme(), "https" | "http")
                        || metadata.as_ref().is_some_and(|old| old != url.as_str())
                    {
                        return None;
                    }
                    metadata = Some(url.to_string());
                }
                "scope" => {
                    if value.len() > 1024
                        || !value.bytes().all(|byte| {
                            byte == b' '
                                || (byte.is_ascii_graphic() && byte != b'"' && byte != b'\\')
                        })
                        || scope.as_ref().is_some_and(|old| old != &value)
                    {
                        return None;
                    }
                    scope = Some(value);
                }
                _ => {}
            }
        }
    }
    found.then_some(AuthChallenge {
        resource_metadata: metadata,
        scope,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_address_policy_rejects_special_networks() {
        for ip in [
            "127.0.0.1",
            "0.1.2.3",
            "10.9.8.7",
            "100.64.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "192.0.2.3",
            "198.19.0.1",
            "198.51.100.2",
            "203.0.113.4",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::ffff:127.0.0.1",
            "64:ff9b::7f00:1",
            "fc00::1",
            "fe80::1",
            "ff00::1",
            "2001:db8::1",
            "2002:7f00:1::1",
            "3fff::1",
        ] {
            assert!(!is_public_address(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "93.184.216.34",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
        ] {
            assert!(is_public_address(ip.parse().unwrap()));
        }
    }

    #[test]
    fn url_identity_preserves_path_and_duplicate_query_order() {
        let http = SafeHttp::default();
        assert_eq!(
            http.canonical_url("https://EXAMPLE.com/Mcp/Card/?tag=b&tag=a&x=%2F")
                .unwrap(),
            "https://example.com/Mcp/Card/?tag=b&tag=a&x=%2F"
        );
        for value in [
            "http://example.com/mcp",
            "https://a:b@example.com",
            "https://127.0.0.1",
            "https://example.com/?access%5ftoken=x",
            "https://example.com/#part",
            "file:///tmp/file",
        ] {
            assert!(http.canonical_url(value).is_err());
        }
    }

    #[test]
    fn fixture_is_explicit_and_origin_scoped() {
        let http = SafeHttp::test_fixture(Url::parse("http://127.0.0.1:45678").unwrap()).unwrap();
        assert!(http.canonical_url("http://127.0.0.1:45678/mcp").is_ok());
        assert!(http.canonical_url("http://127.0.0.1:45679/mcp").is_err());
        assert!(http.canonical_url("http://192.168.1.1:45678/mcp").is_err());
        assert!(SafeHttp::test_fixture(Url::parse("http://localhost:45678").unwrap()).is_err());
    }

    #[test]
    fn challenge_parser_preserves_quoted_commas_and_rejects_conflicts() {
        let mut headers = HeaderMap::new();
        headers.insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Basic realm=\"x,y\", Bearer resource_metadata=\"https://auth.example/resource?tenant=a,b\", scope=\"read write\""));
        let challenge = parse_auth_challenge(&headers).unwrap();
        assert_eq!(challenge.scope.as_deref(), Some("read write"));
        assert_eq!(
            challenge.resource_metadata.as_deref(),
            Some("https://auth.example/resource?tenant=a,b")
        );
        headers.append(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Bearer resource_metadata=\"https://other.example/resource\""),
        );
        assert!(parse_auth_challenge(&headers).is_none());
        headers.insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static(
                "Bearer resource_metadata=\"https://auth.example/?token=private\"",
            ),
        );
        assert!(parse_auth_challenge(&headers).is_none());
    }

    #[tokio::test]
    async fn redirects_cannot_forward_credentials_or_escape_fixture_origin() {
        use axum::{Router, http::StatusCode, routing::get};
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let app = Router::new()
            .route(
                "/start",
                get(|| async { (StatusCode::FOUND, [("location", "/finish")]) }),
            )
            .route(
                "/escape",
                get(|| async {
                    (
                        StatusCode::FOUND,
                        [("location", "http://169.254.169.254/latest/meta-data")],
                    )
                }),
            )
            .route(
                "/finish",
                get(move |headers: HeaderMap| {
                    let observed = observed.clone();
                    async move {
                        observed.fetch_add(1, Ordering::SeqCst);
                        assert!(!headers.contains_key(header::AUTHORIZATION));
                        assert!(!headers.contains_key(header::COOKIE));
                        "done"
                    }
                }),
            )
            .route(
                "/mcp",
                axum::routing::post(|headers: HeaderMap| async move {
                    assert_eq!(headers[header::AUTHORIZATION], "Bearer fixture-remote-only");
                    (StatusCode::TEMPORARY_REDIRECT, [("location", "/finish")])
                }),
            );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let http = SafeHttp::test_fixture(Url::parse(&origin).unwrap()).unwrap();
        assert_eq!(
            http.get(&format!("{origin}/start")).await.unwrap().body,
            b"done"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(matches!(
            http.get(&format!("{origin}/escape")).await,
            Err(McpError {
                category: ErrorCategory::UnsafeNetwork,
                ..
            })
        ));
        let endpoint = format!("{origin}/mcp");
        let bearer = RemoteBearer::new("fixture-remote-only".into(), &endpoint).unwrap();
        assert_eq!(
            http.post_json(
                &endpoint,
                &serde_json::json!({}),
                Some(&bearer),
                HeaderMap::new()
            )
            .await
            .unwrap()
            .status,
            307
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(
            http.post_json(
                &format!("{origin}/finish"),
                &serde_json::json!({}),
                Some(&bearer),
                HeaderMap::new()
            )
            .await
            .is_err()
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer must-not-forward"),
        );
        assert!(
            http.get_with_headers(&format!("{origin}/finish"), headers)
                .await
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        server.abort();
    }
}
