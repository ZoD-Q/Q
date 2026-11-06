use super::fetch::FetchError;
use chrono::{DateTime, NaiveDateTime, Utc};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Fed,
    Ecb,
    GdeltMarkets,
    GdeltCrypto,
    GdeltTechnology,
}
impl Source {
    pub const ALL: [Self; 5] = [
        Self::Fed,
        Self::Ecb,
        Self::GdeltMarkets,
        Self::GdeltCrypto,
        Self::GdeltTechnology,
    ];
    pub fn id(self) -> &'static str {
        match self {
            Self::Fed => "fed",
            Self::Ecb => "ecb",
            Self::GdeltMarkets => "gdelt_markets",
            Self::GdeltCrypto => "gdelt_crypto",
            Self::GdeltTechnology => "gdelt_technology",
        }
    }
    pub fn gdelt(self) -> bool {
        !matches!(self, Self::Fed | Self::Ecb)
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Fed => "Federal Reserve",
            Self::Ecb => "European Central Bank",
            _ => "GDELT DOC 2.0",
        }
    }
    pub fn url(self) -> String {
        match self {
            Self::Fed => "https://www.federalreserve.gov/feeds/press_monetary.xml".into(),
            Self::Ecb => "https://www.ecb.europa.eu/rss/press.html".into(),
            _ => {
                let query = match self {
                    Self::GdeltMarkets => "(\"stock market\" OR \"bond market\" OR inflation)",
                    Self::GdeltCrypto => "(bitcoin OR ethereum OR cryptocurrency)",
                    _ => "(\"artificial intelligence\" OR semiconductor OR technology)",
                };
                let mut url = Url::parse("https://api.gdeltproject.org/api/v2/doc/doc")
                    .expect("constant URL");
                url.query_pairs_mut().extend_pairs([
                    ("query", query),
                    ("mode", "artlist"),
                    ("format", "json"),
                    ("maxrecords", "20"),
                    ("timespan", "24h"),
                    ("sort", "datedesc"),
                ]);
                url.to_string()
            }
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Article {
    pub title: String,
    pub url: String,
    pub source_id: String,
    pub publisher: String,
    pub published_at: Option<DateTime<Utc>>,
    pub indexed_at: Option<DateTime<Utc>>,
}
fn text(value: &str) -> Option<String> {
    if value.len() > 16384 {
        return None;
    }
    let html = scraper::Html::parse_fragment(value);
    let clean = html
        .root_element()
        .text()
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let clean = clean
        .chars()
        .filter(|c| !c.is_control())
        .take(240)
        .collect::<String>();
    if clean.is_empty() { None } else { Some(clean) }
}
fn article_url(value: &str, source: Source) -> Option<Url> {
    if value.len() > 2048 || value.chars().any(char::is_control) {
        return None;
    }
    let url = Url::parse(value).ok()?;
    let host = url.host_str()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
        || host.ends_with('.')
    {
        return None;
    }
    if let Ok(ip) = host.parse() {
        if !crate::plugins::network::is_public_address(ip) {
            return None;
        }
    } else if !host.contains('.') || host.ends_with(".local") || host.ends_with(".localhost") {
        return None;
    }
    if (source == Source::Fed && host != "www.federalreserve.gov")
        || (source == Source::Ecb && host != "www.ecb.europa.eu")
    {
        return None;
    }
    Some(url)
}
/// Parsing has independent body/node/depth/item bounds. DTDs/entities are never resolved.
pub fn parse_feed(source: Source, body: &[u8]) -> Result<Vec<Article>, FetchError> {
    if body.len() > super::fetch::MAX_BYTES {
        return Err(FetchError::TooLarge);
    }
    let mut records = Vec::new();
    if source.gdelt() {
        let value: Value = serde_json::from_slice(body).map_err(|_| FetchError::InvalidData)?;
        let items = value
            .get("articles")
            .and_then(Value::as_array)
            .filter(|v| v.len() <= 200)
            .ok_or(FetchError::InvalidData)?;
        for item in items {
            let title = item
                .get("title")
                .and_then(Value::as_str)
                .and_then(text)
                .ok_or(FetchError::InvalidData)?;
            let url = item
                .get("url")
                .and_then(Value::as_str)
                .and_then(|v| article_url(v, source))
                .ok_or(FetchError::InvalidData)?;
            let indexed_at = item
                .get("seendate")
                .and_then(Value::as_str)
                .and_then(|v| NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%SZ").ok())
                .map(|v| v.and_utc());
            records.push(Article {
                title,
                publisher: url.host_str().unwrap_or_default().into(),
                url: url.into(),
                source_id: source.id().into(),
                published_at: None,
                indexed_at,
            });
        }
    } else {
        let body = std::str::from_utf8(body).map_err(|_| FetchError::InvalidData)?;
        let document = roxmltree::Document::parse_with_options(
            body,
            roxmltree::ParsingOptions {
                allow_dtd: false,
                nodes_limit: 10_000,
                ..Default::default()
            },
        )
        .map_err(|_| FetchError::InvalidData)?;
        if document
            .descendants()
            .any(|node| node.ancestors().take(26).count() > 25)
        {
            return Err(FetchError::InvalidData);
        }
        let root = document.root_element();
        if !root.has_tag_name("rss") {
            return Err(FetchError::InvalidData);
        }
        let mut channels = root.children().filter(|v| v.has_tag_name("channel"));
        let channel = channels.next().ok_or(FetchError::InvalidData)?;
        if channels.next().is_some() {
            return Err(FetchError::InvalidData);
        }
        let items = channel
            .children()
            .filter(|v| v.has_tag_name("item"))
            .collect::<Vec<_>>();
        if items.len() > 200 {
            return Err(FetchError::InvalidData);
        }
        for item in items {
            let field = |name| {
                item.children()
                    .find(|v| v.has_tag_name(name))
                    .and_then(|v| v.text())
            };
            let title = field("title")
                .and_then(text)
                .ok_or(FetchError::InvalidData)?;
            let url = field("link")
                .and_then(|v| article_url(v, source))
                .ok_or(FetchError::InvalidData)?;
            let published_at = field("pubDate")
                .and_then(|v| DateTime::parse_from_rfc2822(v).ok())
                .map(|v| v.with_timezone(&Utc));
            records.push(Article {
                title,
                url: url.into(),
                source_id: source.id().into(),
                publisher: source.name().into(),
                published_at,
                indexed_at: None,
            });
        }
    }
    let mut urls = HashSet::new();
    records.retain(|r| urls.insert(r.url.clone()));
    records.sort_by_key(|r| std::cmp::Reverse(r.published_at.or(r.indexed_at)));
    records.truncate(20);
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sources_and_article_times_are_not_interchangeable() {
        let rss=br#"<rss><channel><item><title>Policy &amp; rates</title><link>https://www.ecb.europa.eu/press/a.html</link><pubDate>Wed, 04 Nov 2026 01:00:00 +0100</pubDate></item></channel></rss>"#;
        let records = parse_feed(Source::Ecb, rss).unwrap();
        assert_eq!(records[0].source_id, "ecb");
        assert!(records[0].published_at.is_some());
        assert!(records[0].indexed_at.is_none());
        let data=br#"{"articles":[{"title":"Market","url":"https://news.example.com/a","seendate":"20261104T010000Z"}]}"#;
        let records = parse_feed(Source::GdeltMarkets, data).unwrap();
        assert!(records[0].published_at.is_none());
        assert!(records[0].indexed_at.is_some());
    }
    #[test]
    fn parser_rejects_dtd_external_links_bad_shapes_and_bounds() {
        for data in [
            "<!DOCTYPE rss [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><rss><channel/></rss>",
            "<rss><channel><item><title>x</title><link>https://evil.example/a</link></item></channel></rss>",
            "<rss><channel>",
        ] {
            assert!(parse_feed(Source::Fed, data.as_bytes()).is_err());
        }
        let nested = format!(
            "<rss><channel>{}{}{}</channel></rss>",
            "<a>".repeat(30),
            "x",
            "</a>".repeat(30)
        );
        assert!(parse_feed(Source::Fed, nested.as_bytes()).is_err());
        assert!(parse_feed(Source::Fed, &vec![b'a'; super::super::fetch::MAX_BYTES + 1]).is_err());
        assert!(
            parse_feed(
                Source::GdeltMarkets,
                br#"{"articles":[{"title":"a","url":"https://127.0.0.1/a"}]}"#
            )
            .is_err()
        );
        assert!(parse_feed(Source::GdeltMarkets, br#"{"articles":{}}"#).is_err());
        assert_eq!(
            parse_feed(Source::Fed, b"<rss><channel/></rss>")
                .unwrap()
                .len(),
            0
        );
    }
}
