use std::collections::HashSet;

use reqwest::{Url, header};
use scraper::{Html, Selector};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    network::{HttpResponse, SafeHttp},
    protocol::bounded_json,
    types::{
        CARD_SCHEMA, Candidate, EntryKind, ErrorCategory, McpError, McpResult, PROTOCOL_VERSION,
    },
};

const CARD_TYPE: &str = "application/mcp-server-card+json";
const CATALOG_TYPE: &str = "application/ai-catalog+json";
const MAX_CANDIDATES: usize = 32;

fn discovery_error() -> McpError {
    McpError::new(
        "MCP_DISCOVERY_FAILED",
        ErrorCategory::Discovery,
        "No supported plugin discovery document was found at this address.",
    )
}
fn text(value: Option<&Value>, max: usize) -> McpResult<&str> {
    value
        .and_then(Value::as_str)
        .filter(|value| {
            !value.trim().is_empty()
                && value.chars().count() <= max
                && !value.chars().any(char::is_control)
        })
        .ok_or_else(discovery_error)
}
fn successful(response: &HttpResponse) -> McpResult<()> {
    if !(200..300).contains(&response.status) {
        return Err(discovery_error().with_status(response.status));
    }
    Ok(())
}

pub fn parse_card(
    http: &SafeHttp,
    card_url: &str,
    resolved_url: &str,
    discovery_url: &str,
    card: Value,
) -> McpResult<Candidate> {
    bounded_json(&card, 65536, 20, 4096)?;
    if card.get("$schema").and_then(Value::as_str) != Some(CARD_SCHEMA) {
        return Err(McpError::unsupported());
    }
    let name = text(card.get("name"), 200)?;
    let (namespace, short_name) = name.split_once('/').ok_or_else(discovery_error)?;
    if namespace.is_empty()
        || short_name.is_empty()
        || !namespace
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
        || !short_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(discovery_error());
    }
    let version = text(card.get("version"), 255)?;
    if version.bytes().any(|byte| b"^~<>*=|".contains(&byte))
        || version.split('.').any(|part| part == "x" || part == "X")
    {
        return Err(discovery_error());
    }
    let description = text(card.get("description"), 100)?;
    let title = card
        .get("title")
        .map(|title| text(Some(title), 100))
        .transpose()?
        .unwrap_or(name);
    if card.get("_meta").is_some_and(|value| !value.is_object()) {
        return Err(discovery_error());
    }
    if let Some(website) = card.get("websiteUrl") {
        Url::parse(text(Some(website), 8192)?).map_err(|_| discovery_error())?;
    }
    if let Some(repository) = card.get("repository") {
        Url::parse(text(repository.get("url"), 8192)?).map_err(|_| discovery_error())?;
        text(repository.get("source"), 128)?;
        if let Some(folder) = repository.get("subfolder") {
            let folder = text(Some(folder), 512)?;
            if folder.starts_with('/')
                || folder.contains('\\')
                || folder
                    .split('/')
                    .any(|part| part == ".." || part.is_empty())
            {
                return Err(discovery_error());
            }
        }
    }
    if let Some(icons) = card.get("icons") {
        let icons = icons
            .as_array()
            .filter(|icons| icons.len() <= 8)
            .ok_or_else(discovery_error)?;
        for icon in icons {
            Url::parse(text(icon.get("src"), 8192)?).map_err(|_| discovery_error())?;
            if let Some(mime) = icon.get("mimeType") {
                text(Some(mime), 128)?;
            }
            if icon
                .get("theme")
                .is_some_and(|value| !matches!(value.as_str(), Some("light" | "dark")))
            {
                return Err(discovery_error());
            }
            if let Some(sizes) = icon.get("sizes") {
                let sizes = sizes
                    .as_array()
                    .filter(|values| values.len() <= 16)
                    .ok_or_else(discovery_error)?;
                for size in sizes {
                    let size = text(Some(size), 32)?;
                    if size != "any"
                        && !size.split_once('x').is_some_and(|(width, height)| {
                            !width.is_empty()
                                && !height.is_empty()
                                && width.bytes().all(|byte| byte.is_ascii_digit())
                                && height.bytes().all(|byte| byte.is_ascii_digit())
                        })
                    {
                        return Err(discovery_error());
                    }
                }
            }
        }
    }
    let remotes = card
        .get("remotes")
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty() && values.len() <= 8)
        .ok_or_else(discovery_error)?;
    let mut endpoint = None;
    for remote in remotes {
        if remote.get("type").and_then(Value::as_str) != Some("streamable-http") {
            continue;
        }
        let Some(versions) = remote
            .get("supportedProtocolVersions")
            .and_then(Value::as_array)
        else {
            continue;
        };
        if versions.len() > 16 || !versions.iter().all(Value::is_string) {
            return Err(discovery_error());
        }
        if !versions
            .iter()
            .any(|version| version.as_str() == Some(PROTOCOL_VERSION))
        {
            continue;
        }
        if remote
            .get("headers")
            .is_some_and(|value| value.as_array().is_none_or(|values| !values.is_empty()))
            || remote
                .get("variables")
                .is_some_and(|value| value.as_object().is_none_or(|values| !values.is_empty()))
        {
            continue;
        }
        let candidate = http.canonical_url(text(remote.get("url"), 8192)?)?;
        endpoint.get_or_insert(candidate);
    }
    let endpoint_url = endpoint.ok_or_else(McpError::unsupported)?;
    let card_url = http.canonical_url(card_url)?;
    let resolved_url = http.canonical_url(resolved_url)?;
    let card_origin = Url::parse(&resolved_url)
        .map_err(|_| discovery_error())?
        .origin()
        .ascii_serialization();
    let fingerprint_input = json!({"card_url": card_url, "resolved_url": resolved_url, "endpoint_url": endpoint_url, "card": card});
    let digest =
        Sha256::digest(serde_json::to_vec(&fingerprint_input).map_err(|_| discovery_error())?);
    let fingerprint = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(Candidate {
        card_url,
        discovery_url: discovery_url.to_owned(),
        card_origin,
        endpoint_url,
        name: name.to_owned(),
        title: title.to_owned(),
        version: version.to_owned(),
        description: description.to_owned(),
        fingerprint,
        card_json: card,
    })
}

