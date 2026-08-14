#!/usr/bin/env bash

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
plan_file="${repo_root}/plan/feature-google-chat-slack-parity-1.md"
ledger_file="${repo_root}/docs/google-chat-parity-verification.md"

for number in $(seq -w 1 31); do
  task="TASK-0${number}"
  test_id="TEST-0${number}"
  [[ "$(grep -c "^| ${task} | ${test_id} |" "${ledger_file}")" -eq 1 ]] || {
    echo "expected exactly one ledger row for ${task}/${test_id}" >&2
    exit 1
  }
  grep -q "^| ${task} .*Verification: ${test_id}\." "${plan_file}" || {
    echo "missing ${task} to ${test_id} mapping in plan" >&2
    exit 1
  }
done

for exclusion in CON-001 CON-002; do
  grep -q "^- \*\*${exclusion}\*\*:" "${ledger_file}" || {
    echo "missing accepted exclusion ${exclusion}" >&2
    exit 1
  }
done

awk -F '|' '
  function trim(value) {
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
    return value
  }
  /^\| TASK-[0-9]+ \| TEST-[0-9]+ \|/ {
    task = trim($2)
    status = trim($4)
    evidence = trim($6)
    if (status !~ /^(Passed|Verified-local|Provisional|Pending|Failed|Blocked)$/) {
      printf "invalid status %s for %s\n", status, task > "/dev/stderr"
      failed = 1
    }
    if (status == "Passed" && evidence !~ /^([0-9a-f]{40}|sha256:[0-9a-f]{64})$/) {
      printf "Passed row %s requires an immutable commit SHA or image digest, not %s\n", task, evidence > "/dev/stderr"
      failed = 1
    }
    statuses[task] = status
    evidence_by_task[task] = evidence
  }
  END {
    if (statuses["TASK-031"] == "Passed") {
      release_evidence = evidence_by_task["TASK-031"]
      for (number = 1; number <= 30; number++) {
        task = sprintf("TASK-%03d", number)
        if (statuses[task] != "Passed" || evidence_by_task[task] != release_evidence) {
          printf "TASK-031 may be Passed only when TASK-001..TASK-030 are Passed on the same immutable evidence\n" > "/dev/stderr"
          failed = 1
          break
        }
      }
    }
    exit failed
  }
' "${ledger_file}"

echo "verified 31 parity task/test rows, 2 accepted exclusions, and immutable Passed evidence"
