//! First-party bank simulation adapters inside Q's existing plugin and wallet surfaces.
//! Built-in URNs are identities, not remote MCP endpoints or claimed bank integrations.
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Query, State, rejection::QueryRejection},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::Authenticated,
    ledger::bank_demo,
    plugins::{
        self,
        types::{Candidate, Tool},
    },
    validation::ApiJson,
};

type ExistingConnection = (Uuid, String, Option<String>, String, Option<String>);
type HistoryPosition = Option<(DateTime<Utc>, Uuid)>;

pub struct Bank {
    pub id: &'static str,
    pub name: &'static str,
    pub name_en: &'static str,
}
pub const BANKS: [Bank; 20] = [
    Bank {
        id: "hsbc",
        name: "汇丰银行",
        name_en: "HSBC Hong Kong",
    },
    Bank {
        id: "hangseng",
        name: "恒生银行",
        name_en: "Hang Seng Bank",
    },
    Bank {
        id: "bochk",
        name: "中银香港",
        name_en: "Bank of China (Hong Kong)",
    },
    Bank {
        id: "scb",
        name: "渣打银行",
        name_en: "Standard Chartered Hong Kong",
    },
    Bank {
        id: "bea",
        name: "东亚银行",
        name_en: "Bank of East Asia",
    },
    Bank {
        id: "dbs",
        name: "星展银行（香港）",
        name_en: "DBS Bank (Hong Kong)",
    },
    Bank {
        id: "citi",
        name: "花旗银行（香港）",
        name_en: "Citibank (Hong Kong)",
    },
    Bank {
        id: "icbc",
        name: "工银亚洲",
        name_en: "ICBC (Asia)",
    },
    Bank {
        id: "ccb",
        name: "建行亚洲",
        name_en: "China Construction Bank (Asia)",
    },
    Bank {
        id: "ncb",
        name: "南洋商业银行",
        name_en: "Nanyang Commercial Bank",
    },
    Bank {
        id: "citic",
        name: "中信银行（国际）",
        name_en: "China CITIC Bank International",
    },
    Bank {
        id: "cmbwinglung",
        name: "招商永隆银行",
        name_en: "CMB Wing Lung Bank",
    },
    Bank {
        id: "dahsing",
        name: "大新银行",
        name_en: "Dah Sing Bank",
    },
    Bank {
        id: "fubon",
        name: "富邦银行（香港）",
        name_en: "Fubon Bank (Hong Kong)",
    },
    Bank {
        id: "chiyu",
        name: "集友银行",
        name_en: "Chiyu Banking Corporation",
    },
    Bank {
        id: "shacombank",
        name: "上海商业银行",
        name_en: "Shanghai Commercial Bank",
    },
    Bank {
        id: "bocom",
        name: "交通银行（香港）",
        name_en: "Bank of Communications (Hong Kong)",
    },
    Bank {
        id: "za",
        name: "众安银行",
        name_en: "ZA Bank",
    },
    Bank {
        id: "mox",
        name: "Mox Bank",
        name_en: "Mox Bank",
    },
    Bank {
        id: "livi",
        name: "理慧银行",
        name_en: "livi bank",
    },
];

fn bank(id: &str) -> ApiResult<&'static Bank> {
    BANKS
        .iter()
        .find(|bank| bank.id == id)
        .ok_or_else(|| ApiError::validation("Choose one of the 20 supported demonstration banks."))
}
fn service_bank(service: &str) -> ApiResult<&'static Bank> {
    service
        .strip_prefix("q.bank-demo.")
        .ok_or_else(|| ApiError::validation("Unknown built-in bank service."))
        .and_then(bank)
}