pub async fn fetch_card(http: &SafeHttp, card_url: &str) -> McpResult<Candidate> {
    let response = http.get(card_url).await?;
    successful(&response)?;
    if !response.media_type().eq_ignore_ascii_case(CARD_TYPE) {
        return Err(discovery_error());
    }
    parse_card(
        http,
        card_url,
        &response.final_url,
        card_url,
        response.json()?,
    )
}

fn catalog_urls(http: &SafeHttp, value: &Value) -> McpResult<Vec<String>> {
    bounded_json(value, 256 * 1024, 20, 8192)?;
    if value.get("specVersion").and_then(Value::as_str) != Some("1.0") {
        return Err(McpError::unsupported());
    }
    let entries = value
        .get("entries")
        .and_then(Value::as_array)
        .filter(|values| values.len() <= 128)
        .ok_or_else(discovery_error)?;
    let mut urls = Vec::new();
    let mut seen = HashSet::new();
    for entry in entries {
        text(entry.get("identifier"), 1024)?;
        let kind = text(entry.get("type"), 128)?;
        if entry.get("url").is_some() == entry.get("data").is_some() {
            return Err(discovery_error());
        }
        if kind != CARD_TYPE {
            continue;
        }
        // Q's selected profile requires independent Card URLs; inline cards are not silently adopted.
        let url = http.canonical_url(text(entry.get("url"), 8192)?)?;
        if seen.insert(url.clone()) {
            urls.push(url);
        }
        if urls.len() > MAX_CANDIDATES {
            return Err(McpError::limit());
        }
    }
    Ok(urls)
}

