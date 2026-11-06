//! Immutable ECB evidence and fenced, shared FX refresh. Never moves money.
use super::{
    PaymentRuntime,
    config::{RateSnapshot, rational},
    operator, store,
};
use crate::error::{ApiError, ApiResult};
use chrono::{DateTime, NaiveDate, Utc};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool, Postgres, Transaction};
use std::{collections::BTreeSet, sync::Arc};
use uuid::Uuid;

pub const ECB_URL: &str = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
pub const BODY_LIMIT: usize = 262_144;
const REFRESH_SECONDS: i64 = 900;
const LEASE_SECONDS: i64 = 60;
const ECB_NS: &str = "http://www.ecb.int/vocabulary/2002-08-01/eurofxref";

#[derive(Clone, sqlx::FromRow)]
struct Snapshot {
    id: Uuid,
    provenance: String,
    source_date: NaiveDate,
    #[sqlx(json)]
    rate_snapshot: RateSnapshot,
}
#[derive(sqlx::FromRow)]
struct Control {
    policy_fingerprint: Vec<u8>,
    generation: i64,
    automatic_enabled: bool,
    active_snapshot_id: Uuid,
    candidate_snapshot_id: Option<Uuid>,
    hold_reason: Option<String>,
    epoch: i64,
    lease_token: Option<Uuid>,
    leased_until: Option<DateTime<Utc>>,
    next_attempt_at: DateTime<Utc>,
    failure_count: i32,
    last_checked_at: Option<DateTime<Utc>>,
    last_success_at: Option<DateTime<Utc>>,
    last_error_code: Option<String>,
    last_http_status: Option<i32>,
    etag: Option<String>,
    last_modified: Option<String>,
}
const CONTROL: &str = "SELECT policy_fingerprint,generation,automatic_enabled,active_snapshot_id,candidate_snapshot_id,hold_reason,epoch,lease_token,leased_until,next_attempt_at,failure_count,last_checked_at,last_success_at,last_error_code,last_http_status,etag,last_modified FROM payment_fx_state WHERE singleton";
async fn control(c: &mut PgConnection, lock: &str) -> Result<Option<Control>, sqlx::Error> {
    sqlx::query_as(&format!("{CONTROL} {lock}"))
        .fetch_optional(c)
        .await
}
async fn snapshot(c: &mut PgConnection, id: Uuid) -> Result<Snapshot, sqlx::Error> {
    sqlx::query_as(
        "SELECT id,provenance,source_date,rate_snapshot FROM payment_fx_snapshots WHERE id=$1",
    )
    .bind(id)
    .fetch_one(c)
    .await
}
fn hash_hex(hash: &[u8]) -> String {
    hash.iter().map(|b| format!("{b:02x}")).collect()
}
fn decode_hash(text: &str) -> Option<Vec<u8>> {
    if text.len() != 64
        || !text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}
fn changed() -> ApiError {
    ApiError::conflict(
        "PAYMENT_FX_CHANGED",
        "The FX evidence or policy changed. Read its current status before continuing.",
    )
}

/// Trusted startup registration. Existing evidence/expiry is never rewritten by a restart.
/// A different business policy or automation mode fences old processes and pending leases.
pub async fn bootstrap(pool: &PgPool, runtime: &PaymentRuntime) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(8181440501)")
        .execute(&mut *tx)
        .await?;
    let date = NaiveDate::parse_from_str(&runtime.policy.rate.rate_source_date, "%Y-%m-%d")
        .map_err(|_| sqlx::Error::Protocol("Invalid bootstrap source date".into()))?;
    let hash = decode_hash(&runtime.policy.rate.rate_evidence_sha256)
        .ok_or_else(|| sqlx::Error::Protocol("Invalid bootstrap evidence hash".into()))?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO payment_fx_snapshots(id,provenance,source_date,rate_snapshot,evidence_hash) VALUES($1,'bootstrap_config',$2,$3,$4) ON CONFLICT(provenance,source_date,evidence_hash) DO NOTHING")
        .bind(id).bind(date).bind(serde_json::to_value(&runtime.policy.rate).map_err(|_|sqlx::Error::Protocol("Invalid bootstrap snapshot".into()))?).bind(&hash).execute(&mut *tx).await?;
    let bootstrap_id:Uuid=sqlx::query_scalar("SELECT id FROM payment_fx_snapshots WHERE provenance='bootstrap_config' AND source_date=$1 AND evidence_hash=$2").bind(date).bind(hash).fetch_one(&mut *tx).await?;
    let prior = control(&mut tx, "FOR UPDATE").await?;
    if let Some(prior) = prior {
        if prior.policy_fingerprint != runtime.fingerprint
            || prior.automatic_enabled != runtime.auto_fx_refresh
        {
            sqlx::query("UPDATE payment_fx_state SET policy_fingerprint=$1,automatic_enabled=$2,generation=generation+1,epoch=epoch+1,lease_token=NULL,leased_until=NULL,next_attempt_at=clock_timestamp() WHERE singleton")
                .bind(&runtime.fingerprint).bind(runtime.auto_fx_refresh).execute(&mut *tx).await?;
        }
    } else {
        sqlx::query("INSERT INTO payment_fx_state(singleton,policy_fingerprint,automatic_enabled,active_snapshot_id) VALUES(true,$1,$2,$3)")
            .bind(&runtime.fingerprint).bind(runtime.auto_fx_refresh).bind(bootstrap_id).execute(&mut *tx).await?;
    }
    tx.commit().await
}

