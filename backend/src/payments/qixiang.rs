//! Qixiang's legacy protocol. A signed notification is a query hint, never credit authority.
//! Callers must durably reserve an order before `create`; transport failure is an unknown write.
use std::{collections::BTreeMap, fmt, time::Duration};

use md5::{Digest, Md5};
use reqwest::{Client, Url};
use serde::Deserialize;
use subtle::ConstantTimeEq;

const ORIGIN: &str = "https://api.payqixiang.cn/";
const MAX_RESPONSE: usize = 32 * 1024;
const MAX_CALLBACK: usize = 8 * 1024;
const CALLBACK_FIELDS: [&str; 10] = [
    "pid",
    "trade_no",
    "out_trade_no",
    "type",
    "name",
    "money",
    "trade_status",
    "sign",
    "sign_type",
    "param",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidConfiguration,
    InvalidRequest,
    InvalidNotification,
    InvalidSignature,
    IdentityMismatch,
    Transport,
    InvalidResponse,
    ProviderRejected,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Qixiang protocol error: {self:?}")
    }
}
impl std::error::Error for Error {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Alipay,
    Wechat,
}
impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Alipay => "alipay",
            Self::Wechat => "wxpay",
        }
    }
}

#[derive(Clone)]
pub struct QixiangConfig {
    merchant_id: String,
    merchant_key: String,
    notify_url: Url,
    return_url: Url,
}
impl fmt::Debug for QixiangConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("QixiangConfig").finish_non_exhaustive()
    }
}
impl QixiangConfig {
    pub fn new(
        merchant_id: String,
        merchant_key: String,
        notify_url: &str,
        return_url: &str,
    ) -> Result<Self, Error> {
        let valid_id = merchant_id
            .parse::<u32>()
            .ok()
            .is_some_and(|id| id > 0 && id.to_string() == merchant_id);
        if !valid_id
            || merchant_key.is_empty()
            || merchant_key.len() > 512
            || merchant_key.chars().any(char::is_control)
        {
            return Err(Error::InvalidConfiguration);
        }
        let notify_url = safe_https_url(notify_url).map_err(|_| Error::InvalidConfiguration)?;
        let return_url = safe_https_url(return_url).map_err(|_| Error::InvalidConfiguration)?;
        Ok(Self {
            merchant_id,
            merchant_key,
            notify_url,
            return_url,
        })
    }
}

#[derive(Debug, Clone)]
pub struct ExpectedPayment {
    pub merchant_id: String,
    pub merchant_order_no: String,
    pub provider_trade_no: Option<String>,
    pub channel: Channel,
    pub amount_minor_cny: i64,
}
pub struct CreatePayment {
    pub merchant_order_no: String,
    pub channel: Channel,
    pub amount_minor_cny: i64,
    pub name: String,
    pub client_ip: String,
}
#[derive(Debug, PartialEq, Eq)]
pub struct CreatedPayment {
    pub provider_trade_no: String,
    pub checkout_url: String,
}
/// This value only identifies a verified notification; query the server before treating it as paid.
#[derive(Debug, PartialEq, Eq)]
pub struct VerifiedNotification {
    pub merchant_order_no: String,
    pub provider_trade_no: String,
}
#[derive(Debug, PartialEq, Eq)]
pub struct PaidConfirmation {
    pub merchant_order_no: String,
    pub provider_trade_no: String,
    pub amount_minor_cny: i64,
    /// Authoritative query evidence only; no timestamp or timezone interpretation here.
    pub provider_paid_at_raw: Option<String>,
}
#[derive(Debug, PartialEq, Eq)]
pub enum QueryOutcome {
    Unpaid,
    Paid(PaidConfirmation),
}

/// Only locates a candidate local order. It performs no authentication or payment confirmation.
pub fn notification_order_no(raw_query: &str) -> Result<String, Error> {
    let params = parse_callback(raw_query)?;
    params
        .get("out_trade_no")
        .filter(|value| valid_order_id(value))
        .cloned()
        .ok_or(Error::InvalidNotification)
}

