/**
 * `setup` — make the plugin usable in one command, and be safe to re-run.
 *
 * Nine steps, every one idempotent: link the plugin into every running Herdr
 * server, put the CLI on PATH, add the one keybinding, style the sidebar, add
 * the tab-bar countdown, turn the agent-list badge on, start this session's
 * watcher, check that Herdr's agent hooks are installed, and paint once so the
 * operator sees a result rather than a blank sidebar.
 *
 * THE CONFIG STEPS ARE THE DANGEROUS ONES, and none of them writes directly:
 * every one goes through `config-toml.ts`, which wraps our text in markers,
 * validates the change on a THROWAWAY copy before the operator's file is
 * touched, and reloads every server afterwards. What that buys is `uninstall` —
 * the markers say exactly which bytes are ours, so removing them is not a guess.
 *
 * Anything the operator wrote themselves is REPORTED, never rewritten.
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { BIN, PLUGIN_ID, pluginRoot } from "./config.ts";
import { allStateTokens, herdrBin } from "./herdr.ts";
import {
  BLOCKS,
  configPath,
  onEveryServer,
  readBlock,
  stripLegacyBlocks,
  upsertBlock,
  writeConfig,
  type Step,
} from "./config-toml.ts";
import { errorMessage, runSafe } from "./runtime.ts";
import { agentListEnabled, setAgentList } from "./store.ts";
import { syncAll } from "./sync.ts";
import { BADGE_TTL_MS, runningWatcher } from "./watch.ts";

export { PLUGIN_ID, pluginRoot };
export type { Step };

/**
 * The one chord. Checked against Herdr 0.8.2's defaults, which use no `alt` at
 * all — `prefix+c` is new-tab, but `prefix+alt+c` is unclaimed.
 *
 * Herdr binds ONE chord after the prefix; multi-step sequences are rejected by
 * the parser outright. Don't "improve" this into `prefix+c+a`.
 */
export const TOGGLE_KEY = "prefix+alt+c";

const KEY_BODY = `[[keys.command]]
key = "${TOGGLE_KEY}"
type = "plugin_action"
command = "${PLUGIN_ID}.toggle"
description = "Toggle the cache badge in the agent list"`;

/** The config this file reads, so a caller can report it without importing two modules. */
export { configPath };

/**
 * Was this checkout put here by `herdr plugin install <owner>/<repo>`?
 *
 * That form unpacks into `<herdr config dir>/plugins/github/<id>-<hash>/` and
 * registers the plugin in an ON-DISK registry that every server reads, including
 * the ones `herdr --session` starts later. Linking it again is not merely
 * redundant, it registers a SECOND copy of the same plugin id.
 *
 * A plain `git clone` anywhere else still needs the per-server link.
 */
export function isGithubInstall(root: string, herdrConfigDir: string): boolean {
  return `${resolve(root)}${sep}`.startsWith(`${join(herdrConfigDir, "plugins", "github")}${sep}`);
}

/** The directory holding `config.toml`, which is also where installed plugins live. */
function herdrDir(): string {
  return dirname(configPath());
}

/**
 * Links the plugin into EVERY running Herdr server.
 *
 * `herdr --session <name>` is a whole separate server with its own plugin
 * registry, so a link into one leaves the others with no panes, actions or
 * event hooks at all.
 */
async function linkPlugin(root: string): Promise<Step> {
  if (isGithubInstall(root, herdrDir())) {
    return { ok: true, what: "plugin", detail: "installed from GitHub, nothing to link" };
  }
  const res = await onEveryServer(["plugin", "link", root]);
  if (res.done === 0) {
    return { ok: false, what: "plugin", detail: "could not link. Is a Herdr server running?" };
  }
  const where = res.failed.length > 0 ? ` (${res.failed.join(", ")} did not answer, probably not running)` : "";
  return { ok: true, what: "plugin", detail: `linked into ${res.done} session(s) from ${root}${where}` };
}

