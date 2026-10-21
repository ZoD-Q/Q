//! Revocable account access, explicit deletion and restricted operator primitives.
//! Deletion retains immutable simulated-ledger records and minimal recovery tombstones.
use axum::{Json, extract::State, http::StatusCode};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::{self, Authenticated},
    validation::{self, ApiJson},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteRequest {
    request_id: Uuid,
    recovery_token: String,
    password: String,
    confirmation: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusRequest {
    request_id: Uuid,
    recovery_token: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct DeletionReceipt {
    request_id: Uuid,
    status: String,
    completed_at: DateTime<Utc>,
}

fn recovery_hash(token: &str) -> ApiResult<Vec<u8>> {
    let bytes = URL_SAFE_NO_PAD
        .decode(token)
        .map_err(|_| ApiError::validation("Provide a 32-byte deletion recovery token."))?;
    if token.len() != 43 || bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&bytes) != token {
        return Err(ApiError::validation(
            "Provide a 32-byte deletion recovery token.",
        ));
    }
    Ok(Sha256::digest(bytes).to_vec())
}

fn busy_or_database(error: sqlx::Error) -> ApiError {
    if error
        .as_database_error()
        .and_then(|failure| failure.code())
        .is_some_and(|code| matches!(code.as_ref(), "40P01" | "40001" | "55P03"))
    {
        ApiError::conflict(
            "ACCOUNT_BUSY",
            "The account changed during deletion. Check the original request before retrying.",
        )
    } else {
        error.into()
    }
}

/// Checks access while holding a transaction lock, before modifying user-owned data.
pub(crate) async fn lock_active(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> ApiResult<()> {
    let state: Option<String> =
        sqlx::query_scalar("SELECT status FROM identities WHERE id=$1 FOR SHARE")
            .bind(user_id)
            .fetch_optional(&mut **tx)
            .await?;
    if state.as_deref() != Some("active") {
        return Err(ApiError::unauthorized());
    }
    Ok(())
}

pub async fn delete(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(request): ApiJson<DeleteRequest>,
) -> ApiResult<Json<DeletionReceipt>> {
    if request.confirmation != "DELETE" {
        return Err(ApiError::validation(
            "Confirm account deletion with DELETE.",
        ));
    }
    let hash = recovery_hash(&request.recovery_token)?;
    validation::text(&request.password, 1, 128, "Provide your current password.")?;
    state.limit_auth(format!("account-delete:{}", auth.user_id), 5)?;
    let saved_hash: Option<String> =
        sqlx::query_scalar("SELECT password_hash FROM identities WHERE id=$1 AND status='active'")
            .bind(auth.user_id)
            .fetch_optional(&state.pool)
            .await?;
    let saved_hash = saved_hash.ok_or_else(ApiError::unauthorized)?;
    if !identity::verify_password(
        request.password,
        saved_hash.clone(),
        state.password_slots.clone(),
    )
    .await?
    {
        return Err(ApiError::invalid_credentials());
    }
    Ok(Json(
        erase(
            &state.pool,
            auth.user_id,
            request.request_id,
            &hash,
            Some(&saved_hash),
            false,
        )
        .await?,
    ))
}

/// A secret capability recovers only this deletion's receipt after sessions are revoked.
/// Wrong tokens and unknown IDs have the same response, without account identifiers.
pub async fn status(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<StatusRequest>,
) -> ApiResult<Json<DeletionReceipt>> {
    let hash = recovery_hash(&request.recovery_token)?;
    let receipt = sqlx::query_as(
        "SELECT request_id,'deleted'::text AS status,completed_at FROM account_deletion_receipts WHERE request_id=$1 AND recovery_hash=$2",
    )
    .bind(request.request_id)
    .bind(hash)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "ACCOUNT_DELETION_NOT_FOUND",
            "No completed deletion was found for this recovery request.",
        )
    })?;
    Ok(Json(receipt))
}