#[derive(Clone)]
pub struct QixiangClient {
    config: QixiangConfig,
    client: Client,
    origin: Url,
}
impl fmt::Debug for QixiangClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("QixiangClient").finish_non_exhaustive()
    }
}
impl QixiangClient {
    pub fn new(config: QixiangConfig) -> Result<Self, Error> {
        Ok(Self {
            config,
            client: transport(true)?,
            origin: Url::parse(ORIGIN).map_err(|_| Error::InvalidConfiguration)?,
        })
    }

    pub fn verify_notification(
        &self,
        raw_query: &str,
        expected: &ExpectedPayment,
    ) -> Result<VerifiedNotification, Error> {
        let params = parse_callback(raw_query)?;
        let get = |key: &str| {
            params
                .get(key)
                .map(String::as_str)
                .ok_or(Error::InvalidNotification)
        };
        if get("sign_type")? != "MD5" {
            return Err(Error::InvalidNotification);
        }
        let signature = get("sign")?;
        if !verify_signature(&params, &self.config.merchant_key, signature) {
            return Err(Error::InvalidSignature);
        }
        if get("trade_status")? != "TRADE_SUCCESS" || get("name")?.is_empty() {
            return Err(Error::InvalidNotification);
        }
        let trade_no = get("trade_no")?;
        self.match_payment(
            expected,
            get("pid")?,
            get("out_trade_no")?,
            trade_no,
            get("type")?,
            get("money")?,
        )?;
        Ok(VerifiedNotification {
            merchant_order_no: expected.merchant_order_no.clone(),
            provider_trade_no: trade_no.to_owned(),
        })
    }

    pub async fn create(&self, request: &CreatePayment) -> Result<CreatedPayment, Error> {
        if !valid_order_id(&request.merchant_order_no)
            || request.name.is_empty()
            || request.name.len() > 127
            || request.name.chars().any(char::is_control)
            || request.client_ip.parse::<std::net::IpAddr>().is_err()
        {
            return Err(Error::InvalidRequest);
        }
        let mut params = BTreeMap::from([
            ("pid".to_owned(), self.config.merchant_id.clone()),
            ("type".to_owned(), request.channel.as_str().to_owned()),
            ("out_trade_no".to_owned(), request.merchant_order_no.clone()),
            ("notify_url".to_owned(), self.config.notify_url.to_string()),
            ("return_url".to_owned(), self.config.return_url.to_string()),
            ("name".to_owned(), request.name.clone()),
            (
                "money".to_owned(),
                format_cny_minor(request.amount_minor_cny)?,
            ),
            ("clientip".to_owned(), request.client_ip.clone()),
            ("device".to_owned(), "jump".to_owned()),
        ]);
        params.insert("sign".into(), signature(&params, &self.config.merchant_key));
        params.insert("sign_type".into(), "MD5".into());
        let response: CreateResponse = self.post("mapi.php", &params).await?;
        if response.code != 1 {
            return Err(Error::ProviderRejected);
        }
        let provider_trade_no = response.trade_no.ok_or(Error::InvalidResponse)?;
        if !valid_order_id(&provider_trade_no) {
            return Err(Error::InvalidResponse);
        }
        let checkout_url = response.payurl.ok_or(Error::InvalidResponse)?;
        let url = safe_https_url(&checkout_url)?;
        if url.origin()
            != Url::parse(ORIGIN)
                .map_err(|_| Error::InvalidConfiguration)?
                .origin()
        {
            return Err(Error::InvalidResponse);
        }
        // qrcode is intentionally not exposed as an automatically launchable native URL.
        Ok(CreatedPayment {
            provider_trade_no,
            checkout_url: url.to_string(),
        })
    }

