//! Short-lived evidence that a workflow invocation came through verified Slack ingress.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Only the simple card emitted by slack_buttons is eligible. Hash all visible content.
fn message_fingerprint(message: &Value) -> Option<String> {
    if message
        .get("attachments")
        .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
    {
        return None;
    }
    let blocks = message["blocks"].as_array()?;
    if blocks.len() != 2
        || blocks[0]["type"] != "section"
        || blocks[1]["type"] != "actions"
        || blocks[0]
            .as_object()?
            .keys()
            .any(|k| !["type", "block_id", "text"].contains(&k.as_str()))
        || blocks[1]
            .as_object()?
            .keys()
            .any(|k| !["type", "block_id", "elements"].contains(&k.as_str()))
        || blocks[0]["text"]["type"] != "mrkdwn"
        || message["text"] != blocks[0]["text"]["text"]
    {
        return None;
    }
    let mut fields = vec![blocks[0]["text"]["text"].as_str()?];
    for button in blocks[1]["elements"].as_array()? {
        if button["type"] != "button"
            || button["text"]["type"] != "plain_text"
            || button
                .as_object()?
                .keys()
                .any(|k| !["type", "text", "action_id", "value", "style"].contains(&k.as_str()))
        {
            return None;
        }
        fields.extend([
            button["text"]["text"].as_str()?,
            button["action_id"].as_str()?,
            button.get("style").map_or(Some(""), Value::as_str)?,
        ]);
    }
    let mut hash = Sha256::new();
    for field in fields {
        hash.update((field.len() as u64).to_be_bytes());
        hash.update(field.as_bytes());
    }
    Some(
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

/// The receiver must still authorize the human, bind the original message and consume the action.
pub fn sign(
    input: &Value,
    workflow: &str,
    message: Option<&Value>,
    key: &[u8],
    now: i64,
) -> Option<String> {
    if key.len() < 32 {
        return None;
    }
    let action_id = input.get("action_id")?.as_str()?;
    uuid::Uuid::parse_str(action_id).ok()?;
    let click = &input["click"];
    let mut claims = json!({"kind": "workflow_action", "action_id": action_id,
        "workflow": workflow, "iat": now, "exp": now + 900,
        "message_sha256": message_fingerprint(message?)?});
    for field in [
        "id",
        "action",
        "user_id",
        "team_id",
        "channel_id",
        "message_ts",
        "action_ts",
    ] {
        let value = click.get(field)?.as_str()?;
        if value.is_empty() || value.len() > 128 {
            return None;
        }
        claims[field] = json!(value);
    }
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).ok()?);
    let authenticated = format!("v1.{body}");
    let mut mac = Hmac::<Sha256>::new_from_slice(key).ok()?;
    mac.update(authenticated.as_bytes());
    Some(format!(
        "{authenticated}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binds_verified_click_and_business_operation() {
        let input = json!({"action_id": "00000000-0000-0000-0000-000000000001", "click": {
            "id": "group", "action": "accept", "user_id": "U1", "team_id": "T1",
            "channel_id": "D1", "message_ts": "1.0", "action_ts": "2.0"}});
        let message = json!({"text": "Café", "blocks": [
            {"type": "section", "text": {"type": "mrkdwn", "text": "Café"}},
            {"type": "actions", "elements": [
                {"type": "button", "text": {"type": "plain_text", "text": "Accept and send"},
                 "action_id": "centaur.workflow.action:00000000-0000-0000-0000-000000000001:accept", "style": "primary"},
                {"type": "button", "text": {"type": "plain_text", "text": "Cancel"}, "action_id": "centaur.workflow.action:00000000-0000-0000-0000-000000000001:cancel"}
            ]}
        ]});
        assert_eq!(
            message_fingerprint(&message).as_deref(),
            Some("877bf687b9a89a898fc3098a5be78056ba00b8a1c9f90e6f2ba35f6ed5ba4941")
        );
        let token = sign(
            &input,
            "resolve_action_approval",
            Some(&message),
            b"01234567890123456789012345678901",
            100,
        )
        .unwrap();
        let parts: Vec<_> = token.split('.').collect();
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["action_id"], input["action_id"]);
        assert_eq!(claims["message_ts"], "1.0");
        assert_eq!(claims["exp"], 1000);
        let mut changed = message.clone();
        changed["blocks"][1]["elements"][0]["text"]["text"] = json!("View");
        assert_ne!(message_fingerprint(&message), message_fingerprint(&changed));
        changed["blocks"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type": "section"}));
        assert!(message_fingerprint(&changed).is_none());
        assert!(
            sign(
                &input,
                "resolve_action_approval",
                Some(&message),
                b"short",
                100
            )
            .is_none()
        );
        assert!(
            sign(
                &json!({}),
                "resolve_action_approval",
                Some(&message),
                &[1; 32],
                100
            )
            .is_none()
        );
    }
}
