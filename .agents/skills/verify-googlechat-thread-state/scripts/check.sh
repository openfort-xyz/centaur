#!/usr/bin/env bash
# Model-check GoogleChatThreadTurn.tla, one TLC run per invariant, and compare
# the failing set with the known findings below. Exit 0 = matches baseline.
set -euo pipefail

TLA_VERSION=1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
TLA_URL="https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar"

INVARIANTS=(
  StopButtonStopsRunningTurn
  StopButtonOnlyStopsItsTurn
  StopNeverKillsNewerTurn
  SteeringNoticeMeansForwarded
  NoSteeringNoticeOnceQuiet
  ThreadMarkedIdleOnceQuiet
  EveryAckResolvedOnceQuiet
)
# Findings in the code at the sync commit in SKILL.md. Keep sorted.
KNOWN_FAILING=(
  SteeringNoticeMeansForwarded
)

skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/centaur-tla"
jar="$cache_dir/tla2tools-${TLA_VERSION}.jar"
java_bin="${JAVA:-java}"

sha256_of() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

if ! command -v "$java_bin" >/dev/null; then
  echo "error: no Java found; install JDK 11+ or set JAVA=/path/to/java" >&2
  exit 2
fi
if [[ ! -f "$jar" ]]; then
  mkdir -p "$cache_dir"
  echo "fetching tla2tools.jar v${TLA_VERSION} into $cache_dir" >&2
  curl -fsSL -o "$jar.part" "$TLA_URL"
  mv "$jar.part" "$jar"
fi
actual="$(sha256_of "$jar")"
if [[ "$actual" != "$TLA_SHA256" ]]; then
  echo "error: $jar has sha256 $actual, expected $TLA_SHA256; move it aside and rerun" >&2
  exit 2
fi

covered=(
  services/googlechatbot/src/index.ts
  services/googlechatbot/src/state.ts
  services/googlechatbot/src/fold-guard.ts
  services/googlechatbot/src/session-api.ts
  crates/centaur-session-runtime/src/lib.rs
)
sync_commit="$(sed -n 's/^Sync commit: .\([0-9a-f]\{40\}\).*/\1/p' "$skill_dir/SKILL.md")"
repo_root="$(git -C "$skill_dir" rev-parse --show-toplevel)"
if ! git -C "$repo_root" diff --quiet "$sync_commit" -- "${covered[@]}" 2>/dev/null; then
  echo "note: covered code differs from sync commit ${sync_commit:-<missing>} (or that commit" \
    "is not in this clone). Review the diff against the coverage table in SKILL.md." >&2
fi

out_dir="${OUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/verify-googlechat-thread-state.XXXXXX")}"
mkdir -p "$out_dir"
cp "$skill_dir/GoogleChatThreadTurn.tla" "$out_dir/"

failing=()
for inv in "${INVARIANTS[@]}"; do
  cfg="$out_dir/$inv.cfg"
  {
    cat "$skill_dir/MC.cfg"
    echo "INVARIANT $inv"
  } >"$cfg"
  log="$out_dir/$inv.out"
  (cd "$out_dir" && "$java_bin" -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
    -config "$cfg" -workers auto -metadir "$out_dir/states-$inv" \
    GoogleChatThreadTurn.tla >"$log" 2>&1) || true
  if grep -q "Invariant $inv is violated" "$log"; then
    failing+=("$inv")
    printf 'FAIL  %-30s trace: %s\n' "$inv" "$log"
  elif grep -q "Model checking completed. No error has been found." "$log"; then
    printf 'PASS  %-30s\n' "$inv"
  else
    printf 'ERROR %-30s (deadlock, parse, or TLC error; read %s)\n' "$inv" "$log"
    tail -20 "$log" >&2
    exit 2
  fi
done

got="$(printf '%s\n' "${failing[@]+"${failing[@]}"}" | sort | sed '/^$/d')"
want="$(printf '%s\n' "${KNOWN_FAILING[@]}" | sort)"
echo "outputs: $out_dir"
if [[ "$got" == "$want" ]]; then
  echo "baseline: matches known findings (${#KNOWN_FAILING[@]} failing, as recorded in SKILL.md)"
  exit 0
fi
echo "baseline: CHANGED"
comm -13 <(echo "$want") <(echo "$got") | sed 's/^/  newly failing: /'
comm -23 <(echo "$want") <(echo "$got") | sed 's/^/  no longer failing: /'
exit 1
