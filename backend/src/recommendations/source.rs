use crate::error::{ApiError, ApiResult};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MAX_CONTEXT_CHARS: usize = 16_000;

pub(super) struct Source {
    pub prompt: String,
    pub context: String,
    pub fingerprint: Vec<u8>,
    pub messages: Vec<Value>,
    pub eligible: bool,
}

fn ordinary_message(message: &Value) -> bool {
    message["status"] == "complete"
        && message["content"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty())
        && ["financeResult", "toolProposalId"]
            .iter()
            .all(|field| message.get(field).is_none_or(Value::is_null))
        && message
            .get("toolInvocationIds")
            .is_none_or(|value| value.is_null() || value.as_array().is_some_and(Vec::is_empty))
        && message["localFinance"] != true
        && message["bankCommand"] != true
}

fn switches_plugin(prompt: &str) -> bool {
    let prompt = prompt.to_lowercase();
    [
        "换个插件",
        "换一个插件",
        "其他插件",
        "更换插件",
        "换个工具",
        "其他工具",
        "改用",
        "换用",
        "换成",
        "切换到",
        "切换为",
        "其他服务",
        "别的插件",
        "switch plugin",
        "switch tool",
        "switch to",
        "use instead",
        "instead of",
        "another plugin",
        "another tool",
        "different plugin",
        "different tool",
        "different service",
    ]
    .iter()
    .any(|phrase| prompt.contains(phrase))
}

pub(super) fn from_snapshot(snapshot: &Value, source_message_id: &str) -> ApiResult<Source> {
    let messages = snapshot["messages"]
        .as_array()
        .ok_or_else(ApiError::internal)?;
    let source_index = messages
        .iter()
        .position(|message| message["id"] == source_message_id)
        .ok_or_else(|| {
            ApiError::conflict(
                "RECOMMENDATION_SOURCE_UNAVAILABLE",
                "Save this question before requesting recommendations.",
            )
        })?;
    let source = &messages[source_index];
    if source["role"] != "user" || !ordinary_message(source) {
        return Err(ApiError::validation(
            "Recommendations require an ordinary saved user question.",
        ));
    }
    let prompt = source["content"]
        .as_str()
        .ok_or_else(ApiError::internal)?
        .to_owned();
    if prompt.chars().count() > 12_000 {
        return Err(ApiError::validation(
            "The saved question exceeds the recommendation limit.",
        ));
    }
    let selected_plugin = snapshot
        .get("plugin")
        .is_some_and(|plugin| !plugin.is_null());
    let eligible = !selected_plugin || switches_plugin(&prompt);
    let mut context = Vec::new();
    let mut remaining = source_index;
    let mut used_chars = prompt.chars().count();
    // A plugin conversation's previous answers may contain private tool results.
    // Carry only the new explicit question when the user asks to switch services.
    if !selected_plugin {
        for _ in 0..2 {
            let Some(answer_index) = (0..remaining).rev().find(|index| {
                messages[*index]["role"] == "assistant" && ordinary_message(&messages[*index])
            }) else {
                break;
            };
            let Some(question_index) = (0..answer_index)
                .rev()
                .find(|index| messages[*index]["role"] == "user")
            else {
                break;
            };
            let question = &messages[question_index];
            let answer = &messages[answer_index];
            remaining = question_index;
            if !ordinary_message(question)
                || messages[question_index..=answer_index]
                    .iter()
                    .any(|message| {
                        message
                            .get("toolProposalId")
                            .is_some_and(|value| !value.is_null())
                            || message
                                .get("toolInvocationIds")
                                .and_then(Value::as_array)
                                .is_some_and(|ids| !ids.is_empty())
                            || message["bankCommand"] == true
                    })
            {
                continue;
            }
            let size = question["content"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .count()
                + answer["content"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .count();
            if used_chars + size > MAX_CONTEXT_CHARS {
                break;
            }
            used_chars += size;
            context.splice(
                0..0,
                [
                    json!({"role":"user","content":question["content"]}),
                    json!({"role":"assistant","content":answer["content"]}),
                ],
            );
        }
    }
    let recent = serde_json::to_string(&context).map_err(|_| ApiError::internal())?;
    let matching_context =
        format!("Recent conversation:\n{recent}\nCurrent user message:\n{prompt}");
    context.push(json!({"role":"user","content":prompt}));
    let encoded = serde_json::to_string(&context).map_err(|_| ApiError::internal())?;
    let fingerprint = Sha256::digest(encoded.as_bytes()).to_vec();
    let messages = context
        .into_iter()
        .map(|mut message| {
            message["id"] = json!(Uuid::new_v4());
            message["status"] = json!("complete");
            message
        })
        .collect();
    Ok(Source {
        prompt,
        context: matching_context,
        fingerprint,
        messages,
        eligible,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn later_streaming_answer_does_not_change_question_fingerprint() {
        let mut snapshot = json!({"messages":[
            {"id":"u1","role":"user","content":"Apple","status":"complete"},
            {"id":"a1","role":"assistant","content":"Which period?","status":"complete"},
            {"id":"u2","role":"user","content":"Three years","status":"complete"},
            {"id":"a2","role":"assistant","content":"","status":"pending"}
        ]});
        let first = from_snapshot(&snapshot, "u2").unwrap();
        snapshot["messages"][3]["content"] = json!("newly streamed content");
        snapshot["messages"][3]["status"] = json!("complete");
        let second = from_snapshot(&snapshot, "u2").unwrap();
        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(first.messages.len(), 3);
    }

    #[test]
    fn plugin_context_never_leaks_previous_private_results() {
        let snapshot = json!({"plugin":{"id":Uuid::new_v4()},"messages":[
            {"id":"u1","role":"user","content":"my bank balance","status":"complete"},
            {"id":"a1","role":"assistant","content":"private result 12345","status":"complete"},
            {"id":"u2","role":"user","content":"switch plugin to research stocks","status":"complete"}
        ]});
        let source = from_snapshot(&snapshot, "u2").unwrap();
        assert!(source.eligible);
        assert_eq!(source.messages.len(), 1);
        assert!(!source.context.contains("12345"));
        assert!(!from_snapshot(&snapshot, "u1").unwrap().eligible);
    }

    #[test]
    fn incomplete_and_tool_messages_cannot_be_recommendation_sources() {
        for extra in [
            json!({"status":"pending"}),
            json!({"toolProposalId":Uuid::new_v4()}),
            json!({"localFinance":true}),
        ] {
            let mut message =
                json!({"id":"source","role":"user","content":"stock news","status":"complete"});
            for (key, value) in extra.as_object().unwrap() {
                message[key] = value.clone();
            }
            assert!(from_snapshot(&json!({"messages":[message]}), "source").is_err());
        }
    }
}
