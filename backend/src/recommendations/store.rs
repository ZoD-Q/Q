use super::{
    source::{self, Source},
    types::{
        Candidate, ListRequest, RecommendRequest, Recommendation, RecommendationPage, Selection,
    },
};
use crate::{
    AppState, account_lifecycle,
    error::{ApiError, ApiResult},
    plugins,
};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub(super) const FIELDS: &str = "id,user_id,conversation_id,source_message_id,source_fingerprint,locale,status,candidates,catalog_version,created_at,lease_until,expires_at";

#[derive(sqlx::FromRow)]
pub(super) struct StoredRecommendation {
    pub id: Uuid,
    pub user_id: Uuid,
    pub conversation_id: Uuid,
    pub source_message_id: String,
    pub source_fingerprint: Vec<u8>,
    pub locale: String,
    pub status: String,
    pub candidates: Value,
    pub catalog_version: String,
    pub created_at: DateTime<Utc>,
    pub lease_until: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

impl StoredRecommendation {
    pub fn dto(self) -> ApiResult<Recommendation> {
        let candidates = if self.status == "pending" {
            Vec::new()
        } else {
            serde_json::from_value(self.candidates).map_err(|_| ApiError::internal())?
        };
        Ok(Recommendation {
            id: self.id,
            conversation_id: self.conversation_id,
            source_message_id: self.source_message_id,
            status: if self.status == "pending" {
                "skipped".to_owned()
            } else {
                self.status
            },
            candidates,
            catalog_version: self.catalog_version,
            created_at: self.created_at,
            expires_at: self.expires_at,
        })
    }
}

pub(super) fn not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "RECOMMENDATION_NOT_FOUND",
        "This recommendation is unavailable.",
    )
}

pub(super) fn stale() -> ApiError {
    ApiError::conflict(
        "RECOMMENDATION_STALE",
        "This question or service changed. Request a new recommendation.",
    )
}

pub(super) async fn source_in(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    conversation: Uuid,
    message: &str,
) -> ApiResult<Source> {
    let snapshot: Value = sqlx::query_scalar(
        "SELECT snapshot FROM ai_conversations WHERE user_id=$1 AND id=$2 FOR SHARE",
    )
    .bind(user)
    .bind(conversation)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(not_found)?;
    source::from_snapshot(&snapshot, message)
}

async fn lock_history(tx: &mut Transaction<'_, Postgres>, user: Uuid) -> ApiResult<()> {
    // Match ai_history's account-wide lock so the 100-conversation quota stays atomic.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(user.to_string())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub(super) enum Claim {
    Existing(StoredRecommendation),
    New(StoredRecommendation, Source),
}