fn link_parts(value: &str) -> McpResult<Vec<&str>> {
    let mut quoted = false;
    let mut angle = false;
    let mut escaped = false;
    let mut start = 0;
    let mut parts = Vec::new();
    for (index, ch) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quoted && ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' && !angle {
            quoted = !quoted;
        }
        if !quoted {
            if ch == '<' {
                angle = true;
            }
            if ch == '>' {
                angle = false;
            }
            if ch == ',' && !angle {
                parts.push(value[start..index].trim());
                start = index + 1;
            }
        }
    }
    if quoted || angle {
        return Err(discovery_error());
    }
    parts.push(value[start..].trim());
    if parts.len() > 32 {
        return Err(McpError::limit());
    }
    Ok(parts)
}

fn page_catalogs(http: &SafeHttp, response: &HttpResponse) -> McpResult<Vec<String>> {
    let base = Url::parse(&response.final_url).map_err(|_| discovery_error())?;
    let mut links = Vec::new();
    for value in response.headers.get_all(header::LINK) {
        let value = value.to_str().map_err(|_| discovery_error())?;
        if value.len() > 16384 {
            return Err(McpError::limit());
        }
        for part in link_parts(value)? {
            let Some(rest) = part.strip_prefix('<') else {
                continue;
            };
            let Some((href, parameters)) = rest.split_once('>') else {
                continue;
            };
            let mut relation = false;
            let mut anchored = false;
            for parameter in parameters.split(';') {
                if let Some((name, value)) = parameter.trim().split_once('=') {
                    if name.eq_ignore_ascii_case("rel") {
                        relation = value
                            .trim()
                            .trim_matches('"')
                            .split_ascii_whitespace()
                            .any(|rel| rel.eq_ignore_ascii_case("ai-catalog"));
                    }
                    if name.eq_ignore_ascii_case("anchor") {
                        anchored = true;
                    }
                }
            }
            if relation && !anchored {
                links.push(
                    http.canonical_url(base.join(href).map_err(|_| discovery_error())?.as_str())?,
                );
            }
        }
    }
    if links.is_empty()
        && matches!(
            response.media_type().to_ascii_lowercase().as_str(),
            "text/html" | "application/xhtml+xml"
        )
    {
        if response.body.len() > 512 * 1024 {
            return Err(McpError::limit());
        }
        let html = std::str::from_utf8(&response.body).map_err(|_| discovery_error())?;
        let document = Html::parse_document(html);
        let base_selector = Selector::parse("head base[href]").map_err(|_| discovery_error())?;
        let document_base = document
            .select(&base_selector)
            .next()
            .and_then(|node| node.value().attr("href"))
            .map(|href| base.join(href))
            .transpose()
            .map_err(|_| discovery_error())?
            .unwrap_or(base);
        let selector = Selector::parse("head link[rel][href]").map_err(|_| discovery_error())?;
        for node in document.select(&selector) {
            if node
                .value()
                .attr("rel")
                .unwrap_or("")
                .split_ascii_whitespace()
                .any(|rel| rel.eq_ignore_ascii_case("ai-catalog"))
            {
                links.push(
                    http.canonical_url(
                        document_base
                            .join(node.value().attr("href").unwrap_or(""))
                            .map_err(|_| discovery_error())?
                            .as_str(),
                    )?,
                );
            }
        }
    }
    let mut seen = HashSet::new();
    links.retain(|url| seen.insert(url.clone()));
    if links.is_empty() {
        return Err(discovery_error());
    }
    if links.len() > 4 {
        return Err(McpError::limit());
    }
    Ok(links)
}

pub async fn discover_entry(
    http: &SafeHttp,
    entry: &str,
    kind: EntryKind,
) -> McpResult<Vec<Candidate>> {
    tokio::time::timeout(
        std::time::Duration::from_secs(60),
        discover_inner(http, entry, kind),
    )
    .await
    .map_err(|_| McpError::timeout())?
}

