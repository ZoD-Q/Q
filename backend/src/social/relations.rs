use super::*;
use crate::validation;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestFriend {
    user_id: Uuid,
    note: String,
}

pub async fn request_friend(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(input): ApiJson<RequestFriend>,
) -> ApiResult<(StatusCode, Json<SocialRequest>)> {
    rate(&state, auth.user_id, "write")?;
    validation::text(
        &input.note,
        0,
        80,
        "A request note may contain at most 80 characters.",
    )?;
    let mut tx = state.pool.begin().await?;
    let (low, high) = lock_pair(&mut tx, auth.user_id, input.user_id).await?;
    ensure_peer_active(&mut tx, input.user_id).await?;
    ensure_unblocked(&mut tx, low, high).await?;
    let friends:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM social_conversations WHERE user_low=$1 AND user_high=$2 AND active)")
        .bind(low).bind(high).fetch_one(&mut *tx).await?;
    if friends {
        return Err(ApiError::conflict(
            "SOCIAL_ALREADY_FRIENDS",
            "You are already friends.",
        ));
    }
    sqlx::query("DELETE FROM social_requests WHERE ((from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)) AND created_at<=clock_timestamp()-interval '30 days'")
        .bind(low).bind(high).execute(&mut *tx).await?;
    let existing:Option<RequestRow>=sqlx::query_as("SELECT * FROM social_requests WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)")
        .bind(low).bind(high).fetch_optional(&mut *tx).await?;
    if let Some(row) = existing {
        if row.from_id != auth.user_id {
            return Err(ApiError::conflict(
                "SOCIAL_REQUEST_PENDING",
                "Respond to the existing incoming request first.",
            ));
        }
        let result = request_view(&mut tx, row).await?;
        tx.commit().await?;
        return Ok((StatusCode::OK, Json(result)));
    }
    for id in [low, high] {
        let count:i64=sqlx::query_scalar("SELECT count(*) FROM social_requests WHERE (from_id=$1 OR to_id=$1) AND created_at>clock_timestamp()-interval '30 days'")
            .bind(id).fetch_one(&mut *tx).await?;
        if count >= REQUEST_LIMIT {
            return Err(capacity());
        }
        check_friend_capacity(&mut tx, id).await?;
    }
    crate::content_policy::validate_content(&input.note)?;
    let row: RequestRow = sqlx::query_as(
        "INSERT INTO social_requests(id,from_id,to_id,note) VALUES($1,$2,$3,$4) RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(auth.user_id)
    .bind(input.user_id)
    .bind(input.note)
    .fetch_one(&mut *tx)
    .await?;
    notify(&mut tx, input.user_id, auth.user_id, "friend_request").await?;
    let result = request_view(&mut tx, row).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(result)))
}
async fn check_friend_capacity(tx: &mut Tx<'_>, id: Uuid) -> ApiResult<()> {
    let (friends,conversations):(i64,i64)=sqlx::query_as("SELECT count(*) FILTER(WHERE active),count(*) FROM social_conversations WHERE user_low=$1 OR user_high=$1")
        .bind(id).fetch_one(&mut **tx).await?;
    if friends >= FRIEND_LIMIT || conversations >= CONVERSATION_LIMIT {
        return Err(capacity());
    }
    Ok(())
}
pub async fn respond_request(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
    ApiJson(input): ApiJson<Decision>,
) -> ApiResult<Json<Mutation>> {
    rate(&state, auth.user_id, "write")?;
    let id = path(id)?;
    let mut tx = state.pool.begin().await?;
    let initial: RequestRow =
        sqlx::query_as("SELECT * FROM social_requests WHERE id=$1 AND to_id=$2")
            .bind(id)
            .bind(auth.user_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(not_found)?;
    let (low, high) = lock_pair(&mut tx, auth.user_id, initial.from_id).await?;
    let current:Option<RequestRow>=sqlx::query_as("SELECT * FROM social_requests WHERE id=$1 AND to_id=$2 AND created_at>clock_timestamp()-interval '30 days'")
        .bind(id).bind(auth.user_id).fetch_optional(&mut *tx).await?;
    let request = current.ok_or_else(|| {
        ApiError::conflict(
            "SOCIAL_REQUEST_CLOSED",
            "This request is no longer pending.",
        )
    })?;
    if input.accept {
        ensure_peer_active(&mut tx, initial.from_id).await?;
        ensure_unblocked(&mut tx, low, high).await?;
        check_friend_capacity(&mut tx, low).await?;
        check_friend_capacity(&mut tx, high).await?;
        sqlx::query("INSERT INTO social_conversations(id,user_low,user_high) VALUES($1,$2,$3)")
            .bind(Uuid::new_v4())
            .bind(low)
            .bind(high)
            .execute(&mut *tx)
            .await?;
        notify(&mut tx, request.from_id, auth.user_id, "friend_accepted").await?;
    }
    sqlx::query("DELETE FROM social_requests WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(success())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FriendPatch {
    remark: Option<String>,
    muted: Option<bool>,
    intimacy_enabled: Option<bool>,
}
pub async fn patch_friend(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
    ApiJson(input): ApiJson<FriendPatch>,
) -> ApiResult<Json<Mutation>> {
    rate(&state, auth.user_id, "write")?;
    let id = path(id)?;
    if input.remark.is_none() && input.muted.is_none() && input.intimacy_enabled.is_none() {
        return Err(ApiError::validation("Provide at least one setting."));
    }
    if let Some(value) = &input.remark {
        validation::text(value, 0, 40, "A remark may contain at most 40 characters.")?;
    }
    let mut tx = state.pool.begin().await?;
    lock_pair(&mut tx, auth.user_id, id).await?;
    let c = active_friend(&mut tx, auth.user_id, id).await?;
    let low = auth.user_id == c.user_low;
    let statement = if low {
        "UPDATE social_conversations SET low_remark=coalesce($2,low_remark),low_muted=coalesce($3,low_muted),low_intimacy_enabled=coalesce($4,low_intimacy_enabled) WHERE id=$1"
    } else {
        "UPDATE social_conversations SET high_remark=coalesce($2,high_remark),high_muted=coalesce($3,high_muted),high_intimacy_enabled=coalesce($4,high_intimacy_enabled) WHERE id=$1"
    };
    sqlx::query(statement)
        .bind(c.id)
        .bind(input.remark)
        .bind(input.muted)
        .bind(input.intimacy_enabled)
        .execute(&mut *tx)
        .await?;
    if input.intimacy_enabled == Some(false) {
        sqlx::query("DELETE FROM social_daily_activity WHERE conversation_id=$1 AND day=(clock_timestamp() AT TIME ZONE 'UTC')::date AND NOT credited")
            .bind(c.id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(success())
}
async fn end_relationship(tx: &mut Tx<'_>, low: Uuid, high: Uuid) -> ApiResult<()> {
    sqlx::query("UPDATE social_conversations SET active=false,proposed_label=NULL,proposed_by=NULL,updated_at=clock_timestamp() WHERE user_low=$1 AND user_high=$2 AND active")
        .bind(low).bind(high).execute(&mut **tx).await?;
    sqlx::query(
        "DELETE FROM social_requests WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)",
    )
    .bind(low)
    .bind(high)
    .execute(&mut **tx)
    .await?;
    // Unopened content should not outlive a lost relationship merely because its timer is longer.
    sqlx::query("DELETE FROM social_ephemeral_payloads p USING social_messages m,social_conversations c WHERE p.message_id=m.id AND m.conversation_id=c.id AND c.user_low=$1 AND c.user_high=$2 AND NOT c.active")
        .bind(low).bind(high).execute(&mut **tx).await?;
    Ok(())
}
pub async fn delete_friend(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
) -> ApiResult<Json<Mutation>> {
    rate(&state, auth.user_id, "write")?;
    let peer = path(id)?;
    let mut tx = state.pool.begin().await?;
    let (low, high) = lock_pair(&mut tx, auth.user_id, peer).await?;
    end_relationship(&mut tx, low, high).await?;
    tx.commit().await?;
    Ok(success())
}
pub async fn block(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(input): ApiJson<Target>,
) -> ApiResult<Json<Mutation>> {
    rate(&state, auth.user_id, "write")?;
    let mut tx = state.pool.begin().await?;
    let (low, high) = lock_pair(&mut tx, auth.user_id, input.user_id).await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM social_blocks WHERE blocker_id=$1 AND blocked_id=$2)",
    )
    .bind(auth.user_id)
    .bind(input.user_id)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM social_blocks WHERE blocker_id=$1")
                .bind(auth.user_id)
                .fetch_one(&mut *tx)
                .await?;
        if count >= BLOCK_LIMIT {
            return Err(capacity());
        }
        sqlx::query("INSERT INTO social_blocks(blocker_id,blocked_id) VALUES($1,$2)")
            .bind(auth.user_id)
            .bind(input.user_id)
            .execute(&mut *tx)
            .await?;
    }
    end_relationship(&mut tx, low, high).await?;
    tx.commit().await?;
    Ok(success())
}
pub async fn unblock(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
) -> ApiResult<Json<Mutation>> {
    rate(&state, auth.user_id, "write")?;
    let peer = path(id)?;
    let mut tx = state.pool.begin().await?;
    lock_pair(&mut tx, auth.user_id, peer).await?;
    sqlx::query("DELETE FROM social_blocks WHERE blocker_id=$1 AND blocked_id=$2")
        .bind(auth.user_id)
        .bind(peer)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(success())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Label {
    #[serde(deserialize_with = "required_nullable")]
    label: Option<String>,
}
fn valid_label(label: &str) -> bool {
    matches!(label, "close_friend" | "partner" | "couple")
}
pub async fn propose_label(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
    ApiJson(input): ApiJson<Label>,
) -> ApiResult<Json<Mutation>> {
    rate(&state, auth.user_id, "write")?;
    let peer = path(id)?;
    if input
        .label
        .as_deref()
        .is_some_and(|label| !valid_label(label))
    {
        return Err(ApiError::validation(
            "Choose a supported relationship label.",
        ));
    }
    let mut tx = state.pool.begin().await?;
    lock_pair(&mut tx, auth.user_id, peer).await?;
    let c = active_friend(&mut tx, auth.user_id, peer).await?;
    if let Some(label) = input.label {
        if c.proposed_by.is_some_and(|id| id != auth.user_id) {
            return Err(ApiError::conflict(
                "SOCIAL_LABEL_PENDING",
                "Respond to the existing proposal first.",
            ));
        }
        if c.relationship_label.as_deref() == Some(label.as_str()) && c.proposed_label.is_none() {
            tx.commit().await?;
            return Ok(success());
        }
        if c.proposed_label.as_deref() != Some(label.as_str())
            || c.proposed_by != Some(auth.user_id)
        {
            sqlx::query(
                "UPDATE social_conversations SET proposed_label=$2,proposed_by=$3 WHERE id=$1",
            )
            .bind(c.id)
            .bind(label)
            .bind(auth.user_id)
            .execute(&mut *tx)
            .await?;
            notify(&mut tx, peer, auth.user_id, "relationship_proposed").await?;
        }
    } else {
        sqlx::query("UPDATE social_conversations SET relationship_label=NULL,proposed_label=NULL,proposed_by=NULL WHERE id=$1").bind(c.id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(success())
}
pub async fn respond_label(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
    ApiJson(input): ApiJson<Decision>,
) -> ApiResult<Json<Mutation>> {
    rate(&state, auth.user_id, "write")?;
    let peer = path(id)?;
    let mut tx = state.pool.begin().await?;
    lock_pair(&mut tx, auth.user_id, peer).await?;
    let c = active_friend(&mut tx, auth.user_id, peer).await?;
    if c.proposed_by != Some(peer) {
        return Err(ApiError::conflict(
            "SOCIAL_LABEL_PENDING",
            "There is no incoming relationship proposal.",
        ));
    }
    sqlx::query("UPDATE social_conversations SET relationship_label=CASE WHEN $2 THEN proposed_label ELSE relationship_label END,proposed_label=NULL,proposed_by=NULL WHERE id=$1")
        .bind(c.id).bind(input.accept).execute(&mut *tx).await?;
    if input.accept {
        notify(&mut tx, peer, auth.user_id, "relationship_accepted").await?;
    }
    tx.commit().await?;
    Ok(success())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn labels_are_a_closed_set() {
        assert!(serde_json::from_str::<Label>("{}").is_err());
        assert!(serde_json::from_str::<Label>(r#"{"label":null}"#).is_ok());
        assert!(valid_label("close_friend"));
        assert!(valid_label("partner"));
        assert!(valid_label("couple"));
        assert!(!valid_label("secret"));
        assert!(!valid_label(""));
    }
}