function installCli(root: string): Step {
  const target = join(root, "bin", BIN);
  const dir = join(homedir(), ".local", "bin");
  const link = join(dir, BIN);
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
      // Only ever replace a symlink, and only one of ours. A real file with
      // this name belongs to someone else and is left strictly alone.
      if (!lstatSync(link).isSymbolicLink()) {
        return { ok: false, what: "cli", detail: `${link} exists and is not a symlink, left untouched` };
      }
      if (readlinkSync(link) === target) return { ok: true, what: "cli", detail: `${link} already points here` };
      unlinkSync(link);
    }
    symlinkSync(target, link);
  } catch (err) {
    return { ok: false, what: "cli", detail: `could not install ${link}: ${errorMessage(err)}` };
  }
  const onPath = (process.env.PATH ?? "").split(":").includes(dir);
  return {
    ok: true,
    what: "cli",
    detail: onPath ? `installed ${link}` : `installed ${link}. Add ${dir} to your PATH to use it by name.`,
  };
}

/**
 * Starts the watcher detached, so it outlives the shell or the action that ran
 * setup. Without it the badge would only repaint on Herdr events, which is
 * exactly when a countdown does not need repainting.
 */

/**
 * Starts the watcher detached, so it outlives the shell or the action that ran
 * setup. Without it the badge would only repaint on Herdr events, which is
 * exactly when a countdown does not need repainting.
 */
