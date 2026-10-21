//! Sole owner of wallets, immutable journal records, and simulated QDC transfers.
pub mod bank_demo;
use axum::{Json, extract::State};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::Authenticated,
    validation::{self, ApiJson},
};

const TREASURY_ID: Uuid = Uuid::from_u128(0x00000000000040008000000000000001);
const WELCOME_MINOR: i64 = 100_000;

#[derive(FromRow)]
struct Account {
    id: Uuid,
    balance_minor: i64,
}

#[derive(Serialize)]
pub struct Wallet {
    account_id: Uuid,
    balance_minor: i64,
    currency: &'static str,
    mode: &'static str,
}

pub async fn wallet(State(state): State<AppState>, auth: Authenticated) -> ApiResult<Json<Wallet>> {
    let account: Account =
        sqlx::query_as("SELECT id,balance_minor FROM ledger_accounts WHERE user_id = $1")
            .bind(auth.user_id)
            .fetch_one(&state.pool)
            .await?;
    Ok(Json(Wallet {
        account_id: account.id,
        balance_minor: account.balance_minor,
        currency: "QDC",
        mode: "demo",
    }))
}

#[derive(Serialize, FromRow)]
pub struct LedgerTransaction {
    id: Uuid,
    kind: String,
    direction: String,
    amount_minor: i64,
    counterparty_handle: String,
    counterparty_name: String,
    memo: String,
    created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct History {
    items: Vec<LedgerTransaction>,
}

pub async fn history(
    State(state): State<AppState>,
    auth: Authenticated,
) -> ApiResult<Json<History>> {
    let items = sqlx::query_as(
        "SELECT t.id, t.kind, CASE WHEN e.delta_minor > 0 THEN 'in' ELSE 'out' END AS direction,
        abs(e.delta_minor) AS amount_minor, coalesce(i.handle,'xiaoq') AS counterparty_handle,
        coalesce(p.display_name,'小Q 演示金') AS counterparty_name, t.memo, t.created_at
        FROM ledger_entries e
        JOIN ledger_accounts own ON own.id = e.account_id
        JOIN ledger_transactions t ON t.id = e.transaction_id
        JOIN ledger_accounts other ON other.id = CASE WHEN e.delta_minor > 0 THEN t.sender_account_id ELSE t.recipient_account_id END
        LEFT JOIN identities i ON i.id = other.user_id
        LEFT JOIN profiles p ON p.user_id = other.user_id
        WHERE own.user_id = $1 ORDER BY t.created_at DESC, t.id DESC LIMIT 50"
    ).bind(auth.user_id).fetch_all(&state.pool).await?;
    Ok(Json(History { items }))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferRequest {
    pub recipient_handle: String,
    pub amount_minor: i64,
    pub memo: String,
    pub idempotency_key: Uuid,
}

impl TransferRequest {
    fn normalize(mut self) -> ApiResult<Self> {
        self.recipient_handle = validation::handle(&self.recipient_handle)?;
        if !(1..=100_000_000).contains(&self.amount_minor) {
            return Err(ApiError::validation(
                "Amount must be an integer between 1 and 100000000 minor units.",
            ));
        }
        validation::text(&self.memo, 0, 80, "Memo must not exceed 80 characters.")?;
        Ok(self)
    }
}

#[derive(Debug, Serialize, FromRow)]
pub struct TransferResponse {
    pub transfer_id: Uuid,
    pub balance_minor: i64,
    pub created_at: DateTime<Utc>,
    pub replayed: bool,
}

#[derive(FromRow)]
struct PriorTransfer {
    id: Uuid,
    recipient_handle: String,
    recipient_deleted_handle_hash: Option<Vec<u8>>,
    amount_minor: i64,
    memo: String,
    sender_balance_after: i64,
    created_at: DateTime<Utc>,
}

pub async fn transfer(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(request): ApiJson<TransferRequest>,
) -> ApiResult<Json<TransferResponse>> {
    Ok(Json(
        execute_transfer(&state.pool, auth.user_id, request).await?,
    ))
}

pub async fn execute_transfer(
    pool: &sqlx::PgPool,
    sender_user_id: Uuid,
    request: TransferRequest,
) -> ApiResult<TransferResponse> {
    let request = request.normalize()?;
    let mut tx = pool.begin().await?;
    let sender_id: Uuid = sqlx::query_scalar("SELECT id FROM ledger_accounts WHERE user_id = $1")
        .bind(sender_user_id)
        .fetch_one(&mut *tx)
        .await?;
    // A completed idempotency key takes precedence over a new recipient lookup.
    // Deleted recipients retain only a handle digest so existing unknown transfers
    // can still recover the original result without reassigning the destination.
    if let Some(response) = replay(&mut tx, sender_id, &request).await? {
        tx.commit().await?;
        return Ok(response);
    }
    let recipient: Option<(Uuid, Uuid)> = sqlx::query_as("SELECT i.id,a.id FROM identities i JOIN ledger_accounts a ON a.user_id = i.id WHERE i.handle = $1 AND i.status = 'active'")
        .bind(&request.recipient_handle).fetch_optional(&mut *tx).await?;
    let (recipient_user_id, recipient_id) = recipient.ok_or_else(ApiError::user_not_found)?;
    if recipient_user_id == sender_user_id {
        return Err(ApiError::conflict(
            "SELF_TRANSFER",
            "Choose a different recipient.",
        ));
    }

    // Account deletion and suspension take identity locks before private writes.
    // Follow the same stable order before taking wallet locks.
    let identities: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT id,status FROM identities WHERE id IN ($1,$2) ORDER BY id FOR UPDATE",
    )
    .bind(sender_user_id)
    .bind(recipient_user_id)
    .fetch_all(&mut *tx)
    .await?;
    if !identities
        .iter()
        .any(|(id, status)| *id == sender_user_id && status == "active")
    {
        return Err(ApiError::unauthorized());
    }
    if !identities
        .iter()
        .any(|(id, status)| *id == recipient_user_id && status == "active")
    {
        return Err(ApiError::user_not_found());
    }

    // Every transfer takes both row locks in the same UUID order. A competing transfer
    // cannot observe stale funds, and opposite-direction transfers cannot deadlock.
    let accounts: Vec<Account> = sqlx::query_as(
        "SELECT id,balance_minor FROM ledger_accounts WHERE id IN ($1,$2) ORDER BY id FOR UPDATE",
    )
    .bind(sender_id)
    .bind(recipient_id)
    .fetch_all(&mut *tx)
    .await?;
    let sender = accounts
        .iter()
        .find(|a| a.id == sender_id)
        .ok_or_else(ApiError::internal)?;
    let recipient = accounts
        .iter()
        .find(|a| a.id == recipient_id)
        .ok_or_else(ApiError::internal)?;

    // Check after acquiring the sender lock: simultaneous retries serialize here.
    if let Some(response) = replay(&mut tx, sender_id, &request).await? {
        tx.commit().await?;
        return Ok(response);
    }

    if sender.balance_minor < request.amount_minor {
        return Err(ApiError::conflict(
            "INSUFFICIENT_FUNDS",
            "Your demo balance is too low.",
        ));
    }
    recipient
        .balance_minor
        .checked_add(request.amount_minor)
        .ok_or_else(ApiError::internal)?;
    let after = sender.balance_minor - request.amount_minor;
    let response = post_pair(
        &mut tx,
        Posting {
            sender_id,
            recipient_id,
            amount: request.amount_minor,
            sender_after: after,
            kind: "transfer",
            memo: &request.memo,
            key: Some(request.idempotency_key),
        },
    )
    .await?;
    tx.commit().await?;
    Ok(response)
}

async fn replay(
    tx: &mut Transaction<'_, Postgres>,
    sender_id: Uuid,
    request: &TransferRequest,
) -> ApiResult<Option<TransferResponse>> {
    let prior: Option<PriorTransfer> = sqlx::query_as("SELECT t.id,i.handle AS recipient_handle,i.deleted_handle_hash AS recipient_deleted_handle_hash,t.amount_minor,t.memo,t.sender_balance_after,t.created_at FROM ledger_transactions t JOIN ledger_accounts a ON a.id = t.recipient_account_id JOIN identities i ON i.id = a.user_id WHERE t.sender_account_id = $1 AND t.idempotency_key = $2")
        .bind(sender_id).bind(request.idempotency_key).fetch_optional(&mut **tx).await?;
    match prior {
        Some(prior) => {
            let same_recipient = match prior.recipient_deleted_handle_hash.as_deref() {
                Some(original_hash) => {
                    original_hash == Sha256::digest(request.recipient_handle.as_bytes()).as_slice()
                }
                None => prior.recipient_handle == request.recipient_handle,
            };
            if !same_recipient
                || prior.amount_minor != request.amount_minor
                || prior.memo != request.memo
            {
                return Err(ApiError::conflict(
                    "IDEMPOTENCY_CONFLICT",
                    "This request key has already been used with different details.",
                ));
            }
            Ok(Some(TransferResponse {
                transfer_id: prior.id,
                balance_minor: prior.sender_balance_after,
                created_at: prior.created_at,
                replayed: true,
            }))
        }
        None => Ok(None),
    }
}

pub(crate) async fn open_with_welcome(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> ApiResult<()> {
    let wallet_id = Uuid::new_v4();
    let treasury: Account =
        sqlx::query_as("SELECT id,balance_minor FROM ledger_accounts WHERE id = $1 FOR UPDATE")
            .bind(TREASURY_ID)
            .fetch_one(&mut **tx)
            .await?;
    sqlx::query("INSERT INTO ledger_accounts(id,user_id,kind) VALUES ($1,$2,'user')")
        .bind(wallet_id)
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    let sender_after = treasury
        .balance_minor
        .checked_sub(WELCOME_MINOR)
        .ok_or_else(ApiError::internal)?;
    post_pair(
        tx,
        Posting {
            sender_id: TREASURY_ID,
            recipient_id: wallet_id,
            amount: WELCOME_MINOR,
            sender_after,
            kind: "welcome",
            memo: "欢迎来到小Q · 演示金",
            key: None,
        },
    )
    .await?;
    Ok(())
}

struct Posting<'a> {
    sender_id: Uuid,
    recipient_id: Uuid,
    amount: i64,
    sender_after: i64,
    kind: &'a str,
    memo: &'a str,
    key: Option<Uuid>,
}

async fn post_pair(
    tx: &mut Transaction<'_, Postgres>,
    posting: Posting<'_>,
) -> ApiResult<TransferResponse> {
    let id = Uuid::new_v4();
    let created_at: DateTime<Utc> = sqlx::query_scalar("INSERT INTO ledger_transactions(id,kind,sender_account_id,recipient_account_id,amount_minor,memo,idempotency_key,sender_balance_after) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at")
        .bind(id).bind(posting.kind).bind(posting.sender_id).bind(posting.recipient_id).bind(posting.amount)
        .bind(posting.memo).bind(posting.key).bind(posting.sender_after).fetch_one(&mut **tx).await?;
    sqlx::query("INSERT INTO ledger_entries(id,transaction_id,account_id,delta_minor) VALUES ($1,$2,$3,-$4),($5,$2,$6,$4)")
        .bind(Uuid::new_v4()).bind(id).bind(posting.sender_id).bind(posting.amount).bind(Uuid::new_v4()).bind(posting.recipient_id)
        .execute(&mut **tx).await?;
    sqlx::query("UPDATE ledger_accounts SET balance_minor = balance_minor - $2 WHERE id = $1")
        .bind(posting.sender_id)
        .bind(posting.amount)
        .execute(&mut **tx)
        .await?;
    sqlx::query("UPDATE ledger_accounts SET balance_minor = balance_minor + $2 WHERE id = $1")
        .bind(posting.recipient_id)
        .bind(posting.amount)
        .execute(&mut **tx)
        .await?;
    Ok(TransferResponse {
        transfer_id: id,
        balance_minor: posting.sender_after,
        created_at,
        replayed: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn money_is_positive_bounded_integer_data() {
        let key = Uuid::new_v4();
        for amount in [0, -1, 100_000_001] {
            assert!(
                TransferRequest {
                    recipient_handle: "lin".into(),
                    amount_minor: amount,
                    memo: "".into(),
                    idempotency_key: key
                }
                .normalize()
                .is_err()
            );
        }
        assert!(serde_json::from_value::<TransferRequest>(serde_json::json!({"recipient_handle":"lin","amount_minor":1.5,"memo":"","idempotency_key":key})).is_err());
        assert!(serde_json::from_value::<TransferRequest>(serde_json::json!({"recipient_handle":"lin","amount_minor":"100","memo":"","idempotency_key":key})).is_err());
    }
}
