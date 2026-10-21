//! Owns password verification and revocable, expiring opaque sessions.
use std::sync::Arc;

use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    extract::{FromRequestParts, State},
    http::{StatusCode, header::AUTHORIZATION, request::Parts},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::{
    AppState,
    error::{ApiError, ApiResult},
    ledger,
    profiles::{self, User},
    validation::{self, ApiJson},
};

pub struct Authenticated {
    pub user_id: Uuid,
    token_hash: Vec<u8>,
}

impl FromRequestParts<AppState> for Authenticated {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> ApiResult<Self> {
        let header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(ApiError::unauthorized)?;
        let (scheme, token) = header.split_once(' ').ok_or_else(ApiError::unauthorized)?;
        if !scheme.eq_ignore_ascii_case("bearer") || token.len() != 45 || !token.starts_with("q_") {
            return Err(ApiError::unauthorized());
        }
        let token_hash = digest_token(token);
        let user_id: Option<Uuid> = sqlx::query_scalar(
            "SELECT s.user_id FROM sessions s JOIN identities i ON i.id=s.user_id WHERE s.token_hash = $1 AND s.expires_at > now() AND i.status='active'",
        )
        .bind(&token_hash)
        .fetch_optional(&state.pool)
        .await?;
        Ok(Self {
            user_id: user_id.ok_or_else(ApiError::unauthorized)?,
            token_hash,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterRequest {
    handle: String,
    password: String,
    display_name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginRequest {
    handle: String,
    password: String,
}
#[derive(Serialize)]
pub struct AuthResponse {
    token: String,
    user: User,
}

pub async fn register(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<RegisterRequest>,
) -> ApiResult<(StatusCode, Json<AuthResponse>)> {
    let handle = validation::handle(&request.handle)?;
    validation::text(
        &request.password,
        10,
        128,
        "Password must contain 10–128 characters.",
    )?;
    let name = request.display_name.trim();
    validation::text(name, 1, 40, "Display name must contain 1–40 characters.")?;
    crate::content_policy::validate_content(name)?;
    state.limit_auth(format!("handle:{handle}"), 10)?;
    let hash = hash_password(request.password, state.password_slots.clone()).await?;
    let mut tx = state.pool.begin().await?;
    let user = provision_user(&mut tx, &handle, name, &hash).await?;
    let token = create_session(&mut tx, user.id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(AuthResponse { token, user })))
}

pub async fn login(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<LoginRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let handle =
        validation::handle(&request.handle).map_err(|_| ApiError::invalid_credentials())?;
    // Bound work even when an invalid password is submitted. Keep failure generic.
    validation::text(&request.password, 1, 128, "invalid")
        .map_err(|_| ApiError::invalid_credentials())?;
    state.limit_auth(format!("handle:{handle}"), 10)?;
    let record: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id,password_hash FROM identities WHERE handle = $1 AND status='active'",
    )
    .bind(&handle)
    .fetch_optional(&state.pool)
    .await?;
    // Unknown handles still run Argon2 to avoid a fast account-existence signal.
    let hash = record
        .as_ref()
        .map(|r| r.1.as_str())
        .unwrap_or(&state.dummy_hash)
        .to_owned();
    let valid = verify_password(request.password, hash, state.password_slots.clone()).await?;
    let (user_id, _) = record
        .filter(|_| valid)
        .ok_or_else(ApiError::invalid_credentials)?;
    let user = profiles::read(&state.pool, user_id).await?;
    let mut tx = state.pool.begin().await?;
    let token = create_session(&mut tx, user_id).await?;
    tx.commit().await?;
    Ok(Json(AuthResponse { token, user }))
}

pub async fn logout(State(state): State<AppState>, auth: Authenticated) -> ApiResult<StatusCode> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = $1 AND user_id = $2")
        .bind(auth.token_hash)
        .bind(auth.user_id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn provision_user(
    tx: &mut Transaction<'_, Postgres>,
    handle: &str,
    name: &str,
    hash: &str,
) -> ApiResult<User> {
    let id = Uuid::new_v4();
    let inserted = sqlx::query("INSERT INTO identities(id,handle,password_hash) VALUES ($1,$2,$3)")
        .bind(id)
        .bind(handle)
        .bind(hash)
        .execute(&mut **tx)
        .await;
    if let Err(error) = inserted {
        if error
            .as_database_error()
            .is_some_and(|e| e.is_unique_violation())
        {
            return Err(ApiError::conflict(
                "HANDLE_TAKEN",
                "This handle is already in use.",
            ));
        }
        return Err(error.into());
    }
    let user = profiles::create(tx, id, name).await?;
    ledger::open_with_welcome(tx, id).await?;
    Ok(user)
}

fn digest_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

async fn create_session(tx: &mut Transaction<'_, Postgres>, user_id: Uuid) -> ApiResult<String> {
    crate::account_lifecycle::lock_active(tx, user_id).await?;
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = format!("q_{}", URL_SAFE_NO_PAD.encode(bytes));
    sqlx::query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now() + interval '7 days')")
        .bind(digest_token(&token)).bind(user_id).execute(&mut **tx).await?;
    Ok(token)
}

pub(crate) async fn hash_password(password: String, slots: Arc<Semaphore>) -> ApiResult<String> {
    let permit = slots
        .try_acquire_owned()
        .map_err(|_| ApiError::rate_limited())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|hash| hash.to_string())
            .map_err(|_| ApiError::internal())
    })
    .await
    .map_err(|_| ApiError::internal())?
}

pub(crate) async fn verify_password(
    password: String,
    hash: String,
    slots: Arc<Semaphore>,
) -> ApiResult<bool> {
    let permit = slots
        .try_acquire_owned()
        .map_err(|_| ApiError::rate_limited())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let parsed = PasswordHash::new(&hash).map_err(|_| ApiError::internal())?;
        Ok(Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok())
    })
    .await
    .map_err(|_| ApiError::internal())?
}

/// Explicit local-only fixture bootstrap. Existing accounts/passwords/funds are never reset.
pub async fn seed_demo(state: &AppState) -> ApiResult<()> {
    let hash = hash_password("Qdemo12345!".to_owned(), state.password_slots.clone()).await?;
    for (handle, name) in [("kai", "Kai"), ("lin", "小林")] {
        let mut tx = state.pool.begin().await?;
        // Serializes concurrent startup seeders, including their existence checks.
        sqlx::query("SELECT pg_advisory_xact_lock(709271)")
            .execute(&mut *tx)
            .await?;
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM identities WHERE handle = $1)")
                .bind(handle)
                .fetch_one(&mut *tx)
                .await?;
        if !exists {
            provision_user(&mut tx, handle, name, &hash).await?;
        }
        tx.commit().await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn passwords_are_salted_and_verify_only_the_original() {
        let slots = Arc::new(Semaphore::new(2));
        let hash = hash_password("original password".into(), slots.clone())
            .await
            .unwrap();
        let another = hash_password("original password".into(), slots.clone())
            .await
            .unwrap();
        assert_ne!(hash, another);
        assert!(
            verify_password("original password".into(), hash.clone(), slots.clone())
                .await
                .unwrap()
        );
        assert!(
            !verify_password("wrong password".into(), hash, slots)
                .await
                .unwrap()
        );
    }
    #[test]
    fn session_hashes_do_not_store_bearer_material() {
        let token = "q_a_secret_token";
        assert_eq!(digest_token(token).len(), 32);
        assert_ne!(digest_token(token), token.as_bytes());
        assert_ne!(digest_token(token), digest_token("another token"));
    }
}
