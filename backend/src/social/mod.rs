//! Private social relationships and conversations. Never reads AI history or ledger data.
mod messages;
mod relations;

use std::{collections::HashMap, time::Duration};

use axum::{
    Json, Router,
    extract::{Path, Request, State, rejection::PathRejection},
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::Authenticated,
    validation::ApiJson,
};

type Tx<'a> = Transaction<'a, Postgres>;
const FRIEND_LIMIT: i64 = 200;
const REQUEST_LIMIT: i64 = 100;
const CONVERSATION_LIMIT: i64 = 500;
const BLOCK_LIMIT: i64 = 200;
const MAX_SEQUENCE: i64 = 9_007_199_254_740_991;

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Serialize)]
pub struct Mutation {
    ok: bool,
}
fn success() -> Json<Mutation> {
    Json(Mutation { ok: true })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    accept: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    user_id: Uuid,
}

#[derive(Clone, Serialize, FromRow)]
pub struct SocialUser {
    id: Uuid,
    handle: String,
    display_name: String,
    avatar: String,
}
#[derive(Clone, FromRow)]
struct ConversationRow {
    id: Uuid,
    user_low: Uuid,
    user_high: Uuid,
    active: bool,
    last_seq: i64,
    low_read_seq: i64,
    high_read_seq: i64,
    low_remark: String,
    high_remark: String,
    low_muted: bool,
    high_muted: bool,
    low_intimacy_enabled: bool,
    high_intimacy_enabled: bool,
    intimacy_score: i64,
    relationship_label: Option<String>,
    proposed_label: Option<String>,
    proposed_by: Option<Uuid>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
impl ConversationRow {
    fn peer(&self, user: Uuid) -> ApiResult<Uuid> {
        if user == self.user_low {
            Ok(self.user_high)
        } else if user == self.user_high {
            Ok(self.user_low)
        } else {
            Err(not_found())
        }
    }
    fn reads(&self, user: Uuid) -> (i64, i64) {
        if user == self.user_low {
            (self.low_read_seq, self.high_read_seq)
        } else {
            (self.high_read_seq, self.low_read_seq)
        }
    }
}
#[derive(Serialize)]
pub struct SocialFriend {
    user: SocialUser,
    conversation_id: Uuid,
    remark: String,
    muted: bool,
    intimacy_enabled: bool,
    peer_intimacy_enabled: bool,
    intimacy_score: i64,
    relationship_label: Option<String>,
    proposed_label: Option<String>,
    proposed_by: Option<Uuid>,
    created_at: DateTime<Utc>,
}
#[derive(Serialize)]
pub struct SocialConversation {
    id: Uuid,
    user: SocialUser,
    last_seq: i64,
    read_seq: i64,
    peer_read_seq: i64,
    unread_count: i64,
    last_message: Option<SocialMessage>,
    updated_at: DateTime<Utc>,
    active: bool,
}
#[derive(Clone, Serialize, FromRow)]
pub struct SocialMessage {
    id: Uuid,
    conversation_id: Uuid,
    seq: i64,
    sender_id: Uuid,
    client_message_id: Uuid,
    kind: String,
    body: Option<String>,
    ttl_seconds: Option<i32>,
    opened_at: Option<DateTime<Utc>>,
    expires_at: Option<DateTime<Utc>>,
    unopened_expires_at: Option<DateTime<Utc>>,
    expired: bool,
    created_at: DateTime<Utc>,
}
// Text is never selected from the ephemeral payload table for a list or a preview.
const MESSAGE_SELECT: &str = "SELECT m.id,m.conversation_id,m.seq,m.sender_id,m.client_message_id,m.kind,m.body,m.ttl_seconds,m.opened_at,m.expires_at,m.unopened_expires_at,m.created_at, (m.kind='ephemeral' AND (coalesce(m.expires_at,m.unopened_expires_at) <= clock_timestamp() OR NOT EXISTS (SELECT 1 FROM social_ephemeral_payloads p WHERE p.message_id=m.id))) AS expired FROM social_messages m";
#[derive(FromRow)]
struct RequestRow {
    id: Uuid,
    from_id: Uuid,
    to_id: Uuid,
    note: String,
    created_at: DateTime<Utc>,
}
#[derive(Serialize)]
pub struct SocialRequest {
    id: Uuid,
    from_user: SocialUser,
    to_user: SocialUser,
    note: String,
    created_at: DateTime<Utc>,
}
#[derive(FromRow)]
struct NotificationRow {
    id: Uuid,
    actor_id: Uuid,
    kind: String,
    created_at: DateTime<Utc>,
    read_at: Option<DateTime<Utc>>,
}
#[derive(Serialize)]
pub struct SocialNotification {
    id: Uuid,
    kind: String,
    user: SocialUser,
    created_at: DateTime<Utc>,
    read_at: Option<DateTime<Utc>>,
}
#[derive(Serialize)]
pub struct Snapshot {
    server_time: DateTime<Utc>,
    friends: Vec<SocialFriend>,
    requests: Vec<SocialRequest>,
    conversations: Vec<SocialConversation>,
    blocks: Vec<SocialUser>,
    notifications: Vec<SocialNotification>,
}

fn not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "SOCIAL_NOT_FOUND",
        "This social resource was not found.",
    )
}
fn forbidden() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "SOCIAL_FORBIDDEN",
        "This action is not allowed.",
    )
}
fn expired() -> ApiError {
    ApiError::new(
        StatusCode::GONE,
        "SOCIAL_MESSAGE_EXPIRED",
        "This message is no longer available.",
    )
}
fn idempotency_conflict() -> ApiError {
    ApiError::conflict(
        "IDEMPOTENCY_CONFLICT",
        "This client ID was already used with different content.",
    )
}
fn capacity() -> ApiError {
    ApiError::conflict(
        "SOCIAL_CAPACITY",
        "A social collection has reached its capacity.",
    )
}
fn path(value: Result<Path<Uuid>, PathRejection>) -> ApiResult<Uuid> {
    value
        .map(|Path(id)| id)
        .map_err(|_| ApiError::validation("Provide a valid resource UUID."))
}
fn rate(state: &AppState, user: Uuid, kind: &str) -> ApiResult<()> {
    let limit = match kind {
        "read" => 240,
        "send" => 60,
        _ => 30,
    };
    state.limit_auth(format!("social:{kind}:{user}"), limit)
}
fn pair(a: Uuid, b: Uuid) -> ApiResult<(Uuid, Uuid)> {
    if a == b {
        return Err(ApiError::validation("Choose a different Q user."));
    }
    Ok(if a < b { (a, b) } else { (b, a) })
}
async fn lock_pair(tx: &mut Tx<'_>, a: Uuid, b: Uuid) -> ApiResult<(Uuid, Uuid)> {
    let (low, high) = pair(a, b)?;
    let ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM identities WHERE id=$1 OR id=$2 ORDER BY id FOR UPDATE")
            .bind(low)
            .bind(high)
            .fetch_all(&mut **tx)
            .await?;
    if ids.len() != 2 {
        return Err(ApiError::user_not_found());
    }
    Ok((low, high))
}
async fn ensure_unblocked(tx: &mut Tx<'_>, a: Uuid, b: Uuid) -> ApiResult<()> {
    let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM social_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1))")
        .bind(a).bind(b).fetch_one(&mut **tx).await?;
    if blocked {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "SOCIAL_BLOCKED",
            "This connection is unavailable.",
        ));
    }
    Ok(())
}
async fn user(tx: &mut Tx<'_>, id: Uuid) -> ApiResult<SocialUser> {
    sqlx::query_as("SELECT i.id,i.handle,p.display_name,p.avatar FROM identities i JOIN profiles p ON p.user_id=i.id WHERE i.id=$1")
        .bind(id).fetch_optional(&mut **tx).await?.ok_or_else(not_found)
}
async fn request_view(tx: &mut Tx<'_>, row: RequestRow) -> ApiResult<SocialRequest> {
    Ok(SocialRequest {
        id: row.id,
        from_user: user(tx, row.from_id).await?,
        to_user: user(tx, row.to_id).await?,
        note: row.note,
        created_at: row.created_at,
    })
}
async fn conversation(tx: &mut Tx<'_>, id: Uuid, actor: Uuid) -> ApiResult<ConversationRow> {
    let row: ConversationRow = sqlx::query_as(
        "SELECT * FROM social_conversations WHERE id=$1 AND (user_low=$2 OR user_high=$2)",
    )
    .bind(id)
    .bind(actor)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(not_found)?;
    Ok(row)
}
async fn locked_conversation(tx: &mut Tx<'_>, id: Uuid, actor: Uuid) -> ApiResult<ConversationRow> {
    let existing = conversation(tx, id, actor).await?;
    lock_pair(tx, actor, existing.peer(actor)?).await?;
    conversation(tx, id, actor).await
}
async fn active_friend(tx: &mut Tx<'_>, actor: Uuid, peer: Uuid) -> ApiResult<ConversationRow> {
    let (low, high) = pair(actor, peer)?;
    ensure_unblocked(tx, actor, peer).await?;
    sqlx::query_as(
        "SELECT * FROM social_conversations WHERE user_low=$1 AND user_high=$2 AND active",
    )
    .bind(low)
    .bind(high)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| {
        ApiError::new(
            StatusCode::FORBIDDEN,
            "SOCIAL_FRIEND_REQUIRED",
            "An accepted friendship is required.",
        )
    })
}
async fn ensure_active(tx: &mut Tx<'_>, c: &ConversationRow, actor: Uuid) -> ApiResult<()> {
    ensure_unblocked(tx, actor, c.peer(actor)?).await?;
    if !c.active {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "SOCIAL_FRIEND_REQUIRED",
            "An accepted friendship is required.",
        ));
    }
    Ok(())
}
async fn notify(tx: &mut Tx<'_>, recipient: Uuid, actor: Uuid, kind: &str) -> ApiResult<()> {
    sqlx::query("INSERT INTO social_notifications(id,user_id,actor_id,kind) VALUES($1,$2,$3,$4)")
        .bind(Uuid::new_v4())
        .bind(recipient)
        .bind(actor)
        .bind(kind)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM social_notifications WHERE user_id=$1 AND (created_at <= clock_timestamp()-interval '30 days' OR id IN (SELECT id FROM social_notifications WHERE user_id=$1 ORDER BY created_at DESC,id DESC OFFSET 200))")
        .bind(recipient).execute(&mut **tx).await?;
    Ok(())
}
async fn no_store(req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/social/snapshot", get(snapshot))
        .route("/v1/social/requests", post(relations::request_friend))
        .route(
            "/v1/social/requests/{id}/respond",
            post(relations::respond_request),
        )
        .route(
            "/v1/social/friends/{id}",
            axum::routing::patch(relations::patch_friend).delete(relations::delete_friend),
        )
        .route("/v1/social/blocks", post(relations::block))
        .route(
            "/v1/social/blocks/{id}",
            axum::routing::delete(relations::unblock),
        )
        .route(
            "/v1/social/friends/{id}/label",
            post(relations::propose_label),
        )
        .route(
            "/v1/social/friends/{id}/label/respond",
            post(relations::respond_label),
        )
        .route(
            "/v1/social/conversations/{id}/messages",
            get(messages::list).post(messages::send),
        )
        .route(
            "/v1/social/conversations/{id}/ephemeral-state",
            get(messages::ephemeral_state),
        )
        .route(
            "/v1/social/conversations/{id}/read",
            post(messages::mark_read),
        )
        .route(
            "/v1/social/messages/by-client/{id}",
            get(messages::by_client),
        )
        .route("/v1/social/messages/{id}/open", post(messages::open))
        .route("/v1/social/reports", post(messages::report))
        .route(
            "/v1/social/reports/by-client/{id}",
            get(messages::report_by_client),
        )
        .route(
            "/v1/social/notifications/{id}/read",
            post(read_notification),
        )
        .layer(middleware::from_fn(no_store))
}