    pub async fn query(&self, expected: &ExpectedPayment) -> Result<QueryOutcome, Error> {
        self.validate_expected(expected)?;
        let params = BTreeMap::from([
            ("pid".to_owned(), self.config.merchant_id.clone()),
            ("key".to_owned(), self.config.merchant_key.clone()),
            (
                "out_trade_no".to_owned(),
                expected.merchant_order_no.clone(),
            ),
        ]);
        let response: QueryResponse = self.post("api.php?act=order", &params).await?;
        if response.code != 1 {
            return Err(Error::ProviderRejected);
        }
        let pid = match response.pid.ok_or(Error::InvalidResponse)? {
            MerchantId::Number(id) => id.to_string(),
            MerchantId::Text(id) => id,
        };
        let trade_no = response.trade_no.ok_or(Error::InvalidResponse)?;
        self.match_payment(
            expected,
            &pid,
            response
                .out_trade_no
                .as_deref()
                .ok_or(Error::InvalidResponse)?,
            &trade_no,
            response.r#type.as_deref().ok_or(Error::InvalidResponse)?,
            response.money.as_deref().ok_or(Error::InvalidResponse)?,
        )?;
        match response.status {
            Some(0) => Ok(QueryOutcome::Unpaid),
            Some(1) => {
                let provider_paid_at_raw = response.endtime.filter(|value| !value.is_empty());
                if provider_paid_at_raw
                    .as_ref()
                    .is_some_and(|value| value.len() > 128 || value.chars().any(char::is_control))
                {
                    return Err(Error::InvalidResponse);
                }
                Ok(QueryOutcome::Paid(PaidConfirmation {
                    merchant_order_no: expected.merchant_order_no.clone(),
                    provider_trade_no: trade_no,
                    amount_minor_cny: expected.amount_minor_cny,
                    provider_paid_at_raw,
                }))
            }
            _ => Err(Error::InvalidResponse),
        }
    }

    fn validate_expected(&self, expected: &ExpectedPayment) -> Result<(), Error> {
        if expected.merchant_id != self.config.merchant_id
            || !valid_order_id(&expected.merchant_order_no)
            || expected.amount_minor_cny <= 0
            || expected
                .provider_trade_no
                .as_ref()
                .is_some_and(|id| !valid_order_id(id))
        {
            return Err(Error::InvalidRequest);
        }
        Ok(())
    }
    fn match_payment(
        &self,
        expected: &ExpectedPayment,
        pid: &str,
        order: &str,
        trade: &str,
        channel: &str,
        money: &str,
    ) -> Result<(), Error> {
        self.validate_expected(expected)?;
        if pid != expected.merchant_id
            || order != expected.merchant_order_no
            || !valid_order_id(trade)
            || channel != expected.channel.as_str()
            || expected
                .provider_trade_no
                .as_deref()
                .is_some_and(|id| id != trade)
            || parse_cny_minor(money).map_err(|_| Error::IdentityMismatch)?
                != expected.amount_minor_cny
        {
            return Err(Error::IdentityMismatch);
        }
        Ok(())
    }
    async fn post<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        params: &BTreeMap<String, String>,
    ) -> Result<T, Error> {
        let url = self
            .origin
            .join(path)
            .map_err(|_| Error::InvalidConfiguration)?;
        let body = form_urlencoded::Serializer::new(String::new())
            .extend_pairs(params)
            .finish();
        let mut response = self
            .client
            .post(url)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body(body)
            .send()
            .await
            .map_err(|_| Error::Transport)?;
        if !response.status().is_success() {
            return Err(Error::Transport);
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE as u64)
        {
            return Err(Error::InvalidResponse);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Error::Transport)? {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err(Error::InvalidResponse);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| Error::InvalidResponse)
    }

    #[cfg(any(test, feature = "payments-test-fixtures"))]
    pub fn with_test_fixture(config: QixiangConfig, origin: &str) -> Result<Self, Error> {
        let origin = Url::parse(origin).map_err(|_| Error::InvalidConfiguration)?;
        if origin.scheme() != "http"
            || origin.host_str() != Some("127.0.0.1")
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
            || !origin.username().is_empty()
            || origin.password().is_some()
        {
            return Err(Error::InvalidConfiguration);
        }
        Ok(Self {
            config,
            origin,
            client: transport(false)?,
        })
    }

    #[cfg(test)]
    fn fixture(config: QixiangConfig, origin: &str) -> Result<Self, Error> {
        Self::with_test_fixture(config, origin)
    }
}

