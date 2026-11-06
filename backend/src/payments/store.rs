use super::{
    PaymentRuntime,
    config::RateSnapshot,
    qixiang::{Channel, ExpectedPayment},
};
use crate::error::{ApiError, ApiResult};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub const ORDER_SELECT: &str = "SELECT o.*,refund.id AS refund_id,refund.version AS refund_version,refund.status AS refund_status,CASE WHEN refund.status='refunded' THEN refund.updated_at ELSE NULL END AS refunded_at,q.channel,q.credit_minor,q.base_minor,q.fee_minor,q.pay_minor,q.fee_bps,q.rate_snapshot,q.expires_at AS quote_expires_at,q.config_fingerprint FROM payment_orders o JOIN payment_quotes q ON q.id=o.quote_id LEFT JOIN payment_refunds refund ON refund.payment_id=o.id";
#[derive(Clone, sqlx::FromRow)]
pub struct Order {
    pub id: Uuid,
    pub user_id: Uuid,
    pub refund_id: Option<Uuid>,
    pub refund_version: Option<i64>,
    pub refund_status: Option<String>,
    pub refunded_at: Option<DateTime<Utc>>,
    pub quote_id: Uuid,
    pub client_request_id: Uuid,
    pub merchant_id: String,
    pub credential_version: String,
    pub merchant_no: String,
    pub provider_trade_no: Option<String>,
    pub status: String,
    pub version: i64,
    pub evidence_version: i64,
    pub evidence_hash: Option<Vec<u8>>,
    pub provider_paid_at_raw: Option<String>,
    pub provider_paid_at: Option<DateTime<Utc>>,
    pub verified_at: Option<DateTime<Utc>>,
    pub may_have_sent_at: Option<DateTime<Utc>>,
    pub checkout_url: Option<String>,
    pub checkout_expires_at: DateTime<Utc>,
    pub checkout_detached: bool,
    pub resolved: bool,
    pub error_code: Option<String>,
    pub credited_transaction_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub channel: String,
    pub credit_minor: i64,
    pub base_minor: i64,
    pub fee_minor: i64,
    pub pay_minor: i64,
    pub fee_bps: i32,
    pub rate_snapshot: serde_json::Value,
    pub quote_expires_at: DateTime<Utc>,
    pub config_fingerprint: Vec<u8>,
}
#[derive(Serialize, sqlx::FromRow)]
pub struct Quote {
    #[sqlx(rename = "id")]
    pub quote_id: Uuid,
    #[sqlx(rename = "user_id")]
    pub account_id: Uuid,
    pub channel: String,
    #[sqlx(rename = "credit_minor")]
    pub credit_amount_minor_hkd: i64,
    #[sqlx(rename = "base_minor")]
    pub base_amount_minor_cny: i64,
    #[sqlx(rename = "fee_minor")]
    pub fee_minor_cny: i64,
    #[sqlx(rename = "pay_minor")]
    pub pay_amount_minor_cny: i64,
    #[sqlx(rename = "fee_bps")]
    pub fee_basis_points: i32,
    pub expires_at: DateTime<Utc>,
    #[serde(flatten)]
    #[sqlx(json)]
    pub rate_snapshot: RateSnapshot,
    #[sqlx(skip)]
    pub server_time: DateTime<Utc>,
    #[sqlx(skip)]
    pub credit_currency: String,
    #[sqlx(skip)]
    pub pay_currency: String,
    #[sqlx(skip)]
    pub rounding_policy: String,
}
impl Quote {
    pub fn decorate(mut self) -> Self {
        self.server_time = Utc::now();
        self.credit_currency = "HKD".into();
        self.pay_currency = "CNY".into();
        self.rounding_policy = "total_ceiling_minor_v1".into();
        self
    }
}
#[derive(Serialize)]
pub struct OrderView {
    #[serde(flatten)]
    pub quote: Quote,
    pub payment_id: Uuid,
    pub client_request_id: Uuid,
    pub status: String,
    pub checkout_url: Option<String>,
    pub checkout_expires_at: DateTime<Utc>,
    pub checkout_detached: bool,
    pub terminal: bool,
    pub safe_to_start_new: bool,
    pub can_detach_checkout: bool,
    pub poll_after_seconds: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub error_code: Option<String>,
    pub credited_transaction_id: Option<Uuid>,
    pub evidence_version: i64,
    pub refund_id: Option<Uuid>,
    pub refund_version: Option<i64>,
    pub refund_status: Option<String>,
    pub refunded_at: Option<DateTime<Utc>>,
}
impl Order {
    pub fn channel(&self) -> Channel {
        if self.channel == "wechat" {
            Channel::Wechat
        } else {
            Channel::Alipay
        }
    }
    pub fn expected(&self) -> ExpectedPayment {
        ExpectedPayment {
            merchant_id: self.merchant_id.clone(),
            merchant_order_no: self.merchant_no.clone(),
            provider_trade_no: self.provider_trade_no.clone(),
            channel: self.channel(),
            amount_minor_cny: self.pay_minor,
        }
    }
    pub fn view(self, slot: Option<Uuid>) -> ApiResult<OrderView> {
        let rate_snapshot =
            serde_json::from_value(self.rate_snapshot).map_err(|_| ApiError::internal())?;
        let quote = Quote {
            quote_id: self.quote_id,
            account_id: self.user_id,
            channel: self.channel,
            credit_amount_minor_hkd: self.credit_minor,
            base_amount_minor_cny: self.base_minor,
            fee_minor_cny: self.fee_minor,
            pay_amount_minor_cny: self.pay_minor,
            fee_basis_points: self.fee_bps,
            expires_at: self.quote_expires_at,
            rate_snapshot,
            server_time: Utc::now(),
            credit_currency: "HKD".into(),
            pay_currency: "CNY".into(),
            rounding_policy: "total_ceiling_minor_v1".into(),
        };
        let terminal = self.resolved;
        let can_open = self.status == "awaiting_payment"
            && !self.checkout_detached
            && self.checkout_expires_at > Utc::now();
        Ok(OrderView {
            quote,
            payment_id: self.id,
            client_request_id: self.client_request_id,
            status: self.status,
            checkout_url: if can_open { self.checkout_url } else { None },
            checkout_expires_at: self.checkout_expires_at,
            checkout_detached: self.checkout_detached,
            terminal,
            safe_to_start_new: slot.is_none(),
            can_detach_checkout: !terminal && !self.checkout_detached && slot == Some(self.id),
            poll_after_seconds: 10,
            created_at: self.created_at,
            updated_at: self.updated_at,
            error_code: self.error_code,
            credited_transaction_id: self.credited_transaction_id,
            evidence_version: self.evidence_version,
            refund_id: self.refund_id,
            refund_version: self.refund_version,
            refund_status: self.refund_status,
            refunded_at: self.refunded_at,
        })
    }
}
pub async fn lock_identities(
    tx: &mut Transaction<'_, Postgres>,
    ids: &[Uuid],
) -> ApiResult<Vec<(Uuid, String)>> {
    Ok(
        sqlx::query_as("SELECT id,status FROM identities WHERE id=ANY($1) ORDER BY id FOR UPDATE")
            .bind(ids)
            .fetch_all(&mut **tx)
            .await?,
    )
}
pub fn active(rows: &[(Uuid, String)], user: Uuid) -> bool {
    rows.iter()
        .any(|(id, status)| *id == user && status == "active")
}
pub async fn lock_order(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> ApiResult<Order> {
    sqlx::query_as(&format!("{ORDER_SELECT} WHERE o.id=$1 FOR UPDATE OF o"))
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(not_found)
}
pub async fn slot(tx: &mut Transaction<'_, Postgres>, user: Uuid) -> ApiResult<Option<Uuid>> {
    Ok(sqlx::query_scalar(
        "SELECT payment_id FROM payment_checkout_slots WHERE user_id=$1 FOR UPDATE",
    )
    .bind(user)
    .fetch_optional(&mut **tx)
    .await?)
}
pub async fn load(pool: &sqlx::PgPool, user: Uuid, id: Uuid) -> ApiResult<Order> {
    sqlx::query_as(&format!("{ORDER_SELECT} WHERE o.id=$1 AND o.user_id=$2"))
        .bind(id)
        .bind(user)
        .fetch_optional(pool)
        .await?
        .ok_or_else(not_found)
}
pub async fn owner(pool: &sqlx::PgPool, id: Uuid) -> ApiResult<Uuid> {
    sqlx::query_scalar("SELECT user_id FROM payment_orders WHERE id=$1")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(not_found)
}
pub async fn view(pool: &sqlx::PgPool, order: Order) -> ApiResult<OrderView> {
    let slot = sqlx::query_scalar("SELECT payment_id FROM payment_checkout_slots WHERE user_id=$1")
        .bind(order.user_id)
        .fetch_optional(pool)
        .await?;
    order.view(slot)
}
pub fn unavailable() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "PAYMENTS_UNAVAILABLE",
        "Payments are unavailable until provider, exchange-rate evidence, fee and approval policy are configured.",
    )
}
pub fn not_found() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::NOT_FOUND,
        "PAYMENT_NOT_FOUND",
        "Payment not found.",
    )
}
pub fn conflict() -> ApiError {
    ApiError::conflict(
        "PAYMENT_STATE_CHANGED",
        "The payment or evidence changed. Refresh before continuing.",
    )
}
pub fn runtime(state: &crate::AppState) -> ApiResult<&PaymentRuntime> {
    state.payments.as_deref().ok_or_else(unavailable)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
    pub view: Option<String>,
}
pub fn cursor(value: Option<&str>) -> ApiResult<Option<(DateTime<Utc>, Uuid)>> {
    value
        .map(|value| {
            let (time, id) = value
                .split_once('|')
                .ok_or_else(|| ApiError::validation("Invalid cursor."))?;
            Ok((
                DateTime::parse_from_rfc3339(time)
                    .map_err(|_| ApiError::validation("Invalid cursor."))?
                    .with_timezone(&Utc),
                id.parse()
                    .map_err(|_| ApiError::validation("Invalid cursor."))?,
            ))
        })
        .transpose()
}
pub fn page_limit(limit: Option<i64>) -> ApiResult<i64> {
    let value = limit.unwrap_or(20);
    if !(1..=50).contains(&value) {
        return Err(ApiError::validation("Limit must be between 1 and 50."));
    }
    Ok(value)
}