async fn erase(
    pool: &PgPool,
    user_id: Uuid,
    request_id: Uuid,
    hash: &[u8],
    expected_password: Option<&str>,
    operator: bool,
) -> ApiResult<DeletionReceipt> {
    // This read is only a lock-order hint. All authorization is repeated under lock.
    let handle: Option<String> = sqlx::query_scalar("SELECT handle FROM identities WHERE id=$1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
    let handle = handle.ok_or_else(ApiError::user_not_found)?;
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '3s'")
        .execute(&mut *tx)
        .await?;
    // A global request ID cannot erase two accounts even when both requests arrive
    // before either receipt exists. Take this lock before any identity row.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 910043))")
        .bind(request_id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(busy_or_database)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 910042))")
        .bind(&handle)
        .execute(&mut *tx)
        .await
        .map_err(busy_or_database)?;
    let row: (String, String, String) =
        sqlx::query_as("SELECT handle,status,password_hash FROM identities WHERE id=$1 FOR UPDATE")
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(busy_or_database)?;
    let (current_handle, account_status, password_hash) = row;
    if account_status == "deleted" {
        let original: Option<DeletionReceipt> = sqlx::query_as(
            "SELECT request_id,'deleted'::text AS status,completed_at FROM account_deletion_receipts WHERE request_id=$1 AND user_id=$2 AND recovery_hash=$3",
        ).bind(request_id).bind(user_id).bind(hash).fetch_optional(&mut *tx).await?;
        return original.ok_or_else(|| {
            ApiError::conflict("ACCOUNT_DELETED", "This account has already been deleted.")
        });
    }
    if current_handle != handle
        || (!operator && account_status != "active")
        || expected_password.is_some_and(|expected| expected != password_hash)
    {
        return Err(ApiError::unauthorized());
    }
    if current_handle == "xiaoq" {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "ACCOUNT_PROTECTED",
            "This system identity cannot be changed through account administration.",
        ));
    }
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM account_deletion_receipts WHERE request_id=$1)",
    )
    .bind(request_id)
    .fetch_one(&mut *tx)
    .await?;
    if exists {
        return Err(ApiError::conflict(
            "IDEMPOTENCY_CONFLICT",
            "This deletion request identifier is already in use.",
        ));
    }
    let replacement_handle = unused_deleted_handle(&mut tx).await?;
    purge_private_data(&mut tx, user_id)
        .await
        .map_err(busy_or_database)?;
    let completed_at: DateTime<Utc> = sqlx::query_scalar(
        "UPDATE identities SET handle=$2,password_hash='!deleted',status='deleted',deleted_at=clock_timestamp(),deleted_handle_hash=sha256(convert_to($3,'UTF8')) WHERE id=$1 RETURNING deleted_at",
    )
    .bind(user_id)
    .bind(replacement_handle)
    .bind(current_handle)
    .fetch_one(&mut *tx)
    .await
    .map_err(busy_or_database)?;
    sqlx::query(
        "INSERT INTO account_deletion_receipts(request_id,user_id,recovery_hash,completed_at) VALUES($1,$2,$3,$4)",
    )
    .bind(request_id)
    .bind(user_id)
    .bind(hash)
    .bind(completed_at)
    .execute(&mut *tx)
    .await
    .map_err(busy_or_database)?;
    if operator {
        audit(&mut tx, "delete", Some(user_id), None)
            .await
            .map_err(busy_or_database)?;
    }
    tx.commit().await.map_err(busy_or_database)?;
    Ok(DeletionReceipt {
        request_id,
        status: "deleted".into(),
        completed_at,
    })
}

async fn unused_deleted_handle(tx: &mut Transaction<'_, Postgres>) -> ApiResult<String> {
    for _ in 0..8 {
        let candidate = format!("deleted_{}", &Uuid::new_v4().simple().to_string()[..16]);
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 910042))")
            .bind(&candidate)
            .execute(&mut **tx)
            .await
            .map_err(busy_or_database)?;
        let occupied: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM identities WHERE handle=$1 OR deleted_handle_hash=sha256(convert_to($1,'UTF8')))",
        ).bind(&candidate).fetch_one(&mut **tx).await?;
        if !occupied {
            return Ok(candidate);
        }
    }
    Err(ApiError::conflict(
        "ACCOUNT_BUSY",
        "An account deletion identifier could not be allocated. Check the original request before retrying.",
    ))
}