pub(super) async fn claim(
    state: &AppState,
    user: Uuid,
    request: &RecommendRequest,
) -> ApiResult<Claim> {
    let mut tx = state.pool.begin().await?;
    account_lifecycle::lock_active(&mut tx, user).await?;
    lock_history(&mut tx, user).await?;
    let source = source_in(
        &mut tx,
        user,
        request.conversation_id,
        &request.source_message_id,
    )
    .await?;
    let reused: Option<(Uuid, String)> = sqlx::query_as("SELECT recommendation_id,locale FROM ai_recommendation_requests WHERE user_id=$1 AND request_id=$2")
        .bind(user).bind(request.request_id).fetch_optional(&mut *tx).await?;
    if let Some((id, locale)) = reused {
        let row = sqlx::query_as::<_, StoredRecommendation>(&format!(
            "SELECT {FIELDS} FROM ai_recommendations WHERE id=$1 AND user_id=$2 FOR UPDATE"
        ))
        .bind(id)
        .bind(user)
        .fetch_one(&mut *tx)
        .await?;
        if row.conversation_id != request.conversation_id
            || row.source_message_id != request.source_message_id
            || row.source_fingerprint != source.fingerprint
            || locale != request.locale
        {
            return Err(ApiError::conflict(
                "RECOMMENDATION_REQUEST_REUSED",
                "This request ID belongs to another question.",
            ));
        }
        if row.expires_at <= Utc::now() {
            return Err(stale());
        }
        tx.commit().await?;
        return existing_claim(row);
    }
    let prior = sqlx::query_as::<_, StoredRecommendation>(&format!(
        "SELECT {FIELDS} FROM ai_recommendations WHERE user_id=$1 AND conversation_id=$2 AND source_message_id=$3 AND source_fingerprint=$4 FOR UPDATE"
    )).bind(user).bind(request.conversation_id).bind(&request.source_message_id).bind(&source.fingerprint)
        .fetch_optional(&mut *tx).await?;
    if let Some(row) = prior
        && row.expires_at > Utc::now()
    {
        bind_request(&mut tx, &row, request).await?;
        tx.commit().await?;
        return existing_claim(row);
    }
    sqlx::query("DELETE FROM ai_recommendations WHERE user_id=$1 AND conversation_id=$2 AND expires_at<=now()")
        .bind(user).bind(request.conversation_id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM ai_recommendations WHERE id IN (SELECT id FROM ai_recommendations WHERE user_id=$1 AND conversation_id=$2 ORDER BY created_at DESC,id DESC OFFSET 99)")
        .bind(user).bind(request.conversation_id).execute(&mut *tx).await?;
    let row = sqlx::query_as::<_, StoredRecommendation>(&format!(
        "INSERT INTO ai_recommendations(id,user_id,conversation_id,source_message_id,source_fingerprint,request_id,locale,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING {FIELDS}"
    )).bind(Uuid::new_v4()).bind(user).bind(request.conversation_id).bind(&request.source_message_id)
        .bind(&source.fingerprint).bind(request.request_id).bind(&request.locale).fetch_one(&mut *tx).await?;
    bind_request(&mut tx, &row, request).await?;
    tx.commit().await?;
    Ok(Claim::New(row, source))
}

async fn bind_request(
    tx: &mut Transaction<'_, Postgres>,
    row: &StoredRecommendation,
    request: &RecommendRequest,
) -> ApiResult<()> {
    let aliases: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ai_recommendation_requests WHERE user_id=$1 AND recommendation_id=$2",
    )
    .bind(row.user_id)
    .bind(row.id)
    .fetch_one(&mut **tx)
    .await?;
    if aliases >= 32 {
        return Err(ApiError::conflict(
            "RECOMMENDATION_REQUEST_LIMIT",
            "Restore the existing recommendation instead of creating another request key.",
        ));
    }
    sqlx::query("INSERT INTO ai_recommendation_requests(user_id,request_id,recommendation_id,locale) VALUES($1,$2,$3,$4)")
        .bind(row.user_id).bind(request.request_id).bind(row.id).bind(&request.locale).execute(&mut **tx).await?;
    Ok(())
}

fn existing_claim(row: StoredRecommendation) -> ApiResult<Claim> {
    if row.status == "pending" && row.lease_until > Utc::now() {
        return Err(ApiError::conflict(
            "RECOMMENDATION_PENDING",
            "This recommendation is still being prepared.",
        ));
    }
    Ok(Claim::Existing(row))
}

pub(super) async fn finish(
    state: &AppState,
    row: &StoredRecommendation,
    version: &str,
    candidates: Vec<Candidate>,
) -> ApiResult<StoredRecommendation> {
    let mut tx = state.pool.begin().await?;
    account_lifecycle::lock_active(&mut tx, row.user_id).await?;
    let source = source_in(
        &mut tx,
        row.user_id,
        row.conversation_id,
        &row.source_message_id,
    )
    .await?;
    if source.fingerprint != row.source_fingerprint {
        return Err(stale());
    }
    let candidates = serde_json::to_value(candidates).map_err(|_| ApiError::internal())?;
    let version = if version.is_empty() {
        "unavailable-v1"
    } else {
        version
    };
    let result = sqlx::query_as::<_, StoredRecommendation>(&format!(
        "UPDATE ai_recommendations SET status=CASE WHEN lease_until<=now() OR jsonb_array_length($3)=0 THEN 'skipped' ELSE 'complete' END,candidates=CASE WHEN lease_until<=now() THEN '[]'::jsonb ELSE $3 END,catalog_version=$4 WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING {FIELDS}"
    )).bind(row.id).bind(row.user_id).bind(candidates).bind(version).fetch_optional(&mut *tx).await?.ok_or_else(not_found)?;
    tx.commit().await?;
    Ok(result)
}

