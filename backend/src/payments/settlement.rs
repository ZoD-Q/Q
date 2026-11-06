//! Reconciliation retains original, bounded opaque documents and independent operator attestations.
//! An operator-supplied statement is not a bank API confirmation or an executed FX transaction.
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
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use std::collections::BTreeSet;
use uuid::Uuid;
const SELECT: &str = "SELECT id AS settlement_id,client_request_id,kind,source,currency,status,check_version,mapping_sha256,evidence_sha256,media_type AS source_document_media_type,bank_reference,bank_amount_minor,record_count,matched_count,differences,maker_id,checker_id,created_at,verified_at FROM payment_settlements";
#[derive(Serialize, sqlx::FromRow)]
pub struct SettlementView {
    pub settlement_id: Uuid,
    pub client_request_id: Uuid,
    pub kind: String,
    pub source: String,
    pub currency: String,
    pub status: String,
    pub check_version: i64,
    pub mapping_sha256: String,
    pub evidence_sha256: String,
    pub source_document_media_type: String,
    pub bank_reference: Option<String>,
    pub bank_amount_minor: Option<i64>,
    pub record_count: i32,
    pub matched_count: i32,
    pub differences: Value,
    pub maker_id: Uuid,
    pub checker_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub verified_at: Option<DateTime<Utc>>,
    #[sqlx(skip)]
    pub source_validation: &'static str,
}
impl SettlementView {
    fn decorate(mut self) -> Self {
        self.source_validation = "operator_supplied";
        self
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Import {
    pub client_request_id: Uuid,
    pub kind: String,
    pub source: String,
    pub bank_reference: Option<String>,
    pub bank_amount_minor: Option<i64>,
    pub evidence_base64: String,
    pub source_document_base64: String,
    pub source_document_media_type: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Mapping {
    currency: String,
    rows: Vec<Row>,
}
#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
enum EntryKind {
    #[default]
    Payment,
    Refund,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Row {
    #[serde(default)]
    entry_kind: EntryKind,
    refund_external_reference: Option<String>,
    merchant_order_no: String,
    provider_trade_no: String,
    gross_minor: i64,
    channel_fee_minor: i64,
    net_minor: i64,
}
fn valid_text(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
fn bytes(encoded: &str, max: usize) -> ApiResult<Vec<u8>> {
    if encoded.len() > max.div_ceil(3) * 4 {
        return Err(ApiError::validation("Evidence exceeds its size limit."));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| ApiError::validation("Evidence must be base64."))?;
    if bytes.is_empty() || bytes.len() > max {
        return Err(ApiError::validation(
            "Evidence is empty or exceeds its size limit.",
        ));
    }
    Ok(bytes)
}
fn mapping(
    bytes: &[u8],
    kind: &str,
    bank_reference: Option<&str>,
    bank_amount: Option<i64>,
) -> ApiResult<Mapping> {
    let map: Mapping = serde_json::from_slice(bytes).map_err(|_| {
        ApiError::validation("Mapping must be strict UTF-8 JSON with currency and rows.")
    })?;
    if map.rows.len() > 200 {
        return Err(ApiError::validation(
            "Import at most 200 records per batch.",
        ));
    }
    let bank = bank_reference.is_some_and(|s| valid_text(s, 200))
        && bank_amount.is_some_and(|n| {
            (-crate::ledger::real_hkd::MAX_MINOR..=crate::ledger::real_hkd::MAX_MINOR).contains(&n)
        });
    match kind {
        "order_reconciliation"
            if map.currency == "CNY"
                && !map.rows.is_empty()
                && bank_reference.is_none()
                && bank_amount.is_none() => {}
        "bank_settlement" if map.currency == "CNY" && !map.rows.is_empty() && bank => {}
        "hkd_reserve"
            if map.currency == "HKD"
                && map.rows.is_empty()
                && bank
                && bank_amount.is_some_and(|n| n > 0) => {}
        _ => {
            return Err(ApiError::validation(
                "Choose a valid batch kind, currency and bank reference/amount.",
            ));
        }
    }
    let (mut merchants, mut trades) = (BTreeSet::new(), BTreeSet::new());
    let bound = crate::ledger::real_hkd::MAX_MINOR;
    for row in &map.rows {
        let refund_ref = row.refund_external_reference.as_deref();
        let kind_valid = match row.entry_kind {
            EntryKind::Payment => {
                row.gross_minor > 0
                    && row.channel_fee_minor >= 0
                    && row.net_minor >= 0
                    && refund_ref.is_none()
            }
            EntryKind::Refund => {
                row.gross_minor < 0 && refund_ref.is_some_and(|value| valid_text(value, 200))
            }
        };
        if !kind_valid
            || !valid_text(&row.merchant_order_no, 200)
            || !valid_text(&row.provider_trade_no, 200)
            || !merchants.insert((row.entry_kind, &row.merchant_order_no, refund_ref))
            || !trades.insert((row.entry_kind, &row.provider_trade_no, refund_ref))
            || !(-bound..=bound).contains(&row.gross_minor)
            || !(-bound..=bound).contains(&row.channel_fee_minor)
            || !(-bound..=bound).contains(&row.net_minor)
            || row.gross_minor.checked_sub(row.channel_fee_minor) != Some(row.net_minor)
        {
            return Err(ApiError::validation(
                "Use unique payment/refund entries with exact original references and bounded gross/fee/net amounts.",
            ));
        }
    }
    Ok(map)
}
#[derive(sqlx::FromRow)]
struct ReconciliationOrder {
    status: String,
    pay_minor: i64,
    verified: bool,
    provider_trade_no: Option<String>,
    refund_status: Option<String>,
    refund_reference: Option<String>,
    credited: bool,
    reversed: bool,
    uncredited_refunded: bool,
}
async fn check_rows(
    tx: &mut Transaction<'_, Postgres>,
    map: &Mapping,
    kind: &str,
    bank_amount: Option<i64>,
) -> ApiResult<(i32, Vec<Value>)> {
    let (mut matched, mut differences) = (0, vec![]);
    let mut net = 0i128;
    for (index, row) in map.rows.iter().enumerate() {
        net += i128::from(row.net_minor);
        let actual:Option<ReconciliationOrder>=sqlx::query_as("SELECT o.status,q.pay_minor,o.verified_at IS NOT NULL AS verified,o.provider_trade_no,r.status AS refund_status,r.external_reference AS refund_reference,o.credited_transaction_id IS NOT NULL AS credited,EXISTS(SELECT 1 FROM real_hkd_reversals rev WHERE rev.refund_id=r.id AND rev.original_transaction_id=o.credited_transaction_id) AS reversed,(o.status='failed' AND o.resolved AND o.error_code='refunded' AND o.credited_transaction_id IS NULL AND r.status='refunded') IS TRUE AS uncredited_refunded FROM payment_orders o JOIN payment_quotes q ON q.id=o.quote_id LEFT JOIN payment_refunds r ON r.payment_id=o.id WHERE o.merchant_no=$1")
   .bind(&row.merchant_order_no).fetch_optional(&mut **tx).await?;
        let code = match actual {
            None => Some("Q_ORDER_MISSING"),
            Some(ref actual)
                if actual.provider_trade_no.as_deref() != Some(&row.provider_trade_no) =>
            {
                Some("PROVIDER_REFERENCE_MISMATCH")
            }
            Some(ref actual) if !actual.verified => Some("PAYMENT_NOT_VERIFIED"),
            Some(ref actual) => match row.entry_kind {
                EntryKind::Payment if actual.pay_minor != row.gross_minor => {
                    Some("AMOUNT_MISMATCH")
                }
                EntryKind::Payment
                    if actual.credited
                        && actual.status == "credited"
                        && (actual.refund_status.as_deref() != Some("refunded")
                            || actual.reversed) =>
                {
                    None
                }
                EntryKind::Payment if actual.uncredited_refunded => None,
                EntryKind::Payment => Some("WALLET_NOT_CREDITED"),
                EntryKind::Refund if actual.pay_minor.checked_neg() != Some(row.gross_minor) => {
                    Some("REFUND_AMOUNT_MISMATCH")
                }
                EntryKind::Refund if actual.refund_status.as_deref() != Some("refunded") => {
                    Some("REFUND_NOT_VERIFIED")
                }
                EntryKind::Refund
                    if actual.refund_reference.as_deref()
                        != row.refund_external_reference.as_deref() =>
                {
                    Some("REFUND_REFERENCE_MISMATCH")
                }
                EntryKind::Refund if !actual.reversed && !actual.uncredited_refunded => {
                    Some("REFUND_LEDGER_NOT_RESOLVED")
                }
                EntryKind::Refund => None,
            },
        };
        if let Some(code) = code {
            differences.push(json!({"row":index+1,"code":code}));
        } else {
            matched += 1;
        }
    }
    if kind == "bank_settlement" && Some(net) != bank_amount.map(i128::from) {
        differences.push(json!({"row":0,"code":"BANK_NET_AMOUNT_MISMATCH"}));
    }
    Ok((matched, differences))
}
async fn begin<'a>(
    state: &'a AppState,
    actor: Uuid,
    other: Option<Uuid>,
    role: Option<&str>,
) -> ApiResult<Transaction<'a, Postgres>> {
    let mut tx = state.pool.begin().await?;
    let mut ids = vec![actor];
    if let Some(other) = other {
        ids.push(other);
    }
    let identities = store::lock_identities(&mut tx, &ids).await?;
    if !ids.iter().all(|id| store::active(&identities, *id)) {
        return Err(operator::forbidden());
    }
    operator::authorize(&mut tx, store::runtime(state)?, actor, role).await?;
    Ok(tx)
}
async fn load(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> ApiResult<SettlementView> {
    Ok(
        sqlx::query_as::<_, SettlementView>(&format!("{SELECT} WHERE id=$1"))
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(store::not_found)?
            .decorate(),
    )
}
pub async fn import(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(req): ApiJson<Import>,
) -> ApiResult<Json<SettlementView>> {
    if !valid_text(&req.source, 200)
        || !["application/pdf", "text/csv"].contains(&req.source_document_media_type.as_str())
    {
        return Err(ApiError::validation(
            "Provide the original PDF/CSV source and its name.",
        ));
    }
    let normalized = bytes(&req.evidence_base64, 131072)?;
    let source = bytes(&req.source_document_base64, 262144)?;
    // No PDF/CSV evaluation, navigation, remote loading or rendering. Document type is a download hint.
    if (req.source_document_media_type == "application/pdf" && !source.starts_with(b"%PDF-"))
        || (req.source_document_media_type == "text/csv" && std::str::from_utf8(&source).is_err())
    {
        return Err(ApiError::validation(
            "Source document does not match its media type.",
        ));
    }
    let map = mapping(
        &normalized,
        &req.kind,
        req.bank_reference.as_deref(),
        req.bank_amount_minor,
    )?;
    let mapping_hash = operator::hex(&Sha256::digest(&normalized));
    let source_hash = operator::hex(&Sha256::digest(&source));
    let mut tx = begin(&state, auth.user_id, None, Some("maker")).await?;
    let prior: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM payment_settlements WHERE maker_id=$1 AND client_request_id=$2",
    )
    .bind(auth.user_id)
    .bind(req.client_request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(id) = prior {
        let prior = load(&mut tx, id).await?;
        if prior.evidence_sha256 != source_hash
            || prior.mapping_sha256 != mapping_hash
            || prior.kind != req.kind
            || prior.source != req.source
            || prior.bank_reference != req.bank_reference
            || prior.bank_amount_minor != req.bank_amount_minor
        {
            return Err(store::conflict());
        }
        tx.commit().await?;
        return Ok(Json(prior));
    }
    let duplicate: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM payment_settlements WHERE kind=$1 AND evidence_sha256=$2 AND mapping_sha256=$3)",
    )
    .bind(&req.kind)
    .bind(&source_hash)
    .bind(&mapping_hash)
    .fetch_one(&mut *tx)
    .await?;
    if duplicate {
        return Err(ApiError::conflict(
            "PAYMENT_EVIDENCE_ALREADY_USED",
            "This original source and mapping batch is already imported. Recover the original request.",
        ));
    }
    let (matched, differences) =
        check_rows(&mut tx, &map, &req.kind, req.bank_amount_minor).await?;
    let status = if differences.is_empty() {
        "awaiting_verification"
    } else {
        "discrepancy"
    };
    let id = Uuid::new_v4();
    let differences_json = json!(differences);
    sqlx::query("INSERT INTO payment_settlements(id,client_request_id,kind,source,currency,status,mapping,mapping_sha256,evidence,evidence_sha256,media_type,bank_reference,bank_amount_minor,record_count,matched_count,differences,maker_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)")
 .bind(id).bind(req.client_request_id).bind(req.kind).bind(req.source).bind(map.currency).bind(status).bind(normalized).bind(&mapping_hash).bind(source).bind(&source_hash).bind(req.source_document_media_type).bind(req.bank_reference).bind(req.bank_amount_minor).bind(map.rows.len() as i32).bind(matched).bind(&differences_json).bind(auth.user_id).execute(&mut *tx).await.map_err(database_error)?;
    sqlx::query("INSERT INTO payment_settlement_checks(settlement_id,check_version,matched_count,differences,actor_id) VALUES($1,1,$2,$3,$4)").bind(id).bind(matched).bind(differences_json).bind(auth.user_id).execute(&mut *tx).await?;
    operator::audit(&mut tx,auth.user_id,None,"settlement_evidence_imported",json!({"settlement_id":id,"mapping_sha256":mapping_hash,"evidence_sha256":source_hash,"source_validation":"operator_supplied"})).await?;
    let result = load(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
fn database_error(error: sqlx::Error) -> ApiError {
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
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}
pub async fn list(
    State(state): State<AppState>,
    auth: Authenticated,
    Query(page): Query<Page>,
) -> ApiResult<Json<Value>> {
    let limit = store::page_limit(page.limit)?;
    let cursor = store::cursor(page.cursor.as_deref())?;
    let mut tx = begin(&state, auth.user_id, None, None).await?;
    let mut items:Vec<SettlementView>=sqlx::query_as(&format!("{SELECT} WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1,$2)) ORDER BY created_at DESC,id DESC LIMIT $3")).bind(cursor.map(|c|c.0)).bind(cursor.map(|c|c.1)).bind(limit+1).fetch_all(&mut *tx).await?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next = if more {
        items
            .last()
            .map(|s| format!("{}|{}", s.created_at.to_rfc3339(), s.settlement_id))
    } else {
        None
    };
    let items: Vec<_> = items.into_iter().map(SettlementView::decorate).collect();
    tx.commit().await?;
    Ok(Json(json!({"items":items,"next_cursor":next})))
}
pub async fn detail(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<SettlementView>> {
    let mut tx = begin(&state, auth.user_id, None, None).await?;
    let result = load(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Verify {
    pub mapping_sha256: String,
    pub evidence_sha256: String,
}
/// Every committed computation has an immutable version; no uploaded material is modified.
async fn recalculate(
    tx: &mut Transaction<'_, Postgres>,
    actor: Uuid,
    current: &SettlementView,
) -> ApiResult<SettlementView> {
    if current.status == "operator_verified" {
        return Err(ApiError::conflict(
            "PAYMENT_SETTLEMENT_ALREADY_VERIFIED",
            "Verified evidence is retained unchanged.",
        ));
    }
    let mapping_bytes: Vec<u8> =
        sqlx::query_scalar("SELECT mapping FROM payment_settlements WHERE id=$1")
            .bind(current.settlement_id)
            .fetch_one(&mut **tx)
            .await?;
    let map = mapping(
        &mapping_bytes,
        &current.kind,
        current.bank_reference.as_deref(),
        current.bank_amount_minor,
    )?;
    let (matched, differences) =
        check_rows(tx, &map, &current.kind, current.bank_amount_minor).await?;
    let version = current
        .check_version
        .checked_add(1)
        .ok_or_else(ApiError::internal)?;
    let status = if differences.is_empty() {
        "awaiting_verification"
    } else {
        "discrepancy"
    };
    let differences = json!(differences);
    sqlx::query("INSERT INTO payment_settlement_checks(settlement_id,check_version,matched_count,differences,actor_id) VALUES($1,$2,$3,$4,$5)").bind(current.settlement_id).bind(version).bind(matched).bind(&differences).bind(actor).execute(&mut **tx).await?;
    sqlx::query("UPDATE payment_settlements SET status=$2,check_version=$3,matched_count=$4,differences=$5 WHERE id=$1").bind(current.settlement_id).bind(status).bind(version).bind(matched).bind(differences).execute(&mut **tx).await?;
    operator::audit(tx,actor,None,"settlement_rechecked",json!({"settlement_id":current.settlement_id,"check_version":version,"mapping_sha256":current.mapping_sha256,"evidence_sha256":current.evidence_sha256,"source_validation":"operator_supplied"})).await?;
    load(tx, current.settlement_id).await
}
pub async fn verify(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    ApiJson(req): ApiJson<Verify>,
) -> ApiResult<Json<SettlementView>> {
    let maker: Uuid = sqlx::query_scalar("SELECT maker_id FROM payment_settlements WHERE id=$1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(store::not_found)?;
    if maker == auth.user_id {
        return Err(operator::forbidden());
    }
    let mut tx = begin(&state, auth.user_id, Some(maker), Some("checker")).await?;
    operator::authorize(&mut tx, store::runtime(&state)?, maker, Some("maker")).await?;
    sqlx::query("SELECT id FROM payment_settlements WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let prior = load(&mut tx, id).await?;
    if prior.evidence_sha256 != req.evidence_sha256 || prior.mapping_sha256 != req.mapping_sha256 {
        return Err(store::conflict());
    }
    if prior.status == "operator_verified" {
        if prior.checker_id != Some(auth.user_id) {
            return Err(store::conflict());
        }
        tx.commit().await?;
        return Ok(Json(prior));
    }
    let current = recalculate(&mut tx, auth.user_id, &prior).await?;
    if current.status == "discrepancy" || prior.status == "discrepancy" {
        tx.commit().await?;
        return Err(ApiError::conflict(
            if current.status == "discrepancy" {
                "PAYMENT_RECONCILIATION_DIFFERENCE"
            } else {
                "PAYMENT_RECONCILIATION_REFRESH_REQUIRED"
            },
            "The original evidence has been rechecked. Review the current calculation before approving; outstanding differences cannot be overridden.",
        ));
    }
    if let Some(reference) = current.bank_reference.as_ref() {
        let verified:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM payment_settlements WHERE id<>$1 AND kind=$2 AND currency=$3 AND bank_reference=$4 AND status='operator_verified')").bind(id).bind(&current.kind).bind(&current.currency).bind(reference).fetch_one(&mut *tx).await?;
        if verified {
            tx.commit().await?;
            return Err(ApiError::conflict(
                "PAYMENT_BANK_REFERENCE_ALREADY_VERIFIED",
                "That bank reference has already been independently verified. Review the existing record.",
            ));
        }
    }
    sqlx::query("UPDATE payment_settlements SET status='operator_verified',checker_id=$2,verified_at=clock_timestamp() WHERE id=$1").bind(id).bind(auth.user_id).execute(&mut *tx).await.map_err(database_error)?;
    operator::audit(&mut tx,auth.user_id,None,"settlement_evidence_verified",json!({"settlement_id":id,"check_version":current.check_version,"mapping_sha256":req.mapping_sha256,"evidence_sha256":req.evidence_sha256,"source_validation":"operator_supplied","bank_api_verified":false})).await?;
    let result = load(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecheckRequest {}
pub async fn recheck(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    ApiJson(_req): ApiJson<RecheckRequest>,
) -> ApiResult<Json<SettlementView>> {
    state.limit_auth(format!("payment-recheck:{}", auth.user_id), 30)?;
    let mut tx = begin(&state, auth.user_id, None, None).await?;
    sqlx::query("SELECT id FROM payment_settlements WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(store::not_found)?;
    let current = load(&mut tx, id).await?;
    let result = recalculate(&mut tx, auth.user_id, &current).await?;
    tx.commit().await?;
    Ok(Json(result))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChecksPage {
    pub limit: Option<i64>,
    pub cursor: Option<i64>,
}
#[derive(Serialize, sqlx::FromRow)]
pub struct CheckVersion {
    pub check_version: i64,
    pub matched_count: i32,
    pub differences: Value,
    pub actor_id: Uuid,
    pub created_at: DateTime<Utc>,
}
pub async fn checks(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    Query(page): Query<ChecksPage>,
) -> ApiResult<Json<Value>> {
    let limit = store::page_limit(page.limit)?;
    if page.cursor.is_some_and(|v| v < 1) {
        return Err(ApiError::validation(
            "Choose a positive calculation version cursor.",
        ));
    }
    let mut tx = begin(&state, auth.user_id, None, None).await?;
    load(&mut tx, id).await?;
    let mut items:Vec<CheckVersion>=sqlx::query_as("SELECT check_version,matched_count,differences,actor_id,created_at FROM payment_settlement_checks WHERE settlement_id=$1 AND ($2::bigint IS NULL OR check_version<$2) ORDER BY check_version DESC LIMIT $3").bind(id).bind(page.cursor).bind(limit+1).fetch_all(&mut *tx).await?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next = if more {
        items.last().map(|c| c.check_version.to_string())
    } else {
        None
    };
    tx.commit().await?;
    Ok(Json(json!({"items":items,"next_cursor":next})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentQuery {
    pub part: Option<String>,
}
pub async fn document(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    Query(query): Query<DocumentQuery>,
) -> ApiResult<Response<Body>> {
    let mut tx = begin(&state, auth.user_id, None, None).await?;
    let column = match query.part.as_deref() {
        None | Some("source") => "evidence,media_type",
        Some("mapping") => "mapping,'application/json'::text",
        _ => return Err(ApiError::validation("Choose source or mapping.")),
    };
    let record: Option<(Vec<u8>, String)> = sqlx::query_as(&format!(
        "SELECT {column} FROM payment_settlements WHERE id=$1"
    ))
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((bytes, media)) = record else {
        return Err(store::not_found());
    };
    tx.commit().await?;
    let suffix = match media.as_str() {
        "application/pdf" => "pdf",
        "application/json" => "json",
        _ => "csv",
    };
    Response::builder()
        .header(header::CONTENT_TYPE, media)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"payment-evidence-{id}.{suffix}\""),
        )
        .header("X-Content-Type-Options", "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(bytes))
        .map_err(|_| ApiError::internal())
}

/// Read-only recovery: never inserts, imports, executes or substitutes another maker's key.
pub async fn by_client_key(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(key): Path<Uuid>,
) -> ApiResult<Json<SettlementView>> {
    let mut tx = begin(&state, auth.user_id, None, None).await?;
    let id: Uuid = sqlx::query_scalar(
        "SELECT id FROM payment_settlements WHERE maker_id=$1 AND client_request_id=$2",
    )
    .bind(auth.user_id)
    .bind(key)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(store::not_found)?;
    let result = load(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
