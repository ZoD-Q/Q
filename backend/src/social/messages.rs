use axum::extract::{Query, rejection::QueryRejection};
use chrono::Duration;

use super::*;
use crate::validation;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    #[serde(default)]
    after_seq: i64,
    #[serde(default = "default_limit")]
    limit: i64,
}
fn default_limit() -> i64 {
    50
}
#[derive(Serialize)]
pub struct MessagePage {
    items: Vec<SocialMessage>,
    next_after_seq: i64,
    has_more: bool,
    server_time: DateTime<Utc>,
}
pub async fn list(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
    query: Result<Query<ListQuery>, QueryRejection>,
) -> ApiResult<Json<MessagePage>> {
    rate(&state, auth.user_id, "read")?;
    let id = path(id)?;
    let Query(query) =
        query.map_err(|_| ApiError::validation("Provide a valid message cursor and limit."))?;
    if !(0..=MAX_SEQUENCE).contains(&query.after_seq) || !(1..=100).contains(&query.limit) {
        return Err(ApiError::validation(
            "Message cursor or page limit is out of range.",
        ));
    }
    let mut tx = state.pool.begin().await?;
    conversation(&mut tx, id, auth.user_id).await?;
    let mut items: Vec<SocialMessage> = sqlx::query_as(&format!(
        "{MESSAGE_SELECT} WHERE m.conversation_id=$1 AND m.seq>$2 ORDER BY m.seq LIMIT $3"
    ))
    .bind(id)
    .bind(query.after_seq)
    .bind(query.limit + 1)
    .fetch_all(&mut *tx)
    .await?;
    let has_more = items.len() > query.limit as usize;
    items.truncate(query.limit as usize);
    let next_after_seq = items.last().map_or(query.after_seq, |m| m.seq);
    tx.commit().await?;
    Ok(Json(MessagePage {
        items,
        next_after_seq,
        has_more,
        server_time: Utc::now(),
    }))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EphemeralQuery {
    message_ids: String,
}
#[derive(Serialize)]
pub struct EphemeralState {
    items: Vec<SocialMessage>,
    server_time: DateTime<Utc>,
}
fn ephemeral_ids(value: &str) -> ApiResult<Vec<Uuid>> {
    if value.is_empty() || value.len() > 3699 {
        return Err(ApiError::validation(
            "Provide 1–100 ephemeral message UUIDs.",
        ));
    }
    let mut ids = value
        .split(',')
        .map(|id| {
            Uuid::parse_str(id)
                .map_err(|_| ApiError::validation("Provide valid ephemeral message UUIDs."))
        })
        .collect::<ApiResult<Vec<_>>>()?;
    let count = ids.len();
    if !(1..=100).contains(&count) {
        return Err(ApiError::validation(
            "Provide 1–100 ephemeral message UUIDs.",
        ));
    }
    ids.sort_unstable();
    ids.dedup();
    if ids.len() != count {
        return Err(ApiError::validation("Message UUIDs must be unique."));
    }
    Ok(ids)
}
pub async fn ephemeral_state(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
    query: Result<Query<EphemeralQuery>, QueryRejection>,
) -> ApiResult<Json<EphemeralState>> {
    rate(&state, auth.user_id, "read")?;
    let id = path(id)?;
    let Query(query) =
        query.map_err(|_| ApiError::validation("Provide ephemeral message UUIDs."))?;
    let ids = ephemeral_ids(&query.message_ids)?;
    let mut tx = state.pool.begin().await?;
    conversation(&mut tx, id, auth.user_id).await?;
    let items: Vec<SocialMessage> = sqlx::query_as(&format!(
        "{MESSAGE_SELECT} WHERE m.conversation_id=$1 AND m.kind='ephemeral' AND m.id=ANY($2) ORDER BY m.seq"))
        .bind(id).bind(&ids).fetch_all(&mut *tx).await?;
    if items.len() != ids.len() {
        return Err(not_found());
    }
    tx.commit().await?;
    Ok(Json(EphemeralState {
        items,
        server_time: Utc::now(),
    }))
}
pub async fn by_client(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
) -> ApiResult<Json<SocialMessage>> {
    rate(&state, auth.user_id, "read")?;
    let id = path(id)?;
    let message = sqlx::query_as(&format!(
        "{MESSAGE_SELECT} WHERE m.sender_id=$1 AND m.client_message_id=$2"
    ))
    .bind(auth.user_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(not_found)?;
    Ok(Json(message))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Send {
    client_message_id: Uuid,
    body: String,
    #[serde(deserialize_with = "required_nullable")]
    ttl_seconds: Option<i32>,
}
fn validate_send(input: &Send) -> ApiResult<&str> {
    let body = input.body.trim();
    validation::text(body, 1, 2000, "A message must contain 1–2000 characters.")?;
    if input
        .ttl_seconds
        .is_some_and(|ttl| !matches!(ttl, 30 | 300 | 86400))
    {
        return Err(ApiError::validation(
            "Choose 30 seconds, 5 minutes or 24 hours.",
        ));
    }
    Ok(body)
}
pub async fn send(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
    ApiJson(input): ApiJson<Send>,
) -> ApiResult<(StatusCode, Json<SocialMessage>)> {
    rate(&state, auth.user_id, "send")?;
    let id = path(id)?;
    let body = validate_send(&input)?;
    let mut tx = state.pool.begin().await?;
    let c = locked_conversation(&mut tx, id, auth.user_id).await?;
    let existing: Option<SocialMessage> = sqlx::query_as(&format!(
        "{MESSAGE_SELECT} WHERE m.sender_id=$1 AND m.client_message_id=$2 FOR UPDATE OF m"
    ))
    .bind(auth.user_id)
    .bind(input.client_message_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(message) = existing {
        if message.kind == "ephemeral" && message.expired {
            return Err(expired());
        }
        if message.conversation_id != id || message.ttl_seconds != input.ttl_seconds {
            return Err(idempotency_conflict());
        }
        let saved = if message.kind == "ephemeral" {
            sqlx::query_scalar::<_, String>(
                "SELECT body FROM social_ephemeral_payloads WHERE message_id=$1",
            )
            .bind(message.id)
            .fetch_optional(&mut *tx)
            .await?
        } else {
            message.body.clone()
        };
        if message.kind == "ephemeral"
            && (saved.is_none()
                || message
                    .expires_at
                    .or(message.unopened_expires_at)
                    .is_none_or(|deadline| deadline <= Utc::now()))
        {
            return Err(expired());
        }
        if saved.as_deref() != Some(body) {
            return Err(idempotency_conflict());
        }
        ensure_active(&mut tx, &c, auth.user_id).await?;
        tx.commit().await?;
        return Ok((StatusCode::OK, Json(message)));
    }
    ensure_active(&mut tx, &c, auth.user_id).await?;
    crate::content_policy::validate_content(body)?;
    if c.last_seq >= MAX_SEQUENCE {
        return Err(capacity());
    }
    let seq = c.last_seq + 1;
    let message_id = Uuid::new_v4();
    let ephemeral = input.ttl_seconds.is_some();
    sqlx::query("INSERT INTO social_messages(id,conversation_id,seq,sender_id,client_message_id,kind,body,ttl_seconds,unopened_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8::integer IS NULL THEN NULL ELSE clock_timestamp()+interval '7 days' END)")
        .bind(message_id).bind(id).bind(seq).bind(auth.user_id).bind(input.client_message_id).bind(if ephemeral {"ephemeral"} else {"text"})
        .bind(if ephemeral {None} else {Some(body)}).bind(input.ttl_seconds).execute(&mut *tx).await?;
    if ephemeral {
        sqlx::query("INSERT INTO social_ephemeral_payloads(message_id,body) VALUES($1,$2)")
            .bind(message_id)
            .bind(body)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(
        "UPDATE social_conversations SET last_seq=$2,updated_at=clock_timestamp() WHERE id=$1",
    )
    .bind(id)
    .bind(seq)
    .execute(&mut *tx)
    .await?;
    if !ephemeral && c.low_intimacy_enabled && c.high_intimacy_enabled {
        record_intimacy(&mut tx, &c, auth.user_id).await?;
    }
    let message = sqlx::query_as(&format!("{MESSAGE_SELECT} WHERE m.id=$1"))
        .bind(message_id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(message)))
}
async fn record_intimacy(tx: &mut Tx<'_>, c: &ConversationRow, actor: Uuid) -> ApiResult<()> {
    let low = actor == c.user_low;
    let day: chrono::NaiveDate =
        sqlx::query_scalar("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date")
            .fetch_one(&mut **tx)
            .await?;
    sqlx::query("INSERT INTO social_daily_activity(conversation_id,day,low_sent,high_sent) VALUES($1,$3,$2,NOT $2) ON CONFLICT(conversation_id,day) DO UPDATE SET low_sent=social_daily_activity.low_sent OR EXCLUDED.low_sent,high_sent=social_daily_activity.high_sent OR EXCLUDED.high_sent")
        .bind(c.id).bind(low).bind(day).execute(&mut **tx).await?;
    let credited=sqlx::query("UPDATE social_daily_activity SET credited=true WHERE conversation_id=$1 AND day=$2 AND low_sent AND high_sent AND NOT credited")
        .bind(c.id).bind(day).execute(&mut **tx).await?;
    if credited.rows_affected() > 0 {
        sqlx::query("UPDATE social_conversations SET intimacy_score=intimacy_score+1 WHERE id=$1")
            .bind(c.id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Read {
    through_seq: i64,
}
pub async fn mark_read(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
    ApiJson(input): ApiJson<Read>,
) -> ApiResult<Json<Mutation>> {
    rate(&state, auth.user_id, "write")?;
    let id = path(id)?;
    let mut tx = state.pool.begin().await?;
    let c = locked_conversation(&mut tx, id, auth.user_id).await?;
    if !(0..=c.last_seq).contains(&input.through_seq) {
        return Err(ApiError::validation(
            "Read position is outside the conversation.",
        ));
    }
    let statement = if auth.user_id == c.user_low {
        "UPDATE social_conversations SET low_read_seq=greatest(low_read_seq,$2) WHERE id=$1"
    } else {
        "UPDATE social_conversations SET high_read_seq=greatest(high_read_seq,$2) WHERE id=$1"
    };
    sqlx::query(statement)
        .bind(id)
        .bind(input.through_seq)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(success())
}
#[derive(Serialize)]
pub struct Opened {
    message_id: Uuid,
    body: String,
    expires_at: DateTime<Utc>,
    server_time: DateTime<Utc>,
}
pub async fn open(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
    ApiJson(_): ApiJson<Empty>,
) -> ApiResult<Json<Opened>> {
    rate(&state, auth.user_id, "write")?;
    let id = path(id)?;
    let mut tx = state.pool.begin().await?;
    let cid:Uuid=sqlx::query_scalar("SELECT m.conversation_id FROM social_messages m JOIN social_conversations c ON c.id=m.conversation_id WHERE m.id=$1 AND (c.user_low=$2 OR c.user_high=$2)")
        .bind(id).bind(auth.user_id).fetch_optional(&mut *tx).await?.ok_or_else(not_found)?;
    let c = locked_conversation(&mut tx, cid, auth.user_id).await?;
    ensure_active(&mut tx, &c, auth.user_id).await?;
    // Maintenance takes the same message-row lock, preventing deletion of a newly opened payload.
    let message: SocialMessage =
        sqlx::query_as(&format!("{MESSAGE_SELECT} WHERE m.id=$1 FOR UPDATE OF m"))
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if message.kind != "ephemeral" || message.sender_id == auth.user_id {
        return Err(forbidden());
    }
    if message.expired {
        return Err(expired());
    }
    let body: String = sqlx::query_scalar(
        "SELECT body FROM social_ephemeral_payloads WHERE message_id=$1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(expired)?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    if message
        .expires_at
        .or(message.unopened_expires_at)
        .is_none_or(|deadline| deadline <= now)
    {
        return Err(expired());
    }
    let deadline = if let Some(deadline) = message.expires_at {
        deadline
    } else {
        let deadline = now
            + Duration::seconds(i64::from(
                message.ttl_seconds.ok_or_else(ApiError::internal)?,
            ));
        sqlx::query("UPDATE social_messages SET opened_at=$2,expires_at=$3 WHERE id=$1")
            .bind(id)
            .bind(now)
            .bind(deadline)
            .execute(&mut *tx)
            .await?;
        deadline
    };
    tx.commit().await?;
    Ok(Json(Opened {
        message_id: id,
        body,
        expires_at: deadline,
        server_time: Utc::now(),
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    client_report_id: Uuid,
    user_id: Uuid,
    #[serde(deserialize_with = "required_nullable")]
    message_id: Option<Uuid>,
    reason: String,
    include_evidence: bool,
}
#[derive(FromRow)]
struct SavedReport {
    reported_id: Uuid,
    message_id: Option<Uuid>,
    reason: String,
    include_evidence: bool,
}
#[derive(Serialize)]
pub struct ReportReceipt {
    client_report_id: Uuid,
    status: &'static str,
    expires_at: DateTime<Utc>,
    server_time: DateTime<Utc>,
}
pub async fn report_by_client(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
) -> ApiResult<Json<ReportReceipt>> {
    rate(&state, auth.user_id, "read")?;
    let id = path(id)?;
    // Only receipt availability is selected. Report target, reason and evidence never leave the database.
    let receipt: Option<(DateTime<Utc>, bool)> = sqlx::query_as(
        "SELECT r.expires_at, (r.expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM social_reports s WHERE s.id=r.report_id AND s.reporter_id=r.reporter_id AND s.expires_at>clock_timestamp() AND (NOT s.include_evidence OR EXISTS(SELECT 1 FROM social_report_evidence e WHERE e.report_id=s.id AND e.expires_at>clock_timestamp())))) AS available FROM social_report_receipts r WHERE r.reporter_id=$1 AND r.client_report_id=$2",
    ).bind(auth.user_id).bind(id).fetch_optional(&state.pool).await?;
    let (expires_at, available) = receipt.ok_or_else(not_found)?;
    if !available {
        return Err(ApiError::new(
            StatusCode::GONE,
            "SOCIAL_REPORT_EXPIRED",
            "This report is no longer available.",
        ));
    }
    Ok(Json(ReportReceipt {
        client_report_id: id,
        status: "accepted",
        expires_at,
        server_time: Utc::now(),
    }))
}
pub async fn report(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(input): ApiJson<Report>,
) -> ApiResult<Json<Mutation>> {
    rate(&state, auth.user_id, "write")?;
    let reason = input.reason.trim();
    validation::text(
        reason,
        1,
        500,
        "A report reason must contain 1–500 characters.",
    )?;
    if input.include_evidence && input.message_id.is_none() {
        return Err(ApiError::validation(
            "Select a message before including evidence.",
        ));
    }
    let mut tx = state.pool.begin().await?;
    lock_pair(&mut tx, auth.user_id, input.user_id).await?;
    let receipt:Option<(Uuid,DateTime<Utc>)>=sqlx::query_as("SELECT report_id,expires_at FROM social_report_receipts WHERE reporter_id=$1 AND client_report_id=$2")
        .bind(auth.user_id).bind(input.client_report_id).fetch_optional(&mut *tx).await?;
    if let Some((report_id, expires_at)) = receipt {
        let saved:Option<SavedReport>=sqlx::query_as("SELECT reported_id,message_id,reason,include_evidence FROM social_reports WHERE id=$1 AND expires_at>clock_timestamp()")
            .bind(report_id).fetch_optional(&mut *tx).await?;
        if expires_at <= Utc::now() || saved.is_none() {
            return Err(ApiError::new(
                StatusCode::GONE,
                "SOCIAL_REPORT_EXPIRED",
                "This report's retention period has ended.",
            ));
        }
        let saved = saved.ok_or_else(ApiError::internal)?;
        if saved.include_evidence {
            let evidence_available: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM social_report_evidence WHERE report_id=$1 AND expires_at>clock_timestamp())",
            ).bind(report_id).fetch_one(&mut *tx).await?;
            if !evidence_available {
                return Err(ApiError::new(
                    StatusCode::GONE,
                    "SOCIAL_REPORT_EXPIRED",
                    "This report is no longer available.",
                ));
            }
        }
        if saved.reported_id != input.user_id
            || saved.message_id != input.message_id
            || saved.reason != reason
            || saved.include_evidence != input.include_evidence
        {
            return Err(idempotency_conflict());
        }
        tx.commit().await?;
        return Ok(success());
    }
    let evidence = if let Some(id) = input.message_id {
        let message:SocialMessage=sqlx::query_as(&format!("{MESSAGE_SELECT} JOIN social_conversations c ON c.id=m.conversation_id WHERE m.id=$1 AND m.sender_id=$2 AND (c.user_low=$3 OR c.user_high=$3) FOR UPDATE OF m"))
            .bind(id).bind(input.user_id).bind(auth.user_id).fetch_optional(&mut *tx).await?.ok_or_else(not_found)?;
        if input.include_evidence {
            if message.kind == "ephemeral" {
                if message.expired {
                    return Err(expired());
                }
                if message.opened_at.is_none() {
                    // A definitive refusal must stay final if the client discards its pending pointer.
                    // Reserve only an opaque receipt: no target, reason or content is retained.
                    let deadline: DateTime<Utc> =
                        sqlx::query_scalar("SELECT clock_timestamp()+interval '30 days'")
                            .fetch_one(&mut *tx)
                            .await?;
                    sqlx::query("INSERT INTO social_report_receipts(reporter_id,client_report_id,report_id,expires_at) VALUES($1,$2,$3,$4)")
                        .bind(auth.user_id).bind(input.client_report_id).bind(Uuid::new_v4()).bind(deadline)
                        .execute(&mut *tx).await?;
                    tx.commit().await?;
                    return Err(forbidden());
                }
                sqlx::query_scalar::<_,String>("SELECT p.body FROM social_ephemeral_payloads p JOIN social_messages m ON m.id=p.message_id WHERE p.message_id=$1 AND m.expires_at>clock_timestamp() FOR UPDATE OF p")
                    .bind(id).fetch_optional(&mut *tx).await?.ok_or_else(expired).map(Some)?
            } else {
                message.body
            }
        } else {
            None
        }
    } else {
        None
    };
    let id = Uuid::new_v4();
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    let deadline = now + Duration::days(30);
    sqlx::query("INSERT INTO social_reports(id,reporter_id,reported_id,message_id,reason,include_evidence,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(id).bind(auth.user_id).bind(input.user_id).bind(input.message_id).bind(reason).bind(input.include_evidence).bind(now).bind(deadline).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO social_report_receipts(reporter_id,client_report_id,report_id,expires_at) VALUES($1,$2,$3,$4)")
        .bind(auth.user_id).bind(input.client_report_id).bind(id).bind(deadline).execute(&mut *tx).await?;
    if let Some(body) = evidence {
        sqlx::query(
            "INSERT INTO social_report_evidence(report_id,body,expires_at) VALUES($1,$2,$3)",
        )
        .bind(id)
        .bind(body)
        .bind(deadline)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(success())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ephemeral_refresh_is_bounded_and_rejects_duplicates() {
        let id = Uuid::new_v4().to_string();
        assert!(ephemeral_ids("").is_err());
        assert!(ephemeral_ids("not-a-uuid").is_err());
        assert!(ephemeral_ids(&format!("{id},{id}")).is_err());
        assert_eq!(ephemeral_ids(&id).unwrap().len(), 1);
        let ids = (0..101)
            .map(|_| Uuid::new_v4().to_string())
            .collect::<Vec<_>>()
            .join(",");
        assert!(ephemeral_ids(&ids).is_err());
    }
    #[test]
    fn messages_reject_unknown_timers_empty_text_and_overlong_unicode() {
        let mut input = Send {
            client_message_id: Uuid::new_v4(),
            body: "  小Q  ".into(),
            ttl_seconds: Some(30),
        };
        assert_eq!(validate_send(&input).unwrap(), "小Q");
        input.ttl_seconds = Some(31);
        assert!(validate_send(&input).is_err());
        input.ttl_seconds = None;
        input.body = " ".into();
        assert!(validate_send(&input).is_err());
        input.body = "好".repeat(2001);
        assert!(validate_send(&input).is_err());
        input.body = "好".repeat(2000);
        assert!(validate_send(&input).is_ok());
    }
}
