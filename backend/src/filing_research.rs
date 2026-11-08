//! Bounded SEC primary-document research. Source text is evidence, never executable UI.
use crate::{
    AppState,
    error::{ApiError, ApiResult},
};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    routing::get,
};
use chrono::NaiveDate;
use futures_util::StreamExt;
use scraper::{Html, Node};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};

pub const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_HTML_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PARAGRAPHS: usize = 2_000;
pub const MAX_TEXT_CHARS: usize = 500_000;
pub const PAGE_PARAGRAPHS: usize = 80;
pub const PAGE_TEXT_CHARS: usize = 60_000;
const MAX_PARAGRAPH_CHARS: usize = 8_000;
const MAX_NODES: usize = 200_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DocumentFormat {
    Html,
    Pdf,
    Unsupported,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FilingSummary {
    pub accession: String,
    pub form: String,
    pub filed_at: String,
    pub report_date: Option<String>,
    pub document_name: String,
    pub document_url: String,
    pub format: DocumentFormat,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FilingCatalog {
    pub version: u8,
    pub issuer_id: String,
    pub cik: String,
    pub company_name: String,
    pub fetched_at: String,
    pub filings: Vec<FilingSummary>,
    pub total: usize,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ParagraphKind {
    Text,
    Table,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FilingParagraph {
    pub id: String,
    pub text: String,
    pub kind: ParagraphKind,
    pub section_id: String,
    pub source_url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FilingSection {
    pub id: String,
    pub title: String,
    pub start_paragraph: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FilingDocument {
    pub version: u8,
    pub issuer_id: String,
    pub cik: String,
    pub company_name: String,
    pub filing: FilingSummary,
    pub fetched_at: String,
    pub status: String,
    pub sha256: Option<String>,
    pub content_type: Option<String>,
    pub sections: Vec<FilingSection>,
    pub paragraphs: Vec<FilingParagraph>,
    pub offset: usize,
    pub next_offset: Option<usize>,
    pub total_paragraphs: usize,
    pub truncated: bool,
    pub limitations: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FilingError {
    InvalidInput,
    InvalidSource,
    TooLarge,
    NotFound,
    Unavailable,
    Timeout,
    RateLimited,
    DocumentChanged,
}

#[derive(Clone)]
struct VerifiedFilings {
    cik: String,
    company_name: String,
    fetched_at: String,
    filings: Vec<FilingSummary>,
}

pub fn valid_cik(cik: &str) -> bool {
    cik.len() == 10 && cik.bytes().all(|c| c.is_ascii_digit()) && cik != "0000000000"
}
pub fn valid_accession(value: &str) -> bool {
    value.len() == 20
        && value.bytes().enumerate().all(|(i, c)| {
            if i == 10 || i == 13 {
                c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}
fn supported_form(form: &str) -> bool {
    matches!(
        form.strip_suffix("/A").unwrap_or(form),
        "10-K" | "10-Q" | "20-F" | "40-F" | "8-K" | "6-K"
    )
}
fn valid_date(value: &str) -> bool {
    value.len() == 10
        && NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok_and(|v| v.to_string() == value)
}
fn safe_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 240
        && !value.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}
fn safe_document_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && !value.contains("..")
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_'))
}
fn document_url(cik: &str, accession: &str, name: &str) -> String {
    format!(
        "https://www.sec.gov/Archives/edgar/data/{}/{}/{}",
        cik.trim_start_matches('0'),
        accession.replace('-', ""),
        name
    )
}
fn array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, FilingError> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or(FilingError::InvalidSource)
}
fn parse_filings(
    bytes: &[u8],
    cik: &str,
    fetched_at: String,
) -> Result<VerifiedFilings, FilingError> {
    if !valid_cik(cik) {
        return Err(FilingError::InvalidInput);
    }
    if bytes.len() > MAX_JSON_BYTES {
        return Err(FilingError::TooLarge);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| FilingError::InvalidSource)?;
    let actual_cik = value
        .get("cik")
        .and_then(|v| {
            v.as_str()
                .map(str::to_owned)
                .or_else(|| v.as_u64().map(|v| v.to_string()))
        })
        .ok_or(FilingError::InvalidSource)?;
    if actual_cik.trim_start_matches('0') != cik.trim_start_matches('0') {
        return Err(FilingError::InvalidSource);
    }
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|v| safe_name(v))
        .ok_or(FilingError::InvalidSource)?;
    let recent = value
        .pointer("/filings/recent")
        .ok_or(FilingError::InvalidSource)?;
    let forms = array(recent, "form")?;
    let accessions = array(recent, "accessionNumber")?;
    let filed = array(recent, "filingDate")?;
    let periods = array(recent, "reportDate")?;
    let names = array(recent, "primaryDocument")?;
    if forms.len() > 2_000
        || [accessions.len(), filed.len(), periods.len(), names.len()]
            .iter()
            .any(|n| *n != forms.len())
    {
        return Err(FilingError::InvalidSource);
    }
    let mut filings = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for i in 0..forms.len() {
        let (Some(form), Some(accession), Some(date), Some(file)) = (
            forms[i].as_str(),
            accessions[i].as_str(),
            filed[i].as_str(),
            names[i].as_str(),
        ) else {
            continue;
        };
        if !supported_form(form)
            || !valid_accession(accession)
            || !valid_date(date)
            || !safe_document_name(file)
            || !seen.insert(accession.to_owned())
        {
            continue;
        }
        let report_date = match periods[i].as_str() {
            Some("") | None => None,
            Some(v) if valid_date(v) => Some(v.to_owned()),
            _ => continue,
        };
        let ext = file
            .rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        filings.push(FilingSummary {
            accession: accession.into(),
            form: form.into(),
            filed_at: date.into(),
            report_date,
            document_name: file.into(),
            document_url: document_url(cik, accession, file),
            format: match ext.as_str() {
                "htm" | "html" => DocumentFormat::Html,
                "pdf" => DocumentFormat::Pdf,
                _ => DocumentFormat::Unsupported,
            },
        });
    }
    filings.sort_by(|a, b| {
        b.filed_at
            .cmp(&a.filed_at)
            .then_with(|| b.accession.cmp(&a.accession))
    });
    Ok(VerifiedFilings {
        cik: cik.into(),
        company_name: name.into(),
        fetched_at,
        filings,
    })
}

fn hidden(element: &scraper::node::Element) -> bool {
    if matches!(
        element.name(),
        "head"
            | "script"
            | "style"
            | "noscript"
            | "svg"
            | "template"
            | "ix:hidden"
            | "ix:header"
            | "xbrli:context"
            | "xbrli:unit"
    ) || element.attr("hidden").is_some()
        || element
            .attr("aria-hidden")
            .is_some_and(|v| v.eq_ignore_ascii_case("true"))
    {
        return true;
    }
    let style = element
        .attr("style")
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    style
        .split(';')
        .any(|rule| rule.starts_with("display:none") || rule.starts_with("visibility:hidden"))
}
fn block(name: &str) -> bool {
    matches!(
        name,
        "p" | "div"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "li"
            | "tr"
            | "blockquote"
            | "pre"
            | "body"
    )
}
fn safe_anchor(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.' | b':'))
}
fn normalize(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() || c.is_whitespace())
        .filter(|c| !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

struct Extracted {
    sections: Vec<FilingSection>,
    paragraphs: Vec<FilingParagraph>,
    truncated: bool,
    split: bool,
    has_tables: bool,
    total_chars: usize,
}
impl Extracted {
    fn push(
        &mut self,
        raw: &str,
        kind: ParagraphKind,
        anchor: &str,
        url: &str,
        heading: bool,
        only_link: bool,
    ) {
        let text = normalize(raw);
        if text.is_empty() || self.truncated {
            return;
        }
        let chars: Vec<char> = text.chars().collect();
        if self.paragraphs.len() >= MAX_PARAGRAPHS
            || self.total_chars + chars.len().min(MAX_PARAGRAPH_CHARS) > MAX_TEXT_CHARS
        {
            self.truncated = true;
            return;
        }
        let is_item = text.to_ascii_lowercase().starts_with("item ") && text.chars().count() < 200;
        if !only_link
            && (heading || is_item)
            && kind == ParagraphKind::Text
            && self.sections.len() < 100
        {
            self.sections.push(FilingSection {
                id: format!("s{:04}", self.sections.len()),
                title: text.chars().take(240).collect(),
                start_paragraph: self.paragraphs.len(),
            });
        }
        if self.sections.is_empty() {
            self.sections.push(FilingSection {
                id: "s0000".into(),
                title: "Document text".into(),
                start_paragraph: 0,
            });
        }
        let section_id = self.sections.last().expect("section exists").id.clone();
        self.split |= chars.len() > MAX_PARAGRAPH_CHARS;
        self.has_tables |= kind == ParagraphKind::Table;
        let source_url = if anchor.is_empty() {
            url.into()
        } else {
            format!("{url}#{anchor}")
        };
        for chunk in chars.chunks(MAX_PARAGRAPH_CHARS) {
            if self.paragraphs.len() >= MAX_PARAGRAPHS
                || self.total_chars + chunk.len() > MAX_TEXT_CHARS
            {
                self.truncated = true;
                break;
            }
            self.paragraphs.push(FilingParagraph {
                id: format!("p{:06}", self.paragraphs.len()),
                text: chunk.iter().collect(),
                kind: kind.clone(),
                section_id: section_id.clone(),
                source_url: source_url.clone(),
            });
            self.total_chars += chunk.len();
        }
    }
}

fn extract_html(bytes: &[u8], url: &str) -> Result<Extracted, FilingError> {
    if bytes.len() > MAX_HTML_BYTES || bytes.iter().filter(|b| **b == b'<').count() > MAX_NODES {
        return Err(FilingError::TooLarge);
    }
    let source = std::str::from_utf8(bytes).map_err(|_| FilingError::InvalidSource)?;
    let html = Html::parse_document(source);
    let mut result = Extracted {
        sections: vec![],
        paragraphs: vec![],
        truncated: false,
        split: false,
        has_tables: false,
        total_chars: 0,
    };
    let mut last_block = None;
    let mut last_cell = None;
    let mut text = String::new();
    let mut anchor = String::new();
    let mut active_anchor = String::new();
    let mut kind = ParagraphKind::Text;
    let mut heading = false;
    let mut only_link = true;
    for (index, node) in html.tree.root().descendants().enumerate() {
        if index > MAX_NODES {
            return Err(FilingError::TooLarge);
        }
        let ancestors = node.ancestors().take(129).collect::<Vec<_>>();
        if ancestors.len() > 128 {
            return Err(FilingError::TooLarge);
        }
        if ancestors
            .iter()
            .any(|n| n.value().as_element().is_some_and(hidden))
        {
            continue;
        }
        match node.value() {
            Node::Element(element) => {
                if hidden(element) {
                    continue;
                }
                if let Some(id) = element.attr("id").or_else(|| element.attr("name"))
                    && safe_anchor(id)
                {
                    active_anchor = id.to_owned();
                }
                if element.name() == "br" {
                    text.push(' ');
                }
            }
            Node::Text(value) => {
                if value.trim().is_empty() {
                    text.push(' ');
                    continue;
                }
                let current = ancestors
                    .iter()
                    .find(|n| n.value().as_element().is_some_and(|e| e.name() == "tr"))
                    .or_else(|| {
                        ancestors
                            .iter()
                            .find(|n| n.value().as_element().is_some_and(|e| block(e.name())))
                    });
                let Some(current) = current else {
                    continue;
                };
                if last_block != Some(current.id()) {
                    result.push(&text, kind.clone(), &anchor, url, heading, only_link);
                    if result.truncated {
                        break;
                    }
                    text.clear();
                    last_cell = None;
                    last_block = Some(current.id());
                    only_link = true;
                    let tag = current.value().as_element().expect("element").name();
                    kind = if tag == "tr" {
                        ParagraphKind::Table
                    } else {
                        ParagraphKind::Text
                    };
                    heading = matches!(tag, "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
                    anchor = ancestors
                        .iter()
                        .filter_map(|n| n.value().as_element().and_then(|e| e.attr("id")))
                        .find(|id| safe_anchor(id))
                        .map(str::to_owned)
                        .unwrap_or_else(|| active_anchor.clone());
                }
                only_link &= ancestors.iter().any(|n| {
                    n.value()
                        .as_element()
                        .is_some_and(|e| e.name() == "a" && e.attr("href").is_some())
                });
                let cell = ancestors
                    .iter()
                    .find(|n| {
                        n.value()
                            .as_element()
                            .is_some_and(|e| matches!(e.name(), "td" | "th"))
                    })
                    .map(|n| n.id());
                if cell.is_some() && cell != last_cell && !text.trim().is_empty() {
                    text.push_str(" | ");
                }
                last_cell = cell;
                text.push_str(value);
                if text.len() > MAX_HTML_BYTES {
                    return Err(FilingError::TooLarge);
                }
            }
            _ => {}
        }
    }
    result.push(&text, kind, &anchor, url, heading, only_link);
    if result.paragraphs.is_empty() {
        return Err(FilingError::InvalidSource);
    }
    Ok(result)
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub struct FilingResponse {
    pub status: u16,
    pub content_type: String,
    pub bytes: Vec<u8>,
    pub retry_after: Option<String>,
}
pub trait FilingFetcher: Send + Sync {
    fn fetch<'a>(
        &'a self,
        url: &'a str,
        limit: usize,
    ) -> Pin<Box<dyn Future<Output = Result<FilingResponse, FilingError>> + Send + 'a>>;
}
struct SecFetcher;
impl FilingFetcher for SecFetcher {
    fn fetch<'a>(
        &'a self,
        url: &'a str,
        limit: usize,
    ) -> Pin<Box<dyn Future<Output = Result<FilingResponse, FilingError>> + Send + 'a>> {
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(15), async {
                let parsed = reqwest::Url::parse(url).map_err(|_| FilingError::InvalidInput)?;
                let host = parsed.host_str().ok_or(FilingError::InvalidInput)?;
                if parsed.scheme() != "https"
                    || !["data.sec.gov", "www.sec.gov"].contains(&host)
                    || parsed.port().is_some()
                    || !parsed.username().is_empty()
                    || parsed.password().is_some()
                    || parsed.query().is_some()
                    || parsed.fragment().is_some()
                {
                    return Err(FilingError::InvalidInput);
                }
                let addresses = tokio::net::lookup_host((host, 443))
                    .await
                    .map_err(|_| FilingError::Unavailable)?
                    .collect::<Vec<_>>();
                if addresses.is_empty()
                    || addresses
                        .iter()
                        .any(|a| !crate::plugins::network::is_public_address(a.ip()))
                {
                    return Err(FilingError::Unavailable);
                }
                let client = reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(Duration::from_secs(5))
                    .timeout(Duration::from_secs(15))
                    .user_agent("Q-Public-Research/1 (+https://q.kaicloudpay.com)")
                    .resolve_to_addrs(host, &addresses)
                    .build()
                    .map_err(|_| FilingError::Unavailable)?;
                let response = client
                    .get(parsed.clone())
                    .header(header::ACCEPT, "application/json,text/html")
                    .send()
                    .await
                    .map_err(|e| {
                        if e.is_timeout() {
                            FilingError::Timeout
                        } else {
                            FilingError::Unavailable
                        }
                    })?;
                if response.url() != &parsed || response.status().is_redirection() {
                    return Err(FilingError::Unavailable);
                }
                let status = response.status().as_u16();
                let retry_after = response
                    .headers()
                    .get(header::RETRY_AFTER)
                    .and_then(|s| s.to_str().ok())
                    .filter(|s| s.len() <= 128)
                    .map(str::to_owned);
                let content_type = response
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|s| s.to_str().ok())
                    .unwrap_or_default()
                    .split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase();
                if status != 200 {
                    return Ok(FilingResponse {
                        status,
                        content_type,
                        bytes: vec![],
                        retry_after,
                    });
                }
                if response.content_length().is_some_and(|n| n > limit as u64) {
                    return Err(FilingError::TooLarge);
                }
                let mut bytes = Vec::new();
                let mut stream = response.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|e| {
                        if e.is_timeout() {
                            FilingError::Timeout
                        } else {
                            FilingError::Unavailable
                        }
                    })?;
                    if bytes.len().saturating_add(chunk.len()) > limit {
                        return Err(FilingError::TooLarge);
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok(FilingResponse {
                    status,
                    content_type,
                    bytes,
                    retry_after,
                })
            })
            .await
            .unwrap_or(Err(FilingError::Timeout))
        })
    }
}
enum CachedValue {
    Directory(VerifiedFilings),
    Document(Box<FilingDocument>),
}
struct Cached {
    value: Arc<CachedValue>,
    inserted: Instant,
    bytes: usize,
}
struct Dispatch {
    next: Instant,
    blocked_until: Instant,
}
pub struct FilingRuntime {
    fetcher: Arc<dyn FilingFetcher>,
    dispatch: Mutex<Dispatch>,
    cache: Mutex<HashMap<String, Cached>>,
    admission: Semaphore,
    parse_admission: Arc<Semaphore>,
}
impl Default for FilingRuntime {
    fn default() -> Self {
        Self::new()
    }
}
impl FilingRuntime {
    pub fn new() -> Self {
        Self::create(Arc::new(SecFetcher))
    }
    fn create(fetcher: Arc<dyn FilingFetcher>) -> Self {
        Self {
            fetcher,
            dispatch: Mutex::new(Dispatch {
                next: Instant::now(),
                blocked_until: Instant::now(),
            }),
            cache: Mutex::new(HashMap::new()),
            admission: Semaphore::new(4),
            parse_admission: Arc::new(Semaphore::new(1)),
        }
    }
    #[cfg(any(test, feature = "plugin-test-fixtures"))]
    pub fn with_fetcher(fetcher: Arc<dyn FilingFetcher>) -> Self {
        Self::create(fetcher)
    }
    async fn cached(&self, key: &str) -> Option<Arc<CachedValue>> {
        let mut cache = self.cache.lock().await;
        cache.retain(|_, item| item.inserted.elapsed() < Duration::from_secs(300));
        cache.get(key).map(|item| item.value.clone())
    }
    async fn cache(&self, key: String, value: CachedValue, bytes: usize) -> Arc<CachedValue> {
        let value = Arc::new(value);
        if bytes > 8 * 1024 * 1024 {
            return value;
        }
        let mut cache = self.cache.lock().await;
        cache.remove(&key);
        while cache.len() >= 8
            || cache.values().map(|item| item.bytes).sum::<usize>() + bytes > 8 * 1024 * 1024
        {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, v)| v.inserted)
                .map(|(k, _)| k.clone())
            {
                cache.remove(&oldest);
            } else {
                break;
            }
        }
        cache.insert(
            key,
            Cached {
                value: value.clone(),
                inserted: Instant::now(),
                bytes,
            },
        );
        value
    }
    async fn fetch(&self, url: &str, limit: usize, mime: &str) -> Result<Vec<u8>, FilingError> {
        let mut dispatch = self.dispatch.lock().await;
        if Instant::now() < dispatch.blocked_until {
            return Err(FilingError::RateLimited);
        }
        if Instant::now() < dispatch.next {
            tokio::time::sleep_until(dispatch.next.into()).await;
        }
        dispatch.next = Instant::now() + Duration::from_secs(1);
        let response =
            tokio::time::timeout(Duration::from_secs(15), self.fetcher.fetch(url, limit))
                .await
                .unwrap_or(Err(FilingError::Timeout))?;
        if response.status == 429 {
            let seconds = response
                .retry_after
                .as_deref()
                .and_then(|v| {
                    v.parse::<u64>().ok().or_else(|| {
                        chrono::DateTime::parse_from_rfc2822(v).ok().map(|time| {
                            (time.timestamp() - chrono::Utc::now().timestamp()).max(0) as u64
                        })
                    })
                })
                .unwrap_or(60)
                .max(60);
            dispatch.blocked_until = Instant::now()
                .checked_add(Duration::from_secs(seconds))
                .unwrap_or(Instant::now() + Duration::from_secs(31_536_000));
            return Err(FilingError::RateLimited);
        }
        if response.status != 200 {
            return Err(FilingError::Unavailable);
        }
        if response.content_type != mime {
            return Err(FilingError::InvalidSource);
        }
        if response.bytes.len() > limit {
            return Err(FilingError::TooLarge);
        }
        Ok(response.bytes)
    }
    async fn directory(&self, cik: &str) -> Result<Arc<CachedValue>, FilingError> {
        let key = format!("directory:{cik}");
        if let Some(value) = self.cached(&key).await {
            return Ok(value);
        }
        let bytes = self
            .fetch(
                &format!("https://data.sec.gov/submissions/CIK{cik}.json"),
                MAX_JSON_BYTES,
                "application/json",
            )
            .await?;
        let directory = parse_filings(&bytes, cik, chrono::Utc::now().to_rfc3339())?;
        let weight = directory
            .filings
            .iter()
            .map(|f| f.document_name.len() + f.document_url.len() + 180)
            .sum::<usize>()
            + 1024;
        Ok(self
            .cache(key, CachedValue::Directory(directory), weight)
            .await)
    }
    pub async fn catalog(&self, issuer_id: &str) -> Result<FilingCatalog, FilingError> {
        let cik = issuer_id
            .strip_prefix("sec:")
            .filter(|v| valid_cik(v))
            .ok_or(FilingError::InvalidInput)?;
        let _permit = self
            .admission
            .try_acquire()
            .map_err(|_| FilingError::RateLimited)?;
        tokio::time::timeout(Duration::from_secs(35), async {
            let data = self.directory(cik).await?;
            let CachedValue::Directory(d) = data.as_ref() else {
                return Err(FilingError::InvalidSource);
            };
            Ok(FilingCatalog {
                version: 1,
                issuer_id: issuer_id.into(),
                cik: d.cik.clone(),
                company_name: d.company_name.clone(),
                fetched_at: d.fetched_at.clone(),
                total: d.filings.len(),
                truncated: d.filings.len() > 20,
                filings: d.filings.iter().take(20).cloned().collect(),
            })
        })
        .await
        .unwrap_or(Err(FilingError::Timeout))
    }
    pub async fn document(
        &self,
        cik: &str,
        accession: &str,
        offset: usize,
        expected_sha256: Option<&str>,
    ) -> Result<FilingDocument, FilingError> {
        if !valid_cik(cik)
            || !valid_accession(accession)
            || offset >= MAX_PARAGRAPHS
            || expected_sha256.is_some_and(|s| {
                s.len() != 64
                    || !s
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            })
            || offset > 0 && expected_sha256.is_none()
        {
            return Err(FilingError::InvalidInput);
        }
        let _permit = self
            .admission
            .try_acquire()
            .map_err(|_| FilingError::RateLimited)?;
        tokio::time::timeout(Duration::from_secs(35), async {
            // Membership is checked even when the parsed document is cached.
            let directory = self.directory(cik).await?;
            let CachedValue::Directory(d) = directory.as_ref() else { return Err(FilingError::InvalidSource); };
            let filing = d.filings.iter().find(|f| f.accession == accession).ok_or(FilingError::NotFound)?;
            if filing.format != DocumentFormat::Html {
                if offset != 0 || expected_sha256.is_some() { return Err(FilingError::InvalidInput); }
                return Ok(FilingDocument { version: 1, issuer_id: format!("sec:{cik}"), cik: cik.into(), company_name: d.company_name.clone(), filing: filing.clone(), fetched_at: d.fetched_at.clone(), status: "not_read".into(), sha256: None, content_type: None, sections: vec![], paragraphs: vec![], offset: 0, next_offset: None, total_paragraphs: 0, truncated: false, limitations: vec!["This primary document format is not supported; its text has not been read. Open the official source to inspect it.".into()] });
            }
            let key = format!("document:{cik}:{accession}:{}", filing.document_name);
            let cached = if let Some(cached) = self.cached(&key).await { cached } else {
                let bytes = self.fetch(&filing.document_url, MAX_HTML_BYTES, "text/html").await?;
                let parse_permit = self.parse_admission.clone().try_acquire_owned().map_err(|_| FilingError::RateLimited)?;
                let source_url = filing.document_url.clone();
                let (extracted, sha256) = tokio::task::spawn_blocking(move || {
                    let _permit = parse_permit;
                    extract_html(&bytes, &source_url).map(|extracted| (extracted, hash(&bytes)))
                }).await.map_err(|_| FilingError::InvalidSource)??;
                let mut limitations = vec!["Only this primary document was read; exhibits and incorporated documents were not followed.".into(), "Paragraph numbers are extraction positions, not source page numbers. Detected headings are navigation aids.".into()];
                if extracted.has_tables { limitations.push("Tables are transcribed as text rows; cell structure and numerical relationships may be lost. Use XBRL for financial calculations.".into()); }
                if extracted.split { limitations.push("Long source blocks were split into bounded extracted paragraphs.".into()); }
                if extracted.truncated { limitations.push("Extraction limits were reached; the remaining document text was not included.".into()); }
                let doc = FilingDocument { version: 1, issuer_id: format!("sec:{cik}"), cik: cik.into(), company_name: d.company_name.clone(), filing: filing.clone(), fetched_at: chrono::Utc::now().to_rfc3339(), status: "ready".into(), sha256: Some(sha256), content_type: Some("text/html".into()), total_paragraphs: extracted.paragraphs.len(), sections: extracted.sections, paragraphs: extracted.paragraphs, offset: 0, next_offset: None, truncated: extracted.truncated, limitations };
                let weight = serde_json::to_vec(&doc).map_err(|_| FilingError::InvalidSource)?.len();
                self.cache(key, CachedValue::Document(Box::new(doc)), weight).await
            };
            let CachedValue::Document(doc) = cached.as_ref() else { return Err(FilingError::InvalidSource); };
            if expected_sha256.is_some_and(|expected| doc.sha256.as_deref() != Some(expected)) { return Err(FilingError::DocumentChanged); }
            if offset >= doc.total_paragraphs { return Err(FilingError::InvalidInput); }
            let mut size = 0; let mut paragraphs = Vec::new();
            for p in doc.paragraphs.iter().skip(offset).take(PAGE_PARAGRAPHS) {
                let count = p.text.chars().count(); if size + count > PAGE_TEXT_CHARS { break; } size += count; paragraphs.push(p.clone());
            }
            let next = offset + paragraphs.len();
            Ok(FilingDocument { version: 1, issuer_id: doc.issuer_id.clone(), cik: doc.cik.clone(), company_name: doc.company_name.clone(), filing: doc.filing.clone(), fetched_at: doc.fetched_at.clone(), status: doc.status.clone(), sha256: doc.sha256.clone(), content_type: doc.content_type.clone(), sections: doc.sections.clone(), paragraphs, offset, next_offset: (next < doc.total_paragraphs).then_some(next), total_paragraphs: doc.total_paragraphs, truncated: doc.truncated, limitations: doc.limitations.clone() })
        }).await.unwrap_or(Err(FilingError::Timeout))
    }
}
impl From<FilingError> for ApiError {
    fn from(value: FilingError) -> Self {
        match value {
            FilingError::InvalidInput => Self::validation("Choose a valid SEC filing and page."),
            FilingError::InvalidSource => Self::new(
                StatusCode::BAD_GATEWAY,
                "RESEARCH_SOURCE_INVALID",
                "The public source could not be verified.",
            ),
            FilingError::TooLarge => Self::new(
                StatusCode::BAD_GATEWAY,
                "RESEARCH_SOURCE_TOO_LARGE",
                "The source exceeds the reading limit.",
            ),
            FilingError::NotFound => Self::new(
                StatusCode::NOT_FOUND,
                "RESEARCH_FILING_NOT_FOUND",
                "This filing is not in the verified recent filing window.",
            ),
            FilingError::Unavailable => Self::new(
                StatusCode::BAD_GATEWAY,
                "RESEARCH_SOURCE_UNAVAILABLE",
                "The public source is unavailable.",
            ),
            FilingError::Timeout => Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                "RESEARCH_SOURCE_TIMEOUT",
                "The public source timed out.",
            ),
            FilingError::RateLimited => Self::new(
                StatusCode::TOO_MANY_REQUESTS,
                "RESEARCH_SOURCE_RATE_LIMITED",
                "Too many research requests. Please try later.",
            ),
            FilingError::DocumentChanged => Self::conflict(
                "RESEARCH_DOCUMENT_CHANGED",
                "The source document changed. Reload before reading another page.",
            ),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogQuery {
    issuer_id: String,
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct DocumentQuery {
    #[serde(default)]
    offset: usize,
    expected_sha256: Option<String>,
}
fn response_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers
}
async fn catalog_route(
    State(state): State<AppState>,
    query: Result<Query<CatalogQuery>, axum::extract::rejection::QueryRejection>,
) -> ApiResult<(HeaderMap, Json<FilingCatalog>)> {
    let Query(query) = query.map_err(|_| FilingError::InvalidInput)?;
    Ok((
        response_headers(),
        Json(state.filings.catalog(&query.issuer_id).await?),
    ))
}
async fn document_route(
    State(state): State<AppState>,
    Path((cik, accession)): Path<(String, String)>,
    query: Result<Query<DocumentQuery>, axum::extract::rejection::QueryRejection>,
) -> ApiResult<(HeaderMap, Json<FilingDocument>)> {
    let Query(query) = query.map_err(|_| FilingError::InvalidInput)?;
    Ok((
        response_headers(),
        Json(
            state
                .filings
                .document(
                    &cik,
                    &accession,
                    query.offset,
                    query.expected_sha256.as_deref(),
                )
                .await?,
        ),
    ))
}
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/research/filings", get(catalog_route))
        .route(
            "/v1/research/filings/{cik}/{accession}",
            get(document_route),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn submissions() -> Value {
        serde_json::json!({"cik":320193,"name":"Apple Inc.","filings":{"recent":{
        "accessionNumber":["0001140361-26-015711","0000320193-26-000026"],"form":["8-K","10-K"],
        "filingDate":["2026-04-20","2026-11-03"],"reportDate":["2026-04-17","2026-09-26"],
        "primaryDocument":["ef20071035_8k.htm","aapl-20260926.htm"]}}})
    }
    #[test]
    fn issuer_identity_and_agent_accessions_are_verified_without_prefix_assumptions() {
        let v = submissions();
        let parsed = parse_filings(
            &serde_json::to_vec(&v).unwrap(),
            "0000320193",
            "2026-11-08T00:00:00Z".into(),
        )
        .unwrap();
        assert_eq!(parsed.filings.len(), 2);
        assert_eq!(
            parsed.filings[1].document_url,
            "https://www.sec.gov/Archives/edgar/data/320193/000114036126015711/ef20071035_8k.htm"
        );
        assert!(
            parse_filings(&serde_json::to_vec(&v).unwrap(), "0000320194", "now".into()).is_err()
        );
        for value in ["320193", "0000000000", "0000320193/..", "https://evil.test"] {
            assert!(!valid_cik(value));
        }
    }
    #[test]
    fn document_names_and_parallel_arrays_fail_closed() {
        for file in [
            "../secret.htm",
            "https://evil.test/a.htm",
            "%2e%2e.htm",
            "a.htm?x=1",
            "a/b.htm",
            "a\\b.htm",
        ] {
            let mut v = submissions();
            v["filings"]["recent"]["primaryDocument"][0] = file.into();
            assert_eq!(
                parse_filings(&serde_json::to_vec(&v).unwrap(), "0000320193", "now".into())
                    .unwrap()
                    .filings
                    .len(),
                1
            );
        }
        let mut v = submissions();
        v["filings"]["recent"]["reportDate"] = serde_json::json!([]);
        assert!(
            parse_filings(&serde_json::to_vec(&v).unwrap(), "0000320193", "now".into()).is_err()
        );
    }
    #[test]
    fn html_never_executes_or_exposes_hidden_content_and_preserves_real_anchors() {
        let source = br##"<html><head><title>secret</title><script>steal()</script></head><body>
        <div style="display:none"><p>hidden lie</p></div><ix:hidden>secret XBRL</ix:hidden><script>write()</script>
        <a href="#risk">Item 1A. Risk Factors</a><div id="risk"></div><div>Item 1A. Risk Factors</div>
        <p>Visible &amp; cited <b>paragraph</b>.</p><table><tr><td>Revenue</td><td>1,234</td></tr></table>
        <p aria-hidden="true">aria lie</p><svg><text>svg lie</text></svg><div>Final paragraph.</div></body></html>"##;
        let result = extract_html(
            source,
            "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/a.htm",
        )
        .unwrap();
        let texts = result
            .paragraphs
            .iter()
            .map(|p| p.text.as_str())
            .collect::<Vec<_>>();
        assert!(!texts.join(" ").contains("lie"));
        assert!(!texts.join(" ").contains("secret"));
        assert!(!texts.join(" ").contains("write()"));
        assert!(texts.contains(&"Visible & cited paragraph."));
        assert!(texts.contains(&"Revenue | 1,234"));
        assert_eq!(
            result
                .sections
                .iter()
                .filter(|s| s.title == "Item 1A. Risk Factors")
                .count(),
            1
        );
        assert!(
            result
                .paragraphs
                .iter()
                .find(|p| p.text.starts_with("Visible"))
                .unwrap()
                .source_url
                .ends_with("#risk")
        );
    }
    #[test]
    fn output_and_parser_inputs_are_bounded() {
        let html = format!(
            "<body>{}</body>",
            "<p>paragraph</p>".repeat(MAX_PARAGRAPHS + 2)
        );
        let result = extract_html(html.as_bytes(), "https://www.sec.gov/a.htm").unwrap();
        assert_eq!(result.paragraphs.len(), MAX_PARAGRAPHS);
        assert!(result.truncated);
        assert!(
            extract_html(&vec![b'a'; MAX_HTML_BYTES + 1], "https://www.sec.gov/a.htm").is_err()
        );
        assert!(
            extract_html(
                b"<body><script>hidden</script></body>",
                "https://www.sec.gov/a.htm"
            )
            .is_err()
        );
        assert_eq!(
            hash(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