/// Call under the quote transaction: the shared state lock makes a hold/refresh atomic
/// with deciding which immutable public evidence the new quote freezes.
pub async fn rate_for_quote(
    tx: &mut Transaction<'_, Postgres>,
    runtime: &PaymentRuntime,
) -> ApiResult<RateSnapshot> {
    let state = control(tx, "FOR SHARE").await?;
    let rate = match state {
        Some(s)
            if s.policy_fingerprint != runtime.fingerprint
                || s.automatic_enabled != runtime.auto_fx_refresh =>
        {
            return Err(store::unavailable());
        }
        Some(s) if runtime.auto_fx_refresh => {
            if s.hold_reason.is_some() {
                return Err(store::unavailable());
            }
            snapshot(tx, s.active_snapshot_id).await?.rate_snapshot
        }
        None if runtime.auto_fx_refresh => return Err(store::unavailable()),
        _ => runtime.policy.rate.clone(),
    };
    if !runtime.policy.rate_fresh(&rate, Utc::now()) {
        return Err(store::unavailable());
    }
    Ok(rate)
}
/// Old accepted quotes keep their own rate and expiry; ordinary refresh is no new policy.
/// Explicit FX holds and startup policy/mode changes remain safety stops for NEW orders.
pub async fn creation_allowed(
    tx: &mut Transaction<'_, Postgres>,
    runtime: &PaymentRuntime,
) -> ApiResult<bool> {
    Ok(match control(tx, "FOR SHARE").await? {
        Some(s) => {
            s.policy_fingerprint == runtime.fingerprint
                && s.automatic_enabled == runtime.auto_fx_refresh
                && (!runtime.auto_fx_refresh || s.hold_reason.is_none())
        }
        None => !runtime.auto_fx_refresh,
    })
}
pub async fn quote_available(pool: &PgPool, runtime: &PaymentRuntime) -> ApiResult<bool> {
    let mut tx = pool.begin().await?;
    let result = rate_for_quote(&mut tx, runtime).await;
    tx.rollback().await?;
    match result {
        Ok(_) => Ok(true),
        Err(e) if e.code == "PAYMENTS_UNAVAILABLE" => Ok(false),
        Err(e) => Err(e),
    }
}

