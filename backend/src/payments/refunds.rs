//! Full refunds are externally executed by an operator; this module never calls a payment provider.
use super::{operator, store};
use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::Authenticated,
    validation::ApiJson,
};
use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State},
    http::{Response, header},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;
const SELECT: &str = "SELECT id AS refund_id,payment_id,client_request_id,status,version,reason,notes,pay_minor AS pay_amount_minor_cny,credit_minor AS credit_amount_minor_hkd,CASE WHEN status='refunded' THEN 0 ELSE frozen_minor END AS frozen_minor_hkd,maker_id,checker_id,approved_at,external_reference,executed_at,evidence_sha256,evidence_version,rejection_reason,verified_by,created_at,updated_at FROM payment_refunds";
#[derive(Serialize, sqlx::FromRow)]
pub struct RefundView {
    pub refund_id: Uuid,
    pub payment_id: Uuid,
    pub client_request_id: Uuid,
    pub status: String,
    pub version: i64,
    pub reason: String,
    pub notes: Option<String>,
    pub pay_amount_minor_cny: i64,
    pub credit_amount_minor_hkd: i64,
    pub frozen_minor_hkd: i64,
    pub maker_id: Uuid,
    pub checker_id: Option<Uuid>,
    pub approved_at: Option<DateTime<Utc>>,
    pub external_reference: Option<String>,
    pub executed_at: Option<DateTime<Utc>>,
    pub evidence_sha256: Option<String>,
    pub evidence_version: Option<i64>,
    pub rejection_reason: Option<String>,
    pub verified_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
pub async fn load_by_payment(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> ApiResult<Option<RefundView>> {
    Ok(sqlx::query_as(&format!("{SELECT} WHERE payment_id=$1"))
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?)
}
async fn view(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> ApiResult<RefundView> {
    sqlx::query_as(&format!("{SELECT} WHERE id=$1"))
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(store::not_found)
}
fn existing_owner(rows: &[(Uuid, String)], owner: Uuid) -> bool {
    rows.iter()
        .any(|(id, status)| *id == owner && ["active", "suspended"].contains(&status.as_str()))
}
fn operation_error(error: sqlx::Error) -> ApiError {
    if error
        .as_database_error()
        .is_some_and(|e| e.code().as_deref() == Some("23505"))
    {
        ApiError::conflict(
            "PAYMENT_OPERATION_CONFLICT",
            "This request or evidence is already recorded. Refresh before continuing.",
        )
    } else {
        error.into()
    }
}
fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= max
        && !value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    pub client_request_id: Uuid,
    pub reason: String,
}
pub async fn create(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    ApiJson(req): ApiJson<Create>,
) -> ApiResult<Json<RefundView>> {
    if !text(&req.reason, 1000) {
        return Err(ApiError::validation(
            "Provide a refund reason up to 1000 bytes.",
        ));
    }
    state.limit_auth(format!("payment-refund:{}", auth.user_id), 30)?;
    let owner = store::owner(&state.pool, id).await?;
    let mut tx = state.pool.begin().await?;
    let identities = store::lock_identities(&mut tx, &[owner, auth.user_id]).await?;
    if owner == auth.user_id
        || !existing_owner(&identities, owner)
        || !store::active(&identities, auth.user_id)
    {
        return Err(operator::forbidden());
    }
    operator::authorize(
        &mut tx,
        store::runtime(&state)?,
        auth.user_id,
        Some("maker"),
    )
    .await?;
    let order = store::lock_order(&mut tx, id).await?;
    store::slot(&mut tx, owner).await?;
    if let Some(prior) = load_by_payment(&mut tx, id).await? {
        if prior.client_request_id != req.client_request_id
            || prior.maker_id != auth.user_id
            || prior.reason != req.reason
        {
            return Err(store::conflict());
        }
        tx.commit().await?;
        return Ok(Json(prior));
    }
    if order.verified_at.is_none() || order.provider_trade_no.is_none() {
        return Err(ApiError::conflict(
            "PAYMENT_REFUND_NOT_VERIFIED",
            "Verify the original paid order before requesting an external refund.",
        ));
    }
    let other: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM payment_refunds WHERE maker_id=$1 AND client_request_id=$2)",
    )
    .bind(auth.user_id)
    .bind(req.client_request_id)
    .fetch_one(&mut *tx)
    .await?;
    if other {
        return Err(store::conflict());
    }
    let amount = if order.credited_transaction_id.is_some() {
        order.credit_minor
    } else {
        0
    };
    if amount > 0 {
        crate::ledger::real_hkd::lock_available(&mut tx, owner, amount).await?;
    }
    let refund = Uuid::new_v4();
    sqlx::query("INSERT INTO payment_refunds(id,payment_id,client_request_id,maker_id,status,reason,pay_minor,credit_minor,original_transaction_id,frozen_minor) VALUES($1,$2,$3,$4,'requested',$5,$6,$7,$8,$9)")
 .bind(refund).bind(id).bind(req.client_request_id).bind(auth.user_id).bind(req.reason).bind(order.pay_minor).bind(order.credit_minor).bind(order.credited_transaction_id).bind(amount).execute(&mut *tx).await.map_err(operation_error)?;
    operator::audit(
        &mut tx,
        auth.user_id,
        Some(id),
        "refund_requested",
        json!({"refund_id":refund,"frozen_minor_hkd":amount}),
    )
    .await?;
    let result = view(&mut tx, refund).await?;
    tx.commit().await?;
    Ok(Json(result))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Version {
    pub version: i64,
}
async fn begin<'a>(
    state: &'a AppState,
    actor: Uuid,
    id: Uuid,
    role: Option<&str>,
) -> ApiResult<(Transaction<'a, Postgres>, store::Order, RefundView)> {
    let seed:Option<(Uuid,Uuid,Uuid)>=sqlx::query_as("SELECT r.payment_id,o.user_id,r.maker_id FROM payment_refunds r JOIN payment_orders o ON o.id=r.payment_id WHERE r.id=$1").bind(id).fetch_optional(&state.pool).await?;
    let Some((payment, owner, maker)) = seed else {
        return Err(store::not_found());
    };
    let mut tx = state.pool.begin().await?;
    let identities = store::lock_identities(&mut tx, &[owner, maker, actor]).await?;
    if actor == owner
        || !existing_owner(&identities, owner)
        || ![maker, actor]
            .iter()
            .all(|id| store::active(&identities, *id))
    {
        return Err(operator::forbidden());
    }
    operator::authorize(&mut tx, store::runtime(state)?, actor, role).await?;
    let order = store::lock_order(&mut tx, payment).await?;
    store::slot(&mut tx, owner).await?;
    sqlx::query("SELECT id FROM payment_refunds WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let refund = view(&mut tx, id).await?;
    Ok((tx, order, refund))
}
pub async fn approve(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    ApiJson(req): ApiJson<Version>,
) -> ApiResult<Json<RefundView>> {
    let (mut tx, order, r) = begin(&state, auth.user_id, id, Some("checker")).await?;
    operator::authorize(&mut tx, store::runtime(&state)?, r.maker_id, Some("maker")).await?;
    if r.maker_id == auth.user_id {
        return Err(operator::forbidden());
    }
    if r.checker_id == Some(auth.user_id) && r.status != "requested" {
        tx.commit().await?;
        return Ok(Json(r));
    }
    if r.version != req.version || r.status != "requested" {
        return Err(store::conflict());
    }
    sqlx::query("UPDATE payment_refunds SET status='approved_external',checker_id=$2,approved_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1").bind(id).bind(auth.user_id).execute(&mut *tx).await?;
    operator::audit(
        &mut tx,
        auth.user_id,
        Some(order.id),
        "refund_external_approved",
        json!({"refund_id":id,"provider_request_sent":false}),
    )
    .await?;
    let result = view(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Unknown {
    pub version: i64,
    pub notes: String,
}
pub async fn unknown(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    ApiJson(req): ApiJson<Unknown>,
) -> ApiResult<Json<RefundView>> {
    if !text(&req.notes, 1000) {
        return Err(ApiError::validation(
            "Provide the reason the external result is unknown.",
        ));
    }
    let (mut tx, order, r) = begin(&state, auth.user_id, id, None).await?;
    if ![r.maker_id, r.checker_id.unwrap_or(Uuid::nil())].contains(&auth.user_id) {
        return Err(operator::forbidden());
    }
    if r.status == "unknown" {
        tx.commit().await?;
        return Ok(Json(r));
    }
    if r.version != req.version || r.status != "approved_external" {
        return Err(store::conflict());
    }
    sqlx::query("UPDATE payment_refunds SET status='unknown',notes=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1").bind(id).bind(req.notes).execute(&mut *tx).await?;
    // The restricted record retains the note; the general audit stores only the event.
    operator::audit(
        &mut tx,
        auth.user_id,
        Some(order.id),
        "refund_result_unknown",
        json!({"refund_id":id}),
    )
    .await?;
    let result = view(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub version: i64,
    pub evidence_base64: String,
    pub external_reference: String,
    pub executed_at: DateTime<Utc>,
    pub notes: String,
}
pub async fn evidence(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    ApiJson(req): ApiJson<Evidence>,
) -> ApiResult<Json<RefundView>> {
    if req.evidence_base64.len() > 174_764
        || !text(&req.external_reference, 200)
        || !text(&req.notes, 1000)
        || req.executed_at > Utc::now()
    {
        return Err(ApiError::validation(
            "Provide bounded external refund evidence and its execution reference/time.",
        ));
    }
    let bytes = STANDARD
        .decode(&req.evidence_base64)
        .map_err(|_| ApiError::validation("Evidence must be base64."))?;
    if bytes.is_empty() || bytes.len() > 131_072 {
        return Err(ApiError::validation(
            "Evidence must contain 1 to 131072 bytes.",
        ));
    }
    let hash = operator::hex(&Sha256::digest(&bytes));
    let (mut tx, order, r) = begin(&state, auth.user_id, id, Some("maker")).await?;
    if r.maker_id != auth.user_id {
        return Err(operator::forbidden());
    }
    if r.status != "evidence_rejected"
        && r.evidence_sha256.as_deref() == Some(&hash)
        && r.external_reference.as_deref() == Some(&req.external_reference)
        && r.executed_at == Some(req.executed_at)
    {
        tx.commit().await?;
        return Ok(Json(r));
    }
    if r.version != req.version
        || !["approved_external", "unknown", "evidence_rejected"].contains(&r.status.as_str())
        || order.provider_paid_at.is_none_or(|at| req.executed_at < at)
        || r.approved_at.is_none_or(|at| req.executed_at < at)
    {
        return Err(store::conflict());
    }
    for (kind, value) in [
        ("reference", req.external_reference.as_str()),
        ("hash", hash.as_str()),
    ] {
        sqlx::query("INSERT INTO payment_refund_evidence_bindings(kind,value,refund_id) VALUES($1,$2,$3) ON CONFLICT(kind,value) DO NOTHING").bind(kind).bind(value).bind(id).execute(&mut *tx).await?;
        let owner: Uuid = sqlx::query_scalar(
            "SELECT refund_id FROM payment_refund_evidence_bindings WHERE kind=$1 AND value=$2",
        )
        .bind(kind)
        .bind(value)
        .fetch_one(&mut *tx)
        .await?;
        if owner != id {
            return Err(ApiError::conflict(
                "PAYMENT_EVIDENCE_ALREADY_USED",
                "That external refund evidence/reference belongs to another refund.",
            ));
        }
    }
    let evidence_version = r
        .evidence_version
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(ApiError::internal)?;
    sqlx::query("INSERT INTO payment_refund_evidence(refund_id,evidence_version,evidence,evidence_sha256,external_reference,executed_at,actor_id,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(id).bind(evidence_version).bind(&bytes).bind(&hash).bind(&req.external_reference).bind(req.executed_at).bind(auth.user_id).bind(&req.notes).execute(&mut *tx).await?;
    sqlx::query("UPDATE payment_refunds SET status='evidence_pending',external_reference=$2,executed_at=$3,evidence=$4,evidence_sha256=$5,evidence_actor=$6,notes=$7,evidence_version=$8,rejection_reason=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1")
    .bind(id).bind(req.external_reference).bind(req.executed_at).bind(bytes).bind(&hash).bind(auth.user_id).bind(req.notes).bind(evidence_version).execute(&mut *tx).await.map_err(operation_error)?;
    operator::audit(
        &mut tx,
        auth.user_id,
        Some(order.id),
        "refund_evidence_attached",
        json!({"refund_id":id,"evidence_sha256":hash,"source_validation":"operator_supplied"}),
    )
    .await?;
    let result = view(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Verify {
    pub version: i64,
    pub evidence_sha256: String,
}
pub async fn verify(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    ApiJson(req): ApiJson<Verify>,
) -> ApiResult<Json<RefundView>> {
    let (mut tx, order, r) = begin(&state, auth.user_id, id, Some("checker")).await?;
    operator::authorize(&mut tx, store::runtime(&state)?, r.maker_id, Some("maker")).await?;
    if auth.user_id == r.maker_id || r.checker_id != Some(auth.user_id) {
        return Err(operator::forbidden());
    }
    if r.evidence_sha256.as_deref() != Some(&req.evidence_sha256) {
        return Err(store::conflict());
    }
    if r.status == "refunded" && r.verified_by == Some(auth.user_id) {
        tx.commit().await?;
        return Ok(Json(r));
    }
    if r.version != req.version || r.status != "evidence_pending" {
        return Err(store::conflict());
    }
    sqlx::query("UPDATE payment_refunds SET status='refunded',verified_by=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1").bind(id).bind(auth.user_id).execute(&mut *tx).await?;
    if let Some(original) = order.credited_transaction_id {
        crate::ledger::real_hkd::reverse_refund(
            &mut tx,
            id,
            order.id,
            order.user_id,
            original,
            order.credit_minor,
        )
        .await?;
    } else {
        sqlx::query("UPDATE payment_orders SET status='failed',error_code='refunded',resolved=true,checkout_detached=true,version=version+1,updated_at=clock_timestamp() WHERE id=$1").bind(order.id).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM payment_checkout_slots WHERE payment_id=$1")
            .bind(order.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM payment_jobs WHERE payment_id=$1")
            .bind(order.id)
            .execute(&mut *tx)
            .await?;
    }
    operator::audit(&mut tx,auth.user_id,Some(order.id),"refund_external_verified",json!({"refund_id":id,"evidence_sha256":req.evidence_sha256,"source_validation":"operator_supplied","provider_request_sent":false})).await?;
    let result = view(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(result))
}

pub async fn detail(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<RefundView>> {
    let (mut tx, _) = operator::read_transaction(&state, auth.user_id).await?;
    let result = view(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentQuery {
    pub version: Option<i64>,
}
pub async fn document(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    Query(query): Query<DocumentQuery>,
) -> ApiResult<Response<Body>> {
    let (mut tx, _) = operator::read_transaction(&state, auth.user_id).await?;
    if query.version.is_some_and(|v| v < 1) {
        return Err(ApiError::validation("Choose a positive evidence version."));
    }
    let data: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT e.evidence FROM payment_refund_evidence e JOIN payment_refunds r ON r.id=e.refund_id WHERE r.id=$1 AND e.evidence_version=coalesce($2,r.evidence_version)",
    )
    .bind(id).bind(query.version)
    .fetch_optional(&mut *tx)
    .await?;
    let bytes = data.ok_or_else(store::not_found)?;
    tx.commit().await?;
    Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"refund-evidence-{id}.bin\""),
        )
        .header("X-Content-Type-Options", "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(bytes))
        .map_err(|_| ApiError::internal())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceRejection {
    pub version: i64,
    pub evidence_sha256: String,
    pub reason: String,
}
pub async fn reject_evidence(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    ApiJson(req): ApiJson<EvidenceRejection>,
) -> ApiResult<Json<RefundView>> {
    if !text(&req.reason, 1000) {
        return Err(ApiError::validation(
            "Provide a bounded reason for requesting corrected evidence.",
        ));
    }
    let (mut tx, order, r) = begin(&state, auth.user_id, id, Some("checker")).await?;
    operator::authorize(&mut tx, store::runtime(&state)?, r.maker_id, Some("maker")).await?;
    if auth.user_id == r.maker_id || r.checker_id != Some(auth.user_id) {
        return Err(operator::forbidden());
    }
    if r.evidence_sha256.as_deref() != Some(&req.evidence_sha256) {
        return Err(store::conflict());
    }
    if r.status == "evidence_rejected" && r.rejection_reason.as_deref() == Some(&req.reason) {
        tx.commit().await?;
        return Ok(Json(r));
    }
    if r.status != "evidence_pending" || r.version != req.version {
        return Err(store::conflict());
    }
    let evidence_version = r.evidence_version.ok_or_else(store::conflict)?;
    sqlx::query("INSERT INTO payment_refund_evidence_rejections(refund_id,evidence_version,checker_id,reason) VALUES($1,$2,$3,$4)").bind(id).bind(evidence_version).bind(auth.user_id).bind(&req.reason).execute(&mut *tx).await?;
    sqlx::query("UPDATE payment_refunds SET status='evidence_rejected',rejection_reason=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1").bind(id).bind(req.reason).execute(&mut *tx).await?;
    operator::audit(&mut tx,auth.user_id,Some(order.id),"refund_evidence_correction_requested",json!({"refund_id":id,"evidence_version":evidence_version,"evidence_sha256":req.evidence_sha256,"external_refund_must_not_be_repeated":true})).await?;
    let result = view(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidencePage {
    pub limit: Option<i64>,
    pub cursor: Option<i64>,
}
#[derive(Serialize, sqlx::FromRow)]
pub struct EvidenceVersion {
    pub evidence_version: i64,
    pub evidence_sha256: String,
    pub external_reference: String,
    pub executed_at: DateTime<Utc>,
    pub actor_id: Uuid,
    pub notes: String,
    pub created_at: DateTime<Utc>,
    pub rejected_by: Option<Uuid>,
    pub rejection_reason: Option<String>,
    pub rejected_at: Option<DateTime<Utc>>,
}
pub async fn evidence_history(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    Query(page): Query<EvidencePage>,
) -> ApiResult<Json<serde_json::Value>> {
    let limit = store::page_limit(page.limit)?;
    if page.cursor.is_some_and(|v| v < 1) {
        return Err(ApiError::validation(
            "Choose a positive evidence history cursor.",
        ));
    }
    let (mut tx, _) = operator::read_transaction(&state, auth.user_id).await?;
    view(&mut tx, id).await?;
    let mut items:Vec<EvidenceVersion>=sqlx::query_as("SELECT e.evidence_version,e.evidence_sha256,e.external_reference,e.executed_at,e.actor_id,e.notes,e.created_at,r.checker_id AS rejected_by,r.reason AS rejection_reason,r.created_at AS rejected_at FROM payment_refund_evidence e LEFT JOIN payment_refund_evidence_rejections r ON r.refund_id=e.refund_id AND r.evidence_version=e.evidence_version WHERE e.refund_id=$1 AND ($2::bigint IS NULL OR e.evidence_version<$2) ORDER BY e.evidence_version DESC LIMIT $3").bind(id).bind(page.cursor).bind(limit+1).fetch_all(&mut *tx).await?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next = if more {
        items.last().map(|e| e.evidence_version.to_string())
    } else {
        None
    };
    tx.commit().await?;
    Ok(Json(serde_json::json!({"items":items,"next_cursor":next})))
}
