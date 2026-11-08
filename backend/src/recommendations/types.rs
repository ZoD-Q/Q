use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// Display metadata only. Selecting a candidate always rechecks its current authority.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Candidate {
    pub id: String,
    pub title: String,
    pub description: String,
    pub reason: String,
    pub kind: String,
    pub access: String,
    pub connection_id: Option<Uuid>,
    pub connection_revision: Option<i64>,
    pub module: Option<String>,
    pub provider_id: Option<String>,
    pub bank_id: Option<String>,
    pub capability_version: String,
    pub price_note: Option<String>,
    #[serde(skip)]
    pub search_terms: Vec<String>,
    #[serde(skip)]
    pub exact_names: Vec<String>,
    #[serde(skip)]
    pub trusted: bool,
    #[serde(skip)]
    pub public_query: bool,
}

pub struct CatalogSnapshot {
    pub version: String,
    pub candidates: Vec<Candidate>,
}

#[derive(Debug, Serialize)]
pub struct Recommendation {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub source_message_id: String,
    pub status: String,
    pub candidates: Vec<Candidate>,
    pub catalog_version: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecommendRequest {
    pub conversation_id: Uuid,
    pub source_message_id: String,
    pub request_id: Uuid,
    pub locale: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListRequest {
    pub conversation_id: Uuid,
    pub limit: Option<i64>,
    pub cursor: Option<Uuid>,
}

#[derive(Serialize)]
pub struct RecommendationPage {
    pub items: Vec<Recommendation>,
    pub next_cursor: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectRequest {
    pub candidate_id: String,
}

#[derive(Debug, Serialize)]
pub struct Selection {
    pub kind: String,
    pub candidate: Candidate,
    pub conversation: Option<Value>,
    pub created: bool,
}
