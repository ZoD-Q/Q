//! Account-owned display history. Saved tool metadata never grants execution permission.
use crate::{
    AppState, account_lifecycle,
    error::{ApiError, ApiResult},
    identity::Authenticated,
    validation::ApiJson,
};
use axum::{
    Json,
    extract::{
        Path, Query, State,
        rejection::{PathRejection, QueryRejection},
    },
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

const MAX_SNAPSHOT: usize = 4 * 1024 * 1024;
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SaveRequest {
    request_id: Uuid,
    expected_revision: i64,
    title: String,
    messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugin: Option<Value>,
}
impl SaveRequest {
    fn snapshot(&self) -> ApiResult<Value> {
        if self.expected_revision < 0
            || self.expected_revision == i64::MAX
            || self.title.trim().is_empty()
            || self.title.chars().count() > 200
            || self.messages.len() > 2000
        {
            return Err(ApiError::validation(
                "Invalid history title, revision or message count.",
            ));
        }
        let mut ids = std::collections::HashSet::new();
        for m in &self.messages {
            let Some(o) = m.as_object() else {
                return Err(ApiError::validation("Invalid history message."));
            };
            let allowed = [
                "id",
                "role",
                "content",
                "status",
                "errorCode",
                "model",
                "thinking",
                "finishReason",
                "usage",
                "contextLimited",
                "toolProposalId",
                "toolInvocationIds",
                "bankCommand",
            ];
            let id = m["id"].as_str().filter(|s| !s.is_empty() && s.len() <= 200);
            if o.keys().any(|k| !allowed.contains(&k.as_str()))
                || id.is_none()
                || !ids.insert(id.unwrap())
                || !matches!(m["role"].as_str(), Some("user" | "assistant"))
                || !matches!(
                    m["status"].as_str(),
                    Some(
                        "pending"
                            | "streaming"
                            | "complete"
                            | "incomplete"
                            | "cancelled"
                            | "error"
                            | "tool"
                    )
                )
                || m["content"].as_str().is_none_or(|s| s.len() > 1024 * 1024)
            {
                return Err(ApiError::validation(
                    "Invalid history message fields or content limit.",
                ));
            }
            for field in ["errorCode", "model", "finishReason", "toolProposalId"] {
                if o.get(field)
                    .is_some_and(|v| v.as_str().is_none_or(|s| s.len() > 200))
                {
                    return Err(ApiError::validation("Invalid history metadata."));
                }
            }
            if o.get("model")
                .is_some_and(|v| !matches!(v.as_str(), Some("deepseek-flash" | "deepseek-v4-pro")))
                || o.get("finishReason").is_some_and(|v| {
                    !matches!(
                        v.as_str(),
                        Some(
                            "stop"
                                | "length"
                                | "content_filter"
                                | "tool_calls"
                                | "insufficient_system_resource"
                                | "aborted"
                        )
                    )
                })
                || o.get("toolProposalId")
                    .is_some_and(|v| v.as_str().is_none_or(|s| Uuid::parse_str(s).is_err()))
            {
                return Err(ApiError::validation(
                    "Invalid history model, finish reason or proposal ID.",
                ));
            }
            for field in ["thinking", "contextLimited", "bankCommand"] {
                if o.get(field).is_some_and(|v| !v.is_boolean()) {
                    return Err(ApiError::validation("Invalid history metadata."));
                }
            }
            if o.get("toolInvocationIds").is_some_and(|v| {
                v.as_array().is_none_or(|a| {
                    a.len() > 8
                        || a.iter()
                            .any(|x| x.as_str().is_none_or(|s| Uuid::parse_str(s).is_err()))
                })
            }) {
                return Err(ApiError::validation("Invalid history invocation IDs."));
            }
            if let Some(usage) = o.get("usage")
                && usage.as_object().is_none_or(|u| {
                    u.len() != 3
                        || ["prompt_tokens", "completion_tokens", "total_tokens"]
                            .iter()
                            .any(|k| usage[k].as_u64().is_none_or(|n| n > 9_007_199_254_740_991))
                })
            {
                return Err(ApiError::validation("Invalid history usage metadata."));
            }
        }
        if let Some(p) = &self.plugin
            && (p["id"].as_str().is_none_or(|s| Uuid::parse_str(s).is_err())
                || p.as_object().is_none_or(|o| {
                    o.keys().any(|k| {
                        ![
                            "id",
                            "title",
                            "endpoint_url",
                            "connection_kind",
                            "builtin_service_id",
                        ]
                        .contains(&k.as_str())
                    })
                })
                || ["id", "title", "endpoint_url"]
                    .iter()
                    .any(|k| p[k].as_str().is_none_or(|s| s.is_empty() || s.len() > 4096)))
        {
            return Err(ApiError::validation(
                "Invalid history plugin display metadata.",
            ));
        }
        if let Some(p) = &self.plugin {
            match p["connection_kind"].as_str() {
                None | Some("remote_mcp")
                    if p["builtin_service_id"].is_null()
                        && p.get("connection_kind").is_none_or(|v| v == "remote_mcp") => {}
                Some("bank_demo") => {
                    let service = p["builtin_service_id"]
                        .as_str()
                        .ok_or_else(|| ApiError::validation("Invalid bank plugin metadata."))?;
                    let bank = service
                        .strip_prefix("q.bank-demo.")
                        .ok_or_else(|| ApiError::validation("Invalid bank plugin metadata."))?;
                    if crate::banking::tools(service).is_err()
                        || p["endpoint_url"].as_str()
                            != Some(format!("urn:q:bank-demo:{bank}").as_str())
                    {
                        return Err(ApiError::validation("Invalid bank plugin metadata."));
                    }
                }
                _ => return Err(ApiError::validation("Invalid plugin kind.")),
            }
        }
        let mut value = json!({"title":self.title,"messages":self.messages});
        if let Some(plugin) = &self.plugin {
            value["plugin"] = plugin.clone();
        }
        if serde_json::to_vec(&value)
            .map_err(|_| ApiError::internal())?
            .len()
            > MAX_SNAPSHOT
        {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "AI_HISTORY_TOO_LARGE",
                "History exceeds the 4 MiB storage limit.",
            ));
        }
        Ok(value)
    }
}
#[derive(sqlx::FromRow)]
struct Saved {
    id: Uuid,
    revision: i64,
    snapshot: Value,
    updated_at: DateTime<Utc>,
    request_id: Uuid,
    expected_revision: i64,
}
impl Saved {
    fn response(self) -> Value {
        let mut v = self.snapshot;
        v["id"] = json!(self.id);
        v["revision"] = json!(self.revision);
        v["updated_at"] = json!(self.updated_at);
        v
    }
}
fn conflict() -> ApiError {
    ApiError::conflict(
        "AI_HISTORY_CONFLICT",
        "History changed. Reload before saving.",
    )
}
pub async fn save(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
    ApiJson(request): ApiJson<SaveRequest>,
) -> ApiResult<Json<Value>> {
    let Path(id) = id.map_err(|_| ApiError::validation("Provide a valid conversation UUID."))?;
    let snapshot = request.snapshot()?;
    let mut tx = state.pool.begin().await?;
    account_lifecycle::lock_active(&mut tx, auth.user_id).await?;
    // Serialize all history writes for one account, including quota checks and first saves.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(auth.user_id.to_string())
        .execute(&mut *tx)
        .await?;
    let current = sqlx::query_as::<_, Saved>(
        "SELECT * FROM ai_conversations WHERE user_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(auth.user_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(current) = current {
        if current.request_id == request.request_id {
            if current.expected_revision != request.expected_revision
                || current.snapshot != snapshot
            {
                return Err(ApiError::conflict(
                    "AI_HISTORY_REQUEST_REUSED",
                    "Save request ID was reused with different content.",
                ));
            }
            tx.commit().await?;
            return Ok(Json(current.response()));
        }
        if current.revision != request.expected_revision {
            return Err(conflict());
        }
    } else {
        if request.expected_revision != 0 {
            return Err(conflict());
        }
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM ai_conversations WHERE user_id=$1")
                .bind(auth.user_id)
                .fetch_one(&mut *tx)
                .await?;
        if count >= 100 {
            return Err(ApiError::conflict(
                "AI_HISTORY_LIMIT",
                "The account history limit is 100 conversations.",
            ));
        }
    }
    let row=sqlx::query_as::<_,Saved>("INSERT INTO ai_conversations(user_id,id,revision,request_id,expected_revision,snapshot) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,id) DO UPDATE SET revision=EXCLUDED.revision,request_id=EXCLUDED.request_id,expected_revision=EXCLUDED.expected_revision,snapshot=EXCLUDED.snapshot,updated_at=now() RETURNING *")
        .bind(auth.user_id).bind(id).bind(request.expected_revision+1).bind(request.request_id).bind(request.expected_revision).bind(snapshot).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(row.response()))
}
pub async fn detail(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
) -> ApiResult<Json<Value>> {
    let Path(id) = id.map_err(|_| ApiError::validation("Provide a valid conversation UUID."))?;
    let mut tx = state.pool.begin().await?;
    account_lifecycle::lock_active(&mut tx, auth.user_id).await?;
    let row =
        sqlx::query_as::<_, Saved>("SELECT * FROM ai_conversations WHERE user_id=$1 AND id=$2")
            .bind(auth.user_id)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::NOT_FOUND,
                    "AI_HISTORY_NOT_FOUND",
                    "History was not found.",
                )
            })?;
    tx.commit().await?;
    Ok(Json(row.response()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    cursor: Option<Uuid>,
    limit: Option<i64>,
}
pub async fn list(
    State(state): State<AppState>,
    auth: Authenticated,
    query: Result<Query<ListQuery>, QueryRejection>,
) -> ApiResult<Json<Value>> {
    let Query(query) =
        query.map_err(|_| ApiError::validation("Provide a valid history cursor and limit."))?;
    let limit = query.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::validation(
            "History page limit must be 1 through 100.",
        ));
    }
    let mut tx = state.pool.begin().await?;
    account_lifecycle::lock_active(&mut tx, auth.user_id).await?;
    let cursor = if let Some(id) = query.cursor {
        Some(
            sqlx::query_as::<_, (DateTime<Utc>, Uuid)>(
                "SELECT created_at,id FROM ai_conversations WHERE user_id=$1 AND id=$2",
            )
            .bind(auth.user_id)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                ApiError::validation("History cursor was not found for this account.")
            })?,
        )
    } else {
        None
    };
    let rows=sqlx::query_as::<_,(Uuid,i64,String,DateTime<Utc>)>("SELECT id,revision,snapshot->>'title',updated_at FROM ai_conversations WHERE user_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4").bind(auth.user_id).bind(cursor.map(|v| v.0)).bind(cursor.map(|v| v.1)).bind(limit+1).fetch_all(&mut *tx).await?;
    let more = rows.len() > limit as usize;
    let items:Vec<Value>=rows.into_iter().take(limit as usize).map(|(id,revision,title,updated_at)|json!({"id":id,"revision":revision,"title":title,"updated_at":updated_at})).collect();
    let cursor = if more {
        items.last().map(|i| i["id"].clone())
    } else {
        None
    };
    tx.commit().await?;
    Ok(Json(json!({"items":items,"next_cursor":cursor})))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> SaveRequest {
        serde_json::from_value(json!({"request_id":Uuid::new_v4(),"expected_revision":0,"title":"History","messages":[{"id":"1","role":"assistant","content":"text","status":"complete"}]})).unwrap()
    }
    #[test]
    fn rejects_invalid_display_metadata_and_snapshot_limits() {
        for (field, value) in [
            ("model", json!("fake")),
            ("toolProposalId", json!("not-uuid")),
            ("finishReason", json!("unknown")),
            (
                "usage",
                json!({"prompt_tokens":9007199254740992u64,"completion_tokens":0,"total_tokens":0}),
            ),
        ] {
            let mut r = request();
            r.messages[0][field] = value;
            assert!(r.snapshot().is_err(), "{field}");
        }
        let mut r = request();
        r.plugin = Some(json!({"id":"bad","title":"name","endpoint_url":"https://example.com"}));
        assert!(r.snapshot().is_err());
        let mut r = request();
        r.messages=(0..5).map(|i|json!({"id":i.to_string(),"role":"assistant","content":"x".repeat(1024*1024),"status":"complete"})).collect();
        assert_eq!(r.snapshot().unwrap_err().code, "AI_HISTORY_TOO_LARGE");
    }
}