async function startWatcher(root: string): Promise<Step> {
  const running = runningWatcher();
  if (running !== null) return { ok: true, what: "watcher", detail: `already running (pid ${running})`, skipped: true };
  const { spawn } = await import("node:child_process");
  const child = spawn("bash", [join(root, "scripts", "run.sh"), "cli", "watch"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { ok: true, what: "watcher", detail: `started (pid ${child.pid}), ticks every 30s` };
}

export const SIDEBAR_BLOCK = `
# cache-alert: show the prompt-cache countdown beside each agent, coloured by
# state. Exactly one of these three tokens is ever set, so only one renders.
#
# SIX tokens, not three: the same three states, twice. Herdr draws the ACTIVE row
# on active_row_bg, which on a dark theme is a LIGHT grey — measured #d2d3da here
# against #23273a for its neighbours. A style is fixed per token NAME, so one
# colour cannot serve both backgrounds; the best possible compromise is about
# 3.1:1 on each, which is unreadable-ish on both. Reporting a different NAME for
# the focused pane is what buys 4.8:1 or better everywhere.
#
# Bright colours for the dark rows, dark colours for the light active row.
# Exactly one of the six is ever set.
#
# fg must be #RGB or #RRGGBB. Named theme colours are rejected by the parser,
# and so is any key it does not know, so this line cannot drift silently.
[ui.sidebar.agents]
rows = [["state_icon", "workspace", "tab"], ["agent", { token = "$cache_warm", fg = "#a6e3a1", bold = true }, { token = "$cache_expiring", fg = "#f9e2af", bold = true }, { token = "$cache_cold", fg = "#f38ba8", bold = true }, { token = "$cache_warm_focus", fg = "#166534", bold = true }, { token = "$cache_expiring_focus", fg = "#92400e", bold = true }, { token = "$cache_cold_focus", fg = "#991b1b", bold = true }]]
`;

/** The `[ui.sidebar.agents]` body, without the explanatory comment header. */
const SIDEBAR_BODY = SIDEBAR_BLOCK.trim();

/** The tab-bar entry, as TOML. `root` is the checkout, so the path is absolute. */
export function tabBarEntry(root: string): string {
  // interval_seconds 5, not 1: the badge is denominated in minutes and the
  // watcher only republishes every 30s, so a faster poll buys nothing and spends
  // a process spawn doing it. timeout_seconds guards against a wedged socket —
  // Herdr clears the entry on timeout, which is the failure mode we want.
  return `{ type = "command", command = "${join(root, "bin", BIN)} tabbar", interval_seconds = 5, timeout_seconds = 3 }`;
}

/** The config as it is on disk, with any unmarked block from an older release removed. */
function currentConfig(): string {
  return stripLegacyBlocks(readFileSync(configPath(), "utf8"));
}

function missingConfig(what: string): Step {
  return { ok: false, what, detail: `${configPath()} does not exist. Start Herdr once, then re-run setup.` };
}

/**
 * Adds the toggle keybinding, or explains why it did not.
 *
 * A chord already bound OUTSIDE our markers belongs to the operator. Taking it
 * would silently steal a key they chose, so this reports and changes nothing.
 */
async function installKeybinding(): Promise<Step> {
  if (!existsSync(configPath())) return missingConfig("keybinding");
  const text = currentConfig();
  const chord = new RegExp(`key\\s*=\\s*"${TOGGLE_KEY.replace(/\+/g, "\\+")}"`);
  const outside = text.replace(readBlock(text, BLOCKS.keys) ?? "", "");
  if (chord.test(outside)) {
    return {
      ok: true,
      what: "keybinding",
      detail: `${TOGGLE_KEY} is already bound to something else, left alone. Bind \`${PLUGIN_ID}.toggle\` to a chord you prefer.`,
    };
  }
  return writeConfig(upsertBlock(text, BLOCKS.keys, KEY_BODY, "eof"), "keybinding", `${TOGGLE_KEY} toggles the agent-list badge`);
}

/**
 * Styles the sidebar tokens.
 *
 * A `[ui.sidebar.agents]` the operator wrote themselves is a display preference
 * somebody chose deliberately, so it is left alone with the snippet to paste.
 * Ours is rewritten in place, which is how a token added in a later release
 * reaches an install that already had the older set.
 */
async function installSidebar(): Promise<Step> {
  if (!existsSync(configPath())) return missingConfig("sidebar");
  const text = currentConfig();
  const outside = text.replace(readBlock(text, BLOCKS.sidebar) ?? "", "");
  if (/^\s*\[ui\.sidebar\.agents\]/m.test(outside)) {
    return {
      ok: true,
      what: "sidebar",
      detail: "you already customise [ui.sidebar.agents], left alone. Run `herdr-cache-alert sidebar-snippet` and paste the tokens into your own rows.",
    };
  }
  return writeConfig(
    upsertBlock(text, BLOCKS.sidebar, SIDEBAR_BODY, "eof"),
    "sidebar",
    "cache tokens styled in the agent sidebar",
  );
}

/**
 * Adds the tab-bar countdown — the surface that works on a pane alone in its tab.
 *
 * Two traps here, both load-bearing. `tab_bar_right` belongs to `[ui]`, and a key
 * appended at the END of the file lands in whatever table happens to be last —
 * which, once `[ui.sidebar.agents]` exists, is not `[ui]`. And the entry holds an
 * ABSOLUTE path, so it rots the moment the checkout moves: the command fails, the
 * entry clears itself (empty output clears it, by contract), and the tab bar goes
 * blank with nothing reporting an error. `upsertBlock` rewrites our own entry, so
 * a re-run after a move repoints it.
 */
async function installTabBar(root: string): Promise<Step> {
  if (!existsSync(configPath())) return missingConfig("tab bar");
  const text = currentConfig();
  const outside = text.replace(readBlock(text, BLOCKS.tabbar) ?? "", "");
  if (/^\s*tab_bar_right\s*=/m.test(outside)) {
    return {
      ok: true,
      what: "tab bar",
      detail: "you already set tab_bar_right, left alone. Run `herdr-cache-alert tabbar-snippet` and add the entry to your list.",
    };
  }
  const body = `tab_bar_right = [${tabBarEntry(root)}]`;
  const had = readBlock(text, BLOCKS.tabbar);
  const detail = had !== null && !had.includes(tabBarEntry(root)) ? "repointed the countdown at this checkout" : "countdown added to the tab bar";
  return writeConfig(upsertBlock(text, BLOCKS.tabbar, body, { after: /^\[ui\]\s*$/m, orCreate: "[ui]" }), "tab bar", detail);
}

/**
 * Herdr's agent hooks, which are what give a pane a SESSION ID.
 *
 * Without the hook Herdr still detects that a pane runs Claude, but
 * `pane.agent_session.value` is empty — so every probe here has nothing to open,
 * every pane reads as unknown, and the plugin paints nothing at all. No error is
 * raised anywhere, by us or by Herdr, so this step is the only place it shows.
 */
export type IntegrationState = "current" | "outdated" | "not installed";

/** Where each harness keeps its own directory. Only a harness that is here is worth reporting. */
const HARNESS_HOMES = {
  claude: [[".claude"]],
  codex: [[".codex"]],
  opencode: [[".config", "opencode"], [".local", "share", "opencode"]],
} satisfies Record<string, string[][]>;

/** How to name the harness in a sentence the operator reads. */
const HARNESS_LABEL = new Map([
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["opencode", "opencode"],
]);

/**
 * Reads `herdr integration status`, which prints one line per known harness:
 *
 *   claude: current (v8) (/home/x/.claude/hooks/herdr-agent-state.sh)
 *   codex: outdated (v4 < v8) (/home/x/.codex/herdr-agent-state.sh)
 *   opencode: not installed (/home/x/.config/opencode/plugins/herdr-agent-state.js)
 *
 * There is no `--json`, so this parses the text. Unknown line shapes are skipped
 * rather than guessed at: Herdr adds harnesses release by release.
 */
export function parseIntegrationStatus(text: string): Map<string, IntegrationState> {
  const states = new Map<string, IntegrationState>();
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z][\w-]*): (not installed|outdated|current)\b/.exec(line.trim());
    if (!match) continue;
    const state = match[2];
    // Compared rather than asserted: the alternation above is not visible in the
    // type, and an assertion here would also swallow a future fourth state.
    if (state === "current" || state === "outdated" || state === "not installed") states.set(match[1]!, state);
  }
  return states;
}

