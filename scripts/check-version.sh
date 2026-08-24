#!/usr/bin/env bash
# Version consistency gate for Cache Alert.
#
# The plugin's version lives in two files that MUST agree, plus a matching CHANGELOG entry:
#   - herdr-plugin.toml   (canonical — this is what Herdr reads)
#   - package.json
#   - CHANGELOG.md        (newest "## [x.y.z]" heading)
#
# Exits non-zero with a clear message on any mismatch. See CLAUDE.md → "Versioning".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

toml_v="$(sed -n 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/herdr-plugin.toml" | head -1)"
pkg_v="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
log_v="$(sed -n 's/^##[[:space:]]*\[\([0-9][^]]*\)\].*/\1/p' "$ROOT/CHANGELOG.md" 2>/dev/null | head -1)"

note() { printf '  %-18s %s\n' "$1" "$2"; }

if [ -z "$toml_v" ]; then
  echo "✗ could not read version from herdr-plugin.toml" >&2
  exit 1
fi

if [ "$pkg_v" != "$toml_v" ] || [ "$log_v" != "$toml_v" ]; then
  echo "✗ version mismatch — all three must equal the canonical herdr-plugin.toml version:" >&2
  note "herdr-plugin.toml" "$toml_v  (canonical)"
  note "package.json" "${pkg_v:-<missing>}"
  note "CHANGELOG.md" "${log_v:-<missing>}"
  echo "  → bump both files to the same version and add a matching CHANGELOG entry." >&2
  exit 1
fi

echo "✓ version $toml_v consistent across manifest, package.json, CHANGELOG"
