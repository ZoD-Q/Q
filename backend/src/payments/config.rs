use super::qixiang::{QixiangClient, QixiangConfig};
use chrono::{DateTime, FixedOffset, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RateSnapshot {
    pub rate_cny_per_100_hkd: String,
    pub rate_source: String,
    pub rate_source_url: String,
    pub rate_source_date: String,
    pub rate_at: DateTime<Utc>,
    pub rate_fetched_at: DateTime<Utc>,
    pub rate_evidence_sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentPolicy {
    pub rate: RateSnapshot,
    pub fee_basis_points: i32,
    pub min_credit_amount_minor_hkd: i64,
    pub max_credit_amount_minor_hkd: i64,
    pub quote_ttl_seconds: i64,
    pub checkout_ttl_seconds: i64,
    pub rate_max_age_seconds: i64,
    pub provider_utc_offset_seconds: Option<i32>,
    pub makers: BTreeSet<Uuid>,
    pub checkers: BTreeSet<Uuid>,
}
pub struct PaymentRuntime {
    pub client: QixiangClient,
    pub merchant_id: String,
    pub policy: PaymentPolicy,
    pub fingerprint: Vec<u8>,
    pub credential_version: String,
    pub auto_fx_refresh: bool,
    providers: BTreeMap<String, ProviderVersion>,
}
pub struct ProviderVersion {
    pub version: String,
    pub merchant_id: String,
    pub client: QixiangClient,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialConfig {
    version: String,
    merchant_id: String,
    merchant_key: String,
    notify_url: String,
    return_url: String,
}
impl PaymentRuntime {
    /// Missing required configuration leaves all funding writes unavailable, while reads remain.
    pub fn from_env() -> Result<Option<Self>, &'static str> {
        let read = |key| env::var(key).ok().filter(|v| !v.is_empty());
        let Some(policy) = read("Q_PAYMENT_POLICY_JSON") else {
            return Ok(None);
        };
        let policy: PaymentPolicy =
            serde_json::from_str(&policy).map_err(|_| "Invalid Q_PAYMENT_POLICY_JSON")?;
        let (entries, active) = if let Some(raw) = read("Q_PAYMENT_CREDENTIALS_JSON") {
            let Some(active) = read("Q_PAYMENT_ACTIVE_CREDENTIAL_VERSION") else {
                return Ok(None);
            };
            (
                serde_json::from_str::<Vec<CredentialConfig>>(&raw)
                    .map_err(|_| "Invalid payment credential registry")?,
                active,
            )
        } else {
            let (Some(pid), Some(key), Some(notify), Some(return_url), Some(version)) = (
                read("Q_PAYMENT_MERCHANT_ID"),
                read("Q_PAYMENT_MERCHANT_KEY"),
                read("Q_PAYMENT_NOTIFY_URL"),
                read("Q_PAYMENT_RETURN_URL"),
                read("Q_PAYMENT_CREDENTIAL_VERSION"),
            ) else {
                return Ok(None);
            };
            (
                vec![CredentialConfig {
                    version: version.clone(),
                    merchant_id: pid,
                    merchant_key: key,
                    notify_url: notify,
                    return_url,
                }],
                version,
            )
        };
        let mut providers = vec![];
        for entry in entries {
            let config = QixiangConfig::new(
                entry.merchant_id.clone(),
                entry.merchant_key,
                &entry.notify_url,
                &entry.return_url,
            )
            .map_err(|_| "Invalid payment provider configuration")?;
            let client =
                QixiangClient::new(config).map_err(|_| "Could not initialize payment provider")?;
            providers.push(ProviderVersion {
                version: entry.version,
                merchant_id: entry.merchant_id,
                client,
            });
        }
        let mut runtime = Self::new_versioned(providers, active, policy)?;
        runtime.auto_fx_refresh = match read("Q_PAYMENT_FX_AUTO_REFRESH").as_deref() {
            None | Some("0") => false,
            Some("1") => true,
            _ => return Err("Q_PAYMENT_FX_AUTO_REFRESH must be 0 or 1"),
        };
        Ok(Some(runtime))
    }
    pub fn new(
        client: QixiangClient,
        merchant_id: String,
        policy: PaymentPolicy,
    ) -> Result<Self, &'static str> {
        Self::new_versioned(
            vec![ProviderVersion {
                version: "fixture-v1".into(),
                merchant_id,
                client,
            }],
            "fixture-v1".into(),
            policy,
        )
    }
    pub fn new_versioned(
        entries: Vec<ProviderVersion>,
        active: String,
        policy: PaymentPolicy,
    ) -> Result<Self, &'static str> {
        policy.validate()?;
        if entries.is_empty() || entries.len() > 32 {
            return Err("Invalid payment credential registry");
        }
        let mut providers = BTreeMap::new();
        for entry in entries {
            if entry.version.is_empty()
                || entry.version.len() > 64
                || !entry
                    .version
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                || providers.contains_key(&entry.version)
            {
                return Err("Invalid payment credential version");
            }
            providers.insert(entry.version.clone(), entry);
        }
        let selected = providers
            .get(&active)
            .ok_or("Active payment credential version missing")?;
        // Public-rate refreshes cannot silently invalidate an accepted quote.
        // Credentials, fees, limits, timing and governance remain in the signature.
        let fingerprint = Sha256::digest(
            serde_json::to_vec(&(
                "q-payments-business-v2",
                &selected.merchant_id,
                &active,
                policy.fee_basis_points,
                policy.min_credit_amount_minor_hkd,
                policy.max_credit_amount_minor_hkd,
                policy.quote_ttl_seconds,
                policy.checkout_ttl_seconds,
                policy.rate_max_age_seconds,
                policy.provider_utc_offset_seconds,
                &policy.makers,
                &policy.checkers,
            ))
            .map_err(|_| "Invalid payment policy")?,
        )
        .to_vec();
        Ok(Self {
            client: selected.client.clone(),
            merchant_id: selected.merchant_id.clone(),
            credential_version: active,
            auto_fx_refresh: false,
            policy,
            fingerprint,
            providers,
        })
    }
    pub fn provider(&self, version: &str, merchant: &str) -> Option<&QixiangClient> {
        self.providers
            .get(version)
            .filter(|entry| entry.merchant_id == merchant)
            .map(|entry| &entry.client)
    }
    pub fn eligible_bindings(&self) -> Vec<String> {
        self.providers
            .values()
            .map(|p| format!("{}:{}", p.version, p.merchant_id))
            .collect()
    }
    pub fn accepts_quote_fingerprint(
        &self,
        fingerprint: &[u8],
        frozen_rate: &RateSnapshot,
    ) -> bool {
        if fingerprint == self.fingerprint {
            return true;
        }
        // The old signature serialized the whole policy, including its rate. Rebuild
        // it with THIS quote's immutable snapshot, never today's environment rate.
        let mut legacy = self.policy.clone();
        legacy.rate = frozen_rate.clone();
        serde_json::to_vec(&(&self.merchant_id, &self.credential_version, &legacy))
            .is_ok_and(|bytes| Sha256::digest(bytes).as_slice() == fingerprint)
    }
}
impl PaymentPolicy {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(0..=10000).contains(&self.fee_basis_points)
            || self.min_credit_amount_minor_hkd < 1
            || self.max_credit_amount_minor_hkd < self.min_credit_amount_minor_hkd
            || self.max_credit_amount_minor_hkd > crate::ledger::real_hkd::MAX_MINOR
            || !(1..=900).contains(&self.quote_ttl_seconds)
            || !(1..=3600).contains(&self.checkout_ttl_seconds)
            || !(1..=345600).contains(&self.rate_max_age_seconds)
            || self.makers.is_empty()
            || self.checkers.is_empty()
            || !self
                .makers
                .iter()
                .any(|m| self.checkers.iter().any(|c| c != m))
        {
            return Err("Invalid payment limits, fee, timing or operators");
        }
        rational(&self.rate.rate_cny_per_100_hkd)?;
        let source =
            reqwest::Url::parse(&self.rate.rate_source_url).map_err(|_| "Invalid rate source")?;
        if source.scheme() != "https"
            || !source.username().is_empty()
            || source.password().is_some()
            || source.host_str().is_none()
            || self.rate.rate_source.is_empty()
            || self.rate.rate_source.len() > 256
            || self.rate.rate_source.chars().any(char::is_control)
            || self.rate.rate_source_url.len() > 2048
            || self.rate.rate_evidence_sha256.len() != 64
            || !self
                .rate
                .rate_evidence_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || chrono::NaiveDate::parse_from_str(&self.rate.rate_source_date, "%Y-%m-%d").is_err()
            || self
                .provider_utc_offset_seconds
                .is_some_and(|s| FixedOffset::east_opt(s).is_none())
        {
            return Err("Invalid rate evidence or provider offset");
        }
        Ok(())
    }
    pub fn fresh(&self, now: DateTime<Utc>) -> bool {
        self.rate_fresh(&self.rate, now)
    }
    pub fn rate_fresh(&self, rate: &RateSnapshot, now: DateTime<Utc>) -> bool {
        rate.rate_at <= rate.rate_fetched_at
            && rate.rate_fetched_at <= now
            && now <= self.rate_expires_at(rate)
    }
    pub fn rate_expires_at(&self, rate: &RateSnapshot) -> DateTime<Utc> {
        rate.rate_at.min(rate.rate_fetched_at)
            + chrono::Duration::seconds(self.rate_max_age_seconds.min(345600))
    }
}
pub fn rational(value: &str) -> Result<(i128, i128), &'static str> {
    if value.len() > 24 {
        return Err("Invalid rate");
    }
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || (whole.len() > 1 && whole.starts_with('0'))
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() > 8
        || !fraction.bytes().all(|b| b.is_ascii_digit())
        || (value.contains('.') && fraction.is_empty())
    {
        return Err("Invalid rate");
    }
    let denominator = 10_i128.pow(fraction.len() as u32);
    let numerator = whole
        .parse::<i128>()
        .ok()
        .and_then(|v| v.checked_mul(denominator))
        .and_then(|v| {
            v.checked_add(if fraction.is_empty() {
                0
            } else {
                fraction.parse::<i128>().ok()?
            })
        })
        .filter(|v| *v > 0)
        .ok_or("Invalid rate")?;
    Ok((numerator, denominator))
}
pub fn quote_math(hkd: i64, rate: &str, bps: i32) -> Result<(i64, i64, i64), &'static str> {
    if hkd < 1 || !(0..=10000).contains(&bps) {
        return Err("Invalid amount or fee");
    }
    let (n, d) = rational(rate)?;
    let raw = i128::from(hkd).checked_mul(n).ok_or("Amount overflow")?;
    let denominator = d.checked_mul(100).ok_or("Amount overflow")?;
    let ceil = |a: i128, b: i128| a.checked_add(b - 1).map(|v| v / b).ok_or("Amount overflow");
    let base = ceil(raw, denominator)?;
    let total = ceil(
        raw.checked_mul(i128::from(10000 + bps))
            .ok_or("Amount overflow")?,
        denominator.checked_mul(10000).ok_or("Amount overflow")?,
    )?;
    if total > i128::from(crate::ledger::real_hkd::MAX_MINOR) {
        return Err("Amount overflow");
    }
    Ok((base as i64, (total - base) as i64, total as i64))
}
pub fn provider_paid_time(raw: Option<&str>, offset: Option<i32>) -> Option<DateTime<Utc>> {
    let raw = raw?;
    if let Ok(time) = DateTime::parse_from_rfc3339(raw) {
        return Some(time.with_timezone(&Utc));
    }
    let naive = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S").ok()?;
    use chrono::TimeZone;
    FixedOffset::east_opt(offset?)
        .and_then(|zone| zone.from_local_datetime(&naive).single())
        .map(|time| time.with_timezone(&Utc))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ceiling_total_is_frozen_rational_not_float() {
        assert_eq!(quote_math(10000, "91.12345678", 250), Ok((9113, 228, 9341)));
        assert_eq!(quote_math(1, "91", 0), Ok((1, 0, 1)));
        assert!(quote_math(i64::MAX, "9999999999999999", 10000).is_err());
        assert!(rational("1e2").is_err());
    }
    #[test]
    fn provider_timezone_is_never_guessed() {
        assert!(provider_paid_time(Some("2026-11-02 12:00:00"), None).is_none());
        assert_eq!(
            provider_paid_time(Some("2026-11-02 12:00:00"), Some(28800)),
            provider_paid_time(Some("2026-11-02T04:00:00Z"), None)
        );
        assert!(provider_paid_time(None, Some(28800)).is_none());
    }
}
