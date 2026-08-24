# CLAUDE.md — working agreement for this repo

**Cache Alert** (repo `AltanS/herdr-cache-alert`) — a [Herdr](https://herdr.dev) plugin that puts a
prompt-cache countdown on every agent pane and marks the turns that missed the cache. Plugin id
`herdr.cache-alert` (manifest: `herdr-plugin.toml`). Bun + TypeScript, no build step. Orientation:
[`README.md`](./README.md).

## The claim contract — MANDATORY

**No bare cache constant may enter `src/`.** Every TTL, minimum-token count and cost multiplier is a
`Sourced<T>` (see [`src/claims.ts`](./src/claims.ts)) carrying a value, a confidence, a
documentation URL, the ISO date it was checked, and a verbatim quote from that page.

When you add or change one:

1. **Fetch the page.** Not a search result, not a memory, not another agent's summary. If you cannot
   open it, you cannot cite it.
2. **Quote verbatim.** If the sentence cannot be quoted, the claim is not `documented` — downgrade it
   to `reported` or `inferred` and say in `note` exactly what you could and could not confirm.
3. **Stamp `retrievedAt` with the real date.** This is the load-bearing field; `claims --stale`
   exists entirely to make it rot loudly.
4. **Record gaps as gaps.** `codex.*` carries an explicit "OpenAI publishes no Codex-specific TTL"
   note. An honest hole is worth far more than a plausible number, because the plugin's whole value
   is that its numbers can be trusted.

`confidence: "observed"` is reserved for something MEASURED on this machine from the harness's own
telemetry. It outranks every documented rule. Never use it for anything you reasoned your way to.

## Versioning — MANDATORY

Cache Alert is **SemVer**ed, and the version is **enforced**, so it never silently drifts.

**The version lives in two files that must always agree, plus a matching CHANGELOG entry:**
`herdr-plugin.toml` (canonical — Herdr reads it) · `package.json` · newest `## [x.y.z]` heading in
`CHANGELOG.md`.

**Before committing any functional change** (anything under `src/`, `scripts/`, `bin/`, or the
manifest) you MUST:

1. **Bump** the version in both files to the same number. The axis is **what the operator has to
   do**, not how visible the change is:
   - **PATCH** (`0.2.0 → 0.2.1`): the code now does what it was always meant to do — bug fixes and
     internal refactors. Re-verifying a claim's `retrievedAt` is a patch.
   - **MINOR** (`0.2.0 → 0.3.0`): something is there that wasn't — a new adapter, command, action,
     or config option. Existing setups keep working untouched.
   - **MAJOR** (`0.2.0 → 1.0.0`): the operator must change something — a config key or CLI flag
     renamed or removed, a stored-format break, an adapter contract change that breaks third-party
     adapters.
2. **Add a `CHANGELOG.md` entry** under a new `## [x.y.z] - YYYY-MM-DD` heading (Added / Changed /
   Fixed). Use the real date. **Style: crisp and short** — one line per change, no prose paragraphs.
3. **Run `scripts/check-version.sh`** — it must print `✓`.

Doc-only changes (`*.md`) don't need a bump.

**Tag the release when you push it.** `git tag -a vX.Y.Z -m "Cache Alert X.Y.Z" && git push --follow-tags`
so the tag ships *with* the release. One `v<x.y.z>` tag per shipped version on the remote.

## Build / run

- **No build step.** Plugin panes run `scripts/run.sh <entrypoint>`, which picks a runtime and
  executes `src/<entrypoint>.ts` directly. Herdr launches plugin commands with a minimal
  environment — never assume anything is on `PATH` there; the shim checks the usual install
  locations too.
- **Both runtimes are supported and both must keep working.** Bun is preferred when present,
  Node ≥ 22.6 otherwise. Two rules keep that true:
  **(1)** every runtime difference goes in `src/runtime.ts` — no `Bun.*` or Node-only global may
  appear anywhere else in `src/`; **(2)** `erasableSyntaxOnly` is on, because Node *strips* types
  rather than compiling them — no enums, namespaces, or constructor parameter properties.
  Check both after touching either: `CACHE_ALERT_RUNTIME=node ./bin/herdr-cache-alert status` and
  `CACHE_ALERT_RUNTIME=bun …`.
- **Three gates, all must pass:** `bun run lint` (oxlint + the vendored anti-slop
  rules in `tools/oxlint/`, `--max-warnings 0`), `bun x tsc --noEmit`
  (TypeScript 7, strict, with `noUnusedLocals/Parameters` and
  `noUncheckedIndexedAccess`), and `bun run test`.
- **The suite is Node's built-in runner** (`node:test`), so it adds no dependency
  and there is still no build step. `scripts/test.sh` points `HERDR_PLUGIN_STATE_DIR`
  and `HERDR_CONFIG_PATH` at a throwaway directory — without that a test writes
  the operator's real `state.json` and lands on a live pane's countdown. It then
  runs the CLI under BOTH runtimes, which is the part `node:test` cannot cover.
- **Test the seams that have already shipped a bug.** Every rule in the list below
  is a test now: precedence order, the claim contract applied to the rules that
  actually ship, the six token names, the event payload's spelling, `sessionKey`.
  A test whose name states the reason is worth more than one that states the
  input — the bug was never that the code did the wrong thing on purpose.
- Still verify against a live Herdr session. The suite covers the pure seams;
  nothing in it can prove that a badge appeared on screen.
- **`herdr plugin link "$PWD"` must be re-run after any manifest change** — Herdr caches the
  action/pane/event set at link time.
- **Actions run detached.** Their stdout only reaches
  `herdr plugin log list --plugin herdr.cache-alert`; anything the operator must see goes through
  `notify()`. `herdr plugin action invoke doctor` dumps resolved paths and per-pane detection there.

## Architecture — the four layers

```
claims.ts        Sourced<T>, CacheRule, staleness          — the contract
harness/*.ts     one adapter per harness, registered by id — the extension point
engine.ts        pane → CacheState                         — where precedence is decided
badge.ts sync.ts state → 6 cells on the border             — the surface
```

**Precedence in `engine.ts` is the load-bearing decision and must not be reordered casually:**

```
observed now > observed earlier > harness config override > rule for the MODEL/UPSTREAM > tier rule
```

The fourth step (`ttlForProbe`) is not decoration either. Tier is simply the
wrong axis for some harnesses: OpenAI's lifetime follows the MODEL (30 minutes on
GPT-5.6+, 5-10 minutes idle before it — both appear in one operator's logs), and
opencode's follows the UPSTREAM PROVIDER, which differs per session. A per-tier
number is wrong for one of those cases whichever value it takes.

"Observed earlier" is not redundant. A tick between turns has no probe to read, and falling straight
back to the documented rule there makes the badge flip between `⚡ 59m` and `⚡ 4m` depending on how
recently the agent happened to reply.

## Rules learned building this — don't relearn them

- **Codex DOES log cache token counts — the opposite was once shipped as fact.**
  An earlier adapter asserted in a doc comment that Codex writes none, and skipped
  them. `event_msg` records of type `token_count` carry
  `payload.info.last_token_usage.cached_input_tokens`, in the same tail the probe
  already read. Read `total_token_usage` instead and every turn looks permanently
  warm — it is a running total that reaches millions. A confident doc comment is
  not evidence; the file on disk is.
- **A credential's on-disk shape is not its in-memory struct.** Codex's Rust source
  exposes `id_token.chatgpt_plan_type`, which reads like a free plan detector. On
  disk `id_token` is a JWT STRING, so getting that field means decoding the
  credential — exactly what the secrets rule forbids. Check the file, not the type.
- **opencode's evidence is a LIVE SQLite database, not a log.** WAL mode, owned by
  a running process. Open it READ-ONLY and query by indexed key. Note the casing
  trap: `readonly` for `bun:sqlite`, `readOnly` for `node:sqlite`, and an
  unrecognised option is silently IGNORED rather than rejected — the wrong key
  opens an operator's live database for writing.
- **Herdr's own integrations are how a pane maps to a session.** opencode's
  terminal title carries a human title and its TUI binds no discoverable port, so
  there is no way in from outside. `herdr integration install opencode` reports
  opencode's `sessionID` (and drops subagent sessions). Before concluding a
  harness is unidentifiable, check `herdr integration status`.
- **A surface must stand down when a better one appears.** The tab bar can only
  ever describe the FOCUSED pane. On a split tab every pane already carries its
  own border badge, so leaving the tab bar on states one pane's number above a row
  of panes that each have their own. It is the fallback for a pane alone in its
  tab — which is the only case that has no border.

- **Two renderers of one fact will eventually both render it.** The agent list had
  `--display-agent` (the zero-config fallback) AND the `$cache_*` tokens, guarded
  by a switch that governed only the first. Once setup installed the tokens, the
  badge appeared TWICE in one row — and the duplicate was the truncated one, so it
  looked like a rendering bug rather than a logic one. `--display-agent` also
  REPLACES the agent's name, which is what forced the badge to be pasted onto the
  name and then clipped. A toggle must govern the thing that actually paints.

- **`herdr --session <name>` is a WHOLE SEPARATE SERVER, and the watcher is
  per-session.** Its own socket, panes, tab bar and plugin registration. Anything
  keyed to "the" Herdr instance is wrong: a single global `watch.pid` made the
  second session look like it already had a watcher, so it silently got none.
  Herdr injects `HERDR_SOCKET_PATH` into plugin commands and the CLI honours it,
  which is both how a command reaches the right server and how the session can be
  identified. **Anything that installs into a server must FAN OUT over every socket**
  — `~/.config/herdr/herdr.sock` plus `~/.config/herdr/sessions/*/herdr.sock`.
  `herdr plugin link` and `herdr server reload-config` are both per-server: each
  session holds its own plugin registry and its own parsed copy of `config.toml`.
  A session that missed the reload keeps the OLD `ui.sidebar.agents.rows`, so a
  newly-named `$cache_*` token renders NOTHING there however often it is painted
  — and the paint succeeds, so there is no error to find.

- **Nothing else starts the watcher, so the hooks must.** `[[startup]]` and
  `[[events]]` run `ensure`, not `sync`: paint once, and spawn a watcher for THIS
  session if it has none. Without that, only the session where `setup` happened to
  run ever had one. The spawn inherits `HERDR_SOCKET_PATH`, which is what binds
  the child to the right server.

- **The countdown cannot be event-driven.** Herdr's events fire when something happens; this plugin
  is about the stretch when nothing does. An idle pane approaching expiry emits no events, so an
  event-only badge freezes at its last number. That is why `watch.ts` exists, and why the events in
  the manifest are only the cheap edges (agent detected, status changed, pane created/closed/moved).
- **A dead watcher is INVISIBLE on an active pane, and that will fool you while debugging.** Two
  independent things repaint: the watcher's 30s tick and the `[[events]]` hooks. On a pane whose
  agent is working, `pane.agent_status_changed` fires often enough to keep the badge fresh with no
  watcher at all — so "the badges look fine" proves nothing. This confounded a real test here: a
  SIGSTOPped watcher appeared to keep painting for 190 seconds. Check `watch status` / `doctor`, and
  when testing `--ttl-ms`, use a THROWAWAY metadata source nothing else writes to.
- **Always paint with `--ttl-ms` and `--seq`.** `--ttl-ms` (≈2 ticks) is what makes a dead watcher
  self-clear instead of leaving an authoritative-looking stale number. `--seq` makes a late tick lose
  to a newer one — ticks are spawned processes and do not finish in the order they started.
- **Don't stream the transcript, seek it.** `~/.claude/projects` measured 3.7 GB here. Probes read a
  fixed 128 KB tail and walk backwards to the newest turn. An earlier version persisted a resume
  offset; it was **wrong** — a tick where nothing new was written read zero bytes and concluded there
  was no turn at all, losing the observed TTL and the cold verdict. Always the same window.
- **Resolve the transcript by GLOB, never by reimplementing Claude's cwd→slug rule.** That rule has
  to survive dots, spaces and worktree paths, and a near-miss is a silent "no data", not an error.
- **The memo key is `<adapter>:<session-id>`, never the session alone.** Two adapters pointed at one
  session — which happens the moment someone sets `CACHE_ALERT_HARNESS` — otherwise read each
  other's resolved log path and report numbers from a file they never opened. This was a real bug.
- **`state.json` must never hold an operator DECISION.** It is written once per pane per tick
  through a read-modify-write with no lock, which is fine for memos — a lost update costs one
  repaint. It is not fine for a switch: a watcher that read the file just before the toggle wrote it
  puts the old value back a millisecond later and the keypress silently undoes itself. That is why
  the agent-list switch lives in `switch.json`, which has exactly one writer. This was a real bug.
- **Token NAMES are a public interface, and an unusual one.** A copy lives in the
  operator's `config.toml` and another in the memory of every running server. The
  sidebar renders a token only if the rows it has loaded name it, so painting a
  name the config does not carry paints NOTHING — and the paint still succeeds,
  so nothing anywhere reports an error. ADD names, never rename or remove them;
  `doctor` diffs the two lists (`sidebarTokens`).
- **`evaluate` only WRITES when asked.** The memo is an unlocked read-modify-write
  and the callers are not one process: five event hooks, the watcher, `status`,
  `doctor`, `panel` and the toggle all evaluate. Four concurrent hook processes
  inside one second were measured. Only `paintPane` passes `persist: true`; a
  losing update there can drop `observedTtlSeconds`, which is precedence level 2.
- **An event hook repaints ONE pane, not all of them.** `HERDR_PLUGIN_EVENT_JSON`
  nests the pane under `data.pane_id` — verified live, do not infer it from the
  manifest. `pane.agent_status_changed` fires several times a second on a busy
  workspace, and a full sweep costs a probe per pane.
- **Watcher liveness is a HEARTBEAT, not `kill(pid, 0)`.** That call asks whether
  SOME process holds the number. Pids are recycled, so a dead watcher reads as
  alive forever and `stop` signals a stranger; it also cannot see a SIGKILL,
  which never runs the cleanup. The claim on the file is `wx` (O_EXCL), because
  write-then-read-back is a TOCTOU that both racers can pass.
- **The tab-bar entry holds an ABSOLUTE PATH, so it rots when the checkout moves.**
  A re-clone or a rename leaves the old path in `config.toml`; the command then
  fails, the entry CLEARS ITSELF, and the tab bar just goes blank. `setup` must
  compare the path, not merely detect that some entry of ours exists — reporting
  "already in your tab bar" over a dead path is a success message for a surface
  about to disappear. Every config writer goes through `writeConfig()`, which is
  what makes the reload fan out.
- **Uninstall in the order UNLINK, STOP, CLEAR.** The plugin is self-healing: while
  the `[[events]]` hooks are still registered, clearing the badges fires `ensure`,
  which spawns a fresh watcher and repaints everything. `src/uninstall.ts` does
  this in the right order; do not reorder it for tidiness.
- **`herdr pane list` reports metadata whose `--ttl-ms` has expired.** The RENDER
  honours the TTL; the API dump does not. A badge visible in `pane list` is not
  proof of a badge on screen — do not use it to conclude a paint is still live.
- **A MIGRATION THAT STRIPS OLD BLOCKS CAN EAT THE NEW ONE.** `stripLegacyBlocks`
  matches the prose comment the pre-marker sidebar block opened with — and our
  MARKED block still opens with that same comment. Unguarded, a re-run of `setup`
  emptied the block from between its own markers and printed a tick. The stripper
  is skipped for any block that already has markers. Whenever old and new content
  overlap textually, the migration must be gated on the NEW form's presence, not
  on the old form's pattern.
- **Everything written to `config.toml` is MARKED.** `# cache-alert:begin <name>`
  / `# cache-alert:end <name>`, one region per concern, all of it in
  `src/config-toml.ts`. That is what makes `uninstall` exact and `setup`
  idempotent. Anything outside those markers is the operator's: report it, never
  rewrite it. Validate on a throwaway copy via `HERDR_CONFIG_PATH` BEFORE their
  file is touched — write-then-restore leaves a window where their config is
  broken, and a crash in that window leaves it broken for good.
- **Never key state by pane id.** Pane ids change on move and on server restart. The harness's
  session id is the identity of the conversation whose cache this is.
- **A pane ALONE IN ITS TAB has no border, and nothing can give it one.** Herdr's own embedded config
  documentation settles it: `pane_borders` is "Draw borders around **split** panes", and
  `show_agent_labels_on_pane_borders` is "Show detected/reported agent labels in **split pane
  borders**". Tested exhaustively before accepting it: `ui.pane_outer_borders = true` changes nothing
  on a solo pane, and `herdr pane rename` (a manual pane name) does not render there either. Stop
  looking for a border trick — the answer is a surface the AGENT draws, i.e. the statusline.
- **`strings $(which herdr) | grep -B3 '<key> ='` is the fastest route to the truth.** Herdr embeds
  its fully-commented default config in the binary, and it documents every `ui.*` key precisely.
  It beat both the website docs and guesswork, twice, in one session.
- **The token NAME is the only styling variable you control, so vary the name.**
  `ui.sidebar.agents.rows` fixes one colour per token name, which is why there are
  three state tokens. The active row is a SECOND axis: Herdr draws it on
  `active_row_bg` (measured `#d2d3da` against `#23273a` for its neighbours), and no
  single colour serves both — the best possible compromise is ~3.1:1 on each.
  Reporting `<token>_focus` for the pane with `focused: true` gives 4.8:1 or better
  on both. Six tokens now, exactly one ever set. Any further axis works the same
  way; the cost is one more entry in the operator's rows line.

- **Style the SELECTED row, not just the normal one.** `ui.sidebar.agents.rows`
  colours are static per token, and the row under the cursor is drawn on
  `active_row_bg` — a different lightness from its neighbours. A pale dark-theme
  colour that reads everywhere else vanishes on exactly the row the operator is
  looking at. Use mid-tones. Two parser rules go with it: `fg` must be
  `#RGB`/`#RRGGBB` (named theme colours are REJECTED — "sidebar token fg must be
  #RGB or #RRGGBB"), and unknown keys are rejected as well, so a typo fails loudly
  rather than being dropped.

- **Colour IS possible — through config, not through the string.** ANSI escapes in pane metadata are
  stored verbatim and paint nothing. But `ui.sidebar.agents.rows` styles a token
  (`{ token = "$cache_warm", fg = "#a6e3a1", bold = true }`), and custom tokens reported through pane
  metadata are addressable there as `$name` — the `$` is required, and the validator says so. Since
  the style is STATIC per token name, one token can only ever be one colour: that is why there are
  three state tokens and exactly one is ever set.
- **A surface that cannot be PUSHED to cannot carry a countdown.** This is the deepest lesson here
  and it was learned by shipping the mistake. Claude Code's statusline repaints only on turn
  activity, so an idle pane freezes it at the last render — and because the TTL resets on every
  request, that render is always the full hour. It counted down never, while looking authoritative.
  Before adopting any surface, ask what makes it repaint when NOTHING is happening. There are exactly
  two valid answers: we push on the watcher tick (pane metadata), or it pulls on its own timer
  (`ui.tab_bar_right` command entries, `interval_seconds`).
- **`ui.tab_bar_right` command entries are the always-on surface**, because the tab bar exists over a
  solo pane and Herdr re-runs the entry on its own interval. Contract, all load-bearing: only the
  LAST LINE of stdout is used, EMPTY OUTPUT CLEARS the entry (which is how "silence over noise"
  comes free), and diagnostics on stdout eat the badge — send them to stderr. `tabbar` reads the
  token the watcher already published rather than probing, so every surface shows the same string.
- **A TOML key appended at EOF lands in whatever table is last, not the one you meant.** Once setup
  has written `[ui.sidebar.agents]`, appending `tab_bar_right` at the end puts it in THAT table.
  Insert after the `[ui]` header instead. `herdr config check` catches the schema error, but only
  because the key is unknown there — a key valid in both tables would have failed silently.
- **Herdr does not hot-reload `config.toml`.** Any config edit must be followed by
  `herdr server reload-config` or it sits inert and the operator reports the feature as broken.
- **`placement = "overlay"` is a transient FULL-COVER, focus-stealing, active-pane-only primitive.**
  It zooms over the active pane and restores focus and zoom when the process exits, and `--no-focus`
  is ignored. Right for `panel` (a detail view read once and dismissed); categorically wrong for an
  ambient badge. `--width`/`--height` are rejected for anything but `popup`.
- **The statusline stays dependency-free**: session id from the stdin JSON, transcript read directly,
  no `herdr` call and no watcher (20 ms measured). It calls `evaluate(..., { persist: false })` so it
  can never race the watcher for the memo file. It is a warm/cold VERDICT, not a countdown.
- **`--display-agent` REPLACES the agent's name**, so pass the name through with the badge
  (`claude ⚡ 44m`) or you have taken away the label you were decorating.
- **Never repaint-skip an unchanged badge.** Every paint carries `--ttl-ms`, so a badge that is not
  re-reported EXPIRES. `❄ COLD` never changes by definition, which made it the one state that
  reliably vanished. This shipped as a real bug once — do not reintroduce it as an
  optimisation.
- **No tab-label fallback.** Writing a countdown there renames a tab every minute, which churns the
  event bus (our own rename echoes back as `tab.renamed`) and makes the tab bar twitch. A tab rename
  is a real edit to the operator's workspace, unlike scoped metadata — `clearAll()` still strips the
  mark the earlier design wrote, so an upgrade does not leave litter.
- **Manifest event names are dotted; the payload spells them snake_case.** `on = "pane.agent_detected"`
  in `[[events]]`, but `HERDR_PLUGIN_EVENT_JSON` comes back as `{"event":"pane_agent_detected"}`.
  Writing the payload spelling parses fine and *never fires* — it surfaces only as an `unknown event`
  warning in `herdr plugin link` output. **Read those warnings.**
- **Pane metadata does not survive a server restart** — hence the `[[startup]]` hook. It repaints
  from live probes, not from remembered numbers: a badge restored from a memo written before the
  outage would be stale by exactly the length of the outage.
- **Herdr exposes no per-pane environment and no per-pane last-output timestamp.** Both were assumed
  during design and neither exists. Tier detection reads THIS process's environment, which is the
  operator's; that is why every detection carries a confidence and why an uncertain one takes the
  shorter TTL.
- **Pane ids are base36-ish, not decimal** — `w1T:p17`, `w37:pC`. Anything matching one must allow
  letters.

## Secrets

Tier detection reads credential files. It reads **only** the fields that name a plan
(`claudeAiOauth.subscriptionType`, the presence of `tokens.access_token` / `OPENAI_API_KEY`) and
never a token value. No credential value may be logged, copied into the store, put in a badge, or
included in `doctor` output. `doctor` is meant to be pasted into a bug report — keep it pasteable.

## Conventions

- Comments explain **why**, at the line that would otherwise be changed by mistake. Don't narrate
  what the code already says.
- The panel sticks to bold/dim/reset so it inherits the operator's Herdr theme. Don't hardcode a
  palette.
- User-facing errors name the remedy, not the internal failure.
- **Silence over noise.** Unknown paints nothing, never a `?`. Warm can be configured to paint
  nothing. The badge does not contain the word "CACHE" — the glyph is the label.
- **But brevity is not the goal, clarity is.** The border title has an 80-character budget. `⚡ 44m`
  was ambiguous enough that the first user asked what it meant — a reader's first guess is as likely
  to be "the cache is 44 minutes old". `left` costs four cells and removes the question.