async fn discover_inner(
    http: &SafeHttp,
    entry: &str,
    kind: EntryKind,
) -> McpResult<Vec<Candidate>> {
    if kind == EntryKind::Card {
        return Ok(vec![fetch_card(http, entry).await?]);
    }
    let catalog_addresses = match kind {
        EntryKind::Domain => {
            let value = if entry.contains("://") {
                entry.to_owned()
            } else {
                format!("https://{entry}")
            };
            let mut base =
                Url::parse(&http.canonical_url(&value)?).map_err(|_| discovery_error())?;
            if base.path() != "/" || base.query().is_some() {
                return Err(discovery_error());
            }
            base.set_path("/.well-known/ai-catalog.json");
            vec![base.to_string()]
        }
        EntryKind::Page => {
            let response = http.get(entry).await?;
            successful(&response)?;
            page_catalogs(http, &response)?
        }
        EntryKind::Catalog => vec![http.canonical_url(entry)?],
        EntryKind::Card => unreachable!(),
    };
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for catalog_url in catalog_addresses {
        let response = http.get(&catalog_url).await?;
        successful(&response)?;
        if !response.media_type().eq_ignore_ascii_case(CATALOG_TYPE) {
            return Err(discovery_error());
        }
        for card_url in catalog_urls(http, &response.json()?)? {
            if !seen.insert(card_url.clone()) {
                continue;
            }
            if candidates.len() >= MAX_CANDIDATES {
                return Err(McpError::limit());
            }
            let mut candidate = fetch_card(http, &card_url).await?;
            candidate.discovery_url = response.final_url.clone();
            candidates.push(candidate);
        }
    }
    Ok(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(endpoint: &str) -> Value {
        json!({"$schema":CARD_SCHEMA,"name":"com.example/weather","version":"1.0.0","description":"Weather tools","remotes":[{"type":"streamable-http","url":endpoint,"supportedProtocolVersions":[PROTOCOL_VERSION]}]})
    }
    fn response(media: &str, body: &str, url: &str) -> HttpResponse {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_str(media).unwrap(),
        );
        HttpResponse {
            status: 200,
            headers,
            body: body.as_bytes().to_vec(),
            final_url: url.into(),
        }
    }

    #[test]
    fn card_profile_and_identity_do_not_merge_same_names() {
        let http = SafeHttp::default();
        let first = parse_card(
            &http,
            "https://example.com/Card?x=2&x=1",
            "https://example.com/Card?x=2&x=1",
            "https://example.com/catalog",
            card("https://example.com/mcp"),
        )
        .unwrap();
        let second = parse_card(
            &http,
            "https://example.com/Other",
            "https://example.com/Other",
            "https://example.com/catalog",
            card("https://example.com/mcp"),
        )
        .unwrap();
        assert_ne!(first.card_url, second.card_url);
        assert_ne!(first.fingerprint, second.fingerprint);
        assert!(first.card_url.ends_with("?x=2&x=1"));
        let mut legacy = card("https://example.com/mcp");
        legacy["remotes"][0]["supportedProtocolVersions"] = json!(["2025-11-25"]);
        assert!(
            parse_card(
                &http,
                "https://example.com/card",
                "https://example.com/card",
                "https://example.com/card",
                legacy
            )
            .is_err()
        );
        assert!(
            parse_card(
                &http,
                "https://example.com/card",
                "https://example.com/card",
                "https://example.com/card",
                card("https://127.0.0.1/mcp")
            )
            .is_err()
        );
    }

    #[test]
    fn catalog_profile_preserves_duplicate_queries_and_requires_independent_urls() {
        let http = SafeHttp::default();
        let catalog = json!({"specVersion":"1.0","entries":[{"identifier":"opaque","type":CARD_TYPE,"url":"https://example.com/Card?x=2&x=1"},{"identifier":"opaque-2","type":CARD_TYPE,"url":"https://example.com/card?x=1&x=2"}]});
        let urls = catalog_urls(&http, &catalog).unwrap();
        assert_eq!(urls.len(), 2);
        assert!(urls[0].ends_with("Card?x=2&x=1"));
        let inline = json!({"specVersion":"1.0","entries":[{"identifier":"inline","type":CARD_TYPE,"data":card("https://example.com/mcp")}]});
        assert!(catalog_urls(&http, &inline).is_err());
    }

    #[test]
    fn page_discovery_is_static_and_keeps_the_specific_path() {
        let http = SafeHttp::default();
        let html = r#"<html><head><script>document.write('<link rel="ai-catalog" href="/wrong.json">')</script><link rel="other ai-catalog" href="../catalog.json?a=2&amp;a=1"></head></html>"#;
        let links = page_catalogs(
            &http,
            &response(
                "text/html",
                html,
                "https://example.com/plugins/tool/index.html",
            ),
        )
        .unwrap();
        assert_eq!(
            links,
            vec!["https://example.com/plugins/catalog.json?a=2&a=1"]
        );
        let no_link = response(
            "text/html",
            "<script>fetch('/catalog')</script>",
            "https://example.com/specific/page",
        );
        assert!(page_catalogs(&http, &no_link).is_err());
        let mut header_link = no_link;
        header_link.headers.insert(
            header::LINK,
            reqwest::header::HeaderValue::from_static(
                "</wrong>; rel=preload, <../chosen?x=a,b>; rel=\"ai-catalog\"",
            ),
        );
        assert_eq!(
            page_catalogs(&http, &header_link).unwrap(),
            vec!["https://example.com/chosen?x=a,b"]
        );
    }

    #[tokio::test]
    async fn all_four_entry_types_read_real_fixture_documents_without_bulk_add() {
        use axum::{Router, http::HeaderValue, response::IntoResponse, routing::get};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let card_body = card(&format!("{origin}/mcp")).to_string();
        let catalog_body = json!({"specVersion":"1.0","entries":[{"identifier":"first","type":CARD_TYPE,"url":format!("{origin}/card?x=2&x=1")},{"identifier":"second","type":CARD_TYPE,"url":format!("{origin}/card?x=1&x=2")}]}).to_string();
        let catalog = move || {
            let body = catalog_body.clone();
            async move {
                (
                    [(header::CONTENT_TYPE, HeaderValue::from_static(CATALOG_TYPE))],
                    body,
                )
                    .into_response()
            }
        };
        let app = Router::new()
            .route(
                "/card",
                get(move || {
                    let body = card_body.clone();
                    async move {
                        (
                            [(header::CONTENT_TYPE, HeaderValue::from_static(CARD_TYPE))],
                            body,
                        )
                            .into_response()
                    }
                }),
            )
            .route("/catalog", get(catalog.clone()))
            .route("/.well-known/ai-catalog.json", get(catalog))
            .route(
                "/landing/tool",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "text/html")],
                        "<head><link rel='ai-catalog' href='/catalog'></head>",
                    )
                }),
            );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let http = SafeHttp::test_fixture(Url::parse(&origin).unwrap()).unwrap();
        for (entry, kind, count) in [
            (origin.clone(), EntryKind::Domain, 2),
            (format!("{origin}/landing/tool"), EntryKind::Page, 2),
            (format!("{origin}/catalog"), EntryKind::Catalog, 2),
            (format!("{origin}/card"), EntryKind::Card, 1),
        ] {
            let candidates = discover_entry(&http, &entry, kind).await.unwrap();
            assert_eq!(candidates.len(), count);
            assert!(
                candidates
                    .iter()
                    .all(|candidate| candidate.name == "com.example/weather")
            );
        }
        server.abort();
    }
}
