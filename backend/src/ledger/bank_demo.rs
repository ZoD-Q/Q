//! Owner-isolated HKD simulations. This journal never reads or writes QDC balances.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection, Postgres, Transaction};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

pub const BANK_IDS: [&str; 20] = [
    "hsbc",
    "hangseng",
    "bochk",
    "scb",
    "bea",
    "dbs",
    "citi",
    "icbc",
    "ccb",
    "ncb",
    "citic",
    "cmbwinglung",
    "dahsing",
    "fubon",
    "chiyu",
    "shacombank",
    "bocom",
    "za",
    "mox",
    "livi",
];
pub const INITIAL_MINOR: i64 = 10_000_000;
pub const MAX_MINOR: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TransferRequest {
    pub to_bank_id: String,
    pub recipient: String,
    pub amount_minor: i64,
    #[serde(default)]
    pub memo: String,
}
impl TransferRequest {
    pub fn validate(&self) -> ApiResult<()> {
        bank_id(&self.to_bank_id)?;
        if !matches!(self.recipient.as_str(), "self" | "demo_chen") {
            return Err(ApiError::validation(
                "Choose your own account or the fictional demo recipient.",
            ));
        }
        if !(1..=MAX_MINOR).contains(&self.amount_minor) {
            return Err(ApiError::validation(
                "Amount must be a positive integer in HKD minor units.",
            ));
        }
        if self.memo.chars().count() > 120 || self.memo.chars().any(char::is_control) {
            return Err(ApiError::validation(
                "Memo must contain at most 120 characters and no control characters.",
            ));
        }
        Ok(())
    }
}

