#!/usr/bin/env bash
# Entrypoint shim for every plugin command.
#
# cache-alert has no build step: this picks a JavaScript runtime and hands it the
# TypeScript source directly. Bun is preferred when present; otherwise Node,
# which executes TypeScript by stripping types (bare from 23.6, behind
# --experimental-strip-types from 22.6). Herdr launches plugin commands with a
# minimal environment, so neither may be assumed to be on PATH — both are
# looked for in the usual install locations too.
#
# $CACHE_ALERT_BUN / $CACHE_ALERT_NODE override the search; $CACHE_ALERT_RUNTIME=node|bun forces
# one of the two.
set -euo pipefail

ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

first_existing() {
  for candidate in "$@"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

find_bun() {
  [ -n "${CACHE_ALERT_BUN:-}" ] && { printf '%s' "$CACHE_ALERT_BUN"; return 0; }
  command -v bun 2>/dev/null && return 0
  first_existing "$HOME/.bun/bin/bun" /usr/local/bin/bun /opt/homebrew/bin/bun
}

find_node() {
  [ -n "${CACHE_ALERT_NODE:-}" ] && { printf '%s' "$CACHE_ALERT_NODE"; return 0; }
  command -v node 2>/dev/null && return 0
  first_existing /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node
}

# Node gained bare `node file.ts` in 23.6; 22.6–23.5 need the flag. --no-warnings
# keeps the experimental notice off stderr, which would otherwise land in a pane.
node_ts_flags() {
  local version major minor
  version="$("$1" --version 2>/dev/null | sed 's/^v//')"
  major="${version%%.*}"
  minor="${version#*.}"; minor="${minor%%.*}"
  if [ "${major:-0}" -ge 24 ] || { [ "${major:-0}" -eq 23 ] && [ "${minor:-0}" -ge 6 ]; }; then
    printf '%s' "--no-warnings"
  elif [ "${major:-0}" -ge 23 ] || { [ "${major:-0}" -eq 22 ] && [ "${minor:-0}" -ge 6 ]; }; then
    printf '%s' "--no-warnings --experimental-strip-types"
  else
    return 1
  fi
}

entry="${1:?usage: run.sh <panel|cli|action> [args...]}"
shift

case "$entry" in
  panel|cli|action) ;;
  *) echo "cache-alert: unknown entrypoint '$entry'" >&2; exit 2 ;;
esac

target="$ROOT/src/$entry.ts"
want="${CACHE_ALERT_RUNTIME:-any}"

if [ "$want" != "node" ] && BUN="$(find_bun)"; then
  exec "$BUN" "$target" "$@"
fi

if [ "$want" != "bun" ] && NODE="$(find_node)"; then
  if FLAGS="$(node_ts_flags "$NODE")"; then
    # shellcheck disable=SC2086 -- FLAGS is a deliberate word list.
    exec "$NODE" $FLAGS "$target" "$@"
  fi
  echo "cache-alert: $NODE is $("$NODE" --version), which cannot run TypeScript — need Node 22.6+ or Bun." >&2
  exit 127
fi

echo "cache-alert: no JavaScript runtime found. Install Node 22.6+ (https://nodejs.org) or Bun" >&2
echo "       (https://bun.sh), or point CACHE_ALERT_NODE / CACHE_ALERT_BUN at one." >&2
exit 127