/** The harnesses actually installed on this machine, in a stable order. */
export function installedHarnesses(home = homedir()): string[] {
  return Object.entries(HARNESS_HOMES)
    .filter(([, dirs]) => dirs.some((parts) => existsSync(join(home, ...parts))))
    .map(([id]) => id);
}

/** The remedy line for a harness with NO hook, which is the whole point of reporting the state. */
export function integrationRemedy(id: string): string {
  const label = HARNESS_LABEL.get(id) ?? id;
  return `${id}: run \`herdr integration install ${id}\`, then restart ${label}. Without the hook a pane has no session id and shows nothing.`;
}

/**
 * The hint for hooks that are merely BEHIND, which is not a failure.
 *
 * An outdated hook still reports the session id, so the badge keeps working:
 * this machine ran the v4 Claude hook for weeks and painted the whole time.
 * Marking it `!` would make a healthy install exit 1 and send the operator
 * looking for a badge that is already on screen.
 */
export function outdatedHint(ids: readonly string[]): string {
  const commands = ids.map((id) => `\`herdr integration install ${id}\``).join(" and ");
  const many = ids.length > 1;
  return `${ids.join(", ")} hook${many ? "s" : ""} outdated, ${commands} update${many ? " them" : "s it"}`;
}

/** What `doctor` prints. Every known harness, with `unknown` when the command did not answer. */
export async function integrationStates(): Promise<Record<string, string>> {
  const res = await runSafe([herdrBin()], ["integration", "status"]);
  const states = parseIntegrationStatus(res.stdout);
  return Object.fromEntries(Object.keys(HARNESS_HOMES).map((id) => [id, states.get(id) ?? "unknown"]));
}

/**
 * Runs BEFORE the paint step, so "painted 0 of 2" has its reason printed above it.
 */
async function checkIntegrations(): Promise<Step> {
  const present = installedHarnesses();
  if (present.length === 0) {
    return { ok: true, what: "integrations", detail: "no supported agent harness on this machine yet", skipped: true };
  }
  const res = await runSafe([herdrBin()], ["integration", "status"]);
  const states = parseIntegrationStatus(res.stdout);
  if (states.size === 0) {
    return {
      ok: true,
      what: "integrations",
      detail: "could not run `herdr integration status`. Run it by hand to check the agent hooks.",
      skipped: true,
    };
  }
  const missing = present.filter((id) => states.get(id) === "not installed");
  const outdated = present.filter((id) => states.get(id) === "outdated");
  if (missing.length > 0) {
    // The missing hooks are the ones that need the operator; an outdated hook
    // still paints, so its hint is folded onto the same line rather than
    // raising a second `!`.
    const hint = outdated.length > 0 ? `; ${outdatedHint(outdated)}` : "";
    return { ok: false, what: "integrations", detail: `${missing.map(integrationRemedy).join("; ")}${hint}` };
  }
  if (outdated.length > 0) {
    return { ok: true, what: "integrations", detail: outdatedHint(outdated), skipped: true };
  }
  const current = present.filter((id) => states.get(id) === "current");
  if (current.length === 0) {
    return { ok: true, what: "integrations", detail: "no agent hook status reported for this machine", skipped: true };
  }
  return { ok: true, what: "integrations", detail: `${current.join(", ")} hook${current.length > 1 ? "s" : ""} current` };
}

