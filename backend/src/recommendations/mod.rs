//! Account-owned recommendations. Cards never grant tool execution authority.
pub mod catalog;
pub mod matching;
pub(crate) mod metrics;
mod source;
mod store;
pub mod types;

use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::Authenticated,
    validation::ApiJson,
};
use axum::{
    Json, Router,
    extract::{
        Path, Query, State,
        rejection::{PathRejection, QueryRejection},
    },
    http::StatusCode,
    middleware,
    routing::{get, post},
};
use std::{collections::HashSet, time::Duration};
use tokio::time::{Instant, timeout_at};
use types::{
    Candidate, ListRequest, RecommendRequest, Recommendation, RecommendationPage, SelectRequest,
    Selection,
};
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/ai/recommendations", get(list).post(recommend))
        .route("/v1/ai/recommendations/{id}/select", post(select))
        .layer(middleware::from_fn(crate::private_response))
}

fn require_enabled(state: &AppState) -> ApiResult<()> {
    if !state.recommendations_enabled {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "RECOMMENDATIONS_DISABLED",
            "Recommendations are not enabled.",
        ));
    }
    Ok(())
}

async fn recommend(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(request): ApiJson<RecommendRequest>,
) -> ApiResult<Json<Recommendation>> {
    require_enabled(&state)?;
    if !matches!(request.locale.as_str(), "zh" | "en")
        || request.source_message_id.is_empty()
        || request.source_message_id.len() > 200
        || request.request_id.is_nil()
    {
        return Err(ApiError::validation(
            "Provide a saved question, nonempty request UUID and zh or en locale.",
        ));
    }
    state.limit_auth(format!("recommendation:{}", auth.user_id), 30)?;
    let started = Instant::now();
    let deadline = Instant::now() + Duration::from_secs(5);
    let result = timeout_at(deadline, generate(&state, auth.user_id, &request, deadline)).await;
    tracing::info!(
        event = "recommendation_finished",
        duration_ms = started.elapsed().as_millis() as u64
    );
    result
        .map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "RECOMMENDATION_TIMEOUT",
                "Recommendation timed out. Continue chatting or restore this request later.",
            )
        })?
        .map(Json)
}

async fn generate(
    state: &AppState,
    user: Uuid,
    request: &RecommendRequest,
    deadline: Instant,
) -> ApiResult<Recommendation> {
    let (row, source) = match store::claim(state, user, request).await? {
        store::Claim::Existing(row) => return row.dto(),
        store::Claim::New(row, source) => (row, source),
    };
    if !source.eligible {
        return store::finish(state, &row, "", Vec::new()).await?.dto();
    }
    let Ok(_permit) = state.recommendation_gate.clone().try_acquire_owned() else {
        tracing::info!(
            event = "recommendation_skipped",
            code = "RECOMMENDATION_CAPACITY"
        );
        return store::finish(state, &row, "capacity-v1", Vec::new())
            .await?
            .dto();
    };
    // Leave a small part of the total budget for the final short database transaction.
    let rank_deadline = deadline - Duration::from_millis(250);
    let result = timeout_at(
        rank_deadline,
        candidates(state, user, &request.locale, &source.context),
    )
    .await;
    let (version, selected) = match result {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            tracing::info!(event = "recommendation_skipped", code = error.code);
            (String::new(), Vec::new())
        }
        Err(_) => (String::new(), Vec::new()),
    };
    tracing::info!(event = "recommendation_generated", count = selected.len());
    store::finish(state, &row, &version, selected).await?.dto()
}

async fn candidates(
    state: &AppState,
    user: Uuid,
    locale: &str,
    context: &str,
) -> ApiResult<(String, Vec<Candidate>)> {
    let snapshot = catalog::load(state, user, locale).await?;
    let exact = matching::exact(context, &snapshot.candidates);
    if !exact.is_empty() {
        return revalidate(state, user, locale, exact.into_iter().take(3).collect()).await;
    }
    let recalled = matching::recall(context, &snapshot.candidates);
    let Some(ai) = state.ai.as_ref().filter(|_| !recalled.is_empty()) else {
        return Ok((snapshot.version, Vec::new()));
    };
    let ids = match ai.recommend(user, context, &recalled).await {
        Ok(ids) => ids,
        Err(error) => {
            tracing::info!(event = "recommendation_rank_skipped", code = error.code);
            return Ok((snapshot.version, Vec::new()));
        }
    };
    let mut seen = HashSet::new();
    let selected = ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .filter_map(|id| recalled.iter().find(|candidate| candidate.id == id))
        .filter(|candidate| candidate.access != "unavailable")
        .take(3)
        .cloned()
        .collect();
    revalidate(state, user, locale, selected).await
}

async fn revalidate(
    state: &AppState,
    user: Uuid,
    locale: &str,
    selected: Vec<Candidate>,
) -> ApiResult<(String, Vec<Candidate>)> {
    let current = catalog::load(state, user, locale).await?;
    let verified = selected
        .into_iter()
        .filter_map(|saved| {
            current
                .candidates
                .iter()
                .find(|fresh| {
                    fresh.id == saved.id
                        && fresh.access != "unavailable"
                        && fresh.connection_id == saved.connection_id
                        && fresh.connection_revision == saved.connection_revision
                        && fresh.capability_version == saved.capability_version
                })
                .cloned()
        })
        .collect();
    Ok((current.version, verified))
}

async fn list(
    State(state): State<AppState>,
    auth: Authenticated,
    query: Result<Query<ListRequest>, QueryRejection>,
) -> ApiResult<Json<RecommendationPage>> {
    require_enabled(&state)?;
    let Query(query) = query
        .map_err(|_| ApiError::validation("Provide a valid conversation, cursor and page size."))?;
    let limit = query.limit.unwrap_or(20);
    if !(1..=20).contains(&limit) {
        return Err(ApiError::validation(
            "Recommendation page size must be between 1 and 20.",
        ));
    }
    store::list(&state, auth.user_id, &query, limit)
        .await
        .map(Json)
}

async fn select(
    State(state): State<AppState>,
    auth: Authenticated,
    id: Result<Path<Uuid>, PathRejection>,
    ApiJson(request): ApiJson<SelectRequest>,
) -> ApiResult<Json<Selection>> {
    require_enabled(&state)?;
    let Path(id) = id.map_err(|_| ApiError::validation("Provide a valid recommendation UUID."))?;
    if request.candidate_id.is_empty() || request.candidate_id.len() > 200 {
        return Err(ApiError::validation(
            "Provide the candidate ID from this recommendation.",
        ));
    }
    let row = store::owned(&state, auth.user_id, id).await?;
    if row.status != "complete" || row.expires_at <= chrono::Utc::now() {
        return Err(store::stale());
    }
    let saved: Vec<Candidate> =
        serde_json::from_value(row.candidates.clone()).map_err(|_| ApiError::internal())?;
    let saved = saved
        .iter()
        .find(|candidate| candidate.id == request.candidate_id)
        .ok_or_else(store::not_found)?;
    let snapshot = catalog::load(&state, auth.user_id, &row.locale).await?;
    let current = snapshot
        .candidates
        .into_iter()
        .find(|candidate| candidate.id == saved.id)
        .ok_or_else(store::stale)?;
    let selected = store::select(&state, &row, saved, current).await?;
    tracing::info!(
        event = "recommendation_selected",
        kind = selected.kind,
        created = selected.created
    );
    Ok(Json(selected))
}
