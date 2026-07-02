use std::{
    collections::BTreeSet,
    time::{Duration, SystemTime},
};

use centaur_sandbox_core::{ObservedSandbox, SandboxError, SandboxId, SandboxStatus};
use centaur_session_core::SessionExecution;
use tokio::time::{MissedTickBehavior, interval};
use tracing::{info, warn};

use crate::{
    RuntimeContext, STDOUT_OWNER_LEASE, SessionRuntimeError, TerminalOutput, record_idle_pause,
    record_terminal_output,
};

/// A running execution younger than this is left alone by the stranded-execution
/// sweep: its sandbox may still be provisioning, and the session row can briefly
/// point at the previous sandbox while `ensure_session_sandbox` replaces it.
const STRANDED_EXECUTION_GRACE: Duration = Duration::from_secs(300);

#[derive(Clone, Copy, Debug)]
pub struct SessionSandboxCleanupConfig {
    /// How often to sweep. `None` disables the cleanup worker entirely.
    pub interval: Option<Duration>,
    /// Pause session sandboxes whose latest execution has been terminal longer
    /// than this. `None` disables the idle backstop arm.
    pub idle_backstop: Option<Duration>,
    /// Fail executions still queued/running after this long, regardless of
    /// sandbox state. The last-resort bound for runs whose caller supplied no
    /// `max_duration_ms`. `None` disables the age backstop.
    pub max_execution_age: Option<Duration>,
}

impl SessionSandboxCleanupConfig {
    pub fn is_enabled(&self) -> bool {
        self.interval.is_some()
    }
}

#[derive(Debug, Default)]
pub struct SessionSandboxCleanupReport {
    pub stopped_orphans: usize,
    pub failed_orphans: usize,
    pub idle_pause_attempts: usize,
    pub failed_idle_pauses: usize,
    pub stranded_executions_failed: usize,
}

pub struct SessionSandboxCleanupWorker {
    ctx: RuntimeContext,
    config: SessionSandboxCleanupConfig,
    pending_orphans: BTreeSet<String>,
}

impl SessionSandboxCleanupWorker {
    pub(crate) fn new(ctx: RuntimeContext, config: SessionSandboxCleanupConfig) -> Self {
        Self {
            ctx,
            config,
            pending_orphans: BTreeSet::new(),
        }
    }

