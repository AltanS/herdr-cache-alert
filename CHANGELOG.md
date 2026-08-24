# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-08-24

### Fixed
- **A MOVED checkout kept a dead tab-bar command, and `setup` called it installed.** The entry holds an absolute path, and the check was only "does any `herdr-cache-alert tabbar` line exist". After a re-clone or a rename that path is gone: the command fails, the entry clears itself, and the tab bar silently goes blank — while `setup` printed "the countdown is already in your tab bar". It now compares the path and repoints its own entry, and says so.
- The tab-bar step went through its own copy of the backup/validate/restore dance, with a single-server `reload-config`, so a second session kept the old config. It now uses the shared writer that fans out over every server.

## [0.1.0] - 2026-08-24

First release.

### Added
- Prompt-cache badge on every agent pane: `⚡ 47m left` warm, `⚠ 4m left` expiring, `❄ COLD`, nothing when unknown. The number is idle time remaining, not time elapsed.
- **The tab bar is the primary surface** — a `ui.tab_bar_right` command entry that Herdr re-runs on its own interval, so the countdown keeps falling while you are away. It is the only surface present over a pane alone in its tab, and it stands down on a split tab, where every pane already carries its own border badge.
- Two further surfaces: the agent list, coloured through six `$cache_*` tokens, and the pane top border on split panes. `prefix+alt+c` toggles the agent-list copy.
- **A colour for the selected row.** Herdr draws the active sidebar row on `active_row_bg` — a light grey on a dark theme — and a token's style is fixed per NAME, so one colour cannot serve both. Each state reports a `_focus` variant for the focused pane: 4.8:1 or better everywhere, against a theoretical best of 3.1:1 for any single static colour.
- Sourced-claim contract: every cache number carries a URL, a checked date, a verbatim quote and a confidence. `claims --stale DAYS` audits them and exits non-zero, so it can gate a release.
- **Claude Code adapter** — transcript probe with real cache token counts, cold-hit detection, and TTL observed from `usage.cache_creation.ephemeral_1h/5m_input_tokens`.
- **Codex CLI adapter** — rollout-log probe reading `last_token_usage.cached_input_tokens` for a real warm/cold verdict, with the TTL following the model rather than the tier: OpenAI runs 30 minutes on GPT-5.6 and later, and 5-10 minutes idle before it.
- **opencode adapter** — reads opencode's SQLite store read-only and by indexed key. The rule follows the upstream provider per session, and gateway sessions are unwrapped to their true upstream from the model prefix. Needs `herdr integration install opencode`, which is what reports the session id.
- **OpenRouter adapter** — sourced per-upstream rules, forced-only, no probe. The minimal worked example of the extension contract.
- **A per-session watcher**, ticking every 30s. `herdr --session <name>` is a whole separate server, so the watcher, the plugin link and the config reload are all per-session. Liveness is a heartbeat rather than `kill(pid, 0)`, which cannot tell a recycled pid from a live watcher or see a SIGKILL; the file is claimed with `O_EXCL`.
- **Self-healing.** `[[startup]]` and all five `[[events]]` hooks run `ensure`: paint, and start this session's watcher if it has none. An event repaints only the pane it names.
- Every paint carries `--ttl-ms` (two ticks) and a monotonic `--seq`, so a dead watcher's badge clears itself instead of leaving an authoritative-looking stale number, and a late tick loses to a newer one.
- `status`, `explain`, `rules`, `claims`, `tabbar`, `toggle`, `sync`, `ensure`, `clear`, `watch`, `setup`, `update`, `doctor` CLI commands, each with a matching plugin action, plus a `panel` overlay showing a pane's full provenance.
- `setup` links the plugin, installs the CLI, writes the tab-bar entry and sidebar tokens, binds `prefix+alt+c`, starts the watcher and paints once. It fans out over every running Herdr server, refuses a chord already in use, keeps a config backup, validates before leaving the new config in place, restores the backup on failure, and reloads each server. `--no-keys` skips the config entirely.
- **75 tests** on Node's built-in runner — no dependency, no build step. They cover the precedence ladder, the cold mark's stickiness, the badge vocabulary, the token names, the event payload's spelling, the session key and the update planner, and they apply the claim contract to every rule the plugin ships. `scripts/test.sh` sandboxes the state and config directories, then runs the CLI under both runtimes.
- oxlint with the vendored anti-slop ruleset and TypeScript 7 as the other two gates (`bun run lint`, `bun x tsc --noEmit`).

### Known limits
- Herdr draws pane borders only around **split** panes, and the border badge also needs `ui.show_agent_labels_on_pane_borders = true`. The tab bar covers the solo-pane case.
- ANSI escapes in pane metadata are stored verbatim and paint nothing, so colour comes from `ui.sidebar.agents.rows` token styling rather than from the badge string.
- No harness publishes a cache TTL for its subscription tier. Those numbers are the vendors' general API figures, recorded as gaps in the claims rather than presented as fact — read `confidence` before trusting one.
