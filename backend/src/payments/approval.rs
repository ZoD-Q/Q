use super::store;
use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::Authenticated,
    validation::ApiJson,
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

fn forbidden() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "PAYMENT_OPERATOR_REQUIRED",
        "This action requires an explicitly configured payment operator.",
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposalRequest {
    pub evidence_version: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalRequest {
    pub proposal_id: Uuid,
    pub evidence_version: i64,
}
#[derive(Serialize, sqlx::FromRow)]
pub struct Proposal {
    pub proposal_id: Uuid,
    pub payment_id: Uuid,
    pub maker_id: Uuid,
    pub evidence_version: i64,
    pub created_at: DateTime<Utc>,
}
fn proof(order: &store::Order) -> bool {
    order.verified_at.is_some()
        && order.evidence_version > 0
        && order.evidence_hash.as_ref().is_some_and(|h| h.len() == 32)
        && order.provider_trade_no.is_some()
        && order.provider_paid_at.is_some_and(|at| {
            at >= order.created_at && at <= order.checkout_expires_at && at <= Utc::now()
        })
        && (order.status == "awaiting_credit_approval"
            || order.status == "credited"
            || (order.status == "review_required"
                && order.error_code.as_deref() == Some("ACCOUNT_UNAVAILABLE")))
}
pub async fn proposal(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    ApiJson(request): ApiJson<ProposalRequest>,
) -> ApiResult<Json<Proposal>> {
    let r = store::runtime(&state)?;
    if !r.policy.makers.contains(&auth.user_id) {
        return Err(forbidden());
    }
    state.limit_auth(format!("payment-proposal:{}", auth.user_id), 30)?;
    let user = store::owner(&state.pool, id).await?;
    let mut tx = state.pool.begin().await?;
    let identities = store::lock_identities(&mut tx, &[user, auth.user_id]).await?;
    if !store::active(&identities, user) || !store::active(&identities, auth.user_id) {
        return Err(store::conflict());
    }
    let order = store::lock_order(&mut tx, id).await?;
    store::slot(&mut tx, user).await?;
    if !proof(&order)
        || order.evidence_version != request.evidence_version
        || r.provider(&order.credential_version, &order.merchant_id)
            .is_none()
    {
        return Err(store::conflict());
    }
    let prior:Option<Proposal>=sqlx::query_as("SELECT id AS proposal_id,payment_id,maker_id,evidence_version,created_at FROM payment_proposals WHERE payment_id=$1 AND evidence_version=$2")
 .bind(id).bind(request.evidence_version).fetch_optional(&mut *tx).await?;
    if let Some(prior) = prior {
        if prior.maker_id != auth.user_id {
            return Err(store::conflict());
        }
        tx.commit().await?;
        return Ok(Json(prior));
    }
    let result=sqlx::query_as("INSERT INTO payment_proposals(id,payment_id,maker_id,evidence_version,evidence_hash) VALUES($1,$2,$3,$4,$5) RETURNING id AS proposal_id,payment_id,maker_id,evidence_version,created_at")
 .bind(Uuid::new_v4()).bind(id).bind(auth.user_id).bind(order.evidence_version).bind(order.evidence_hash).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(result))
}
pub async fn approve(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    ApiJson(request): ApiJson<ApprovalRequest>,
) -> ApiResult<Json<store::OrderView>> {
    let r = store::runtime(&state)?;
    if !r.policy.checkers.contains(&auth.user_id) {
        return Err(forbidden());
    }
    state.limit_auth(format!("payment-approval:{}", auth.user_id), 30)?;
    let user = store::owner(&state.pool, id).await?;
    let proposed:Option<(Uuid,Vec<u8>)>=sqlx::query_as("SELECT maker_id,evidence_hash FROM payment_proposals WHERE id=$1 AND payment_id=$2 AND evidence_version=$3")
 .bind(request.proposal_id).bind(id).bind(request.evidence_version).fetch_optional(&state.pool).await?;
    let Some((maker, hash)) = proposed else {
        return Err(store::conflict());
    };
    if maker == auth.user_id || !r.policy.makers.contains(&maker) {
        return Err(forbidden());
    }
    let mut tx = state.pool.begin().await?;
    let identities = store::lock_identities(&mut tx, &[user, maker, auth.user_id]).await?;
    if [user, maker, auth.user_id]
        .iter()
        .any(|id| !store::active(&identities, *id))
    {
        return Err(store::conflict());
    }
    let order = store::lock_order(&mut tx, id).await?;
    let current = store::slot(&mut tx, user).await?;
    if !proof(&order)
        || order.evidence_version != request.evidence_version
        || order.evidence_hash.as_ref() != Some(&hash)
        || r.provider(&order.credential_version, &order.merchant_id)
            .is_none()
    {
        return Err(store::conflict());
    }
    // Immutable proposal was inspected before locks, then re-read under the order fence.
    let same:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM payment_proposals WHERE id=$1 AND payment_id=$2 AND maker_id=$3 AND evidence_version=$4 AND evidence_hash=$5)")
 .bind(request.proposal_id).bind(id).bind(maker).bind(request.evidence_version).bind(&hash).fetch_one(&mut *tx).await?;
    if !same {
        return Err(store::conflict());
    }
    if order.status == "credited" {
        let original:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM payment_approvals WHERE payment_id=$1 AND proposal_id=$2 AND checker_id=$3 AND evidence_version=$4)").bind(id).bind(request.proposal_id).bind(auth.user_id).bind(request.evidence_version).fetch_one(&mut *tx).await?;
        if !original {
            return Err(store::conflict());
        }
        tx.commit().await?;
        return Ok(Json(order.view(current)?));
    }
    sqlx::query("INSERT INTO payment_approvals(id,payment_id,proposal_id,maker_id,checker_id,evidence_version,evidence_hash) VALUES($1,$2,$3,$4,$5,$6,$7)")
 .bind(Uuid::new_v4()).bind(id).bind(request.proposal_id).bind(maker).bind(auth.user_id).bind(order.evidence_version).bind(hash).execute(&mut *tx).await?;
    let transaction =
        crate::ledger::real_hkd::credit(&mut tx, id, user, order.credit_minor).await?;
    sqlx::query("UPDATE payment_orders SET status='credited',credited_transaction_id=$2,resolved=true,error_code=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1").bind(id).bind(transaction).execute(&mut *tx).await?;
    if current == Some(id) {
        sqlx::query("DELETE FROM payment_checkout_slots WHERE user_id=$1 AND payment_id=$2")
            .bind(user)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("DELETE FROM payment_jobs WHERE payment_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let result = store::lock_order(&mut tx, id).await?;
    let current = store::slot(&mut tx, user).await?;
    tx.commit().await?;
    Ok(Json(result.view(current)?))
}