fn transport(https_only: bool) -> Result<Client, Error> {
    Client::builder()
        .https_only(https_only)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| Error::InvalidConfiguration)
}
fn safe_https_url(raw: &str) -> Result<Url, Error> {
    if raw.len() > 4096 || raw.chars().any(char::is_control) {
        return Err(Error::InvalidResponse);
    }
    let url = Url::parse(raw).map_err(|_| Error::InvalidResponse)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err(Error::InvalidResponse);
    }
    Ok(url)
}
fn valid_order_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Exact positive decimal yuan -> cents. No exponent, signs, separators or floating point.
pub fn parse_cny_minor(value: &str) -> Result<i64, Error> {
    if value.is_empty() || value.len() > 21 {
        return Err(Error::InvalidRequest);
    }
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() > 2
        || !fraction.bytes().all(|b| b.is_ascii_digit())
        || (value.contains('.') && fraction.is_empty())
    {
        return Err(Error::InvalidRequest);
    }
    let whole = whole.parse::<i64>().map_err(|_| Error::InvalidRequest)?;
    let fraction = match fraction.len() {
        0 => 0,
        1 => i64::from(fraction.as_bytes()[0] - b'0') * 10,
        _ => {
            i64::from(fraction.as_bytes()[0] - b'0') * 10 + i64::from(fraction.as_bytes()[1] - b'0')
        }
    };
    let minor = whole
        .checked_mul(100)
        .and_then(|v| v.checked_add(fraction))
        .ok_or(Error::InvalidRequest)?;
    if minor <= 0 {
        return Err(Error::InvalidRequest);
    }
    Ok(minor)
}
pub fn format_cny_minor(minor: i64) -> Result<String, Error> {
    if minor <= 0 {
        return Err(Error::InvalidRequest);
    }
    Ok(format!("{}.{:02}", minor / 100, minor % 100))
}