/**
 * The last step, and it is not optional: setup must LEAVE A BADGE ON SCREEN.
 *
 * Nothing else here paints. `startWatcher` stands down when one is already
 * running, and a watcher that is running only ticks every 30s — so on a quiet
 * pane, `setup` used to finish with the sidebar still blank, and stay blank for
 * up to half a minute. The operator reads that as "it did not work" and reaches
 * for the toggle: the first press paints the badge OFF (still nothing), the
 * second paints it ON, and the badge finally appears. That is the "press
 * prefix+alt+c twice" bug — the switch was right all along, nobody had painted.
 *
 * Failures here are reported, never thrown: the install itself succeeded, and
 * the next tick will paint anyway.
 */
async function paintNow(): Promise<Step> {
  try {
    const painted = await syncAll(BADGE_TTL_MS);
    const shown = painted.filter((p) => p.badge !== null).length;
    return {
      ok: true,
      what: "badges",
      detail: shown > 0 ? `painted ${shown} of ${painted.length} agent panes` : "no agent pane has a cache yet. Badges appear after the first turn.",
    };
  } catch (cause) {
    return { ok: false, what: "badges", detail: `could not paint yet (${errorMessage(cause)}). The watcher paints within 30s.` };
  }
}

/**
 * What the operator's config actually styles, against what this version paints.
 *
 * The token names are a PUBLIC INTERFACE, and an unusual one: a copy of them
 * lives in the operator's `config.toml` and another in the memory of every
 * running server. The sidebar renders a token only if the rows it has loaded
 * name it, so painting a name the config does not carry paints NOTHING — and
 * the paint still succeeds, so nothing anywhere reports an error. That is
 * exactly how the 0.3.0 `_focus` tokens went missing on a server that had not
 * reloaded.
 *
 * Hence: add token names, never rename or remove them, and let `doctor` say
 * when a config has fallen behind.
 */

export interface SidebarTokenReport {
  /** Every `$name` the operator's rows line styles. */
  configured: string[];
  /** Painted by this version but not styled: renders as nothing at all. */
  missing: string[];
  /** Styled but never painted: harmless, but the config line is stale. */
  unstyled: string[];
}

export function sidebarTokenReport(): SidebarTokenReport {
  const painted = allStateTokens();
  if (!existsSync(configPath())) return { configured: [], missing: painted, unstyled: [] };
  const rows = readFileSync(configPath(), "utf8")
    .split("\n")
    .find((line) => line.trimStart().startsWith("rows = ") && line.includes("$cache_"));
  const configured = rows ? [...rows.matchAll(/\$([A-Za-z0-9_]+)/g)].map((m) => m[1] ?? "") : [];
  return {
    configured,
    missing: painted.filter((name) => !configured.includes(name)),
    unstyled: configured.filter((name) => name.startsWith("cache") && !painted.includes(name)),
  };
}

export interface SetupOptions {
  /** Leave `config.toml` strictly alone — no keybinding, no sidebar rows, no tab bar. */
  noKeys?: boolean;
}

export async function setup(options: SetupOptions = {}): Promise<Step[]> {
  const root = pluginRoot();
  const steps = [await linkPlugin(root), installCli(root)];
  if (options.noKeys) {
    steps.push({ ok: true, what: "config", detail: `skipped (--no-keys), nothing written to ${configPath()}`, skipped: true });
  } else {
    const keys = await installKeybinding();
    const sidebar = await installSidebar();
    const tabbar = await installTabBar(root);
    steps.push(keys, sidebar, tabbar);
    // The agent-list badge IS the `$cache_*` tokens, so the switch is only worth
    // turning on when those tokens are actually in the operator's sidebar rows.
    // Turning it on without them would toggle something nothing renders.
    const tokensLive = sidebar.ok && !sidebar.detail.startsWith("you already customise");
    const changed = agentListEnabled() !== tokensLive;
    setAgentList(tokensLive);
    steps.push({
      ok: true,
      what: "agent list",
      detail: tokensLive
        ? "coloured badge ON, prefix+alt+c hides it"
        : "no badge: add the $cache tokens to ui.sidebar.agents.rows first, or the toggle has nothing to show",
      skipped: !changed,
    });
  }
  steps.push(await startWatcher(root));
  // Before the paint, never after: without an agent hook nothing has a session
  // id, and "painted 0 of 2" then reads as a bug in the badge rather than a
  // missing hook.
  steps.push(await checkIntegrations());
  steps.push(await paintNow());
  return steps;
}
