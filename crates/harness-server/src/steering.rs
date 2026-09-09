use crate::{Result, util::write_value};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::Write;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Steering {
    pub message_id: String,
    pub execution_id: String,
}

impl Steering {
    pub fn from_metadata(metadata: &Value) -> Option<Self> {
        if metadata.get("action")?.as_str()? != "steer_active_execution" {
            return None;
        }
        serde_json::from_value(metadata.clone()).ok()
    }

    pub fn reply(&self, stdout: &mut impl Write, status: &str) -> Result<()> {
        write_value(
            stdout,
            &json!({
                "type": "centaur.steering_result", "message_id": self.message_id,
                "execution_id": self.execution_id, "status": status,
            }),
        )
    }
}