#[derive(Serialize)]
pub struct RateStatus {
    pub snapshot_id: Option<Uuid>,
    pub source_date: String,
    pub rate_at: DateTime<Utc>,
    pub fetched_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub remaining_seconds: i64,
    pub rate_cny_per_100_hkd: String,
    pub evidence_sha256: String,
    pub evidence_verified: bool,
}
#[derive(Serialize)]
pub struct CandidateStatus {
    pub id: Uuid,
    pub source_date: String,
    pub rate_cny_per_100_hkd: String,
    pub evidence_sha256: String,
    pub reason: String,
    pub manual_activation_allowed: bool,
}
#[derive(Serialize)]
pub struct Alerts {
    pub within_24h: bool,
    pub within_6h: bool,
    pub stale: bool,
    pub held: bool,
}
#[derive(Serialize)]
pub struct FxStatus {
    pub mode: &'static str,
    pub state: &'static str,
    pub generation: Option<i64>,
    pub policy_fingerprint: String,
    pub current: Option<RateStatus>,
    pub candidate: Option<CandidateStatus>,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub last_error_code: Option<String>,
    pub hold_reason: Option<String>,
    pub next_attempt_at: Option<DateTime<Utc>>,
    pub last_http_status: Option<i32>,
    pub refresh_in_progress: bool,
    pub alerts: Alerts,
    pub server_time: DateTime<Utc>,
}
fn rate_status(
    s: Option<&Snapshot>,
    rate: &RateSnapshot,
    r: &PaymentRuntime,
    now: DateTime<Utc>,
) -> RateStatus {
    let expires = r.policy.rate_expires_at(rate);
    RateStatus {
        snapshot_id: s.map(|s| s.id),
        source_date: rate.rate_source_date.clone(),
        rate_at: rate.rate_at,
        fetched_at: rate.rate_fetched_at,
        expires_at: expires,
        remaining_seconds: (expires - now).num_seconds(),
        rate_cny_per_100_hkd: rate.rate_cny_per_100_hkd.clone(),
        evidence_sha256: rate.rate_evidence_sha256.clone(),
        evidence_verified: s.is_some_and(|s| s.provenance == "ecb"),
    }
}
pub async fn status(c: &mut PgConnection, r: &PaymentRuntime) -> Result<FxStatus, sqlx::Error> {
    let now = Utc::now();
    let s = control(c, "").await?;
    let current = if r.auto_fx_refresh {
        if let Some(s) = &s {
            let a = snapshot(c, s.active_snapshot_id).await?;
            Some(rate_status(Some(&a), &a.rate_snapshot, r, now))
        } else {
            None
        }
    } else {
        Some(rate_status(None, &r.policy.rate, r, now))
    };
    let hold = s
        .as_ref()
        .and_then(|s| r.auto_fx_refresh.then_some(s.hold_reason.clone()).flatten());
    let candidate = if let Some(s) = &s {
        if let Some(id) = s.candidate_snapshot_id {
            let a = snapshot(c, id).await?;
            Some(CandidateStatus {
                id,
                source_date: a.source_date.to_string(),
                rate_cny_per_100_hkd: a.rate_snapshot.rate_cny_per_100_hkd.clone(),
                evidence_sha256: a.rate_snapshot.rate_evidence_sha256.clone(),
                reason: s.hold_reason.clone().unwrap_or_default(),
                manual_activation_allowed: r.auto_fx_refresh
                    && s.policy_fingerprint == r.fingerprint
                    && r.policy.rate_fresh(&a.rate_snapshot, now)
                    && matches!(
                        s.hold_reason.as_deref(),
                        Some("same_date_rewrite" | "rate_jump")
                    ),
            })
        } else {
            None
        }
    } else {
        None
    };
    let fresh = current
        .as_ref()
        .is_some_and(|a| a.rate_at <= a.fetched_at && a.fetched_at <= now && a.expires_at >= now);
    let bound = s.as_ref().is_none_or(|s| {
        s.policy_fingerprint == r.fingerprint && s.automatic_enabled == r.auto_fx_refresh
    });
    let state = if !bound || current.is_none() {
        "unconfigured"
    } else if hold.is_some() {
        "held"
    } else if !fresh {
        "stale"
    } else {
        "ready"
    };
    let remaining = current.as_ref().map(|a| a.remaining_seconds);
    Ok(FxStatus {
        mode: if r.auto_fx_refresh {
            "automatic"
        } else {
            "manual"
        },
        state,
        generation: s.as_ref().map(|s| s.generation),
        policy_fingerprint: hash_hex(&r.fingerprint),
        current,
        candidate,
        last_checked_at: s.as_ref().and_then(|s| s.last_checked_at),
        last_success_at: s.as_ref().and_then(|s| s.last_success_at),
        last_error_code: s.as_ref().and_then(|s| s.last_error_code.clone()),
        hold_reason: hold,
        next_attempt_at: s.as_ref().map(|s| s.next_attempt_at),
        last_http_status: s.as_ref().and_then(|s| s.last_http_status),
        refresh_in_progress: s
            .as_ref()
            .is_some_and(|s| s.leased_until.is_some_and(|t| t > now)),
        alerts: Alerts {
            within_24h: remaining.is_some_and(|n| n <= 86400),
            within_6h: remaining.is_some_and(|n| n <= 21600),
            stale: !fresh,
            held: state == "held",
        },
        server_time: now,
    })
}

