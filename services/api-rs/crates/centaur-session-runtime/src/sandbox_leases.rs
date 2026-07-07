//! Process-wide advisory leases that shield non-session sandboxes from the
//! session cleanup worker's unreferenced-sandbox reaper.
//!
//! The reaper treats every observed sandbox that is not referenced by
//! `sessions.sandbox_id` or the warm pool as an orphan and stops it on its
//! second consecutive sweep. Python workflow-host sandboxes are referenced by
//! neither, so any workflow outliving two sweep intervals had its sandbox torn
//! down mid-run — the proxy Service vanished first, so the dying host reported
//! "[Errno -2] Name or service not known" and the real cause was invisible
//! (2026-07-07 notion_sync incident: ~150 runs killed this way since Jun 30).
//!
//! A lease is process-global rather than threaded through `RuntimeContext`
//! because the holder (`centaur-workflows`) only sees the public
//! `SessionRuntime` surface, and the minimal-diff shape keeps this fork patch
//! cheap to carry across upstream syncs.

use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex};

static LEASES: LazyLock<Mutex<BTreeMap<String, usize>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

/// RAII lease: the sandbox is exempt from orphan reaping until every clone of
/// its lease is dropped. Reference-counted so overlapping holders compose.
#[derive(Debug)]
pub struct SandboxLease {
    id: String,
}

pub fn lease_sandbox(id: impl Into<String>) -> SandboxLease {
    let id = id.into();
    let mut leases = LEASES.lock().expect("sandbox lease lock poisoned");
    *leases.entry(id.clone()).or_insert(0) += 1;
    SandboxLease { id }
}

pub fn is_sandbox_leased(id: &str) -> bool {
    LEASES
        .lock()
        .expect("sandbox lease lock poisoned")
        .contains_key(id)
}

impl Drop for SandboxLease {
    fn drop(&mut self) {
        let mut leases = LEASES.lock().expect("sandbox lease lock poisoned");
        if let Some(count) = leases.get_mut(&self.id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                leases.remove(&self.id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_shields_until_last_holder_drops() {
        let id = "asbx-lease-test-1";
        assert!(!is_sandbox_leased(id));
        let first = lease_sandbox(id);
        let second = lease_sandbox(id);
        assert!(is_sandbox_leased(id));
        drop(first);
        assert!(is_sandbox_leased(id));
        drop(second);
        assert!(!is_sandbox_leased(id));
    }
}