pub fn tools(service_id: &str) -> ApiResult<Vec<Tool>> {
    let bank = service_bank(service_id)?;
    let make = |name: &str, title: &str, description: String, schema: Value, read_only: bool| {
        Tool {
            name: name.into(),
            title: Some(title.into()),
            description,
            input_schema: schema,
            output_schema: None,
            annotations: Some(
                json!({"readOnlyHint":read_only,"destructiveHint":false,"idempotentHint":read_only,"openWorldHint":false}),
            ),
            meta: None,
        }
    };
    Ok(vec![
        make(
            "bank_balance",
            "查询模拟余额",
            format!(
                "Read the signed-in user's simulated HKD balance at {}. No real bank connection or money.",
                bank.name_en
            ),
            json!({"type":"object","properties":{},"additionalProperties":false}),
            true,
        ),
        make(
            "bank_transfer",
            "模拟银行转账",
            format!(
                "Transfer simulated HKD from the signed-in user's {} account after explicit confirmation. Destination is another connected bank account belonging to the same user or that user's fictional demo recipient 陈小明. This never transfers real money. Ask for any missing bank, recipient or amount; never guess. amount_minor is integer HKD cents (HK$500 = 50000).",
                bank.name_en
            ),
            json!({"type":"object","properties":{"to_bank_id":{"type":"string","enum":bank_demo::BANK_IDS},"recipient":{"type":"string","enum":["self","demo_chen"]},"amount_minor":{"type":"integer","minimum":1,"maximum":bank_demo::MAX_MINOR},"memo":{"type":"string","maxLength":120}},"required":["to_bank_id","recipient","amount_minor"],"additionalProperties":false}),
            false,
        ),
        make(
            "bank_transactions",
            "查询模拟转账记录",
            format!(
                "Read the signed-in user's latest simulated HKD transfers involving {}. This does not execute transfers.",
                bank.name_en
            ),
            json!({"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":20}},"additionalProperties":false}),
            true,
        ),
    ])
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyArgs {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryArgs {
    limit: Option<i64>,
}

fn complete(text: String, structured: Value) -> Value {
    json!({"resultType":"complete","content":[{"type":"text","text":text}],"structuredContent":structured,"isError":false})
}
fn business_error(error: ApiError) -> ApiResult<Value> {
    if error.status.is_server_error() || error.code == "UNAUTHORIZED" {
        return Err(error);
    }
    Ok(
        json!({"resultType":"complete","content":[{"type":"text","text":error.message}],"structuredContent":{"kind":"bank_error","mode":"demo","error_code":error.code},"isError":true}),
    )
}

pub async fn execute_tool(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    service_id: &str,
    invocation_id: Uuid,
    tool_name: &str,
    args: &Value,
) -> ApiResult<Value> {
    let bank = service_bank(service_id)?;
    bank_demo::lock_active_user(tx, user).await?;
    let result: ApiResult<Value> = match tool_name {
        "bank_balance" => {
            if serde_json::from_value::<EmptyArgs>(args.clone()).is_err() {
                return business_error(ApiError::validation("Balance queries take no arguments."));
            }
            let account: Option<(Uuid,i64)> = sqlx::query_as("SELECT id,balance_minor FROM bank_demo_accounts WHERE user_id=$1 AND bank_id=$2 AND participant='self' AND status='active'")
                .bind(user).bind(bank.id).fetch_optional(&mut **tx).await?;
            account.ok_or_else(bank_demo::account_unavailable).map(|(id,balance)| complete(format!("{} simulated balance: HK${}.{:02}. No real funds.",bank.name_en,balance/100,balance%100), json!({"kind":"bank_balance","mode":"demo","currency":"HKD","bank_id":bank.id,"account_id":id,"balance_minor":balance})))
        }
        "bank_transfer" => {
            let request = match serde_json::from_value::<bank_demo::TransferRequest>(args.clone()) {
                Ok(request) => request,
                Err(_) => {
                    return business_error(ApiError::validation(
                        "Provide a destination bank, demo recipient and positive integer HKD minor-unit amount.",
                    ));
                }
            };
            bank_demo::transfer(tx,user,bank.id,invocation_id,&request).await.map(|receipt| {
                let text = format!("Simulated transfer completed: HK${}.{:02} from {} to {} ({}). Receipt {}. No real money was transferred.",receipt.amount_minor/100,receipt.amount_minor%100,receipt.source_bank_id,receipt.destination_bank_id,receipt.recipient,receipt.id);
                let mut structured = json!(receipt);
                structured["kind"] = json!("bank_transfer");
                complete(text,structured)
            })
        }
        "bank_transactions" => {
            let request = match serde_json::from_value::<HistoryArgs>(args.clone()) {
                Ok(request) => request,
                Err(_) => {
                    return business_error(ApiError::validation(
                        "Transfer history accepts only an optional limit.",
                    ));
                }
            };
            let limit = request.limit.unwrap_or(10);
            if !(1..=20).contains(&limit) {
                return business_error(ApiError::validation(
                    "History limit must be between 1 and 20.",
                ));
            }
            let items = bank_demo::transactions(tx, user, Some(bank.id), None, limit).await?;
            Ok(complete(
                format!(
                    "Found {} simulated bank transfers for {}.",
                    items.len(),
                    bank.name_en
                ),
                json!({"kind":"bank_transactions","mode":"demo","currency":"HKD","bank_id":bank.id,"items":items}),
            ))
        }
        _ => Err(ApiError::validation(
            "This built-in bank does not provide that tool.",
        )),
    };
    match result {
        Ok(value) => Ok(value),
        Err(error) => business_error(error),
    }
}

#[derive(Serialize)]
pub struct WalletAccount {
    id: Uuid,
    bank_id: String,
    bank_name: &'static str,
    bank_name_en: &'static str,
    balance_minor: i64,
    masked_number: String,
    connection_id: Option<Uuid>,
}
#[derive(Serialize)]
pub struct Wallet {
    mode: &'static str,
    currency: &'static str,
    accounts: Vec<WalletAccount>,
    total_balance_minor: i64,
    recipients: Vec<Value>,
}
#[derive(FromRow)]
struct AccountView {
    id: Uuid,
    bank_id: String,
    balance_minor: i64,
    connection_id: Option<Uuid>,
}
async fn wallet_view(connection: &mut PgConnection, user: Uuid) -> ApiResult<Wallet> {
    let rows: Vec<AccountView> = sqlx::query_as("SELECT a.id,a.bank_id,a.balance_minor,c.id AS connection_id FROM bank_demo_accounts a LEFT JOIN plugin_connections c ON c.user_id=a.user_id AND c.connection_kind='bank_demo' AND c.builtin_service_id='q.bank-demo.' || a.bank_id AND c.status='ready' WHERE a.user_id=$1 AND a.participant='self' AND a.status='active' ORDER BY a.created_at,a.bank_id")
        .bind(user).fetch_all(connection).await?;
    let mut accounts = Vec::with_capacity(rows.len());
    let mut total = 0_i64;
    for row in rows {
        let bank = bank(&row.bank_id)?;
        total = total
            .checked_add(row.balance_minor)
            .ok_or_else(ApiError::internal)?;
        accounts.push(WalletAccount {
            id: row.id,
            bank_id: row.bank_id,
            bank_name: bank.name,
            bank_name_en: bank.name_en,
            balance_minor: row.balance_minor,
            masked_number: format!("DEMO {}", &row.id.simple().to_string()[24..]),
            connection_id: row.connection_id,
        });
    }
    Ok(Wallet {
        mode: "demo",
        currency: "HKD",
        accounts,
        total_balance_minor: total,
        recipients: vec![json!({"id":"demo_chen","display_name":"陈小明","demo":true})],
    })
}
async fn wallet(State(state): State<AppState>, auth: Authenticated) -> ApiResult<Json<Wallet>> {
    let mut connection = state.pool.acquire().await?;
    Ok(Json(wallet_view(&mut connection, auth.user_id).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectRequest {
    bank_ids: Vec<String>,
}
async fn connect(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(request): ApiJson<ConnectRequest>,
) -> ApiResult<Json<Wallet>> {
    if !(1..=20).contains(&request.bank_ids.len()) {
        return Err(ApiError::validation(
            "Choose between 1 and 20 demonstration banks.",
        ));
    }
    let mut selected = std::collections::BTreeSet::new();
    for id in &request.bank_ids {
        bank(id)?;
        if !selected.insert(id) {
            return Err(ApiError::validation("Each bank may be selected only once."));
        }
    }
    let mut tx = state.pool.begin().await?;
    bank_demo::lock_active_user(&mut tx, auth.user_id).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('q.plugins:' || $1::text,731291))")
        .bind(auth.user_id.to_string())
        .execute(&mut *tx)
        .await?;
    let mut count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM plugin_connections WHERE user_id=$1")
            .bind(auth.user_id)
            .fetch_one(&mut *tx)
            .await?;
    for id in selected {
        let bank = bank(id)?;
        let builtin = format!("q.bank-demo.{}", bank.id);
        let urn = format!("urn:q:bank-demo:{}", bank.id);
        let card_json = json!({"kind":"bank_demo","name":builtin,"title":format!("{} · 模拟",bank.name),"description":"Q first-party simulated HKD bank adapter. No real bank connection or money.","version":"1.0.0","_meta":{plugins::types::OWNER_META_KEY:{"name":"小Q演示"}}});
        let card = Candidate {
            card_url: urn.clone(),
            discovery_url: urn.clone(),
            card_origin: "urn:q:bank-demo".into(),
            endpoint_url: urn.clone(),
            name: builtin.clone(),
            title: format!("{} · 模拟", bank.name),
            version: "1.0.0".into(),
            description: "Q 内置港币模拟银行插件；不连接真实银行，不转移真实资金。".into(),
            fingerprint: plugins::fingerprint(&card_json)?,
            card_json: card_json.clone(),
        };
        let service: Option<Uuid> = sqlx::query_scalar("INSERT INTO plugin_services(id,card_url,card_url_hash,anonymous_card) VALUES ($1,$2,$3,$4) ON CONFLICT(card_url_hash) DO UPDATE SET anonymous_card=EXCLUDED.anonymous_card,updated_at=now() WHERE plugin_services.card_url=EXCLUDED.card_url RETURNING id")
            .bind(Uuid::new_v4()).bind(&urn).bind(plugins::hash(urn.as_bytes())).bind(card_json).fetch_optional(&mut *tx).await?;
        let service = service.ok_or_else(|| {
            ApiError::conflict(
                "PLUGIN_IDENTITY_CONFLICT",
                "The built-in service identity could not be matched.",
            )
        })?;
        let tool_snapshot = json!(tools(&builtin)?);
        let signature = plugins::fingerprint(&tool_snapshot)?;
        let existing: Option<ExistingConnection> = sqlx::query_as("SELECT id,connection_kind,builtin_service_id,status,schema_fingerprint FROM plugin_connections WHERE user_id=$1 AND service_id=$2 FOR UPDATE")
            .bind(auth.user_id).bind(service).fetch_optional(&mut *tx).await?;
        if let Some((id, kind, saved_service, status, old_signature)) = existing {
            if kind != "bank_demo" || saved_service.as_deref() != Some(&builtin) {
                return Err(ApiError::conflict(
                    "PLUGIN_IDENTITY_CONFLICT",
                    "A different connection already owns this service identity.",
                ));
            }
            if status != "ready" || old_signature.as_deref() != Some(&signature) {
                sqlx::query("UPDATE plugin_connections SET candidate=$3,pending_candidate=NULL,tools_snapshot=$4,pending_tools=NULL,schema_fingerprint=$5,revision=revision+1,status='ready',auth_status='anonymous',auth_challenge=NULL,requested_scopes='{}',last_error_code=NULL,updated_at=now() WHERE id=$1 AND user_id=$2")
                    .bind(id).bind(auth.user_id).bind(json!(card)).bind(tool_snapshot).bind(signature).execute(&mut *tx).await?;
                sqlx::query("UPDATE plugin_invocations SET status='cancelled',error_code='PLUGIN_RECONFIRM_REQUIRED',updated_at=now() WHERE connection_id=$1 AND user_id=$2 AND status='awaiting_confirmation'")
                    .bind(id).bind(auth.user_id).execute(&mut *tx).await?;
            }
        } else {
            if count >= 100 {
                return Err(ApiError::conflict(
                    "PLUGIN_CONNECTION_LIMIT",
                    "This account has reached its 100 saved connection limit.",
                ));
            }
            sqlx::query("INSERT INTO plugin_connections(id,user_id,service_id,candidate,tools_snapshot,schema_fingerprint,status,auth_status,connection_kind,builtin_service_id) VALUES ($1,$2,$3,$4,$5,$6,'ready','anonymous','bank_demo',$7)")
                .bind(Uuid::new_v4()).bind(auth.user_id).bind(service).bind(json!(card)).bind(tool_snapshot).bind(signature).bind(builtin).execute(&mut *tx).await?;
            count += 1;
        }
    }
    bank_demo::ensure_accounts(&mut tx, auth.user_id, &request.bank_ids).await?;
    let result = wallet_view(&mut tx, auth.user_id).await?;
    tx.commit().await?;
    Ok(Json(result))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    created_at: DateTime<Utc>,
    id: Uuid,
}
fn encode_cursor(created_at: DateTime<Utc>, id: Uuid) -> ApiResult<String> {
    Ok(URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&Cursor { created_at, id }).map_err(|_| ApiError::internal())?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryQuery {
    cursor: Option<String>,
    limit: Option<i64>,
    bank_id: Option<String>,
}
impl HistoryQuery {
    fn validate(&self) -> ApiResult<(HistoryPosition, i64)> {
        let limit = self.limit.unwrap_or(20);
        if !(1..=100).contains(&limit) {
            return Err(ApiError::validation("Page size must be between 1 and 100."));
        }
        if let Some(id) = &self.bank_id {
            bank(id)?;
        }
        let cursor = if let Some(value) = &self.cursor {
            if value.len() > 256 {
                return Err(ApiError::validation("Invalid history cursor."));
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(value)
                .map_err(|_| ApiError::validation("Invalid history cursor."))?;
            let cursor: Cursor = serde_json::from_slice(&bytes)
                .map_err(|_| ApiError::validation("Invalid history cursor."))?;
            Some((cursor.created_at, cursor.id))
        } else {
            None
        };
        Ok((cursor, limit))
    }
}
#[derive(Serialize)]
struct History<T: Serialize> {
    items: Vec<T>,
    next_cursor: Option<String>,
}
async fn transactions(
    State(state): State<AppState>,
    auth: Authenticated,
    query: Result<Query<HistoryQuery>, QueryRejection>,
) -> ApiResult<Json<History<bank_demo::Receipt>>> {
    let Query(query) = query.map_err(|_| ApiError::validation("Invalid bank history query."))?;
    let (cursor, limit) = query.validate()?;
    let mut connection = state.pool.acquire().await?;
    let mut items = bank_demo::transactions(
        &mut connection,
        auth.user_id,
        query.bank_id.as_deref(),
        cursor,
        limit + 1,
    )
    .await?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next_cursor = if more {
        items
            .last()
            .map(|item| encode_cursor(item.created_at, item.id))
            .transpose()?
    } else {
        None
    };
    Ok(Json(History { items, next_cursor }))
}
async fn entries(
    State(state): State<AppState>,
    auth: Authenticated,
    query: Result<Query<HistoryQuery>, QueryRejection>,
) -> ApiResult<Json<History<bank_demo::Entry>>> {
    let Query(query) = query.map_err(|_| ApiError::validation("Invalid bank history query."))?;
    let (cursor, limit) = query.validate()?;
    let mut connection = state.pool.acquire().await?;
    let mut items = bank_demo::entries(
        &mut connection,
        auth.user_id,
        query.bank_id.as_deref(),
        cursor,
        limit + 1,
    )
    .await?;
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next_cursor = if more {
        items
            .last()
            .map(|item| encode_cursor(item.created_at, item.id))
            .transpose()?
    } else {
        None
    };
    Ok(Json(History { items, next_cursor }))
}

pub async fn purge_private_data(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
) -> Result<(), sqlx::Error> {
    bank_demo::purge_private_data(tx, user).await
}
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/banking/wallet", get(wallet))
        .route("/v1/banking/connect", post(connect))
        .route("/v1/banking/transactions", get(transactions))
        .route("/v1/banking/entries", get(entries))
        .layer(DefaultBodyLimit::max(16 * 1024))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bank_services_and_tools_are_strictly_bounded() {
        assert_eq!(BANKS.len(), bank_demo::BANK_IDS.len());
        for bank in BANKS {
            let tools = tools(&format!("q.bank-demo.{}", bank.id)).unwrap();
            assert_eq!(tools.len(), 3);
            for tool in tools {
                crate::plugins::protocol::validate_tool(json!(tool)).unwrap();
            }
        }
        for service in [
            "hsbc",
            "q.bank-demo.unknown",
            "https://bank.example",
            "q.bank-demo.hsbc.attacker",
        ] {
            assert!(tools(service).is_err());
        }
    }
    #[test]
    fn malformed_amounts_recipients_and_memos_are_rejected() {
        for value in [
            json!({"to_bank_id":"hsbc","recipient":"self","amount_minor":1.2}),
            json!({"to_bank_id":"hsbc","recipient":"self","amount_minor":"100"}),
            json!({"to_bank_id":"hsbc","recipient":"self","amount_minor":1,"user_id":"other"}),
        ] {
            assert!(serde_json::from_value::<bank_demo::TransferRequest>(value).is_err());
        }
        for value in [
            json!({"to_bank_id":"hsbc","recipient":"self","amount_minor":-1}),
            json!({"to_bank_id":"hsbc","recipient":"person","amount_minor":1}),
            json!({"to_bank_id":"fake","recipient":"self","amount_minor":1}),
            json!({"to_bank_id":"hsbc","recipient":"self","amount_minor":1,"memo":"x".repeat(121)}),
        ] {
            assert!(
                serde_json::from_value::<bank_demo::TransferRequest>(value)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
    }
}