pub(super) async fn owned(
    state: &AppState,
    user: Uuid,
    id: Uuid,
) -> ApiResult<StoredRecommendation> {
    sqlx::query_as::<_, StoredRecommendation>(&format!(
        "SELECT {FIELDS} FROM ai_recommendations WHERE id=$1 AND user_id=$2"
    ))
    .bind(id)
    .bind(user)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(not_found)
}

pub(super) async fn list(
    state: &AppState,
    user: Uuid,
    request: &ListRequest,
    limit: i64,
) -> ApiResult<RecommendationPage> {
    let mut tx = state.pool.begin().await?;
    account_lifecycle::lock_active(&mut tx, user).await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM ai_conversations WHERE user_id=$1 AND id=$2)",
    )
    .bind(user)
    .bind(request.conversation_id)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(not_found());
    }
    let cursor: Option<(DateTime<Utc>, Uuid)> = if let Some(id) = request.cursor {
        Some(sqlx::query_as("SELECT created_at,id FROM ai_recommendations WHERE user_id=$1 AND conversation_id=$2 AND id=$3 AND expires_at>now()")
            .bind(user).bind(request.conversation_id).bind(id).fetch_optional(&mut *tx).await?
            .ok_or_else(|| ApiError::validation("The recommendation cursor is no longer available."))?)
    } else {
        None
    };
    let mut rows = sqlx::query_as::<_, StoredRecommendation>(&format!(
        "SELECT {FIELDS} FROM ai_recommendations WHERE user_id=$1 AND conversation_id=$2 AND expires_at>now() AND (status<>'pending' OR lease_until<=now()) AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4)) ORDER BY created_at DESC,id DESC LIMIT $5"
    )).bind(user).bind(request.conversation_id).bind(cursor.map(|value| value.0))
        .bind(cursor.map(|value| value.1)).bind(limit + 1).fetch_all(&mut *tx).await?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = if has_more {
        rows.last().map(|row| row.id)
    } else {
        None
    };
    let items = rows
        .into_iter()
        .map(StoredRecommendation::dto)
        .collect::<ApiResult<_>>()?;
    tx.commit().await?;
    Ok(RecommendationPage { items, next_cursor })
}