fn signature(params: &BTreeMap<String, String>, key: &str) -> String {
    let mut hash = Md5::new();
    let mut first = true;
    for (name, value) in params {
        if name == "sign" || name == "sign_type" || value.is_empty() {
            continue;
        }
        if !first {
            hash.update(b"&");
        }
        first = false;
        hash.update(name.as_bytes());
        hash.update(b"=");
        hash.update(value.as_bytes());
    }
    hash.update(key.as_bytes());
    format!("{:x}", hash.finalize())
}
fn verify_signature(params: &BTreeMap<String, String>, key: &str, received: &str) -> bool {
    if received.len() != 32
        || !received
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return false;
    }
    bool::from(signature(params, key).as_bytes().ct_eq(received.as_bytes()))
}
fn parse_callback(raw: &str) -> Result<BTreeMap<String, String>, Error> {
    if raw.is_empty() || raw.len() > MAX_CALLBACK {
        return Err(Error::InvalidNotification);
    }
    let mut params = BTreeMap::new();
    for pair in raw.split('&') {
        let (name, value) = pair.split_once('=').ok_or(Error::InvalidNotification)?;
        let name = decode_component(name)?;
        let value = decode_component(value)?;
        if name.is_empty()
            || !CALLBACK_FIELDS.contains(&name.as_str())
            || value.len() > 2048
            || value.chars().any(char::is_control)
            || params.insert(name, value).is_some()
        {
            return Err(Error::InvalidNotification);
        }
    }
    Ok(params)
}
fn decode_component(raw: &str) -> Result<String, Error> {
    let input = raw.as_bytes();
    let mut bytes = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        match input[index] {
            b'%' => {
                let hex = input
                    .get(index + 1..index + 3)
                    .ok_or(Error::InvalidNotification)?;
                let digit = |b: u8| -> Result<u8, Error> {
                    match b {
                        b'0'..=b'9' => Ok(b - b'0'),
                        b'a'..=b'f' => Ok(b - b'a' + 10),
                        b'A'..=b'F' => Ok(b - b'A' + 10),
                        _ => Err(Error::InvalidNotification),
                    }
                };
                bytes.push(digit(hex[0])? * 16 + digit(hex[1])?);
                index += 3;
            }
            b'+' => {
                bytes.push(b' ');
                index += 1;
            }
            byte => {
                bytes.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(bytes).map_err(|_| Error::InvalidNotification)
}

#[derive(Deserialize)]
struct CreateResponse {
    code: i64,
    trade_no: Option<String>,
    payurl: Option<String>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum MerchantId {
    Number(u32),
    Text(String),
}
#[derive(Deserialize)]
struct QueryResponse {
    code: i64,
    pid: Option<MerchantId>,
    trade_no: Option<String>,
    out_trade_no: Option<String>,
    r#type: Option<String>,
    money: Option<String>,
    status: Option<i64>,
    endtime: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        extract::State,
        http::{Request, Response, StatusCode},
    };
    use serde_json::{Value, json};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::{sync::Mutex, task::JoinHandle};

    fn config() -> QixiangConfig {
        QixiangConfig::new(
            "1001".into(),
            "secret".into(),
            "https://q.example/payment/notify",
            "https://q.example/payment/return",
        )
        .unwrap()
    }
    fn expected() -> ExpectedPayment {
        ExpectedPayment {
            merchant_id: "1001".into(),
            merchant_order_no: "order-1".into(),
            provider_trade_no: Some("trade-1".into()),
            channel: Channel::Wechat,
            amount_minor_cny: 123,
        }
    }
    fn notification() -> BTreeMap<String, String> {
        BTreeMap::from(
            [
                ("pid", "1001"),
                ("out_trade_no", "order-1"),
                ("trade_no", "trade-1"),
                ("type", "wxpay"),
                ("name", "港币 & a=b + %26"),
                ("money", "1.23"),
                ("trade_status", "TRADE_SUCCESS"),
                ("sign_type", "MD5"),
            ]
            .map(|(k, v)| (k.to_owned(), v.to_owned())),
        )
    }
    fn signed(mut params: BTreeMap<String, String>) -> String {
        params.insert("sign".into(), signature(&params, "secret"));
        form_urlencoded::Serializer::new(String::new())
            .extend_pairs(params)
            .finish()
    }
    fn paid_response() -> Value {
        json!({"code":1,"pid":1001,"out_trade_no":"order-1","trade_no":"trade-1",
            "type":"wxpay","money":"1.23","status":1})
    }
    fn create_request() -> CreatePayment {
        CreatePayment {
            merchant_order_no: "order-1".into(),
            channel: Channel::Wechat,
            amount_minor_cny: 123,
            name: "HKD deposit".into(),
            client_ip: "127.0.0.1".into(),
        }
    }

    #[test]
    fn md5_golden_vectors_use_raw_utf8_ascii_order_and_preserve_zero() {
        // Independently computed using Python hashlib, not this signing implementation.
        let params = BTreeMap::from([
            ("pid".into(), "1001".into()),
            ("name".into(), "Test".into()),
            ("money".into(), "1.00".into()),
        ]);
        assert_eq!(
            signature(&params, "secret"),
            "e90d8bd610031169dab23714da0a8771"
        );
        let mut params = params;
        params.insert("name".into(), "港币".into());
        params.insert("money".into(), "0".into());
        params.insert("param".into(), "".into());
        params.insert("sign".into(), "ignored".into());
        params.insert("sign_type".into(), "MD5".into());
        let expected = "af1489f0bb751cd85650248825c176f3";
        assert_eq!(signature(&params, "secret"), expected);
        assert!(verify_signature(&params, "secret", expected));
        assert!(!verify_signature(
            &params,
            "secret",
            &expected.to_uppercase()
        ));
        assert!(!verify_signature(&params, "wrong", expected));
        let params = BTreeMap::from([("b".into(), "空 格".into()), ("a".into(), "x&y=z".into())]);
        assert_eq!(
            signature(&params, "secret"),
            "c832043865330ff3bfd3196c2ae6bd92"
        );
    }
    #[test]
    fn decimal_parser_is_exact_bounded_and_positive() {
        for (text, cents) in [
            ("0.01", 1),
            ("1", 100),
            ("1.2", 120),
            ("1.23", 123),
            ("92233720368547758.07", i64::MAX),
        ] {
            assert_eq!(parse_cny_minor(text), Ok(cents));
            assert_eq!(
                parse_cny_minor(&format_cny_minor(cents).unwrap()),
                Ok(cents)
            );
        }
        for invalid in [
            "0",
            "-1.00",
            "+1.00",
            "1.001",
            "1.",
            ".1",
            "1e2",
            "NaN",
            "1,00",
            " 1.00",
            "１.００",
            "92233720368547758.08",
            "99999999999999999999999",
        ] {
            assert_eq!(
                parse_cny_minor(invalid),
                Err(Error::InvalidRequest),
                "{invalid}"
            );
        }
        assert!(format_cny_minor(0).is_err());
    }
    #[test]
    fn callback_decodes_once_and_closed_fields_precede_signature_verification() {
        let client = QixiangClient::new(config()).unwrap();
        let params = notification();
        let raw = signed(params.clone());
        assert_eq!(parse_callback(&raw).unwrap()["name"], params["name"]);
        assert_eq!(
            client
                .verify_notification(&raw, &expected())
                .unwrap()
                .provider_trade_no,
            "trade-1"
        );
        // Unknown/duplicate fields are rejected even when the signature is otherwise valid.
        for suffix in [
            "&unknown=x",
            "&%70id=1001",
            "&money=1.23",
            "&param=%",
            "&param=%0G",
            "&param=%FF",
            "&param=%00",
            "&&",
            "&=x",
        ] {
            assert_eq!(
                client.verify_notification(&(raw.clone() + suffix), &expected()),
                Err(Error::InvalidNotification),
                "{suffix}"
            );
        }
        assert_eq!(
            client.verify_notification(&"x".repeat(MAX_CALLBACK + 1), &expected()),
            Err(Error::InvalidNotification)
        );
        let mut params = notification();
        params.insert("money".into(), "1.24".into());
        assert_eq!(
            client.verify_notification(&signed(params), &expected()),
            Err(Error::IdentityMismatch)
        );
        for (field, value) in [
            ("pid", "1002"),
            ("type", "alipay"),
            ("trade_no", "trade-2"),
            ("out_trade_no", "order-2"),
        ] {
            let mut params = notification();
            params.insert(field.into(), value.into());
            assert_eq!(
                client.verify_notification(&signed(params), &expected()),
                Err(Error::IdentityMismatch)
            );
        }
        let mut params = notification();
        params.insert("trade_status".into(), "WAIT_BUYER_PAY".into());
        assert_eq!(
            client.verify_notification(&signed(params), &expected()),
            Err(Error::InvalidNotification)
        );
        assert_eq!(
            client.verify_notification(&raw.replace("1.23", "1.24"), &expected()),
            Err(Error::InvalidSignature)
        );
    }
    #[test]
    fn configuration_redacts_secrets_and_rejects_unsafe_urls() {
        assert!(!format!("{:?}", config()).contains("secret"));
        for url in [
            "http://q.example/notify",
            "https://user:pass@q.example/notify",
            "https://q.example:444/notify",
            "https://q.example/notify#fragment",
        ] {
            assert!(
                QixiangConfig::new(
                    "1001".into(),
                    "secret".into(),
                    url,
                    "https://q.example/return"
                )
                .is_err()
            );
        }
        assert!(QixiangClient::fixture(config(), "http://localhost:1234/").is_err());
    }

    struct FixtureState {
        status: StatusCode,
        body: Vec<u8>,
        redirect: Option<String>,
        requests: Mutex<Vec<(String, String)>>,
        count: AtomicUsize,
    }
    struct Fixture {
        client: QixiangClient,
        state: Arc<FixtureState>,
        task: JoinHandle<()>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    async fn fixture(status: StatusCode, body: Vec<u8>, redirect: Option<String>) -> Fixture {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}/", listener.local_addr().unwrap());
        let state = Arc::new(FixtureState {
            status,
            body,
            redirect,
            requests: Mutex::new(vec![]),
            count: AtomicUsize::new(0),
        });
        async fn handler(
            State(state): State<Arc<FixtureState>>,
            request: Request<Body>,
        ) -> Response<Body> {
            state.count.fetch_add(1, Ordering::SeqCst);
            assert_eq!(request.method(), "POST");
            assert_eq!(
                request.headers()["content-type"],
                "application/x-www-form-urlencoded"
            );
            let uri = request.uri().to_string();
            let body = to_bytes(request.into_body(), 16 * 1024).await.unwrap();
            state
                .requests
                .lock()
                .await
                .push((uri, String::from_utf8(body.to_vec()).unwrap()));
            let mut response = Response::builder().status(state.status);
            if let Some(location) = &state.redirect {
                response = response.header("location", location);
            }
            response.body(Body::from(state.body.clone())).unwrap()
        }
        let app = Router::new().fallback(handler).with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Fixture {
            client: QixiangClient::fixture(config(), &origin).unwrap(),
            state,
            task,
        }
    }
    #[tokio::test]
    async fn create_signs_server_side_and_returns_only_documented_https_checkout() {
        let response = json!({"code":1,"trade_no":"trade-1","payurl":"https://api.payqixiang.cn/pay/submit/order-1/", "qrcode":"weixin://not-launched"});
        let fixture = fixture(StatusCode::OK, response.to_string().into_bytes(), None).await;
        let created = fixture.client.create(&create_request()).await.unwrap();
        assert_eq!(created.provider_trade_no, "trade-1");
        let requests = fixture.state.requests.lock().await;
        assert_eq!(requests[0].0, "/mapi.php");
        assert!(!requests[0].0.contains("secret"));
        let params: BTreeMap<String, String> = form_urlencoded::parse(requests[0].1.as_bytes())
            .into_owned()
            .collect();
        assert!(!params.contains_key("key"));
        assert_eq!(params["money"], "1.23");
        assert_eq!(params["device"], "jump");
        assert_eq!(params["type"], "wxpay");
        assert!(verify_signature(&params, "secret", &params["sign"]));
        drop(requests);
        for unsafe_url in [
            "http://api.payqixiang.cn/pay/1",
            "https://evil.example/pay/1",
            "https://api.payqixiang.cn@evil.example/1",
            "weixin://pay/1",
            "https://api.payqixiang.cn:444/pay/1",
        ] {
            let value = json!({"code":1,"trade_no":"trade-1","payurl":unsafe_url});
            let fixture = self::fixture(StatusCode::OK, value.to_string().into_bytes(), None).await;
            assert_eq!(
                fixture.client.create(&create_request()).await,
                Err(Error::InvalidResponse)
            );
        }
    }
    #[tokio::test]
    async fn only_matching_paid_query_confirms_payment_and_key_stays_in_post_body() {
        let fixture = fixture(
            StatusCode::OK,
            paid_response().to_string().into_bytes(),
            None,
        )
        .await;
        assert!(matches!(
            fixture.client.query(&expected()).await.unwrap(),
            QueryOutcome::Paid(_)
        ));
        let requests = fixture.state.requests.lock().await;
        assert_eq!(requests[0].0, "/api.php?act=order");
        assert!(!requests[0].0.contains("secret"));
        let params: BTreeMap<String, String> = form_urlencoded::parse(requests[0].1.as_bytes())
            .into_owned()
            .collect();
        assert_eq!(params["key"], "secret");
        assert_eq!(params["out_trade_no"], "order-1");
        assert!(!params.contains_key("trade_no"));
        drop(requests);
        for (field, value) in [
            ("pid", json!(1002)),
            ("out_trade_no", json!("other")),
            ("trade_no", json!("other")),
            ("type", json!("alipay")),
            ("money", json!("1.24")),
            ("money", json!(1.23)),
            ("status", json!(2)),
            ("status", json!("1")),
        ] {
            let mut response = paid_response();
            response[field] = value;
            let fixture =
                self::fixture(StatusCode::OK, response.to_string().into_bytes(), None).await;
            assert!(fixture.client.query(&expected()).await.is_err(), "{field}");
        }
        let mut response = paid_response();
        response["status"] = json!(0);
        let fixture = self::fixture(StatusCode::OK, response.to_string().into_bytes(), None).await;
        assert_eq!(
            fixture.client.query(&expected()).await,
            Ok(QueryOutcome::Unpaid)
        );
    }

    #[tokio::test]
    async fn paid_query_preserves_bounded_raw_endtime_without_timezone_inference() {
        for (value, expected_raw) in [
            (None, None),
            (Some(Value::Null), None),
            (Some(json!("")), None),
            (
                Some(json!("2026-11-02T12:34:56+08:00")),
                Some("2026-11-02T12:34:56+08:00".to_owned()),
            ),
            (
                Some(json!("2026-11-02 12:34:56")),
                Some("2026-11-02 12:34:56".to_owned()),
            ),
            // Protocol evidence remains raw; policy must reject ambiguous/unparseable dates.
            (
                Some(json!("not a timestamp")),
                Some("not a timestamp".to_owned()),
            ),
            (Some(json!(" ")), Some(" ".to_owned())),
            (Some(json!("港".repeat(42))), Some("港".repeat(42))),
            (Some(json!("x".repeat(128))), Some("x".repeat(128))),
        ] {
            let mut response = paid_response();
            if let Some(value) = value {
                response["endtime"] = value;
            }
            let fixture = fixture(StatusCode::OK, response.to_string().into_bytes(), None).await;
            let QueryOutcome::Paid(confirmation) = fixture.client.query(&expected()).await.unwrap()
            else {
                panic!("Matching paid query must return confirmation");
            };
            assert_eq!(confirmation.provider_paid_at_raw, expected_raw);
        }
        for value in [
            json!(123),
            json!({"date":"2026-11-02"}),
            json!(["2026-11-02"]),
            json!("x".repeat(129)),
            json!("港".repeat(43)),
            json!("2026-11-02\n12:34:56"),
            json!("\u{7f}"),
            json!("\u{85}"),
        ] {
            let mut response = paid_response();
            response["endtime"] = value;
            let fixture = fixture(StatusCode::OK, response.to_string().into_bytes(), None).await;
            assert_eq!(
                fixture.client.query(&expected()).await,
                Err(Error::InvalidResponse)
            );
        }
    }
    #[tokio::test]
    async fn bounds_invalid_responses_and_never_retries_or_follows_redirects() {
        for body in [
            b"not json: secret".to_vec(),
            vec![b'x'; MAX_RESPONSE + 1],
            b"{\"code\":1}".to_vec(),
        ] {
            let fixture = fixture(StatusCode::OK, body, None).await;
            assert_eq!(
                fixture.client.query(&expected()).await,
                Err(Error::InvalidResponse)
            );
            assert_eq!(fixture.state.count.load(Ordering::SeqCst), 1);
        }
        for (status, redirect) in [
            (StatusCode::TEMPORARY_REDIRECT, Some("/trapped".into())),
            (StatusCode::INTERNAL_SERVER_ERROR, None),
        ] {
            let fixture = fixture(status, b"secret untrusted payload".to_vec(), redirect).await;
            let error = fixture.client.create(&create_request()).await.unwrap_err();
            assert_eq!(error, Error::Transport);
            assert!(!error.to_string().contains("secret"));
            assert_eq!(fixture.state.count.load(Ordering::SeqCst), 1);
        }
        let fixture = fixture(
            StatusCode::OK,
            b"{\"code\":-1,\"msg\":\"secret\"}".to_vec(),
            None,
        )
        .await;
        assert_eq!(
            fixture.client.query(&expected()).await,
            Err(Error::ProviderRejected)
        );
    }

    #[tokio::test]
    async fn bounds_streamed_body_without_content_length() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}/", listener.local_addr().unwrap());
        let app = Router::new().fallback(|| async {
            let chunks = futures_util::stream::iter([
                Ok::<_, std::io::Error>(vec![b' '; MAX_RESPONSE]),
                Ok(vec![b' '; 1]),
            ]);
            Response::new(Body::from_stream(chunks))
        });
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = QixiangClient::fixture(config(), &origin).unwrap();
        let result = client.query(&expected()).await;
        task.abort();
        assert_eq!(result, Err(Error::InvalidResponse));
    }

    #[tokio::test]
    async fn invalid_frozen_identity_or_create_request_never_leaves_server() {
        let fixture = fixture(
            StatusCode::OK,
            paid_response().to_string().into_bytes(),
            None,
        )
        .await;
        let mut invalid = expected();
        invalid.merchant_id = "1002".into();
        assert_eq!(
            fixture.client.query(&invalid).await,
            Err(Error::InvalidRequest)
        );
        let mut invalid = create_request();
        invalid.amount_minor_cny = 0;
        assert_eq!(
            fixture.client.create(&invalid).await,
            Err(Error::InvalidRequest)
        );
        assert_eq!(fixture.state.count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn native_qrcode_cannot_replace_checkout_and_ambiguous_json_is_rejected() {
        for body in [
            r#"{"code":1,"trade_no":"trade-1","qrcode":"weixin://wxpay/something"}"#,
            r#"{"code":1,"code":-1,"trade_no":"trade-1","payurl":"https://api.payqixiang.cn/pay/1"}"#,
            r#"{"code":"1","trade_no":"trade-1","payurl":"https://api.payqixiang.cn/pay/1"}"#,
        ] {
            let fixture = fixture(StatusCode::OK, body.as_bytes().to_vec(), None).await;
            assert_eq!(
                fixture.client.create(&create_request()).await,
                Err(Error::InvalidResponse)
            );
        }
    }
}