async fn purge_private_data(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<(), sqlx::Error> {
    crate::banking::purge_private_data(tx, user_id).await?;
    // Owner-only provider records are erased; minimal idempotency identities survive.
    for statement in [
        "INSERT INTO account_erased_operations(user_id,kind,idempotency_key,operation_id) SELECT user_id,'video',idempotency_key,id FROM video_jobs WHERE user_id=$1 ON CONFLICT DO NOTHING",
        "INSERT INTO account_erased_operations(user_id,kind,idempotency_key,operation_id) SELECT user_id,'plugin',idempotency_key,id FROM plugin_invocations WHERE user_id=$1 ON CONFLICT DO NOTHING",
        "DELETE FROM sessions WHERE user_id=$1",
        "DELETE FROM ai_conversations WHERE user_id=$1",
        "DELETE FROM plugin_oauth_tokens WHERE user_id=$1",
        "DELETE FROM plugin_oauth_attempts WHERE user_id=$1",
        "DELETE FROM plugin_invocations WHERE user_id=$1",
        "DELETE FROM plugin_connections WHERE user_id=$1",
        "DELETE FROM plugin_discoveries WHERE user_id=$1",
        "DELETE FROM video_jobs WHERE user_id=$1",
        "DELETE FROM video_connections WHERE user_id=$1",
        "DELETE FROM social_ephemeral_payloads p USING social_messages m WHERE p.message_id=m.id AND m.sender_id=$1",
        "UPDATE social_messages SET body='[Message removed after account deletion]' WHERE sender_id=$1 AND kind='text'",
        "DELETE FROM social_reports WHERE reporter_id=$1",
        "DELETE FROM social_requests WHERE from_id=$1 OR to_id=$1",
        "DELETE FROM social_notifications WHERE user_id=$1 OR actor_id=$1",
        "DELETE FROM social_blocks WHERE blocker_id=$1",
        "DELETE FROM social_daily_activity d USING social_conversations c WHERE d.conversation_id=c.id AND (c.user_low=$1 OR c.user_high=$1)",
        "UPDATE social_conversations SET active=false,relationship_label=NULL,proposed_label=NULL,proposed_by=NULL,intimacy_score=0,low_remark=CASE WHEN user_low=$1 THEN '' ELSE low_remark END,high_remark=CASE WHEN user_high=$1 THEN '' ELSE high_remark END,low_muted=CASE WHEN user_low=$1 THEN false ELSE low_muted END,high_muted=CASE WHEN user_high=$1 THEN false ELSE high_muted END,low_intimacy_enabled=CASE WHEN user_low=$1 THEN false ELSE low_intimacy_enabled END,high_intimacy_enabled=CASE WHEN user_high=$1 THEN false ELSE high_intimacy_enabled END,updated_at=clock_timestamp() WHERE user_low=$1 OR user_high=$1",
        "UPDATE profiles SET display_name='Deleted account',avatar='orbit',bio='',theme='warm',locale='zh-CN' WHERE user_id=$1",
    ] {
        sqlx::query(statement)
            .bind(user_id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    action: &str,
    user_id: Option<Uuid>,
    report_id: Option<Uuid>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO account_operator_audit(id,database_actor,action,user_id,report_id) VALUES($1,current_user,$2,$3,$4)",
    )
    .bind(Uuid::new_v4())
    .bind(action)
    .bind(user_id)
    .bind(report_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Called only by the local operator CLI, using an existing privileged DB connection.
/// This function is deliberately not exposed as a public HTTP route.
pub async fn operator_status(pool: &PgPool, user_id: Uuid, suspend: bool) -> ApiResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '3s'")
        .execute(&mut *tx)
        .await?;
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT status,handle FROM identities WHERE id=$1 FOR UPDATE")
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(busy_or_database)?;
    let (status, handle) = row.ok_or_else(ApiError::user_not_found)?;
    if status == "deleted" || handle == "xiaoq" {
        return Err(ApiError::conflict(
            "ACCOUNT_UNAVAILABLE",
            "Deleted and system accounts cannot be suspended or reinstated.",
        ));
    }
    let target = if suspend { "suspended" } else { "active" };
    if status == target {
        return Ok(());
    }
    sqlx::query("UPDATE identities SET status=$2 WHERE id=$1")
        .bind(user_id)
        .bind(target)
        .execute(&mut *tx)
        .await
        .map_err(busy_or_database)?;
    if suspend {
        sqlx::query("DELETE FROM sessions WHERE user_id=$1")
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(busy_or_database)?;
    }
    audit(
        &mut tx,
        if suspend { "suspend" } else { "reinstate" },
        Some(user_id),
        None,
    )
    .await
    .map_err(busy_or_database)?;
    tx.commit().await.map_err(busy_or_database)?;
    Ok(())
}

/// Explicit administrator deletion also works for suspended accounts.
pub async fn operator_delete(pool: &PgPool, user_id: Uuid) -> ApiResult<DeletionReceipt> {
    let mut random = [0_u8; 32];
    use rand::RngCore;
    rand::rngs::OsRng.fill_bytes(&mut random);
    erase(
        pool,
        user_id,
        Uuid::new_v4(),
        &Sha256::digest(random),
        None,
        true,
    )
    .await
}

/// Report decisions record only the report UUID and a closed decision value.
/// They never extend expiry or copy reason/evidence into another persistent table.
pub async fn operator_resolve_report(
    pool: &PgPool,
    report_id: Uuid,
    actioned: bool,
) -> ApiResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '3s'")
        .execute(&mut *tx)
        .await?;
    let expiry: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT expires_at FROM social_reports WHERE id=$1 FOR UPDATE")
            .bind(report_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(busy_or_database)?;
    // A predicate evaluated before waiting for a row lock can become stale.
    // Recheck against the database clock only after the row is actually locked.
    let live: bool = sqlx::query_scalar("SELECT coalesce($1::timestamptz>clock_timestamp(),false)")
        .bind(expiry)
        .fetch_one(&mut *tx)
        .await?;
    if !live {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "SOCIAL_REPORT_EXPIRED",
            "This report has expired or is unavailable.",
        ));
    }
    audit(
        &mut tx,
        if actioned {
            "report_actioned"
        } else {
            "report_dismissed"
        },
        None,
        Some(report_id),
    )
    .await
    .map_err(busy_or_database)?;
    tx.commit().await.map_err(busy_or_database)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_capability_is_exactly_32_random_bytes_in_canonical_base64url() {
        let token = URL_SAFE_NO_PAD.encode([17_u8; 32]);
        assert_eq!(token.len(), 43);
        assert_eq!(
            recovery_hash(&token).unwrap(),
            Sha256::digest([17_u8; 32]).as_slice()
        );
        for invalid in ["", "a", &format!("{token}="), &"x".repeat(43)] {
            assert!(recovery_hash(invalid).is_err());
        }
    }
}