pub fn bank_id(value: &str) -> ApiResult<&str> {
    if BANK_IDS.contains(&value) {
        Ok(value)
    } else {
        Err(ApiError::validation(
            "Choose one of the 20 supported demonstration banks.",
        ))
    }
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Receipt {
    pub id: Uuid,
    pub source_bank_id: String,
    pub destination_bank_id: String,
    pub recipient: String,
    pub amount_minor: i64,
    pub currency: String,
    pub mode: String,
    pub source_balance_minor: i64,
    pub destination_balance_minor: Option<i64>,
    pub memo: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct Entry {
    pub id: Uuid,
    pub transaction_id: Uuid,
    pub bank_id: String,
    pub kind: String,
    pub direction: String,
    pub amount_minor: i64,
    pub balance_after_minor: i64,
    pub currency: String,
    pub mode: String,
    pub memo: String,
    pub created_at: DateTime<Utc>,
    pub source_bank_id: Option<String>,
    pub destination_bank_id: Option<String>,
    pub recipient: Option<String>,
}

#[derive(FromRow)]
struct Account {
    id: Uuid,
    balance_minor: i64,
    status: String,
}

pub async fn lock_active_user(tx: &mut Transaction<'_, Postgres>, user: Uuid) -> ApiResult<()> {
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM identities WHERE id=$1 FOR SHARE")
            .bind(user)
            .fetch_optional(&mut **tx)
            .await?;
    if status.as_deref() != Some("active") {
        return Err(ApiError::unauthorized());
    }
    Ok(())
}

/// Call while holding the owner's plugin advisory lock; initial funding happens only once.
pub async fn ensure_accounts(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    banks: &[String],
) -> ApiResult<()> {
    lock_active_user(tx, user).await?;
    for bank in banks {
        bank_id(bank)?;
    }
    sqlx::query("INSERT INTO bank_demo_accounts(id,user_id,participant) VALUES ($1,$2,'issuance') ON CONFLICT DO NOTHING")
        .bind(Uuid::new_v4()).bind(user).execute(&mut **tx).await?;
    let issuer: Account = sqlx::query_as("SELECT id,balance_minor,status FROM bank_demo_accounts WHERE user_id=$1 AND participant='issuance' FOR UPDATE")
        .bind(user).fetch_one(&mut **tx).await?;
    let mut issuer_balance = issuer.balance_minor;
    for bank in banks {
        for participant in ["self", "demo_chen"] {
            let created: Option<Uuid> = sqlx::query_scalar("INSERT INTO bank_demo_accounts(id,user_id,bank_id,participant) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id")
                .bind(Uuid::new_v4()).bind(user).bind(bank).bind(participant).fetch_optional(&mut **tx).await?;
            if let Some(account_id) = created {
                issuer_balance = issuer_balance
                    .checked_sub(INITIAL_MINOR)
                    .ok_or_else(ApiError::internal)?;
                post_pair(
                    tx,
                    Posting {
                        user,
                        kind: "initial",
                        invocation_id: None,
                        fingerprint: None,
                        source: issuer.id,
                        destination: account_id,
                        amount: INITIAL_MINOR,
                        source_after: issuer_balance,
                        destination_after: INITIAL_MINOR,
                        memo: "",
                    },
                )
                .await?;
            }
        }
    }
    Ok(())
}

fn request_fingerprint(source_bank: &str, request: &TransferRequest) -> Vec<u8> {
    Sha256::digest(json!({"source_bank_id":source_bank,"to_bank_id":request.to_bank_id,"recipient":request.recipient,"amount_minor":request.amount_minor,"memo":request.memo}).to_string().as_bytes()).to_vec()
}

pub async fn transfer(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    source_bank: &str,
    invocation_id: Uuid,
    request: &TransferRequest,
) -> ApiResult<Receipt> {
    bank_id(source_bank)?;
    request.validate()?;
    lock_active_user(tx, user).await?;
    let fingerprint = request_fingerprint(source_bank, request);
    // Internal callers also serialize identical invocation IDs, independently of HTTP confirmation.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('q.bank.invocation:' || $1::text || ':' || $2::text,734221))")
        .bind(user.to_string()).bind(invocation_id.to_string()).execute(&mut **tx).await?;
    let prior: Option<(Uuid, Vec<u8>)> = sqlx::query_as("SELECT id,request_fingerprint FROM bank_demo_transactions WHERE user_id=$1 AND invocation_id=$2")
        .bind(user).bind(invocation_id).fetch_optional(&mut **tx).await?;
    if let Some((id, prior)) = prior {
        if prior != fingerprint {
            return Err(ApiError::conflict(
                "IDEMPOTENCY_CONFLICT",
                "This invocation already belongs to another transfer.",
            ));
        }
        return receipt(tx, user, id).await;
    }
    let ids: Vec<(Uuid, String, String)> = sqlx::query_as("SELECT id,bank_id,participant FROM bank_demo_accounts WHERE user_id=$1 AND ((bank_id=$2 AND participant='self') OR (bank_id=$3 AND participant=$4))")
        .bind(user).bind(source_bank).bind(&request.to_bank_id).bind(&request.recipient).fetch_all(&mut **tx).await?;
    let source = ids
        .iter()
        .find(|(_, bank, participant)| bank == source_bank && participant == "self")
        .map(|(id, _, _)| *id)
        .ok_or_else(account_unavailable)?;
    let destination = ids
        .iter()
        .find(|(_, bank, participant)| {
            bank == &request.to_bank_id && participant == &request.recipient
        })
        .map(|(id, _, _)| *id)
        .ok_or_else(account_unavailable)?;
    if source == destination {
        return Err(ApiError::conflict(
            "BANK_SAME_ACCOUNT",
            "Choose a different destination account.",
        ));
    }
    let locked: Vec<Account> = sqlx::query_as("SELECT id,balance_minor,status FROM bank_demo_accounts WHERE user_id=$1 AND id IN ($2,$3) ORDER BY id FOR UPDATE")
        .bind(user).bind(source).bind(destination).fetch_all(&mut **tx).await?;
    let source_account = locked
        .iter()
        .find(|account| account.id == source)
        .ok_or_else(account_unavailable)?;
    let destination_account = locked
        .iter()
        .find(|account| account.id == destination)
        .ok_or_else(account_unavailable)?;
    if source_account.status != "active" || destination_account.status != "active" {
        return Err(account_unavailable());
    }
    if source_account.balance_minor < request.amount_minor {
        return Err(ApiError::conflict(
            "INSUFFICIENT_FUNDS",
            "Your simulated bank balance is too low.",
        ));
    }
    let destination_after = destination_account
        .balance_minor
        .checked_add(request.amount_minor)
        .filter(|value| *value <= MAX_MINOR)
        .ok_or_else(|| {
            ApiError::validation("The resulting balance exceeds the supported amount.")
        })?;
    let id = post_pair(
        tx,
        Posting {
            user,
            kind: "transfer",
            invocation_id: Some(invocation_id),
            fingerprint: Some(&fingerprint),
            source,
            destination,
            amount: request.amount_minor,
            source_after: source_account.balance_minor - request.amount_minor,
            destination_after,
            memo: &request.memo,
        },
    )
    .await?;
    receipt(tx, user, id).await
}

pub fn account_unavailable() -> ApiError {
    ApiError::conflict(
        "BANK_ACCOUNT_UNAVAILABLE",
        "Connect the selected demonstration bank before using its account.",
    )
}

struct Posting<'a> {
    user: Uuid,
    kind: &'a str,
    invocation_id: Option<Uuid>,
    fingerprint: Option<&'a [u8]>,
    source: Uuid,
    destination: Uuid,
    amount: i64,
    source_after: i64,
    destination_after: i64,
    memo: &'a str,
}
async fn post_pair(tx: &mut Transaction<'_, Postgres>, posting: Posting<'_>) -> ApiResult<Uuid> {
    let id = Uuid::new_v4();
    let created: DateTime<Utc> = sqlx::query_scalar("INSERT INTO bank_demo_transactions(id,user_id,kind,invocation_id,request_fingerprint,source_account_id,destination_account_id,amount_minor,source_balance_after,destination_balance_after) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING created_at")
        .bind(id).bind(posting.user).bind(posting.kind).bind(posting.invocation_id).bind(posting.fingerprint).bind(posting.source).bind(posting.destination).bind(posting.amount).bind(posting.source_after).bind(posting.destination_after).fetch_one(&mut **tx).await?;
    sqlx::query("INSERT INTO bank_demo_entries(id,user_id,transaction_id,account_id,delta_minor,balance_after_minor,created_at) VALUES ($1,$2,$3,$4,-$5,$6,$7),($8,$2,$3,$9,$5,$10,$7)")
        .bind(Uuid::new_v4()).bind(posting.user).bind(id).bind(posting.source).bind(posting.amount).bind(posting.source_after).bind(created).bind(Uuid::new_v4()).bind(posting.destination).bind(posting.destination_after).execute(&mut **tx).await?;
    sqlx::query("UPDATE bank_demo_accounts SET balance_minor=CASE WHEN id=$2 THEN $4 ELSE $5 END WHERE user_id=$1 AND id IN ($2,$3)")
        .bind(posting.user).bind(posting.source).bind(posting.destination).bind(posting.source_after).bind(posting.destination_after).execute(&mut **tx).await?;
    if !posting.memo.is_empty() {
        sqlx::query(
            "INSERT INTO bank_demo_private_memos(transaction_id,user_id,memo) VALUES ($1,$2,$3)",
        )
        .bind(id)
        .bind(posting.user)
        .bind(posting.memo)
        .execute(&mut **tx)
        .await?;
    }
    Ok(id)
}

const RECEIPT_SELECT: &str = "SELECT t.id,s.bank_id AS source_bank_id,d.bank_id AS destination_bank_id,d.participant AS recipient,t.amount_minor,'HKD'::text AS currency,'demo'::text AS mode,t.source_balance_after AS source_balance_minor,CASE WHEN d.participant='self' THEN t.destination_balance_after ELSE NULL END AS destination_balance_minor,coalesce(m.memo,'') AS memo,t.created_at FROM bank_demo_transactions t JOIN bank_demo_accounts s ON s.id=t.source_account_id AND s.user_id=t.user_id JOIN bank_demo_accounts d ON d.id=t.destination_account_id AND d.user_id=t.user_id LEFT JOIN bank_demo_private_memos m ON m.transaction_id=t.id AND m.user_id=t.user_id";
pub async fn receipt(connection: &mut PgConnection, user: Uuid, id: Uuid) -> ApiResult<Receipt> {
    sqlx::query_as(&format!(
        "{RECEIPT_SELECT} WHERE t.id=$1 AND t.user_id=$2 AND t.kind='transfer'"
    ))
    .bind(id)
    .bind(user)
    .fetch_optional(connection)
    .await?
    .ok_or_else(account_unavailable)
}
pub async fn transactions(
    connection: &mut PgConnection,
    user: Uuid,
    bank: Option<&str>,
    before: Option<(DateTime<Utc>, Uuid)>,
    limit: i64,
) -> ApiResult<Vec<Receipt>> {
    let (time, id) = before.map_or((None, None), |(time, id)| (Some(time), Some(id)));
    Ok(sqlx::query_as(&format!("{RECEIPT_SELECT} WHERE t.user_id=$1 AND t.kind='transfer' AND ($2::text IS NULL OR s.bank_id=$2 OR (d.participant='self' AND d.bank_id=$2)) AND ($3::timestamptz IS NULL OR (t.created_at,t.id)<($3,$4)) ORDER BY t.created_at DESC,t.id DESC LIMIT $5"))
        .bind(user).bind(bank).bind(time).bind(id).bind(limit).fetch_all(connection).await?)
}
pub async fn entries(
    connection: &mut PgConnection,
    user: Uuid,
    bank: Option<&str>,
    before: Option<(DateTime<Utc>, Uuid)>,
    limit: i64,
) -> ApiResult<Vec<Entry>> {
    let (time, id) = before.map_or((None, None), |(time, id)| (Some(time), Some(id)));
    Ok(sqlx::query_as("SELECT e.id,e.transaction_id,a.bank_id,t.kind,CASE WHEN e.delta_minor>0 THEN 'in' ELSE 'out' END AS direction,abs(e.delta_minor) AS amount_minor,e.balance_after_minor,'HKD'::text AS currency,'demo'::text AS mode,coalesce(m.memo,'') AS memo,e.created_at,s.bank_id AS source_bank_id,d.bank_id AS destination_bank_id,CASE WHEN t.kind='transfer' THEN d.participant ELSE NULL END AS recipient FROM bank_demo_entries e JOIN bank_demo_accounts a ON a.id=e.account_id AND a.user_id=e.user_id JOIN bank_demo_transactions t ON t.id=e.transaction_id AND t.user_id=e.user_id JOIN bank_demo_accounts s ON s.id=t.source_account_id AND s.user_id=t.user_id JOIN bank_demo_accounts d ON d.id=t.destination_account_id AND d.user_id=t.user_id LEFT JOIN bank_demo_private_memos m ON m.transaction_id=t.id AND m.user_id=t.user_id WHERE e.user_id=$1 AND a.participant='self' AND ($2::text IS NULL OR a.bank_id=$2) AND ($3::timestamptz IS NULL OR (e.created_at,e.id)<($3,$4)) ORDER BY e.created_at DESC,e.id DESC LIMIT $5")
        .bind(user).bind(bank).bind(time).bind(id).bind(limit).fetch_all(connection).await?)
}

pub async fn purge_private_data(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM bank_demo_private_memos WHERE user_id=$1")
        .bind(user)
        .execute(&mut **tx)
        .await?;
    sqlx::query("UPDATE bank_demo_accounts SET status='disabled' WHERE user_id=$1")
        .bind(user)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
