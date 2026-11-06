use super::{Article, Source, parse_feed};
use chrono::{DateTime, Duration as TimeDelta, Utc};
use futures_util::StreamExt;
use reqwest::{Client, Url, header};
use std::{future::Future, pin::Pin, time::Duration};

pub const MAX_BYTES: usize = 512 * 1024;
#[derive(Clone, Default)]
pub struct Validators {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}
#[derive(Debug)]
pub enum FetchResult {
    Modified(Vec<Article>, Validators),
    NotModified,
}
impl std::fmt::Debug for Validators {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Validators(..)")
    }
}
#[derive(Clone, Debug)]
pub enum RetryAfter {
    /// Keep delta-seconds relative until completion obtains PostgreSQL wall time.
    Delay(TimeDelta),
    /// An HTTP-date is already an absolute provider timestamp.
    At(DateTime<Utc>),
}
impl RetryAfter {
    pub fn deadline(&self, database_now: DateTime<Utc>) -> DateTime<Utc> {
        match self {
            Self::Delay(delay) => database_now
                .checked_add_signed(*delay)
                .unwrap_or(DateTime::<Utc>::MAX_UTC),
            Self::At(deadline) => *deadline,
        }
    }
}
#[derive(Clone, Debug)]
pub enum FetchError {
    Network,
    Timeout,
    RateLimited(Option<RetryAfter>),
    Http,
    InvalidData,
    TooLarge,
    UnsafeDestination,
}
impl FetchError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::Timeout => "timeout",
            Self::RateLimited(_) => "rate_limited",
            Self::Http => "http",
            Self::InvalidData => "invalid_data",
            Self::TooLarge => "too_large",
            Self::UnsafeDestination => "unsafe_destination",
        }
    }
}
pub trait FeedFetcher: Send + Sync {
    fn fetch<'a>(
        &'a self,
        source: Source,
        validators: Validators,
    ) -> Pin<Box<dyn Future<Output = Result<FetchResult, FetchError>> + Send + 'a>>;
}
pub struct HttpFetcher;
fn builder() -> reqwest::ClientBuilder {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .user_agent("Q-Public-News/1 (+https://q.kaicloudpay.com)")
}
impl HttpFetcher {
    pub fn new() -> Result<Self, reqwest::Error> {
        builder().build()?;
        Ok(Self)
    }
    async fn request(
        &self,
        source: Source,
        validators: Validators,
    ) -> Result<FetchResult, FetchError> {
        let url = Url::parse(&source.url()).map_err(|_| FetchError::UnsafeDestination)?;
        let host = url.host_str().ok_or(FetchError::UnsafeDestination)?;
        // Fixed hostnames are resolved once and pinned; proxy environment and DNS rebinding
        // cannot send this public collector to private networks or the business database.
        let addresses = tokio::net::lookup_host((host, 443))
            .await
            .map_err(|_| FetchError::Network)?
            .collect::<Vec<_>>();
        if addresses.is_empty()
            || addresses
                .iter()
                .any(|a| !crate::plugins::network::is_public_address(a.ip()))
        {
            return Err(FetchError::UnsafeDestination);
        }
        let client = builder()
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|_| FetchError::Network)?;
        let mut request = client.get(url.clone()).header(
            header::ACCEPT,
            if source.gdelt() {
                "application/json"
            } else {
                "application/rss+xml,application/xml,text/xml"
            },
        );
        if let Some(value) = validators.etag.filter(|s| s.len() <= 512) {
            request = request.header(header::IF_NONE_MATCH, value);
        }
        if let Some(value) = validators.last_modified.filter(|s| s.len() <= 128) {
            request = request.header(header::IF_MODIFIED_SINCE, value);
        }
        let response = request.send().await.map_err(|e| {
            if e.is_timeout() {
                FetchError::Timeout
            } else {
                FetchError::Network
            }
        })?;
        if response.status().as_u16() == 429 {
            return Err(FetchError::RateLimited(parse_retry_after(
                response
                    .headers()
                    .get(header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok()),
            )));
        }
        if response.status().as_u16() == 304 {
            return Ok(FetchResult::NotModified);
        }
        if !response.status().is_success() || response.url() != &url {
            return Err(FetchError::Http);
        }
        let mime = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|s| s.to_str().ok())
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if (source.gdelt() && mime != "application/json")
            || (!source.gdelt()
                && !["application/rss+xml", "application/xml", "text/xml"].contains(&mime.as_str()))
        {
            return Err(FetchError::InvalidData);
        }
        if response
            .content_length()
            .is_some_and(|v| v > MAX_BYTES as u64)
        {
            return Err(FetchError::TooLarge);
        }
        let bounded_header = |name, max| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .filter(|v| v.len() <= max)
                .map(str::to_owned)
        };
        let validators = Validators {
            etag: bounded_header(header::ETAG, 512),
            last_modified: bounded_header(header::LAST_MODIFIED, 128),
        };
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| {
                if e.is_timeout() {
                    FetchError::Timeout
                } else {
                    FetchError::Network
                }
            })?;
            if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
                return Err(FetchError::TooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(FetchResult::Modified(
            parse_feed(source, &bytes)?,
            validators,
        ))
    }
}
impl FeedFetcher for HttpFetcher {
    fn fetch<'a>(
        &'a self,
        source: Source,
        validators: Validators,
    ) -> Pin<Box<dyn Future<Output = Result<FetchResult, FetchError>> + Send + 'a>> {
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(15), self.request(source, validators))
                .await
                .unwrap_or(Err(FetchError::Timeout))
        })
    }
}
pub(super) fn parse_retry_after(value: Option<&str>) -> Option<RetryAfter> {
    let value = value?.trim();
    if value.len() > 128 {
        return None;
    }
    if value.bytes().all(|b| b.is_ascii_digit()) {
        let delay = TimeDelta::try_seconds(value.parse::<i64>().ok()?)?;
        (delay > TimeDelta::zero()).then_some(RetryAfter::Delay(delay))
    } else {
        DateTime::parse_from_rfc2822(value)
            .ok()
            .map(|value| RetryAfter::At(value.with_timezone(&Utc)))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_after_respects_integer_and_http_date() {
        let now = DateTime::parse_from_rfc3339("2026-11-05T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            parse_retry_after(Some("7200")).map(|value| value.deadline(now)),
            Some(now + TimeDelta::hours(2))
        );
        assert_eq!(
            parse_retry_after(Some("Thu, 05 Nov 2026 01:00:00 GMT"))
                .map(|value| value.deadline(now)),
            Some(now + TimeDelta::hours(1))
        );
        for bad in ["-1", "wat", "0", "99999999999999999999999999999999999"] {
            assert!(parse_retry_after(Some(bad)).is_none());
        }
    }
}
