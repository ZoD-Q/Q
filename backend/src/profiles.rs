//! Owns editable personal fields. Credentials, sessions and balances live elsewhere.
use axum::{
    Json,
    extract::{Query, State, rejection::QueryRejection},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::Authenticated,
    validation::{self, ApiJson},
};

#[derive(Debug, Serialize, FromRow)]
pub struct User {
    pub id: Uuid,
    pub handle: String,
    pub display_name: String,
    pub avatar: String,
    pub bio: String,
    pub theme: String,
    pub locale: String,
    pub created_at: DateTime<Utc>,
}

const USER_SELECT: &str = "SELECT i.id, i.handle, p.display_name, p.avatar, p.bio, p.theme, p.locale, i.created_at FROM identities i JOIN profiles p ON p.user_id = i.id WHERE i.id = $1";

pub async fn read(pool: &PgPool, user_id: Uuid) -> ApiResult<User> {
    sqlx::query_as(USER_SELECT)
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(ApiError::unauthorized)
}

pub(crate) async fn create(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    display_name: &str,
) -> ApiResult<User> {
    sqlx::query("INSERT INTO profiles(user_id,display_name) VALUES ($1,$2)")
        .bind(user_id)
        .bind(display_name)
        .execute(&mut **tx)
        .await?;
    Ok(sqlx::query_as(USER_SELECT)
        .bind(user_id)
        .fetch_one(&mut **tx)
        .await?)
}

pub async fn me(State(state): State<AppState>, auth: Authenticated) -> ApiResult<Json<User>> {
    Ok(Json(read(&state.pool, auth.user_id).await?))
}

#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct ProfilePatch {
    display_name: Option<String>,
    avatar: Option<String>,
    bio: Option<String>,
    theme: Option<String>,
    locale: Option<String>,
}

impl ProfilePatch {
    fn validate(&self) -> ApiResult<()> {
        if let Some(name) = &self.display_name {
            validation::text(
                name.trim(),
                1,
                40,
                "Display name must contain 1–40 characters.",
            )?;
        }
        if let Some(bio) = &self.bio {
            validation::text(bio, 0, 160, "Bio must not exceed 160 characters.")?;
        }
        for (value, allowed) in [
            (&self.avatar, &["orbit", "leaf", "spark", "wave"][..]),
            (&self.theme, &["light", "dark", "warm"][..]),
            (&self.locale, &["zh-CN", "en"][..]),
        ] {
            if value
                .as_ref()
                .is_some_and(|v| !allowed.contains(&v.as_str()))
            {
                return Err(ApiError::validation("A profile preference is invalid."));
            }
        }
        Ok(())
    }
}

pub async fn patch(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(patch): ApiJson<ProfilePatch>,
) -> ApiResult<Json<User>> {
    patch.validate()?;
    sqlx::query("UPDATE profiles SET display_name = coalesce($2, display_name), avatar = coalesce($3, avatar), bio = coalesce($4, bio), theme = coalesce($5, theme), locale = coalesce($6, locale) WHERE user_id = $1")
        .bind(auth.user_id).bind(patch.display_name.as_deref().map(str::trim)).bind(patch.avatar)
        .bind(patch.bio).bind(patch.theme).bind(patch.locale).execute(&state.pool).await?;
    Ok(Json(read(&state.pool, auth.user_id).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupQuery {
    handle: String,
}

#[derive(Serialize, FromRow)]
pub struct Recipient {
    id: Uuid,
    handle: String,
    display_name: String,
    avatar: String,
}

pub async fn lookup(
    State(state): State<AppState>,
    _auth: Authenticated,
    query: Result<Query<LookupQuery>, QueryRejection>,
) -> ApiResult<Json<Recipient>> {
    let Query(query) = query.map_err(|_| ApiError::validation("Provide one valid handle."))?;
    let handle = validation::handle(&query.handle)?;
    let recipient = sqlx::query_as("SELECT i.id, i.handle, p.display_name, p.avatar FROM identities i JOIN profiles p ON p.user_id = i.id WHERE i.handle = $1")
        .bind(handle).fetch_optional(&state.pool).await?.ok_or_else(ApiError::user_not_found)?;
    Ok(Json(recipient))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preferences_are_a_closed_set() {
        for invalid in [
            r#"{"theme":"purple"}"#,
            r#"{"locale":"xx"}"#,
            r#"{"avatar":"url"}"#,
            r#"{"display_name":"  "}"#,
        ] {
            assert!(
                serde_json::from_str::<ProfilePatch>(invalid)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        assert!(serde_json::from_str::<ProfilePatch>(r#"{"balance_minor":100}"#).is_err());
    }
}
