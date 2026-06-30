use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_yaml::Value;

use super::{PostgresListener, Transform};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProxyFragment {
    #[serde(default)]
    pub transforms: Vec<Transform>,
    #[serde(default)]
    pub postgres: Vec<PostgresListener>,
    #[serde(default, flatten)]
    pub top_level: BTreeMap<String, Value>,
}

impl ProxyFragment {
    /// Drop `token_broker` secret sources, which only an iron-control-managed
    /// proxy can use: the control plane mints the broker credential's access
    /// token and substitutes it inline at proxy sync, so the raw source never
    /// reaches a managed proxy. A locally-configured (unmanaged) proxy — e.g.
    /// the control-plane egress proxy that boots from a baked config with no
    /// `IRON_CONTROL_PLANE_URL` — has nothing to resolve it and fails to build
    /// its transform pipeline (`unsupported source type "token_broker"`). Strip
    /// those secrets from its config; any `secrets` transform left empty is
    /// removed so it does not serialize a contentless entry.
    pub fn strip_broker_token_secrets(&mut self) {
        for transform in &mut self.transforms {
            if transform.is_secrets() {
                transform
                    .config
                    .secrets
                    .retain(|secret| !secret.is_token_broker());
            }
        }
        self.transforms
            .retain(|transform| !(transform.is_secrets() && transform.config.is_empty()));
    }
}
