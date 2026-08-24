# Cache Alert

A [Herdr](https://herdr.dev) plugin that puts a prompt-cache countdown on every agent pane, and
marks the turns that missed the cache.

```
┌ w2Y:p9 ────────────────────────────────────────────────── ⚡ 47m left ─┐
│ > implement the retry logic                                           │
```

A cold turn re-reads your whole conversation at full input price and makes you wait for it. The
badge tells you, before you step away, how long you have — and tells you afterwards when you paid
for it anyway.

![The cache badge in the Herdr agent list and tab bar](docs/agent-list.png)

Two surfaces, one number. The **tab bar** (top right) covers the pane you are in — including a pane
alone in its tab, which has no border to draw on. The **agent list** carries the whole herd at once:
`maple` has 59 minutes left, while `biscuit-opencode` and `comet` are both cold and have to rebuild
their prefix on the next turn. The selected row is drawn on a lighter background, so it gets its own
colour — one green cannot read on both.

- [Install](#install)
- [What the badge means](#what-the-badge-means)
- [Where the numbers come from](#where-the-numbers-come-from)
- [Supported harnesses](#supported-harnesses)
- [Adding a harness](#adding-a-harness)
- [The watcher](#the-watcher)
- [CLI](#cli)
- [Config](#config)
- [How it works](#how-it-works)
- [Development](#development)
- [License](#license)

## Install

Needs **Node 22.6+ or [Bun](https://bun.sh)** — whichever you already have. There is no build step
and no binary to download; the plugin runs its TypeScript directly.

```bash
git clone git@github.com:AltanS/herdr-cache-alert.git
cd herdr-cache-alert && ./bin/herdr-cache-alert setup
```

`setup` does the whole install and is safe to re-run:

1. links the plugin into Herdr (`herdr plugin link`),
2. puts `herdr-cache-alert` in `~/.local/bin`,
3. binds `prefix+alt+c` to the agent-list toggle,
4. adds the coloured `$cache_*` tokens to your agent sidebar,
5. adds the countdown to your tab bar, which is the surface that works everywhere,
6. starts the watcher, which repaints every 30 seconds.

It does **not** touch your Claude Code config.

Step 3 is the only one that touches a file you own, so it is careful about it: it refuses a chord
already in use, keeps a backup at `config.toml.cache-alert-backup`, validates with
`herdr config check` **before** leaving the new config in place, and restores the backup if that
check fails. Pass `--no-keys` to skip it and bind `herdr.cache-alert.toggle` yourself.

Check it worked:

```bash
herdr-cache-alert status
```

Badges appear on agent panes within one tick. Already inside Herdr? The same thing runs from the
action palette as **Cache: finish setup**.

## Update

```bash
herdr plugin action invoke update --plugin herdr.cache-alert
```

or `herdr-cache-alert update` from a shell. One step: it advances the checkout and re-registers the
plugin with Herdr. The re-link matters — Herdr caches the action set at link time, so a release that
adds an action answers `plugin_action_not_found` until the plugin is linked again.

A routine update stays inside the major it is on. Crossing one needs the separate consent:

```bash
herdr plugin action invoke update-major --plugin herdr.cache-alert
```

## What the badge means

| badge | meaning |
| --- | --- |
| `⚡ 47m left` | warm — the cache survives another 47 minutes of you not sending anything |
| `⚠ 4m left` | expiring — under a quarter of the TTL to go; finish the thought |
| `❄ COLD` | no cache: either the last turn read nothing from it, or the clock ran out |
| *(nothing)* | unknown — no adapter, no session, or no evidence yet |

**The number is idle time remaining, not elapsed time.** It counts down toward the moment the cache
dies, and every message you send resets it to the full TTL — the window is sliding on every harness
here. Walking away is what spends it.

**Unknown paints nothing.** A `?` on the border would be clutter that teaches you nothing, so
silence is the answer whenever the plugin cannot honestly say.

`❄ COLD` from an *observed* miss is sticky: it stays until a warm turn clears it, because the miss
you need to see is usually one you were looking away for.

Minutes, never seconds. The watcher ticks every 30 seconds, so a second-by-second countdown would
be wrong half the time it was on screen.

**Colour** comes from config, not from the badge string. Herdr's client does not render ANSI escapes
in pane metadata, but `ui.sidebar.agents.rows` styles each token — so the sidebar is coloured by
state. The pane border and the tab bar stay monochrome and lean on the glyph.

### Where it paints

Three surfaces, because Herdr's chrome is conditional and the pane's own content
is not:

| surface | shows | scope | works when |
| --- | --- | --- | --- |
| **tab bar** | `⚡ 44m left` | focused pane | **always** — the tab bar is there over a solo pane |
| **agent sidebar** | `claude ⚡ 44m left`, coloured | every pane | the sidebar is open |
| **pane top border** | `⚡ 44m left` | that pane | the pane **shares a tab**, and `ui.show_agent_labels_on_pane_borders = true` |

**A pane alone in its tab has no border, and nothing can give it one.** Tested
three ways: the agent label is documented as "split pane borders" only,
`ui.pane_outer_borders = true` changes nothing there, and a manual pane name does
not render either. The tab bar is the answer.

#### The tab bar: the one that always works

`setup` adds a `command` entry to `ui.tab_bar_right`. Herdr re-runs it every five
seconds **by itself**, which is the whole trick: nothing has to redraw and nobody
has to push, so the number keeps falling while you are away from the machine.

```toml
[ui]
tab_bar_right = [{ type = "command", command = "…/herdr-cache-alert tabbar", interval_seconds = 5, timeout_seconds = 3 }]
```

It reads the badge the watcher already published rather than probing again, so
every surface agrees, and it costs one socket round trip. Herdr uses only the
last line of output and **clears the entry on empty output** — so "nothing known"
empties the slot for free, and a dead watcher clears it within one `--ttl-ms`
window. Blank rather than wrong, as everywhere else here.

Already set `tab_bar_right`? Setup will not rewrite your list — that list is
ordered, capped, and yours. `herdr-cache-alert tabbar-snippet` prints the entry
to paste.

#### In the sidebar: coloured, via metadata tokens

`setup` adds this to `[ui.sidebar.agents]`, and it is where the colour comes from:

```toml
rows = [["state_icon", "workspace", "tab"], ["agent",
  { token = "$cache_warm",     fg = "#a6e3a1" },
  { token = "$cache_expiring", fg = "#f9e2af", bold = true },
  { token = "$cache_cold",     fg = "#f38ba8", bold = true }]]
```

Herdr styles a row token statically — one colour per token name — so one token
could only ever be one colour. The plugin reports the badge under a per-state
name and clears the other two, which is what buys green/yellow/red. Exactly one
is ever set.

**If you already customise `[ui.sidebar.agents]`, setup will not touch it.** It
prints the tokens instead: `herdr-cache-alert sidebar-snippet`. Until you add
them, the agent list shows no badge — the tab bar and the pane border still do.

`prefix+alt+c` shows or hides the agent-list badge. It governs these tokens,
which is the thing the agent list actually renders.

### If you see nothing at all

1. `herdr-cache-alert doctor` — is a watcher running?
2. Is `ui.hide_tab_bar_when_single_tab = true`? That removes the whole tab row.
3. Is the sidebar open? `prefix+b` toggles it.
4. `herdr-cache-alert status` — if that prints badges, the plugin is fine and only
   the surface is missing.

Herdr does **not** hot-reload `config.toml`. `setup` runs `herdr server reload-config`
for you; if you edit the config by hand, run it yourself or the entry sits inert.

There is deliberately no tab-label fallback: writing a countdown there means
renaming a tab every minute, which churns Herdr's event bus and makes the tab bar
twitch.

## Where the numbers come from

Cache lifetimes are vendor behaviour, not a standard. They change without warning, they differ
between a subscription and an API key, and half of what is written about them online is a guess.

So **no bare constant is allowed in this codebase.** Every cache number ships as a `Sourced<T>`: a
value, a confidence, a documentation link, the date it was last checked, and the sentence it came
from.

```ts
export interface Sourced<T> {
  value: T;
  confidence: "documented" | "reported" | "inferred" | "observed";
  source: {
    url: string;          // the exact page, never a search result
    title: string;
    publisher: string;
    retrievedAt: string;  // ISO date the claim was last checked
    quote?: string;       // verbatim from that page
    kind: "vendor-doc" | "vendor-blog" | "vendor-changelog" | "community" | "observed";
  };
  note?: string;
}
```

Read any of it back:

```bash
herdr-cache-alert rules            # every rule, with its source and quote
herdr-cache-alert explain          # why THIS pane says what it says
herdr-cache-alert claims --stale 180   # claims nobody has re-verified lately
```

`claims` exits non-zero when something is stale, so it can gate a release. A cache rule nobody has
re-read in six months is a number this plugin should stop asserting with a straight face.

### Measured beats documented

`confidence: "observed"` outranks everything else, and it is not a figure of speech. Claude Code's
transcript records which TTL each turn actually wrote to:

```
usage.cache_creation.ephemeral_1h_input_tokens: 2421
usage.cache_creation.ephemeral_5m_input_tokens: 0
```

That turn proves the session is on the one-hour TTL. No documented rule, tier guess or environment
sniff can outvote it.

### When unsure, be pessimistic

Tier detection can lie. `ANTHROPIC_API_KEY` being *set* does not mean it is *used* — an OAuth login
wins over it, and an `apiKeyHelper` supplies one without the variable existing at all. Worse, Herdr
exposes no per-pane environment, so what the plugin reads is *its own* environment, which is usually
the pane's but never provably so.

Every detection therefore carries its evidence and its confidence, and an unknown tier takes the
harness's **shortest** rule. A wrong early warning costs you a glance. A wrong "still warm" sends you
back to a cache that expired ten minutes ago.

## Supported harnesses

| harness | tier detection | countdown | cold detection |
| --- | --- | --- | --- |
| **Claude Code** | `~/.claude/.credentials.json`, `ANTHROPIC_*` | ✅ from the transcript | ✅ real token counts |
| **Codex CLI** | `~/.codex/auth.json` (`auth_mode`) | ✅ from the rollout log | ✅ `cached_input_tokens` |
| **opencode** | `auth.json` entry types | ✅ from the SQLite store | ✅ `tokens.cache.read` |
| **OpenRouter** | n/a — a gateway is always per-token | ❌ forced-only, no probe | ❌ |

Cold detection needs the harness to write cache token counts somewhere readable. Three of the four
do. An adapter that cannot read them counts down and stays quiet about warm-versus-cold rather than
guess, because a wrong `❄ COLD` is worse than no `❄ COLD`.

**The TTL is not always a property of the tier.** OpenAI runs two cache regimes at once, split by
model generation — 30 minutes on GPT-5.6 and later, 5-10 minutes idle before it. opencode is a
different upstream provider per session. Both are handled by `ttlForProbe`, which picks the rule from
what the probe actually found; the tier rule is the fallback for when that is not yet known, and it
always carries the shorter number.

**opencode needs Herdr's integration.** `herdr integration install opencode` is what reports the
session id this adapter reads. Without it there is no session to look up and the badge stays silent.

OpenRouter is never auto-selected: nothing calls itself "openrouter" in a pane, because an agent
reaches it through some other CLI. Force it when you know that is what you are on:

```bash
CACHE_ALERT_HARNESS=openrouter herdr-cache-alert explain
```

## Adding a harness

One file, one registry line. Export a `HarnessAdapter`:

```ts
export const myAdapter: HarnessAdapter = {
  id: "myagent",          // MUST equal the `agent` label Herdr reports for the pane
  label: "My Agent",
  rules: MY_RULES,        // sourced, or it does not ship
  detectTier,             // → { tier, confidence, evidence[] }
  ttlOverride,            // optional: a TTL the harness's own config forces
  ttlForProbe,            // optional: a TTL implied by the model/upstream the probe found
  probe,                  // → the last turn's timing and cache counts, or null
};
```

then add it to `ADAPTERS` in [`src/harness/index.ts`](./src/harness/index.ts).

Four things worth knowing before you write one:

- **There is no `matches(pane)` hook.** Herdr already labels the pane's agent, and the registry is a
  map from that label onto an adapter. Self-matching would eventually let two adapters claim one
  pane, and the loser would be whichever was registered second.
- **`probe` returning `null` is a normal answer** — a fresh session, a harness with nothing to read,
  a pane adopted mid-flight. Never guess there. The engine paints nothing rather than paint a
  fiction.
- **Persist through the store you are handed**, not your own dotfile. It is keyed by
  `<adapter>:<session-id>` and ages entries out after a day.
- **Report no cache counts rather than zeros** when your harness logs none. A `0` reads downstream as
  "cold", which is a lie the badge would then paint.

[`src/harness/openrouter.ts`](./src/harness/openrouter.ts) is the minimal worked example: rules and a
tier detector, no telemetry at all. That combination is legal, and it still earns a countdown.

## CLI

```
herdr-cache-alert status [--pane ID]     what every agent pane's cache is doing
herdr-cache-alert explain [--pane ID]    where a pane's number comes from, claim by claim
herdr-cache-alert rules [--json]         every cache rule, with sources
herdr-cache-alert claims [--stale DAYS]  claims nobody has re-verified lately
herdr-cache-alert tabbar                 one line for the tab bar (what Herdr calls on its interval)
herdr-cache-alert tabbar-snippet         the ui.tab_bar_right entry that drives the countdown
herdr-cache-alert sidebar-snippet        the [ui.sidebar.agents] rows that colour the badge
herdr-cache-alert toggle [on|off]        the display-name fallback badge (prefix+alt+c)
herdr-cache-alert sync                   paint every pane once
herdr-cache-alert watch [--force|stop|status]
herdr-cache-alert clear                  remove every badge and tab mark
herdr-cache-alert setup [--no-keys]
herdr-cache-alert update [--major]
herdr-cache-alert doctor                 resolved paths and detection state
```

## Config

`~/.config/herdr/plugins/config/herdr.cache-alert/config.json`, all keys optional:

| key | default | effect |
| --- | --- | --- |
| `quietWhileWarm` | `false` | show nothing until the cache is in trouble |
| `notifyOnCold` | `false` | raise a Herdr notification on an observed miss |
| `claimStaleDays` | `180` | how old a claim may get before `claims` complains |
| `forceHarness` | `""` | pin an adapter instead of detecting one |
| `forceTier` | `""` | pin `subscription` or `api` instead of detecting one |
| `pollMs` | `5000` | reserved for adapters that poll |
| `warnSeconds` | `300` | reserved; the badge uses 25% of the rule's TTL, min 60s |

`CACHE_ALERT_HARNESS`, `CACHE_ALERT_TIER` and `CACHE_ALERT_QUIET=1` override the file for one
invocation.

`notifyOnCold` is **off** by default on purpose: ten panes going cold while you were at lunch is a
notification storm, not a warning.

## The watcher

`setup` starts one background process per machine. It is what makes the countdown a countdown.

**Every 30 seconds** it lists the agent panes, probes each one's harness log, recomputes the state,
and repaints. A full tick over 11 panes measured **0.08s** — one seek of 128 KB per pane and one
socket round trip. It re-reads `config.json` each tick, so a config edit takes effect without a
restart.

```bash
herdr-cache-alert watch status     # running? which pid?
herdr-cache-alert watch stop       # stop it
herdr-cache-alert watch            # start it in the foreground
herdr-cache-alert doctor           # says loudly when no watcher is running
```

### Two things refresh the badge, not one

| trigger | when it fires | what it covers |
| --- | --- | --- |
| the watcher | every 30s, unconditionally | the clock ticking down while nothing happens |
| Herdr events | agent detected, agent status changed, pane created/closed/moved | the moment a turn ends and the warm/cold verdict changes |

**This means a dead watcher is invisible on a busy pane.** Events keep repainting it, so the badge
looks healthy while every idle pane quietly goes blank. `doctor` is how you catch that — it reports
`NO WATCHER RUNNING` in a notification rather than burying it in the log.

### So what happens if you walk away?

Nothing stops. The watcher keeps ticking, so the countdown keeps descending — `⚡ 12m left`, then
`⚠ 4m left`, then `❄ COLD` the moment the TTL elapses. **What you see when you come back is
accurate**, and the number is never more than 30 seconds stale. Since the badge is denominated in
minutes, that is invisible.

Come back after an hour on a subscription session and it will read `❄ COLD`, because it is. The
first message you send then rebuilds the whole prefix at full input price — and the turn after that
confirms it, because the Claude adapter reads the real token counts and reports the miss it
measured rather than the one it predicted.

### If the watcher dies, or the machine sleeps

Badges do not freeze at a stale number. Every paint carries `--ttl-ms` of two ticks, so a badge that
stops being re-reported is dropped by Herdr about 60 seconds later. Verified: a metadata token
written with `--ttl-ms 5000` was gone 20 seconds later.

That is the intended failure mode — **blank rather than wrong**. On a suspended laptop the whole
plugin freezes with everything else, the badges clear, and the first tick after resume recomputes
from real timestamps and paints the truth. There is no window in which an old number is presented
as current.

## How it works

```
herdr pane list ──> adapter registry ──> detectTier ──> rule
                          │                              │
                          └── probe (harness's own log) ──┤
                                                          ▼
                                    ttl = observed ?? remembered ?? override ?? rule
                                                          ▼
                              expiresAt = lastRequestAt + ttl   ──>  badge
```

**The countdown cannot be event-driven.** Herdr's events fire when something *happens*, and the
entire point of this plugin is the stretch when nothing is happening — an idle pane sliding toward
expiry emits no events at all. An event-only badge would freeze at `⚡ 40m` and still say it an hour
later. Hence the watcher.

The watcher is bounded on both sides: every paint carries `--ttl-ms` of about two ticks, so if the
watcher dies its badges clear themselves within a tick instead of lying indefinitely. Every paint
also carries a monotonic `--seq`, so a slow tick cannot overwrite a newer one.

Every paint writes both surfaces, even when the string is unchanged. That is not wasted work:
`--ttl-ms` means a badge that stops being re-reported expires, and `❄ COLD` never changes by
definition — so skipping it made the one state worth showing the one that reliably vanished.

Probes seek. A `~/.claude/projects` directory on the development machine measured 3.7 GB, so each
probe reads the last 128 KB of one file and walks backwards to the newest turn.

## Development

```bash
bun install
bun run test                       # 75 tests on node:test, then the CLI under both runtimes
bun run lint                       # oxlint + the vendored anti-slop rules, --max-warnings 0
bun x tsc --noEmit                 # strict, noUncheckedIndexedAccess, erasableSyntaxOnly
./scripts/check-version.sh         # SemVer consistency across manifest, package.json, CHANGELOG
herdr plugin link "$PWD"           # re-run after ANY manifest change
```

The suite runs on Node's built-in runner, so it adds no dependency and there is still no build
step. `scripts/test.sh` points the state and config directories at a throwaway sandbox — without
that a test writes your real `state.json` and lands on a live pane's countdown.

It covers the seams that have already shipped a bug: the precedence ladder, the cold mark's
stickiness, the badge vocabulary, the six sidebar token names, the event payload's spelling, and
the update planner. It also walks every cache rule the plugin ships and fails if a `documented`
claim carries no verbatim quote, or a `retrievedAt` will not parse. None of it can prove a badge
appeared on screen — for that, still watch a live session.

Both runtimes are supported and both must keep working:

```bash
CACHE_ALERT_RUNTIME=node ./bin/herdr-cache-alert status
CACHE_ALERT_RUNTIME=bun  ./bin/herdr-cache-alert status
```

See [CLAUDE.md](./CLAUDE.md) for the working agreement, including the versioning rules and the
Herdr API gotchas worth not relearning.

## License

MIT © Altan Sarisin
