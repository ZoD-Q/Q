//! Payment operations reuse Q identity. Server policy generations fence revoked/old processes.
use super::{PaymentRuntime, store};
use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::Authenticated,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub fn forbidden() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "PAYMENT_OPERATOR_REQUIRED",
        "An active payment operator is required.",
    )
}
fn digest(runtime: &PaymentRuntime) -> Vec<u8> {
    Sha256::digest(
        serde_json::to_vec(&(&runtime.policy.makers, &runtime.policy.checkers))
            .expect("UUID sets serialize"),
    )
    .to_vec()
}
/// New funding is fenced against a role change even before the new runtime's FX
/// bootstrap commits. The caller holds the identity locks until its write commits.
pub async fn funding_policy_is_current(
    tx: &mut Transaction<'_, Postgres>,
    runtime: &PaymentRuntime,
) -> Result<bool, sqlx::Error> {
    let current: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT digest FROM payment_operator_policy WHERE singleton FOR SHARE")
            .fetch_optional(&mut **tx)
            .await?;
    Ok(current.as_deref() == Some(digest(runtime).as_slice()))
}
/// Trusted startup provisioning only; never exposed as an HTTP command. Identity rows are not
/// referenced by role bindings: this avoids identity/policy lock inversion during revocation.
pub async fn sync_operator_policy(
    pool: &PgPool,
    runtime: &PaymentRuntime,
) -> Result<i64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(8181440502)")
        .execute(&mut *tx)
        .await?;
    let hash = digest(runtime);
    let prior: Option<(Vec<u8>, i64)> = sqlx::query_as(
        "SELECT digest,generation FROM payment_operator_policy WHERE singleton FOR UPDATE",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let generation = match prior {
        Some((old, generation)) if old == hash => {
            tx.commit().await?;
            return Ok(generation);
        }
        Some((_, generation)) => generation + 1,
        None => 1,
    };
    sqlx::query("INSERT INTO payment_operator_policy(singleton,digest,generation) VALUES(true,$1,$2) ON CONFLICT(singleton) DO UPDATE SET digest=$1,generation=$2,updated_at=clock_timestamp()")
        .bind(&hash).bind(generation).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM payment_operator_roles")
        .execute(&mut *tx)
        .await?;
    for (role, ids) in [
        ("maker", &runtime.policy.makers),
        ("checker", &runtime.policy.checkers),
    ] {
        for id in ids {
            sqlx::query(
                "INSERT INTO payment_operator_roles(user_id,role,generation) VALUES($1,$2,$3)",
            )
            .bind(id)
            .bind(role)
            .bind(generation)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(generation)
}
/// Call after identity UUID locks, before order/slot/account locks. The shared policy lock lasts
/// until commit, so a revocation either precedes this operation or waits for its atomic commit.
pub async fn authorize(
    tx: &mut Transaction<'_, Postgres>,
    runtime: &PaymentRuntime,
    actor: Uuid,
    role: Option<&str>,
) -> ApiResult<Vec<String>> {
    let current: Option<(Vec<u8>, i64)> = sqlx::query_as(
        "SELECT digest,generation FROM payment_operator_policy WHERE singleton FOR SHARE",
    )
    .fetch_optional(&mut **tx)
    .await?;
    let Some((hash, generation)) = current else {
        return Err(forbidden());
    };
    if hash != digest(runtime) {
        return Err(ApiError::conflict(
            "PAYMENT_OPERATOR_POLICY_CHANGED",
            "Payment operator policy changed. Use the current service before continuing.",
        ));
    }
    let roles: Vec<String> = sqlx::query_scalar(
        "SELECT role FROM payment_operator_roles WHERE user_id=$1 AND generation=$2 ORDER BY role",
    )
    .bind(actor)
    .bind(generation)
    .fetch_all(&mut **tx)
    .await?;
    if roles.is_empty() || role.is_some_and(|role| !roles.iter().any(|r| r == role)) {
        return Err(forbidden());
    }
    Ok(roles)
}
pub async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: Uuid,
    payment: Option<Uuid>,
    action: &str,
    details: Value,
) -> ApiResult<()> {
    sqlx::query("INSERT INTO payment_operation_audit(id,actor_id,payment_id,action,details) VALUES($1,$2,$3,$4,$5)")
        .bind(Uuid::new_v4()).bind(actor).bind(payment).bind(action).bind(details).execute(&mut **tx).await?;
    Ok(())
}
pub(super) async fn read_transaction(
    state: &AppState,
    actor: Uuid,
) -> ApiResult<(Transaction<'_, Postgres>, Vec<String>)> {
    let mut tx = state.pool.begin().await?;
    let identities = store::lock_identities(&mut tx, &[actor]).await?;
    if !store::active(&identities, actor) {
        return Err(forbidden());
    }
    let roles = authorize(&mut tx, store::runtime(state)?, actor, None).await?;
    Ok((tx, roles))
}
pub async fn me(State(state): State<AppState>, auth: Authenticated) -> ApiResult<Json<Value>> {
    let (tx, roles) = read_transaction(&state, auth.user_id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"user_id":auth.user_id,"roles":roles,"server_time":Utc::now()}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperationsPage {
    pub queue: Option<String>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}
#[derive(Serialize, sqlx::FromRow)]
pub struct Summary {
    pub payment_id: Uuid,
    pub account_id: Uuid,
    pub channel: String,
    pub status: String,
    pub queue: String,
    pub credit_amount_minor_hkd: i64,
    pub pay_amount_minor_cny: i64,
    pub fee_minor_cny: i64,
    pub evidence_version: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub error_code: Option<String>,
    pub refund_status: Option<String>,
}
const SUMMARY: &str = "SELECT o.id AS payment_id,o.user_id AS account_id,q.channel,o.status,q.credit_minor AS credit_amount_minor_hkd,q.pay_minor AS pay_amount_minor_cny,q.fee_minor AS fee_minor_cny,o.evidence_version,o.created_at,o.updated_at,o.error_code,r.status AS refund_status,CASE WHEN r.id IS NOT NULL THEN 'exceptions' WHEN o.status='credited' THEN 'credited' WHEN o.status='review_required' OR o.status='failed' THEN 'exceptions' WHEN o.status='awaiting_credit_approval' AND p.id IS NULL THEN 'first_review' WHEN o.status='awaiting_credit_approval' THEN 'second_review' ELSE 'verification' END AS queue FROM payment_orders o JOIN payment_quotes q ON q.id=o.quote_id LEFT JOIN payment_refunds r ON r.payment_id=o.id LEFT JOIN payment_proposals p ON p.payment_id=o.id AND p.evidence_version=o.evidence_version";
pub async fn orders(
    State(state): State<AppState>,
    auth: Authenticated,
    Query(page): Query<OperationsPage>,
) -> ApiResult<Json<Value>> {
    let limit = store::page_limit(page.limit)?;
    let before = store::cursor(page.cursor.as_deref())?;
    if page.queue.as_ref().is_some_and(|q| {
        ![
            "verification",
            "first_review",
            "second_review",
            "credited",
            "exceptions",
        ]
        .contains(&q.as_str())
    }) {
        return Err(ApiError::validation("Choose a supported payment queue."));
    }
    let (mut tx, _) = read_transaction(&state, auth.user_id).await?;
    let mut items:Vec<Summary>=sqlx::query_as(&format!("SELECT * FROM ({SUMMARY}) s WHERE ($1::text IS NULL OR queue=$1) AND ($2::timestamptz IS NULL OR (created_at,payment_id)<($2,$3)) ORDER BY created_at DESC,payment_id DESC LIMIT $4"))
        .bind(page.queue).bind(before.map(|x|x.0)).bind(before.map(|x|x.1)).bind(limit+1).fetch_all(&mut *tx).await?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next = if more {
        items
            .last()
            .map(|x| format!("{}|{}", x.created_at.to_rfc3339(), x.payment_id))
    } else {
        None
    };
    tx.commit().await?;
    Ok(Json(json!({"items":items,"next_cursor":next})))
}
#[derive(Serialize, sqlx::FromRow)]
pub struct Audit {
    pub audit_id: Uuid,
    pub actor_id: Uuid,
    pub payment_id: Option<Uuid>,
    pub action: String,
    pub created_at: DateTime<Utc>,
    pub details: Value,
}
pub async fn detail(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let (mut tx, _) = read_transaction(&state, auth.user_id).await?;
    let order: store::Order = sqlx::query_as(&format!("{} WHERE o.id=$1", store::ORDER_SELECT))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(store::not_found)?;
    let proposal:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('proposal_id',id,'maker_id',maker_id,'evidence_version',evidence_version,'created_at',created_at) FROM payment_proposals WHERE payment_id=$1 AND evidence_version=$2")
        .bind(id).bind(order.evidence_version).fetch_optional(&mut *tx).await?;
    let approval:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('checker_id',checker_id,'created_at',created_at) FROM payment_approvals WHERE payment_id=$1").bind(id).fetch_optional(&mut *tx).await?;
    let refund = super::refunds::load_by_payment(&mut tx, id).await?;
    let audit:Vec<Audit>=sqlx::query_as("SELECT id AS audit_id,actor_id,payment_id,action,created_at,details FROM payment_operation_audit WHERE payment_id=$1 ORDER BY created_at,id LIMIT 200").bind(id).fetch_all(&mut *tx).await?;
    let slot = sqlx::query_scalar("SELECT payment_id FROM payment_checkout_slots WHERE user_id=$1")
        .bind(order.user_id)
        .fetch_optional(&mut *tx)
        .await?;
    let hash = order.evidence_hash.as_ref().map(|bytes| hex(bytes));
    let result = json!({"merchant_order_no":order.merchant_no,"provider_trade_no":order.provider_trade_no,"provider_paid_at":order.provider_paid_at,"verified_at":order.verified_at,"evidence_sha256":hash,"proposal":proposal,"approval":approval,"refund":refund,"audit":audit,"order":order.view(slot)?});
    tx.commit().await?;
    Ok(Json(result))
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditPage {
    pub payment_id: Option<Uuid>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}
pub async fn audit_list(
    State(state): State<AppState>,
    auth: Authenticated,
    Query(page): Query<AuditPage>,
) -> ApiResult<Json<Value>> {
    let limit = store::page_limit(page.limit)?;
    let cursor = store::cursor(page.cursor.as_deref())?;
    let (mut tx, _) = read_transaction(&state, auth.user_id).await?;
    let mut items:Vec<Audit>=sqlx::query_as("SELECT id AS audit_id,actor_id,payment_id,action,created_at,details FROM payment_operation_audit WHERE ($1::uuid IS NULL OR payment_id=$1) AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3)) ORDER BY created_at DESC,id DESC LIMIT $4").bind(page.payment_id).bind(cursor.map(|c|c.0)).bind(cursor.map(|c|c.1)).bind(limit+1).fetch_all(&mut *tx).await?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next = if more {
        items
            .last()
            .map(|a| format!("{}|{}", a.created_at.to_rfc3339(), a.audit_id))
    } else {
        None
    };
    tx.commit().await?;
    Ok(Json(json!({"items":items,"next_cursor":next})))
}