#[derive(Clone)]
struct Parsed {
    date: NaiveDate,
    rate: RateSnapshot,
}
fn cross_rate(cny: &str, hkd: &str) -> Result<String, &'static str> {
    let (cn, cd) = rational(cny).map_err(|_| "invalid_rate")?;
    let (hn, hd) = rational(hkd).map_err(|_| "invalid_rate")?;
    let n = cn
        .checked_mul(hd)
        .and_then(|n| n.checked_mul(100))
        .and_then(|n| n.checked_mul(100_000_000))
        .ok_or("invalid_rate")?;
    let d = cd.checked_mul(hn).ok_or("invalid_rate")?;
    let scaled = n.checked_add(d - 1).ok_or("invalid_rate")? / d;
    if scaled <= 0 {
        return Err("invalid_rate");
    }
    let result = format!("{}.{:08}", scaled / 100_000_000, scaled % 100_000_000);
    rational(&result).map_err(|_| "invalid_rate")?;
    Ok(result)
}
fn parse_xml(bytes: &[u8], now: DateTime<Utc>) -> Result<Parsed, &'static str> {
    if bytes.is_empty() || bytes.len() > BODY_LIMIT {
        return Err("invalid_xml_size");
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "invalid_xml")?;
    let options = roxmltree::ParsingOptions {
        allow_dtd: false,
        nodes_limit: 4096,
        ..Default::default()
    };
    let doc = roxmltree::Document::parse_with_options(text, options).map_err(|_| "invalid_xml")?;
    let root = doc.root_element();
    if root.tag_name().name() != "Envelope"
        || root.tag_name().namespace() != Some("http://www.gesmes.org/xml/2002-08-01")
    {
        return Err("invalid_xml");
    }
    let dates: Vec<_> = doc
        .descendants()
        .filter(|n| {
            n.is_element()
                && n.tag_name().name() == "Cube"
                && n.tag_name().namespace() == Some(ECB_NS)
                && n.attribute("time").is_some()
        })
        .collect();
    if dates.len() != 1 {
        return Err("invalid_date");
    }
    let raw_date = dates[0].attribute("time").ok_or("invalid_date")?;
    let date = NaiveDate::parse_from_str(raw_date, "%Y-%m-%d").map_err(|_| "invalid_date")?;
    if date.to_string() != raw_date || date > now.date_naive() {
        return Err("future_or_invalid_date");
    }
    let mut seen = BTreeSet::new();
    let mut cny = None;
    let mut hkd = None;
    for node in dates[0].children().filter(|n| n.is_element()) {
        if node.tag_name().name() != "Cube" || node.tag_name().namespace() != Some(ECB_NS) {
            return Err("invalid_currency");
        }
        let currency = node.attribute("currency").ok_or("invalid_currency")?;
        if currency.len() != 3
            || !currency.bytes().all(|b| b.is_ascii_uppercase())
            || currency == "EUR"
            || !seen.insert(currency)
        {
            return Err("invalid_currency");
        }
        let value = node.attribute("rate").ok_or("invalid_rate")?;
        rational(value).map_err(|_| "invalid_rate")?;
        if currency == "CNY" {
            cny = Some(value);
        }
        if currency == "HKD" {
            hkd = Some(value);
        }
    }
    let value = cross_rate(
        cny.ok_or("missing_currency")?,
        hkd.ok_or("missing_currency")?,
    )?;
    // ECB's daily XML has a date, not an authenticated intraday publication time.
    // Midnight UTC is conservative and cannot be renewed by downloading again.
    let rate_at = date.and_hms_opt(0, 0, 0).ok_or("invalid_date")?.and_utc();
    Ok(Parsed {
        date,
        rate: RateSnapshot {
            rate_cny_per_100_hkd: value,
            rate_source: "欧洲中央银行ECB公开参考价交叉换算（原始资料免费，非实时成交价）".into(),
            rate_source_url: ECB_URL.into(),
            rate_source_date: date.to_string(),
            rate_at,
            rate_fetched_at: now,
            rate_evidence_sha256: hash_hex(&Sha256::digest(bytes)),
        },
    })
}
fn large_jump(old: &str, new: &str) -> bool {
    let calc = || {
        let (a, b) = rational(old).ok()?;
        let (c, d) = rational(new).ok()?;
        let left = a.checked_mul(d)?;
        let right = c.checked_mul(b)?;
        Some(
            left.abs_diff(right).checked_mul(10000)?
                >= u128::try_from(left).ok()?.checked_mul(200)?,
        )
    };
    calc().unwrap_or(true)
}
#[derive(Clone)]
struct Lease {
    epoch: i64,
    token: Uuid,
    generation: i64,
    active: Uuid,
    etag: Option<String>,
    last_modified: Option<String>,
}
async fn claim(pool: &PgPool, r: &PaymentRuntime) -> Result<Option<Lease>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let Some(s) = control(&mut tx, "FOR UPDATE").await? else {
        return Ok(None);
    };
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    if !r.auto_fx_refresh
        || !s.automatic_enabled
        || s.policy_fingerprint != r.fingerprint
        || s.next_attempt_at > now
        || s.leased_until.is_some_and(|t| t > now)
    {
        return Ok(None);
    }
    let lease = Lease {
        epoch: s.epoch + 1,
        token: Uuid::new_v4(),
        generation: s.generation,
        active: s.active_snapshot_id,
        etag: s.etag,
        last_modified: s.last_modified,
    };
    sqlx::query("UPDATE payment_fx_state SET epoch=$1,lease_token=$2,leased_until=clock_timestamp()+make_interval(secs=>$3) WHERE singleton").bind(lease.epoch).bind(lease.token).bind(LEASE_SECONDS as f64).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Some(lease))
}
enum Poll {
    Xml {
        body: Vec<u8>,
        etag: Option<String>,
        modified: Option<String>,
    },
    NotModified,
    Failure {
        code: &'static str,
        status: Option<i32>,
    },
}
fn bounded_header(value: Option<&reqwest::header::HeaderValue>, max: usize) -> Option<String> {
    value
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() <= max && !v.chars().any(char::is_control))
        .map(str::to_owned)
}
async fn fetch_request(lease: &Lease) -> Poll {
    let host = "www.ecb.europa.eu";
    let addresses = match tokio::net::lookup_host((host, 443)).await {
        Ok(addresses) => addresses.collect::<Vec<_>>(),
        Err(_) => {
            return Poll::Failure {
                code: "fx_network",
                status: None,
            };
        }
    };
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !crate::plugins::network::is_public_address(address.ip()))
    {
        return Poll::Failure {
            code: "fx_unsafe_destination",
            status: None,
        };
    }
    let client = match reqwest::Client::builder()
        .no_proxy()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(25))
        .user_agent("Q-Public-FX/0.1 (+https://q.kaicloudpay.com)")
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return Poll::Failure {
                code: "fx_network",
                status: None,
            };
        }
    };
    let mut request = client
        .get(ECB_URL)
        .header(reqwest::header::ACCEPT, "application/xml,text/xml");
    if let Some(etag) = &lease.etag {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    if let Some(date) = &lease.last_modified {
        request = request.header(reqwest::header::IF_MODIFIED_SINCE, date);
    }
    let response = match request.send().await {
        Ok(r) => r,
        Err(_) => {
            return Poll::Failure {
                code: "fx_network",
                status: None,
            };
        }
    };
    let status = i32::from(response.status().as_u16());
    if response.url().as_str() != ECB_URL {
        return Poll::Failure {
            code: "fx_redirect",
            status: Some(status),
        };
    }
    if status == 304 {
        return Poll::NotModified;
    }
    if status != 200 {
        return Poll::Failure {
            code: "fx_http",
            status: Some(status),
        };
    }
    let content = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(content.as_str(), "application/xml" | "text/xml") {
        return Poll::Failure {
            code: "fx_content_type",
            status: Some(status),
        };
    }
    if response
        .content_length()
        .is_some_and(|n| n > BODY_LIMIT as u64)
    {
        return Poll::Failure {
            code: "fx_too_large",
            status: Some(status),
        };
    }
    let etag = bounded_header(response.headers().get(reqwest::header::ETAG), 512);
    let modified = bounded_header(response.headers().get(reqwest::header::LAST_MODIFIED), 256);
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            return Poll::Failure {
                code: "fx_network",
                status: Some(status),
            };
        };
        if body.len() + chunk.len() > BODY_LIMIT {
            return Poll::Failure {
                code: "fx_too_large",
                status: Some(status),
            };
        }
        body.extend_from_slice(&chunk);
    }
    Poll::Xml {
        body,
        etag,
        modified,
    }
}
// Includes DNS, TLS, headers and the bounded body. Less than the 60s DB lease.
async fn fetch(lease: &Lease) -> Poll {
    tokio::time::timeout(std::time::Duration::from_secs(30), fetch_request(lease))
        .await
        .unwrap_or(Poll::Failure {
            code: "fx_timeout",
            status: None,
        })
}
async fn insert_snapshot(
    tx: &mut Transaction<'_, Postgres>,
    p: &Parsed,
) -> Result<Uuid, sqlx::Error> {
    let id = Uuid::new_v4();
    let hash = decode_hash(&p.rate.rate_evidence_sha256)
        .ok_or_else(|| sqlx::Error::Protocol("Invalid parsed hash".into()))?;
    sqlx::query("INSERT INTO payment_fx_snapshots(id,provenance,source_date,rate_snapshot,evidence_hash,verified_evidence_hash) VALUES($1,'ecb',$2,$3,$4,$4) ON CONFLICT(provenance,source_date,evidence_hash) DO NOTHING").bind(id).bind(p.date).bind(serde_json::to_value(&p.rate).map_err(|_|sqlx::Error::Protocol("Invalid parsed rate".into()))?).bind(&hash).execute(&mut **tx).await?;
    sqlx::query_scalar("SELECT id FROM payment_fx_snapshots WHERE provenance='ecb' AND source_date=$1 AND evidence_hash=$2").bind(p.date).bind(hash).fetch_one(&mut **tx).await
}
async fn finish(
    pool: &PgPool,
    r: &PaymentRuntime,
    lease: &Lease,
    poll: Poll,
) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let Some(s) = control(&mut tx, "FOR UPDATE").await? else {
        return Ok(false);
    };
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    if s.epoch != lease.epoch
        || s.lease_token != Some(lease.token)
        || s.generation != lease.generation
        || s.active_snapshot_id != lease.active
        || s.policy_fingerprint != r.fingerprint
        || !s.automatic_enabled
        || !s.leased_until.is_some_and(|t| t > now)
    {
        return Ok(false);
    }
    let active = snapshot(&mut tx, s.active_snapshot_id).await?;
    let review_pending = s.candidate_snapshot_id.is_some()
        && matches!(
            s.hold_reason.as_deref(),
            Some("same_date_rewrite" | "rate_jump")
        );
    let previous_hold = s.hold_reason.clone();
    let mut hold = s.hold_reason;
    let mut candidate = s.candidate_snapshot_id;
    let mut error = None;
    let mut http = Some(200_i32);
    let mut active_id = s.active_snapshot_id;
    let mut headers = None;
    let mut success = false;
    let mut held_hash: Option<Vec<u8>> = None;
    match poll {
        Poll::Failure { code, status } => {
            error = Some(code);
            http = status;
        }
        Poll::NotModified => {
            http = Some(304);
            if active.provenance == "ecb" {
                success = true;
            } else {
                hold = Some("invalid_304".into());
                error = Some("invalid_304");
            }
        }
        Poll::Xml {
            body,
            etag,
            modified,
        } => {
            if !body.is_empty() && body.len() <= BODY_LIMIT {
                let hash = Sha256::digest(&body).to_vec();
                sqlx::query("INSERT INTO payment_fx_evidence(evidence_hash,raw_xml,first_fetched_at) VALUES($1,$2,$3) ON CONFLICT(evidence_hash) DO NOTHING").bind(&hash).bind(&body).bind(now).execute(&mut *tx).await?;
                held_hash = Some(hash);
            }
            match parse_xml(&body, now) {
                Err(code) => {
                    if !review_pending {
                        hold = Some(code.into());
                        candidate = None;
                    }
                    error = Some(code);
                }
                Ok(parsed) => {
                    let first_hash: Option<Vec<u8>> = sqlx::query_scalar(
                        "SELECT evidence_hash FROM payment_fx_snapshots WHERE provenance='ecb' AND source_date=$1 ORDER BY created_at,id LIMIT 1"
                    ).bind(parsed.date).fetch_optional(&mut *tx).await?;
                    let same_approved_evidence = active.provenance == "ecb"
                        && parsed.date == active.source_date
                        && parsed.rate.rate_evidence_sha256
                            == active.rate_snapshot.rate_evidence_sha256;
                    let date_already_rewritten = !same_approved_evidence
                        && first_hash.is_some_and(|hash| {
                            hash_hex(&hash) != parsed.rate.rate_evidence_sha256
                        });
                    let id = insert_snapshot(&mut tx, &parsed).await?;
                    let reason = if !r.policy.rate_fresh(&parsed.rate, now) {
                        Some("stale_source_date")
                    } else if parsed.date < active.source_date {
                        Some("older_source_date")
                    } else if date_already_rewritten
                        || (parsed.date == active.source_date
                            && parsed.rate.rate_evidence_sha256
                                != active.rate_snapshot.rate_evidence_sha256)
                    {
                        Some("same_date_rewrite")
                    } else if large_jump(
                        &active.rate_snapshot.rate_cny_per_100_hkd,
                        &parsed.rate.rate_cny_per_100_hkd,
                    ) {
                        Some("rate_jump")
                    } else {
                        None
                    };
                    if let Some(reason) = reason {
                        if matches!(reason, "same_date_rewrite" | "rate_jump") || !review_pending {
                            hold = Some(reason.into());
                            candidate =
                                matches!(reason, "same_date_rewrite" | "rate_jump").then_some(id);
                        }
                        error = Some(reason);
                    } else {
                        headers = Some((etag, modified));
                        success = true;
                        // An identical date/hash never rewrites fetched_at or extends validity.
                        if parsed.date > active.source_date
                            || (active.provenance != "ecb" && !review_pending)
                        {
                            active_id = id;
                            hold = None;
                            candidate = None;
                        } else if active.provenance == "ecb"
                            && !review_pending
                            && parsed.date == active.source_date
                            && parsed.rate.rate_evidence_sha256
                                == active.rate_snapshot.rate_evidence_sha256
                            && r.policy.rate_fresh(&active.rate_snapshot, now)
                        {
                            // Full clean evidence restores a temporary malformed/future/old
                            // response hold. A pending review candidate cannot be washed away
                            // by a malformed response followed by the old approved XML.
                            hold = None;
                            candidate = None;
                        }
                    }
                }
            }
        }
    }
    let failures = if error.is_some() {
        s.failure_count.saturating_add(1).min(30)
    } else {
        0
    };
    let delay = if failures > 0 {
        (60_i64.saturating_mul(1_i64 << failures.min(4))).min(REFRESH_SECONDS)
    } else {
        REFRESH_SECONDS
    };
    let (etag, modified) = headers.unwrap_or((s.etag, s.last_modified));
    let changed = active_id != s.active_snapshot_id
        || candidate != s.candidate_snapshot_id
        || hold != previous_hold;
    sqlx::query("UPDATE payment_fx_state SET active_snapshot_id=$1,candidate_snapshot_id=$2,hold_reason=$3,held_evidence_hash=CASE WHEN $3::text IS NULL THEN NULL ELSE COALESCE($4,held_evidence_hash) END,lease_token=NULL,leased_until=NULL,next_attempt_at=clock_timestamp()+make_interval(secs=>$5),failure_count=$6,last_checked_at=clock_timestamp(),last_success_at=CASE WHEN $7 THEN clock_timestamp() ELSE last_success_at END,last_error_code=$8,last_http_status=$9,etag=$10,last_modified=$11,generation=generation+CASE WHEN $12 THEN 1 ELSE 0 END WHERE singleton")
        .bind(active_id).bind(candidate).bind(hold).bind(held_hash).bind(delay as f64).bind(failures).bind(success).bind(error).bind(http).bind(etag).bind(modified).bind(changed).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
}
// Finite operational categories only: log state edges, never a public rate or raw error.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AlertLevel {
    Healthy,
    Unavailable,
    Held,
    Stale,
    SixHours,
    TwentyFourHours,
    PollFailed,
}
impl AlertLevel {
    fn code(self) -> &'static str {
        match self {
            Self::Healthy => "healthy",
            Self::Unavailable => "unavailable",
            Self::Held => "held",
            Self::Stale => "stale",
            Self::SixHours => "within_6h",
            Self::TwentyFourHours => "within_24h",
            Self::PollFailed => "poll_failed",
        }
    }
}
#[derive(Default)]
struct AlertObserver {
    previous: Option<AlertLevel>,
}
impl AlertObserver {
    fn observe(
        &mut self,
        level: AlertLevel,
        last_success_at: Option<DateTime<Utc>>,
        remaining_seconds: Option<i64>,
    ) {
        if self.previous == Some(level) {
            return;
        }
        if level != AlertLevel::Healthy {
            tracing::warn!(
                fx_alert = level.code(),
                ?last_success_at,
                ?remaining_seconds,
                "FX source/freshness alert"
            );
        } else if self.previous.is_some() {
            tracing::info!(
                fx_alert = level.code(),
                ?last_success_at,
                ?remaining_seconds,
                "FX source/freshness recovered"
            );
        }
        self.previous = Some(level);
    }
}
fn alert_level(status: &FxStatus, worker_problem: bool) -> AlertLevel {
    if worker_problem || status.state == "unconfigured" {
        AlertLevel::Unavailable
    } else if status.alerts.held {
        AlertLevel::Held
    } else if status.alerts.stale {
        AlertLevel::Stale
    } else if status.alerts.within_6h {
        AlertLevel::SixHours
    } else if status.alerts.within_24h {
        AlertLevel::TwentyFourHours
    } else if status.last_error_code.is_some() {
        AlertLevel::PollFailed
    } else {
        AlertLevel::Healthy
    }
}
/// Explicit opt-in only. No credentials, alternate origins, redirects or automatic HTTP retries.
pub fn spawn(pool: PgPool, runtime: Arc<PaymentRuntime>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if !runtime.auto_fx_refresh {
            return;
        }
        let mut alerts = AlertObserver::default();
        loop {
            let problem = match claim(&pool, &runtime).await {
                Ok(Some(lease)) => {
                    let response = fetch(&lease).await;
                    finish(&pool, &runtime, &lease, response).await.is_err()
                }
                Ok(None) => false,
                Err(_) => true,
            };
            let observed = match pool.acquire().await {
                Ok(mut connection) => status(&mut connection, &runtime).await.ok(),
                Err(_) => None,
            };
            if let Some(status) = observed {
                alerts.observe(
                    alert_level(&status, problem),
                    status.last_success_at,
                    status.current.map(|r| r.remaining_seconds),
                );
            } else {
                alerts.observe(AlertLevel::Unavailable, None, None);
            }
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        }
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivationRequest {
    pub candidate_id: Uuid,
    pub evidence_sha256: String,
    pub expected_generation: i64,
    pub reason: String,
}
#[derive(Serialize)]
pub struct Activation {
    pub activation_id: Uuid,
    pub snapshot_id: Uuid,
    pub generation: i64,
    pub activated_at: DateTime<Utc>,
}
/// Caller holds the identity and B operator-policy fences. No XML/amount editing API.
pub async fn activate(
    tx: &mut Transaction<'_, Postgres>,
    r: &PaymentRuntime,
    actor: Uuid,
    request: ActivationRequest,
) -> ApiResult<Activation> {
    if request.reason.trim().chars().count() < 10
        || request.reason.chars().count() > 500
        || request.reason.chars().any(char::is_control)
    {
        return Err(ApiError::validation(
            "Provide a 10–500 character review reason.",
        ));
    }
    let hash = decode_hash(&request.evidence_sha256)
        .ok_or_else(|| ApiError::validation("Use the exact evidence SHA-256."))?;
    let s = control(tx, "FOR UPDATE")
        .await?
        .ok_or_else(store::unavailable)?;
    if !r.auto_fx_refresh
        || !s.automatic_enabled
        || s.policy_fingerprint != r.fingerprint
        || s.generation != request.expected_generation
        || s.candidate_snapshot_id != Some(request.candidate_id)
        || !matches!(
            s.hold_reason.as_deref(),
            Some("same_date_rewrite" | "rate_jump")
        )
    {
        return Err(changed());
    }
    let a = snapshot(tx, request.candidate_id).await?;
    if a.provenance != "ecb"
        || decode_hash(&a.rate_snapshot.rate_evidence_sha256).as_ref() != Some(&hash)
        || !r.policy.rate_fresh(&a.rate_snapshot, Utc::now())
        || a.source_date > Utc::now().date_naive()
    {
        return Err(changed());
    }
    let activation_id = Uuid::new_v4();
    let at:DateTime<Utc>=sqlx::query_scalar("INSERT INTO payment_fx_activations(id,snapshot_id,operator_id,policy_generation,policy_fingerprint,evidence_hash,reason) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING created_at").bind(activation_id).bind(a.id).bind(actor).bind(s.generation).bind(&r.fingerprint).bind(hash).bind(request.reason.trim()).fetch_one(&mut **tx).await?;
    let generation: i64 = sqlx::query_scalar("UPDATE payment_fx_state SET active_snapshot_id=$1,candidate_snapshot_id=NULL,hold_reason=NULL,held_evidence_hash=NULL,generation=generation+1,epoch=epoch+1,lease_token=NULL,leased_until=NULL,last_error_code=NULL WHERE singleton RETURNING generation").bind(a.id).fetch_one(&mut **tx).await?;
    operator::audit(tx,actor,None,"fx_candidate_activated",serde_json::json!({"activation_id":activation_id,"snapshot_id":a.id,"reviewed_generation":s.generation,"generation":generation,"evidence_sha256":a.rate_snapshot.rate_evidence_sha256})).await?;
    Ok(Activation {
        activation_id,
        snapshot_id: a.id,
        generation,
        activated_at: at,
    })
}

#[cfg(feature = "payments-test-fixtures")]
pub mod test_support {
    use super::*;
    pub struct Claim(Lease);
    pub async fn claim_due(
        pool: &PgPool,
        r: &PaymentRuntime,
    ) -> Result<Option<Claim>, sqlx::Error> {
        claim(pool, r).await.map(|v| v.map(Claim))
    }
    pub async fn xml(
        pool: &PgPool,
        r: &PaymentRuntime,
        c: &Claim,
        bytes: Vec<u8>,
    ) -> Result<bool, sqlx::Error> {
        finish(
            pool,
            r,
            &c.0,
            Poll::Xml {
                body: bytes,
                etag: Some("fixture-etag".into()),
                modified: None,
            },
        )
        .await
    }
    pub async fn not_modified(
        pool: &PgPool,
        r: &PaymentRuntime,
        c: &Claim,
    ) -> Result<bool, sqlx::Error> {
        finish(pool, r, &c.0, Poll::NotModified).await
    }
    pub async fn network_failure(
        pool: &PgPool,
        r: &PaymentRuntime,
        c: &Claim,
    ) -> Result<bool, sqlx::Error> {
        finish(
            pool,
            r,
            &c.0,
            Poll::Failure {
                code: "fx_network",
                status: None,
            },
        )
        .await
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn xml(date: &str, cny: &str, hkd: &str) -> Vec<u8> {
        format!(r#"<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="{ECB_NS}"><Cube><Cube time="{date}"><Cube currency="CNY" rate="{cny}"/><Cube currency="HKD" rate="{hkd}"/></Cube></Cube></gesmes:Envelope>"#).into_bytes()
    }
    #[test]
    fn ecb_math_date_and_evidence_are_exact() {
        let now = DateTime::parse_from_rfc3339("2026-11-03T15:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let raw = xml("2026-11-02", "7.4567", "8.8002");
        let p = parse_xml(&raw, now).unwrap();
        assert_eq!(p.rate.rate_cny_per_100_hkd, "84.73330152");
        assert_eq!(p.rate.rate_at.to_rfc3339(), "2026-11-02T00:00:00+00:00");
        assert_eq!(p.rate.rate_evidence_sha256, hash_hex(&Sha256::digest(raw)));
        assert!(parse_xml(&xml("2026-11-04", "7", "8"), now).is_err());
    }
    #[test]
    fn xml_rejects_dtd_entities_missing_duplicate_and_nondecimal() {
        let now = Utc::now();
        for raw in [
            b"<!DOCTYPE x [<!ENTITY a '1'>]><x/>".to_vec(),
            xml("2026-11-02", "0", "8"),
            xml("2026-11-02", "7e1", "8"),
            vec![b'x'; BODY_LIMIT + 1],
        ] {
            assert!(parse_xml(&raw, now).is_err());
        }
        let missing = String::from_utf8(xml("2026-11-02", "7", "8"))
            .unwrap()
            .replace("currency=\"HKD\"", "currency=\"USD\"");
        assert!(parse_xml(missing.as_bytes(), now).is_err());
        let duplicate = missing.replace("currency=\"USD\"", "currency=\"CNY\"");
        assert!(parse_xml(duplicate.as_bytes(), now).is_err());
    }
    #[test]
    fn two_percent_inclusive_jump_is_held() {
        assert!(!large_jump("100", "101.99999999"));
        assert!(large_jump("100", "102"));
        assert!(large_jump("100", "98"));
    }
    #[test]
    fn xml_node_limit_is_enforced_before_currency_processing() {
        let raw = format!(
            r#"<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="{ECB_NS}"><Cube><Cube time="2026-11-02">{}</Cube></Cube></gesmes:Envelope>"#,
            "<x/>".repeat(5000)
        );
        assert!(raw.len() < BODY_LIMIT);
        assert_eq!(
            parse_xml(raw.as_bytes(), Utc::now()).err(),
            Some("invalid_xml")
        );
    }
    #[test]
    fn alert_state_edges_are_logged_once_and_recovery_is_info() {
        use std::{io::Write, sync::Mutex};
        #[derive(Clone)]
        struct Capture(Arc<Mutex<Vec<u8>>>);
        impl Write for Capture {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let captured = bytes.clone();
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .with_writer(move || Capture(captured.clone()))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            let mut observer = AlertObserver::default();
            for level in [
                AlertLevel::Healthy,
                AlertLevel::TwentyFourHours,
                AlertLevel::TwentyFourHours,
                AlertLevel::SixHours,
                AlertLevel::SixHours,
                AlertLevel::Held,
                AlertLevel::Held,
                AlertLevel::Healthy,
                AlertLevel::Healthy,
            ] {
                observer.observe(level, None, Some(3600));
            }
        });
        let output = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
        assert_eq!(output.matches("FX source/freshness alert").count(), 3);
        assert_eq!(output.matches("FX source/freshness recovered").count(), 1);
        assert!(output.contains("last_success_at") && output.contains("remaining_seconds"));
        assert!(
            !output.contains("merchant")
                && !output.contains("rate_cny")
                && !output.contains("raw_xml")
        );
    }
}