    pub(crate) fn spawn(mut self) {
        let Some(interval_duration) = self.config.interval else {
            return;
        };
        tokio::spawn(async move {
            let mut tick = interval(interval_duration);
            tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                if let Err(error) = self.reap_once().await {
                    warn!(%error, "session sandbox cleanup worker sweep failed");
                }
            }
        });
    }

    pub(crate) async fn reap_once(
        &mut self,
    ) -> Result<SessionSandboxCleanupReport, SessionRuntimeError> {
        let mut report = SessionSandboxCleanupReport::default();
        self.reap_unreferenced_sandboxes(&mut report).await?;
        self.pause_idle_sandboxes(&mut report).await?;
        self.fail_stranded_executions(&mut report).await?;
        Ok(report)
    }

    /// Fails executions that can never finish: their sandbox no longer accepts
    /// io, or they outlived `max_execution_age`. Without this arm a sandbox
    /// stopped out from under a run (crash, reap, node loss) leaves the
    /// execution `running` forever, which blocks its thread on the
    /// one-active-execution-per-thread index.
    async fn fail_stranded_executions(
        &self,
        report: &mut SessionSandboxCleanupReport,
    ) -> Result<(), SessionRuntimeError> {
        for execution in self.ctx.store.list_active_executions().await? {
            let started = execution.started_at.unwrap_or(execution.created_at);
            let age = SystemTime::now()
                .duration_since(SystemTime::from(started))
                .unwrap_or_default();
            if age < STRANDED_EXECUTION_GRACE {
                continue;
            }
            if let Some(max_age) = self.config.max_execution_age
                && age >= max_age
            {
                self.fail_stranded_execution(
                    &execution,
                    "",
                    "max_execution_age",
                    format!(
                        "execution exceeded the cleanup worker's max execution age ({}s)",
                        max_age.as_secs()
                    ),
                    report,
                )
                .await;
                continue;
            }
            let session = match self.ctx.store.get_session(&execution.thread_key).await {
                Ok(session) => session,
                Err(_) => continue,
            };
            let Some(sandbox_id) = session.sandbox_id.as_deref() else {
                continue;
            };
            let status = match self.ctx.manager.status(&SandboxId::new(sandbox_id)).await {
                Ok(status) => status,
                Err(SandboxError::NotFound(_)) => SandboxStatus::Gone,
                // Transient status failures must not fail a possibly live
                // execution; retry on the next sweep.
                Err(_) => continue,
            };
            if status.can_open_io() {
                continue;
            }
            self.fail_stranded_execution(
                &execution,
                sandbox_id,
                "sandbox_unavailable",
                format!("sandbox no longer accepts io (status {status:?}) while execution active"),
                report,
            )
            .await;
        }
        Ok(())
    }

    async fn fail_stranded_execution(
        &self,
        execution: &SessionExecution,
        sandbox_id: &str,
        reason: &str,
        error: String,
        report: &mut SessionSandboxCleanupReport,
    ) {
        // Take the stdout lease if the previous owner's lapsed; a no-op when we
        // already own it. `record_terminal_output` is owner-guarded, so an
        // execution actively owned by another live control plane is left for
        // that instance's own sweep.
        let _ = self
            .ctx
            .store
            .claim_expired_stdout_owner(
                &execution.execution_id,
                &self.ctx.stdout_owner_id,
                STDOUT_OWNER_LEASE,
            )
            .await;
        match record_terminal_output(
            &self.ctx,
            &execution.thread_key,
            sandbox_id,
            &execution.execution_id,
            TerminalOutput::Failed { error },
        )
        .await
        {
            Ok(()) => {
                report.stranded_executions_failed += 1;
                info!(
                    thread_key = %execution.thread_key,
                    execution_id = %execution.execution_id,
                    sandbox_id,
                    reason,
                    "session sandbox cleanup worker failed stranded execution"
                );
            }
            Err(fail_error) => {
                warn!(
                    thread_key = %execution.thread_key,
                    execution_id = %execution.execution_id,
                    sandbox_id,
                    reason,
                    %fail_error,
                    "session sandbox cleanup worker could not fail stranded execution"
                );
            }
        }
    }

    async fn reap_unreferenced_sandboxes(
        &mut self,
        report: &mut SessionSandboxCleanupReport,
    ) -> Result<(), SessionRuntimeError> {
        let referenced = self
            .ctx
            .store
            .list_referenced_sandbox_ids()
            .await?
            .into_iter()
            .collect::<BTreeSet<_>>();
        let observed = self.ctx.manager.list_observed().await?;
        let candidates =
            select_orphan_reap_candidates(&observed, &referenced, &mut self.pending_orphans);

        for sandbox_id in candidates {
            let id = SandboxId::new(sandbox_id.clone());
            match self.ctx.manager.stop(&id).await {
                Ok(()) | Err(SandboxError::NotFound(_)) => {
                    self.ctx.sandbox_pipes.remove(&sandbox_id);
                    self.pending_orphans.remove(&sandbox_id);
                    report.stopped_orphans += 1;
                    info!(
                        sandbox_id,
                        reason = "unreferenced",
                        "session sandbox cleanup worker stopped orphaned sandbox"
                    );
                }
                Err(error) => {
                    report.failed_orphans += 1;
                    warn!(
                        sandbox_id,
                        %error,
                        "session sandbox cleanup worker failed to stop orphaned sandbox"
                    );
                }
            }
        }

        Ok(())
    }

    async fn pause_idle_sandboxes(
        &self,
        report: &mut SessionSandboxCleanupReport,
    ) -> Result<(), SessionRuntimeError> {
        let Some(idle_backstop) = self.config.idle_backstop else {
            return Ok(());
        };
        for candidate in self
            .ctx
            .store
            .list_idle_sandbox_candidates(idle_backstop)
            .await?
        {
            report.idle_pause_attempts += 1;
            if let Err(error) = record_idle_pause(
                &self.ctx,
                &candidate.thread_key,
                &candidate.execution_id,
                &candidate.sandbox_id,
                candidate.idle_timeout,
            )
            .await
            {
                report.failed_idle_pauses += 1;
                warn!(
                    thread_key = %candidate.thread_key,
                    execution_id = %candidate.execution_id,
                    sandbox_id = %candidate.sandbox_id,
                    %error,
                    "session sandbox cleanup worker failed to pause idle sandbox"
                );
            }
        }
        Ok(())
    }
}

