use super::{
    config::quote_math,
    fx, jobs, operator,
    store::{self, ORDER_SELECT, Order, Page, Quote},
};
use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::Authenticated,
    validation::ApiJson,
};
use axum::{
    Json,
    extract::{Path, Query, RawQuery, State},
    http::StatusCode,
};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Serialize)]
pub struct Capabilities {
    enabled: bool,
    unavailable_reason: Option<&'static str>,
    channels: Vec<ChannelCapability>,
    credit_currency: &'static str,
    pay_currency: &'static str,
    min_credit_amount_minor_hkd: Option<i64>,
    max_credit_amount_minor_hkd: Option<i64>,
    fee_basis_points: Option<i32>,
    quote_ttl_seconds: Option<i64>,
    checkout_detach_supported: bool,
    payment_history_supported: bool,
    independent_orders_supported: bool,
    approval_mode: &'static str,
    server_time: chrono::DateTime<Utc>,
}
#[derive(Serialize)]
struct ChannelCapability {
    id: &'static str,
    enabled: bool,
    unavailable_reason: Option<&'static str>,
}
async fn configured_operators(
    state: &AppState,
    runtime: &super::PaymentRuntime,
    payer: Uuid,
) -> ApiResult<bool> {
    let ids: Vec<Uuid> = runtime
        .policy
        .makers
        .union(&runtime.policy.checkers)
        .filter(|id| **id != payer)
        .copied()
        .collect();
    let active: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM identities WHERE id=ANY($1) AND status='active'")
            .bind(ids)
            .fetch_all(&state.pool)
            .await?;
    Ok(independent_reviewers(runtime, payer, |id| {
        active.contains(&id)
    }))
}
fn independent_reviewers(
    runtime: &super::PaymentRuntime,
    payer: Uuid,
    active: impl Fn(Uuid) -> bool,
) -> bool {
    runtime.policy.makers.iter().any(|m| {
        *m != payer
            && active(*m)
            && runtime
                .policy
                .checkers
                .iter()
                .any(|c| *c != payer && c != m && active(*c))
    })
}
fn funding_identity_ids(runtime: Option<&super::PaymentRuntime>, payer: Uuid) -> Vec<Uuid> {
    let mut ids = vec![payer];
    if let Some(runtime) = runtime {
        ids.extend(
            runtime
                .policy
                .makers
                .union(&runtime.policy.checkers)
                .copied(),
        );
    }
    ids
}
fn reviewers_unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "PAYMENT_REVIEWERS_UNAVAILABLE",
        "Payments require two independent active reviewers other than the payer.",
    )
}
async fn require_funding_reviewers(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    runtime: &super::PaymentRuntime,
    identities: &[(Uuid, String)],
    payer: Uuid,
) -> ApiResult<()> {
    if !independent_reviewers(runtime, payer, |id| store::active(identities, id))
        || !operator::funding_policy_is_current(tx, runtime).await?
    {
        return Err(reviewers_unavailable());
    }
    Ok(())
}
pub async fn capabilities(
    State(state): State<AppState>,
    auth: Authenticated,
) -> ApiResult<Json<Capabilities>> {
    let runtime = state.payments.as_deref();
    let reason = if let Some(r) = runtime {
        if !configured_operators(&state, r, auth.user_id).await? {
            Some("PAYMENT_REVIEWERS_UNAVAILABLE")
        } else if !fx::quote_available(&state.pool, r).await? {
            Some("PAYMENTS_NOT_READY")
        } else {
            None
        }
    } else {
        Some("PAYMENTS_NOT_READY")
    };
    let enabled = reason.is_none();
    Ok(Json(Capabilities {
        enabled,
        unavailable_reason: reason,
        channels: ["wechat", "alipay"]
            .into_iter()
            .map(|id| ChannelCapability {
                id,
                enabled,
                unavailable_reason: reason,
            })
            .collect(),
        credit_currency: "HKD",
        pay_currency: "CNY",
        min_credit_amount_minor_hkd: runtime.map(|r| r.policy.min_credit_amount_minor_hkd),
        max_credit_amount_minor_hkd: runtime.map(|r| r.policy.max_credit_amount_minor_hkd),
        fee_basis_points: runtime.map(|r| r.policy.fee_basis_points),
        quote_ttl_seconds: runtime.map(|r| r.policy.quote_ttl_seconds),
        checkout_detach_supported: true,
        payment_history_supported: true,
        independent_orders_supported: false,
        approval_mode: "governance_maker_checker_v1",
        server_time: Utc::now(),
    }))
}
pub async fn wallet(
    State(state): State<AppState>,
    auth: Authenticated,
) -> ApiResult<Json<crate::ledger::real_hkd::Wallet>> {
    Ok(Json(
        crate::ledger::real_hkd::wallet(&state.pool, auth.user_id).await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuoteRequest {
    pub channel: String,
    pub credit_amount_minor_hkd: i64,
}
pub async fn quote(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(request): ApiJson<QuoteRequest>,
) -> ApiResult<Json<Quote>> {
    state.limit_auth(format!("payment-quote:{}", auth.user_id), 30)?;
    let r = store::runtime(&state)?;
    let p = &r.policy;
    if !matches!(request.channel.as_str(), "wechat" | "alipay")
        || !(p.min_credit_amount_minor_hkd..=p.max_credit_amount_minor_hkd)
            .contains(&request.credit_amount_minor_hkd)
    {
        return Err(ApiError::validation(
            "Choose an available channel and amount within the allowed HKD range.",
        ));
    }
    let mut tx = state.pool.begin().await?;
    let ids = funding_identity_ids(Some(r), auth.user_id);
    let identities = store::lock_identities(&mut tx, &ids).await?;
    if !store::active(&identities, auth.user_id) {
        return Err(ApiError::unauthorized());
    }
    require_funding_reviewers(&mut tx, r, &identities, auth.user_id).await?;
    let rate = fx::rate_for_quote(&mut tx, r).await?;
    let (base, fee, pay) = quote_math(
        request.credit_amount_minor_hkd,
        &rate.rate_cny_per_100_hkd,
        p.fee_basis_points,
    )
    .map_err(|_| ApiError::validation("The amount cannot be quoted."))?;
    let expires = std::cmp::min(
        Utc::now() + Duration::seconds(p.quote_ttl_seconds),
        p.rate_expires_at(&rate),
    );
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO payment_quotes(id,user_id,channel,credit_minor,base_minor,fee_minor,pay_minor,fee_bps,rate_snapshot,config_fingerprint,expires_at,merchant_id,credential_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)")
 .bind(id).bind(auth.user_id).bind(request.channel).bind(request.credit_amount_minor_hkd).bind(base).bind(fee).bind(pay).bind(p.fee_basis_points).bind(serde_json::to_value(&rate).map_err(|_|ApiError::internal())?).bind(&r.fingerprint).bind(expires).bind(&r.merchant_id).bind(&r.credential_version).execute(&mut *tx).await?;
    let quote: Quote = sqlx::query_as("SELECT * FROM payment_quotes WHERE id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(quote.decorate()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRequest {
    pub quote_id: Uuid,
    pub client_request_id: Uuid,
}
#[derive(sqlx::FromRow)]
struct QuoteAuthorizationRow {
    expires_at: chrono::DateTime<Utc>,
    config_fingerprint: Vec<u8>,
    merchant_id: String,
    credential_version: String,
    rate_snapshot: serde_json::Value,
}
pub async fn create(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(request): ApiJson<CreateRequest>,
) -> ApiResult<Json<store::OrderView>> {
    state.limit_auth(format!("payment-create:{}", auth.user_id), 20)?;
    // Lock all candidate identities in the common UUID order. A suspension cannot slip
    // between the eligibility check and the new order/work-item commit. Original-key
    // recovery and the expired never-created receipt do not depend on current policy.
    let runtime = store::runtime(&state);
    let ids = funding_identity_ids(runtime.as_ref().ok().copied(), auth.user_id);
    let mut tx = state.pool.begin().await?;
    let identities = store::lock_identities(&mut tx, &ids).await?;
    if !store::active(&identities, auth.user_id) {
        return Err(ApiError::unauthorized());
    }
    let prior: Option<Order> = sqlx::query_as(&format!(
        "{ORDER_SELECT} WHERE o.user_id=$1 AND o.client_request_id=$2 FOR UPDATE OF o"
    ))
    .bind(auth.user_id)
    .bind(request.client_request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(order) = prior {
        if order.quote_id != request.quote_id {
            return Err(ApiError::conflict(
                "IDEMPOTENCY_CONFLICT",
                "This request key belongs to a different quote.",
            ));
        }
        let slot = store::slot(&mut tx, auth.user_id).await?;
        tx.commit().await?;
        return Ok(Json(order.view(slot)?));
    }
    let quote: Option<QuoteAuthorizationRow> = sqlx::query_as(
        "SELECT expires_at,config_fingerprint,merchant_id,credential_version,rate_snapshot FROM payment_quotes WHERE id=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(request.quote_id)
    .bind(auth.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(QuoteAuthorizationRow {
        expires_at: expires,
        config_fingerprint: fingerprint,
        merchant_id,
        credential_version,
        rate_snapshot,
    }) = quote
    else {
        return Err(store::not_found());
    };
    // The quote is single-use, including authoritative no-create receipts. Another key
    // cannot cancel, replace or reinterpret an order which already owns this quote.
    let used: Option<Uuid> = sqlx::query_scalar("SELECT id FROM payment_orders WHERE quote_id=$1")
        .bind(request.quote_id)
        .fetch_optional(&mut *tx)
        .await?;
    if let Some(id) = used {
        store::lock_order(&mut tx, id).await?;
        return Err(store::conflict());
    }
    if expires <= Utc::now() {
        // This key never reserved a provider send. Persist that fact instead of leaving
        // a client with an unqueryable expired intent. Delayed/replayed creates now find
        // this terminal receipt first and can never enqueue a supplier write.
        let id = Uuid::new_v4();
        let now = Utc::now();
        sqlx::query("INSERT INTO payment_orders(id,user_id,quote_id,client_request_id,merchant_id,credential_version,merchant_no,status,error_code,resolved,checkout_detached,created_at,updated_at,checkout_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'failed','not_created',true,true,$8,$8,$8)")
            .bind(id).bind(auth.user_id).bind(request.quote_id).bind(request.client_request_id).bind(merchant_id).bind(credential_version).bind(format!("q{}",id.simple())).bind(now).execute(&mut *tx).await?;
        let order = store::lock_order(&mut tx, id).await?;
        let slot = store::slot(&mut tx, auth.user_id).await?;
        tx.commit().await?;
        return Ok(Json(order.view(slot)?));
    }
    let r = runtime?;
    require_funding_reviewers(&mut tx, r, &identities, auth.user_id).await?;
    let frozen_rate: super::RateSnapshot =
        serde_json::from_value(rate_snapshot).map_err(|_| ApiError::internal())?;
    if merchant_id != r.merchant_id
        || credential_version != r.credential_version
        || r.provider(&credential_version, &merchant_id).is_none()
        || !r.accepts_quote_fingerprint(&fingerprint, &frozen_rate)
    {
        return Err(ApiError::conflict(
            "PAYMENT_QUOTE_CHANGED",
            "The server policy changed. Request a new quote.",
        ));
    }
    if !fx::creation_allowed(&mut tx, r).await? || !r.policy.rate_fresh(&frozen_rate, Utc::now()) {
        return Err(store::unavailable());
    }
    if store::slot(&mut tx, auth.user_id).await?.is_some() {
        return Err(ApiError::conflict(
            "PAYMENT_CHECKOUT_ACTIVE",
            "Resume or explicitly detach the existing checkout first.",
        ));
    }
    let id = Uuid::new_v4();
    let merchant_no = format!("q{}", id.simple());
    sqlx::query("INSERT INTO payment_orders(id,user_id,quote_id,client_request_id,merchant_id,merchant_no,status,checkout_expires_at,credential_version) VALUES($1,$2,$3,$4,$5,$6,'creating',$7,$8)")
 .bind(id).bind(auth.user_id).bind(request.quote_id).bind(request.client_request_id).bind(&r.merchant_id).bind(merchant_no).bind(Utc::now()+Duration::seconds(r.policy.checkout_ttl_seconds)).bind(&r.credential_version).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO payment_checkout_slots(user_id,payment_id) VALUES($1,$2)")
        .bind(auth.user_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    jobs::schedule(&mut tx, id).await?;
    let order = store::lock_order(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(order.view(Some(id))?))
}
pub async fn fx_status(
    State(state): State<AppState>,
    auth: Authenticated,
) -> ApiResult<Json<fx::FxStatus>> {
    let r = store::runtime(&state)?;
    let mut tx = state.pool.begin().await?;
    let identities = store::lock_identities(&mut tx, &[auth.user_id]).await?;
    if !store::active(&identities, auth.user_id) {
        return Err(ApiError::unauthorized());
    }
    operator::authorize(&mut tx, r, auth.user_id, None).await?;
    let result = fx::status(&mut tx, r).await?;
    tx.commit().await?;
    Ok(Json(result))
}
pub async fn fx_activate(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(request): ApiJson<fx::ActivationRequest>,
) -> ApiResult<Json<fx::Activation>> {
    let r = store::runtime(&state)?;
    let mut tx = state.pool.begin().await?;
    let identities = store::lock_identities(&mut tx, &[auth.user_id]).await?;
    if !store::active(&identities, auth.user_id) {
        return Err(ApiError::unauthorized());
    }
    operator::authorize(&mut tx, r, auth.user_id, None).await?;
    let result = fx::activate(&mut tx, r, auth.user_id, request).await?;
    tx.commit().await?;
    Ok(Json(result))
}
pub async fn detail(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<store::OrderView>> {
    Ok(Json(
        store::view(
            &state.pool,
            store::load(&state.pool, auth.user_id, id).await?,
        )
        .await?,
    ))
}
pub async fn by_key(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(key): Path<Uuid>,
) -> ApiResult<Json<store::OrderView>> {
    let order: Order = sqlx::query_as(&format!(
        "{ORDER_SELECT} WHERE o.user_id=$1 AND o.client_request_id=$2"
    ))
    .bind(auth.user_id)
    .bind(key)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(store::not_found)?;
    Ok(Json(store::view(&state.pool, order).await?))
}
pub async fn active(
    State(state): State<AppState>,
    auth: Authenticated,
) -> ApiResult<Json<serde_json::Value>> {
    let order: Option<Order> = sqlx::query_as(&format!(
        "{ORDER_SELECT} JOIN payment_checkout_slots s ON s.payment_id=o.id WHERE s.user_id=$1"
    ))
    .bind(auth.user_id)
    .fetch_optional(&state.pool)
    .await?;
    let payment = match order {
        Some(order) => Some(store::view(&state.pool, order).await?),
        None => None,
    };
    Ok(Json(serde_json::json!({"payment":payment})))
}
pub async fn orders(
    State(state): State<AppState>,
    auth: Authenticated,
    Query(page): Query<Page>,
) -> ApiResult<Json<serde_json::Value>> {
    let limit = store::page_limit(page.limit)?;
    let before = store::cursor(page.cursor.as_deref())?;
    let pending = match page.view.as_deref() {
        None | Some("pending") => true,
        Some("history") => false,
        _ => return Err(ApiError::validation("Choose pending or history.")),
    };
    let mut orders:Vec<Order>=sqlx::query_as(&format!("{ORDER_SELECT} WHERE o.user_id=$1 AND (NOT $2 OR NOT o.resolved) AND ($3::timestamptz IS NULL OR (o.created_at,o.id)<($3,$4)) ORDER BY o.created_at DESC,o.id DESC LIMIT $5"))
 .bind(auth.user_id).bind(pending).bind(before.map(|v|v.0)).bind(before.map(|v|v.1)).bind(limit+1).fetch_all(&state.pool).await?;
    let more = orders.len() > limit as usize;
    orders.truncate(limit as usize);
    let next = if more {
        orders
            .last()
            .map(|o| format!("{}|{}", o.created_at.to_rfc3339(), o.id))
    } else {
        None
    };
    let mut items = vec![];
    for order in orders {
        items.push(store::view(&state.pool, order).await?)
    }
    Ok(Json(serde_json::json!({"items":items,"next_cursor":next})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DetachRequest {
    pub acknowledge_old_payment_may_complete: bool,
}
#[derive(Serialize)]
pub struct DetachResponse {
    payment: store::OrderView,
    active_payment: Option<store::OrderView>,
    can_start_new_checkout: bool,
}
pub async fn detach(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    ApiJson(request): ApiJson<DetachRequest>,
) -> ApiResult<Json<DetachResponse>> {
    if !request.acknowledge_old_payment_may_complete {
        return Err(ApiError::validation(
            "Acknowledge that the original payment may still complete.",
        ));
    }
    store::load(&state.pool, auth.user_id, id).await?;
    let mut tx = state.pool.begin().await?;
    let identities = store::lock_identities(&mut tx, &[auth.user_id]).await?;
    if !store::active(&identities, auth.user_id) {
        return Err(ApiError::unauthorized());
    }
    let order = store::lock_order(&mut tx, id).await?;
    if order.user_id != auth.user_id {
        return Err(store::not_found());
    }
    let current = store::slot(&mut tx, auth.user_id).await?;
    if order.status == "credited" {
        return Err(store::conflict());
    }
    let cancelled = jobs::cancel_never_sent(&mut tx, &order).await?;
    if !cancelled && !order.resolved && !order.checkout_detached {
        sqlx::query("UPDATE payment_orders SET checkout_detached=true,version=version+1,updated_at=clock_timestamp() WHERE id=$1").bind(id).execute(&mut *tx).await?;
    }
    if current == Some(id) {
        sqlx::query("DELETE FROM payment_checkout_slots WHERE user_id=$1 AND payment_id=$2")
            .bind(auth.user_id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if !cancelled && !order.resolved && order.verified_at.is_none() {
        jobs::invalidate(&mut tx, id).await?;
    }
    let order = store::lock_order(&mut tx, id).await?;
    let current = store::slot(&mut tx, auth.user_id).await?;
    let active_payment = if let Some(active_id) = current {
        let active: Order =
            sqlx::query_as(&format!("{ORDER_SELECT} WHERE o.id=$1 AND o.user_id=$2"))
                .bind(active_id)
                .bind(auth.user_id)
                .fetch_one(&mut *tx)
                .await?;
        Some(active.view(current)?)
    } else {
        None
    };
    tx.commit().await?;
    Ok(Json(DetachResponse {
        payment: order.view(current)?,
        active_payment,
        can_start_new_checkout: current.is_none(),
    }))
}
pub async fn ledger(
    State(state): State<AppState>,
    auth: Authenticated,
    Query(page): Query<Page>,
) -> ApiResult<Json<serde_json::Value>> {
    let limit = store::page_limit(page.limit)?;
    let mut items = crate::ledger::real_hkd::history(
        &state.pool,
        auth.user_id,
        store::cursor(page.cursor.as_deref())?,
        limit + 1,
    )
    .await?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next = if more {
        items
            .last()
            .map(|e| format!("{}|{}", e.created_at.to_rfc3339(), e.id))
    } else {
        None
    };
    Ok(Json(serde_json::json!({"items":items,"next_cursor":next})))
}
pub async fn notify(
    State(state): State<AppState>,
    RawQuery(query): RawQuery,
) -> Result<&'static str, (StatusCode, &'static str)> {
    let work = async {
        let raw = query
            .as_deref()
            .ok_or_else(|| ApiError::validation("Invalid notification."))?;
        let no = super::qixiang::notification_order_no(raw)
            .map_err(|_| ApiError::validation("Invalid notification."))?;
        let order: Order = sqlx::query_as(&format!("{ORDER_SELECT} WHERE o.merchant_no=$1"))
            .bind(no)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(store::not_found)?;
        let r = store::runtime(&state)?;
        let provider = r
            .provider(&order.credential_version, &order.merchant_id)
            .ok_or_else(store::unavailable)?;
        provider
            .verify_notification(raw, &order.expected())
            .map_err(|_| ApiError::validation("Invalid notification."))?;
        let mut tx = state.pool.begin().await?;
        store::lock_identities(&mut tx, &[order.user_id]).await?;
        let order = store::lock_order(&mut tx, order.id).await?;
        store::slot(&mut tx, order.user_id).await?;
        // Verify again against a trade binding which may have changed while waiting for locks.
        let hint = provider
            .verify_notification(raw, &order.expected())
            .map_err(|_| ApiError::validation("Invalid notification."))?;
        let fingerprint = Sha256::digest(
            format!(
                "{}|{}|{}",
                order.id, hint.provider_trade_no, order.pay_minor
            )
            .as_bytes(),
        )
        .to_vec();
        let inserted=sqlx::query("INSERT INTO payment_notifications(id,payment_id,fingerprint) VALUES($1,$2,$3) ON CONFLICT(fingerprint) DO NOTHING").bind(Uuid::new_v4()).bind(order.id).bind(fingerprint).execute(&mut *tx).await?.rows_affected()>0;
        if inserted && order.verified_at.is_none() && !order.resolved {
            jobs::schedule(&mut tx, order.id).await?;
        }
        tx.commit().await?;
        Ok::<_, ApiError>(())
    };
    work.await
        .map(|_| "success")
        .map_err(|_| (StatusCode::BAD_REQUEST, "fail"))
}
pub async fn browser_return() -> &'static str {
    "Returned to Q. Open the Q app and check the original payment order. Returning here does not confirm payment or credit."
}
