//! Sole writer of the real HKD journal; no simulated balance is read or modified.
use crate::error::{ApiError, ApiResult};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub const MAX_MINOR: i64 = 9_007_199_254_740_991;
const CLEARING: Uuid = Uuid::from_u128(0x00000000000040008000000000000002);

#[derive(Serialize, sqlx::FromRow)]
pub struct Wallet {
    pub currency: String,
    pub balance_minor: i64,
    pub updated_at: DateTime<Utc>,
}
pub async fn wallet(pool: &sqlx::PgPool, user: Uuid) -> ApiResult<Wallet> {
    Ok(sqlx::query_as("SELECT 'HKD'::text AS currency,coalesce(a.balance_minor,0)::bigint AS balance_minor,coalesce(a.updated_at,clock_timestamp()) AS updated_at FROM identities i LEFT JOIN real_hkd_accounts a ON a.user_id=i.id WHERE i.id=$1")
        .bind(user).fetch_one(pool).await?)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Entry {
    #[serde(skip)]
    pub id: Uuid,
    pub transaction_id: Uuid,
    pub payment_id: Uuid,
    pub amount_minor: i64,
    pub balance_after_minor: i64,
    pub created_at: DateTime<Utc>,
}
pub async fn history(
    pool: &sqlx::PgPool,
    user: Uuid,
    before: Option<(DateTime<Utc>, Uuid)>,
    limit: i64,
) -> ApiResult<Vec<Entry>> {
    Ok(sqlx::query_as("SELECT e.id,e.transaction_id,t.payment_id,e.delta_minor AS amount_minor,e.balance_after_minor,e.created_at,'HKD'::text AS currency,'in'::text AS direction FROM real_hkd_entries e JOIN real_hkd_accounts a ON a.id=e.account_id JOIN real_hkd_transactions t ON t.id=e.transaction_id WHERE a.user_id=$1 AND ($2::timestamptz IS NULL OR (e.created_at,e.id)<($2,$3)) ORDER BY e.created_at DESC,e.id DESC LIMIT $4")
        .bind(user).bind(before.map(|v|v.0)).bind(before.map(|v|v.1)).bind(limit).fetch_all(pool).await?)
}

/// Caller holds all identity/order/slot locks and has inserted the verified approval.
pub async fn credit(
    tx: &mut Transaction<'_, Postgres>,
    payment: Uuid,
    user: Uuid,
    amount: i64,
) -> ApiResult<Uuid> {
    if !(1..=MAX_MINOR).contains(&amount) {
        return Err(ApiError::internal());
    }
    if let Some(id) = sqlx::query_scalar("SELECT id FROM real_hkd_transactions WHERE payment_id=$1")
        .bind(payment)
        .fetch_optional(&mut **tx)
        .await?
    {
        return Ok(id);
    }
    sqlx::query("INSERT INTO real_hkd_accounts(id,user_id,kind) VALUES($1,$2,'user') ON CONFLICT(user_id) DO NOTHING")
        .bind(Uuid::new_v4()).bind(user).execute(&mut **tx).await?;
    let rows: Vec<(Uuid,i64)>=sqlx::query_as("SELECT id,balance_minor FROM real_hkd_accounts WHERE id=$1 OR user_id=$2 ORDER BY id FOR UPDATE")
        .bind(CLEARING).bind(user).fetch_all(&mut **tx).await?;
    let (destination, balance) = rows
        .iter()
        .find(|v| v.0 != CLEARING)
        .copied()
        .ok_or_else(ApiError::internal)?;
    let source = rows
        .iter()
        .find(|v| v.0 == CLEARING)
        .ok_or_else(ApiError::internal)?
        .1;
    let after = balance
        .checked_add(amount)
        .filter(|v| *v <= MAX_MINOR)
        .ok_or_else(ApiError::internal)?;
    let source_after = source.checked_sub(amount).ok_or_else(ApiError::internal)?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO real_hkd_transactions(id,payment_id,source_account_id,destination_account_id,amount_minor,source_balance_after,destination_balance_after) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(id).bind(payment).bind(CLEARING).bind(destination).bind(amount).bind(source_after).bind(after).execute(&mut **tx).await?;
    for (account, delta, value) in [
        (CLEARING, -amount, source_after),
        (destination, amount, after),
    ] {
        sqlx::query("INSERT INTO real_hkd_entries(id,transaction_id,account_id,delta_minor,balance_after_minor) VALUES($1,$2,$3,$4,$5)")
            .bind(Uuid::new_v4()).bind(id).bind(account).bind(delta).bind(value).execute(&mut **tx).await?;
        sqlx::query("UPDATE real_hkd_accounts SET balance_minor=$2,updated_at=clock_timestamp() WHERE id=$1")
            .bind(account).bind(value).execute(&mut **tx).await?;
    }
    Ok(id)
}

/// Called while the lifecycle operation holds the owner's identity lock.
pub async fn guard_deletion(tx: &mut Transaction<'_, Postgres>, user: Uuid) -> ApiResult<()> {
    let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM real_hkd_accounts WHERE user_id=$1 AND balance_minor<>0) OR EXISTS(SELECT 1 FROM payment_orders WHERE user_id=$1 AND NOT resolved)")
        .bind(user).fetch_one(&mut **tx).await?;
    if blocked {
        return Err(ApiError::conflict(
            "PAYMENT_ACCOUNT_UNRESOLVED",
            "Resolve your real HKD balance and pending payments before deleting this account.",
        ));
    }
    Ok(())
}