pub(super) async fn select(
    state: &AppState,
    row: &StoredRecommendation,
    saved: &Candidate,
    current: Candidate,
) -> ApiResult<Selection> {
    if current.access == "unavailable" {
        return Err(stale());
    }
    if let Some(previous) = saved.connection_id {
        if current.connection_id != Some(previous) {
            return Err(stale());
        }
        if saved.access == "ready"
            && (saved.connection_revision != current.connection_revision
                || saved.capability_version != current.capability_version)
        {
            return Err(stale());
        }
    }
    let mut tx = state.pool.begin().await?;
    account_lifecycle::lock_active(&mut tx, row.user_id).await?;
    lock_history(&mut tx, row.user_id).await?;
    let source = source_in(
        &mut tx,
        row.user_id,
        row.conversation_id,
        &row.source_message_id,
    )
    .await?;
    if source.fingerprint != row.source_fingerprint {
        return Err(stale());
    }
    let still_valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ai_recommendations WHERE id=$1 AND user_id=$2 AND status='complete' AND expires_at>now())")
        .bind(row.id).bind(row.user_id).fetch_one(&mut *tx).await?;
    if !still_valid {
        return Err(stale());
    }
    let plugin = if let Some(id) = current.connection_id {
        let connection = sqlx::query_as::<_, plugins::store::StoredConnection>(&format!(
            "SELECT {} FROM plugin_connections WHERE id=$1 AND user_id=$2 FOR SHARE",
            plugins::store::CONNECTION_FIELDS
        ))
        .bind(id)
        .bind(row.user_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(stale)?;
        if Some(connection.revision) != current.connection_revision
            || connection.status == "revoked"
            || super::catalog::connection_version(&connection)? != current.capability_version
        {
            return Err(stale());
        }
        if current.access == "ready" {
            connection.usable()?;
            if connection.status != "ready" {
                return Err(stale());
            }
        }
        Some(connection.dto()?)
    } else {
        None
    };
    let navigation = if current.kind == "module" && !current.public_query {
        Some("navigate")
    } else {
        match current.access.as_str() {
            "connect" => Some("connect"),
            "authorize" => Some("authorize"),
            "review" => Some("review"),
            "ready" => None,
            _ => return Err(stale()),
        }
    };
    if let Some(kind) = navigation {
        tx.commit().await?;
        return Ok(Selection {
            kind: kind.to_owned(),
            candidate: current,
            conversation: None,
            created: false,
        });
    }
    if current.kind == "plugin" && plugin.is_none() {
        return Err(stale());
    }
    let existing: Option<Option<Uuid>> = sqlx::query_scalar("SELECT conversation_id FROM ai_recommendation_selections WHERE user_id=$1 AND recommendation_id=$2 AND candidate_id=$3")
        .bind(row.user_id).bind(row.id).bind(&saved.id).fetch_optional(&mut *tx).await?;
    if let Some(id) = existing {
        let id = id.ok_or_else(stale)?;
        let detail = conversation(&mut tx, row.user_id, id).await?;
        tx.commit().await?;
        return Ok(Selection {
            kind: "conversation".to_owned(),
            candidate: current,
            conversation: Some(detail),
            created: false,
        });
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM ai_conversations WHERE user_id=$1")
        .bind(row.user_id)
        .fetch_one(&mut *tx)
        .await?;
    if count >= 100 {
        return Err(ApiError::conflict(
            "AI_HISTORY_LIMIT",
            "The account history limit is 100 conversations.",
        ));
    }
    let id = Uuid::new_v4();
    let first_message_count = source.messages.len() as i32;
    let mut snapshot = json!({"title":source.prompt.chars().take(200).collect::<String>(),"messages":source.messages});
    if let Some(plugin) = plugin {
        snapshot["plugin"] = json!({"id":plugin.id,"title":plugin.title,"endpoint_url":plugin.endpoint_url,
            "connection_kind":plugin.connection_kind,"builtin_service_id":plugin.builtin_service_id});
    }
    sqlx::query("INSERT INTO ai_conversations(user_id,id,revision,request_id,expected_revision,snapshot) VALUES($1,$2,1,$3,0,$4)")
        .bind(row.user_id).bind(id).bind(Uuid::new_v4()).bind(snapshot).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO ai_recommendation_selections(user_id,recommendation_id,candidate_id,conversation_id,first_message_count) VALUES($1,$2,$3,$4,$5)")
        .bind(row.user_id).bind(row.id).bind(&saved.id).bind(id).bind(first_message_count).execute(&mut *tx).await?;
    let detail = conversation(&mut tx, row.user_id, id).await?;
    tx.commit().await?;
    Ok(Selection {
        kind: "conversation".to_owned(),
        candidate: current,
        conversation: Some(detail),
        created: true,
    })
}

async fn conversation(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    id: Uuid,
) -> ApiResult<Value> {
    let row: (i64, Value, DateTime<Utc>) = sqlx::query_as(
        "SELECT revision,snapshot,updated_at FROM ai_conversations WHERE user_id=$1 AND id=$2",
    )
    .bind(user)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(not_found)?;
    let mut snapshot = row.1;
    snapshot["id"] = json!(id);
    snapshot["revision"] = json!(row.0);
    snapshot["updated_at"] = json!(row.2);
    Ok(snapshot)
}
