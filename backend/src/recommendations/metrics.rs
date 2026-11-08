//! Completion observations are product telemetry, never business authorization.
//! Only the first handed-off question is observed, not later unrelated questions.
use crate::error::ApiResult;
use serde_json::Value;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub(crate) async fn observe_history(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    conversation: Uuid,
    snapshot: &Value,
) -> ApiResult<()> {
    let selections: Vec<(Uuid, String, i32)> = sqlx::query_as(
        "SELECT recommendation_id,candidate_id,first_message_count FROM ai_recommendation_selections WHERE user_id=$1 AND conversation_id=$2 AND (outcome IS NULL OR outcome IN ('error','cancelled'))",
    )
    .bind(user)
    .bind(conversation)
    .fetch_all(&mut **tx)
    .await?;
    for (recommendation, candidate, initial_count) in selections {
        let Some(message) = first_task_terminal(snapshot, initial_count as usize) else {
            continue;
        };
        let mut outcome = match message["status"].as_str() {
            Some("complete") => "answered",
            Some("cancelled") => "cancelled",
            _ => "error",
        };
        if outcome == "answered"
            && let Some(connection) = snapshot["plugin"]["id"]
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok())
            && let Some(ids) = message["toolInvocationIds"].as_array()
            && !ids.is_empty()
            && ids.len() <= 8
        {
            let expected = ids.len();
            let ids: Vec<Uuid> = ids
                .iter()
                .filter_map(|value| value.as_str().and_then(|id| Uuid::parse_str(id).ok()))
                .collect();
            if ids.len() == expected {
                let succeeded: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM plugin_invocations WHERE id=ANY($1) AND user_id=$2 AND connection_id=$3 AND status='succeeded'",
                )
                .bind(&ids)
                .bind(user)
                .bind(connection)
                .fetch_one(&mut **tx)
                .await?;
                if succeeded as usize == ids.len() {
                    outcome = "tool_succeeded";
                }
            }
        }
        let changed = sqlx::query(
            "UPDATE ai_recommendation_selections SET outcome=$4,finished_at=now() WHERE user_id=$1 AND recommendation_id=$2 AND candidate_id=$3 AND outcome IS DISTINCT FROM $4 AND (outcome IS NULL OR outcome IN ('error','cancelled'))",
        )
        .bind(user)
        .bind(recommendation)
        .bind(candidate)
        .bind(outcome)
        .execute(&mut **tx)
        .await?;
        if changed.rows_affected() > 0 {
            tracing::info!(event = "recommendation_task_observed", outcome);
        }
    }
    Ok(())
}

fn first_task_terminal(snapshot: &Value, initial_count: usize) -> Option<&Value> {
    snapshot["messages"]
        .as_array()?
        .iter()
        .skip(initial_count)
        .take_while(|message| message["role"] != "user")
        .filter(|message| message["role"] == "assistant")
        .last()
        .filter(|message| {
            matches!(
                message["status"].as_str(),
                Some("complete" | "error" | "cancelled")
            ) && message["finishReason"] != "tool_calls"
                && message.get("toolProposalId").is_none_or(Value::is_null)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ignores_carried_context_and_later_questions() {
        let mut snapshot = json!({"messages":[
            {"role":"assistant","status":"complete","content":"old context"},
            {"role":"user","status":"complete","content":"original question"},
            {"role":"assistant","status":"streaming","content":""},
            {"role":"user","status":"complete","content":"later question"},
            {"role":"assistant","status":"complete","content":"unrelated answer"}
        ]});
        assert!(first_task_terminal(&snapshot, 2).is_none());
        snapshot["messages"][2]["status"] = json!("complete");
        assert_eq!(first_task_terminal(&snapshot, 2).unwrap()["content"], "");
        snapshot["messages"][2]["finishReason"] = json!("tool_calls");
        assert!(first_task_terminal(&snapshot, 2).is_none());
    }
}