fn select_orphan_reap_candidates(
    observed: &[ObservedSandbox],
    referenced: &BTreeSet<String>,
    pending_orphans: &mut BTreeSet<String>,
) -> Vec<String> {
    let current_orphans = observed
        .iter()
        .filter(|sandbox| orphan_reap_eligible(sandbox, referenced))
        .map(|sandbox| sandbox.id.as_str().to_owned())
        .collect::<BTreeSet<_>>();

    let candidates = current_orphans
        .intersection(pending_orphans)
        .cloned()
        .collect::<Vec<_>>();
    *pending_orphans = current_orphans;
    candidates
}

fn orphan_reap_eligible(sandbox: &ObservedSandbox, referenced: &BTreeSet<String>) -> bool {
    if referenced.contains(sandbox.id.as_str()) {
        return false;
    }
    !matches!(
        sandbox.status,
        SandboxStatus::Created | SandboxStatus::Stopped | SandboxStatus::Gone
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observed(id: &str, status: SandboxStatus) -> ObservedSandbox {
        ObservedSandbox::new(SandboxId::new(id), "test", status)
    }

    fn referenced(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn orphan_reap_requires_two_consecutive_passes() {
        let observed = [observed("asbx-1", SandboxStatus::Running)];
        let mut pending = BTreeSet::new();

        assert_eq!(
            select_orphan_reap_candidates(&observed, &referenced(&[]), &mut pending),
            Vec::<String>::new()
        );
        assert_eq!(
            select_orphan_reap_candidates(&observed, &referenced(&[]), &mut pending),
            vec!["asbx-1".to_owned()]
        );
    }

    #[test]
    fn referenced_sandbox_rescues_pending_orphan() {
        let observed = [observed("asbx-1", SandboxStatus::Running)];
        let mut pending = BTreeSet::new();

        select_orphan_reap_candidates(&observed, &referenced(&[]), &mut pending);
        assert_eq!(
            select_orphan_reap_candidates(&observed, &referenced(&["asbx-1"]), &mut pending),
            Vec::<String>::new()
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn created_and_terminal_sandboxes_are_not_reaped() {
        let observed = [
            observed("asbx-created", SandboxStatus::Created),
            observed("asbx-stopped", SandboxStatus::Stopped),
            observed("asbx-gone", SandboxStatus::Gone),
        ];
        let mut pending = BTreeSet::from([
            "asbx-created".to_owned(),
            "asbx-stopped".to_owned(),
            "asbx-gone".to_owned(),
        ]);

        assert_eq!(
            select_orphan_reap_candidates(&observed, &referenced(&[]), &mut pending),
            Vec::<String>::new()
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn failed_stop_stays_pending_for_retry() {
        let observed = [observed("asbx-1", SandboxStatus::Running)];
        let mut pending = BTreeSet::from(["asbx-1".to_owned()]);

        assert_eq!(
            select_orphan_reap_candidates(&observed, &referenced(&[]), &mut pending),
            vec!["asbx-1".to_owned()]
        );
        assert!(pending.contains("asbx-1"));
    }

    #[test]
    fn vanished_pending_orphan_is_dropped() {
        let mut pending = BTreeSet::from(["asbx-1".to_owned()]);

        assert_eq!(
            select_orphan_reap_candidates(&[], &referenced(&[]), &mut pending),
            Vec::<String>::new()
        );
        assert!(pending.is_empty());
    }
}
