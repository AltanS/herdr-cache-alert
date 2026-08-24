#!/usr/bin/env bash
# The unit suite. `bun run test`, or run this directly.
#
# NODE'S BUILT-IN RUNNER, not Bun's, and that is deliberate: `node:test` is
# stdlib on a runtime this plugin already requires, so the suite adds no
# dependency and there is still no build step. Node also runs each test FILE in
# its own process, which is what lets a test set an environment variable and
# re-import a module that read it at load time.
#
# Both runtimes are still checked — by executing the CLI under each, at the
# bottom of this script. That is the part `node:test` cannot cover.
#
# The state and config directories are THROWAWAY. Without that the suite would
# read and write the operator's real `state.json`, and a test that writes a memo
# would land on a live pane's countdown.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

export HERDR_PLUGIN_STATE_DIR="$SANDBOX/state"
export HERDR_PLUGIN_CONFIG_DIR="$SANDBOX/config"
export HERDR_CONFIG_PATH="$SANDBOX/herdr/config.toml"
mkdir -p "$HERDR_PLUGIN_STATE_DIR" "$HERDR_PLUGIN_CONFIG_DIR" "$SANDBOX/herdr"
# An empty config.toml, so a test that reads one gets a file rather than ENOENT.
: >"$HERDR_CONFIG_PATH"

NODE="${CACHE_ALERT_NODE:-node}"
"$NODE" --no-warnings --test "test/*.test.ts"

# The runtime matrix. `status` exercises the config load, the adapter registry
# and the claim tables under each runtime — which is what catches an `enums`,
# a `Bun.*` outside runtime.ts, or a constructor parameter property.
echo
for runtime in node bun; do
  if CACHE_ALERT_RUNTIME="$runtime" ./bin/herdr-cache-alert rules >/dev/null 2>&1; then
    echo "✓ runs under $runtime"
  else
    echo "✗ FAILED under $runtime" >&2
    exit 1
  fi
done