pub async fn snapshot(
    State(state): State<AppState>,
    auth: Authenticated,
) -> ApiResult<Json<Snapshot>> {
    rate(&state, auth.user_id, "read")?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let conversation_rows: Vec<ConversationRow> = sqlx::query_as(
        "SELECT * FROM social_conversations WHERE user_low=$1 OR user_high=$1 ORDER BY updated_at DESC,id")
        .bind(auth.user_id).fetch_all(&mut *tx).await?;
    let request_rows: Vec<RequestRow> = sqlx::query_as(
        "SELECT * FROM social_requests WHERE (from_id=$1 OR to_id=$1) AND created_at>clock_timestamp()-interval '30 days' ORDER BY created_at DESC,id")
        .bind(auth.user_id).fetch_all(&mut *tx).await?;
    let notification_rows: Vec<NotificationRow> = sqlx::query_as(
        "SELECT id,actor_id,kind,created_at,read_at FROM social_notifications WHERE user_id=$1 AND created_at>clock_timestamp()-interval '30 days' ORDER BY created_at DESC,id DESC")
        .bind(auth.user_id).fetch_all(&mut *tx).await?;
    let blocks: Vec<SocialUser> = sqlx::query_as(
        "SELECT i.id,i.handle,p.display_name,p.avatar FROM social_blocks b JOIN identities i ON i.id=b.blocked_id JOIN profiles p ON p.user_id=i.id WHERE b.blocker_id=$1 ORDER BY b.created_at DESC,i.id")
        .bind(auth.user_id).fetch_all(&mut *tx).await?;
    let mut user_ids = vec![auth.user_id];
    for c in &conversation_rows {
        user_ids.push(c.peer(auth.user_id)?);
    }
    for r in &request_rows {
        user_ids.extend([r.from_id, r.to_id]);
    }
    for n in &notification_rows {
        user_ids.push(n.actor_id);
    }
    user_ids.sort_unstable();
    user_ids.dedup();
    let users: Vec<SocialUser> = sqlx::query_as(
        "SELECT i.id,i.handle,p.display_name,p.avatar FROM identities i JOIN profiles p ON p.user_id=i.id WHERE i.id=ANY($1)")
        .bind(user_ids).fetch_all(&mut *tx).await?;
    let users: HashMap<Uuid, SocialUser> = users.into_iter().map(|u| (u.id, u)).collect();
    let lookup = |id: Uuid| users.get(&id).cloned().ok_or_else(ApiError::internal);
    // One batched query per collection, rather than one round trip for every friend.
    let preview_select = MESSAGE_SELECT.replacen("m.body,", "left(m.body,160) AS body,", 1);
    let last_messages: Vec<SocialMessage> = sqlx::query_as(&format!(
        "{preview_select} WHERE (m.conversation_id,m.seq) IN (SELECT id,last_seq FROM social_conversations WHERE user_low=$1 OR user_high=$1)"))
        .bind(auth.user_id).fetch_all(&mut *tx).await?;
    let mut last_messages: HashMap<Uuid, SocialMessage> = last_messages
        .into_iter()
        .map(|m| (m.conversation_id, m))
        .collect();
    let counts: Vec<(Uuid,i64)> = sqlx::query_as(
        "SELECT m.conversation_id,count(*) FROM social_messages m JOIN social_conversations c ON c.id=m.conversation_id WHERE m.sender_id<>$1 AND ((c.user_low=$1 AND m.seq>c.low_read_seq) OR (c.user_high=$1 AND m.seq>c.high_read_seq)) AND (m.kind='text' OR (coalesce(m.expires_at,m.unopened_expires_at)>clock_timestamp() AND EXISTS(SELECT 1 FROM social_ephemeral_payloads p WHERE p.message_id=m.id))) GROUP BY m.conversation_id")
        .bind(auth.user_id).fetch_all(&mut *tx).await?;
    let counts: HashMap<Uuid, i64> = counts.into_iter().collect();
    let mut friends = Vec::new();
    let mut conversations = Vec::new();
    for c in conversation_rows {
        let peer = lookup(c.peer(auth.user_id)?)?;
        let (read_seq, peer_read_seq) = c.reads(auth.user_id);
        if c.active {
            let low = auth.user_id == c.user_low;
            friends.push(SocialFriend {
                user: peer.clone(),
                conversation_id: c.id,
                remark: if low { c.low_remark } else { c.high_remark },
                muted: if low { c.low_muted } else { c.high_muted },
                intimacy_enabled: if low {
                    c.low_intimacy_enabled
                } else {
                    c.high_intimacy_enabled
                },
                peer_intimacy_enabled: if low {
                    c.high_intimacy_enabled
                } else {
                    c.low_intimacy_enabled
                },
                intimacy_score: c.intimacy_score,
                relationship_label: c.relationship_label,
                proposed_label: c.proposed_label,
                proposed_by: c.proposed_by,
                created_at: c.created_at,
            });
        }
        conversations.push(SocialConversation {
            id: c.id,
            user: peer,
            last_seq: c.last_seq,
            read_seq,
            peer_read_seq,
            unread_count: *counts.get(&c.id).unwrap_or(&0),
            last_message: last_messages.remove(&c.id),
            updated_at: c.updated_at,
            active: c.active,
        });
    }
    let requests = request_rows
        .into_iter()
        .map(|r| {
            Ok(SocialRequest {
                id: r.id,
                from_user: lookup(r.from_id)?,
                to_user: lookup(r.to_id)?,
                note: r.note,
                created_at: r.created_at,
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;
    let notifications = notification_rows
        .into_iter()
        .map(|n| {
            Ok(SocialNotification {
                id: n.id,
                kind: n.kind,
                user: lookup(n.actor_id)?,
                created_at: n.created_at,
                read_at: n.read_at,
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;
    tx.commit().await?;
    Ok(Json(Snapshot {
        server_time: Utc::now(),
        friends,
        requests,
        conversations,
        blocks,
        notifications,
    }))
}
async fn read_notification(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
    ApiJson(_): ApiJson<Empty>,
) -> ApiResult<Json<Mutation>> {
    rate(&state, auth.user_id, "write")?;
    let id = path(id)?;
    let result=sqlx::query("UPDATE social_notifications SET read_at=coalesce(read_at,clock_timestamp()) WHERE id=$1 AND user_id=$2 AND created_at>clock_timestamp()-interval '30 days'")
        .bind(id).bind(auth.user_id).execute(&state.pool).await?;
    if result.rows_affected() == 0 {
        return Err(not_found());
    }
    Ok(success())
}

/// Runs independently of client activity; API expiry checks do not rely on this worker.
pub async fn cleanup(pool: &PgPool) -> ApiResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("WITH expired_messages AS (SELECT m.id FROM social_messages m JOIN social_ephemeral_payloads p ON p.message_id=m.id WHERE coalesce(m.expires_at,m.unopened_expires_at)<=clock_timestamp() ORDER BY coalesce(m.expires_at,m.unopened_expires_at),m.id LIMIT 1000 FOR UPDATE OF m SKIP LOCKED) DELETE FROM social_ephemeral_payloads p USING expired_messages m WHERE p.message_id=m.id")
        .execute(&mut *tx).await?;
    sqlx::query("DELETE FROM social_report_evidence WHERE expires_at<=clock_timestamp()")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM social_reports WHERE expires_at<=clock_timestamp()")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "DELETE FROM social_requests WHERE created_at<=clock_timestamp()-interval '30 days'",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM social_notifications WHERE created_at<=clock_timestamp()-interval '30 days'",
    )
    .execute(&mut *tx)
    .await?;
    // Daily facts contain no content; completed counts are already on the relationship.
    sqlx::query("DELETE FROM social_daily_activity WHERE day < (clock_timestamp() AT TIME ZONE 'UTC')::date - 1").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
pub fn spawn_cleanup(pool: PgPool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            if let Err(error) = cleanup(&pool).await {
                tracing::warn!(code = error.code, "social maintenance failed");
            }
        }
    })
}
