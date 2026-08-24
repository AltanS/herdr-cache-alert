/**
 * `setup` — make the plugin usable in one command, and be safe to re-run.
 *
 * Five steps, all idempotent: link the plugin, put the CLI on PATH, add the one
 * keybinding, start the watcher, and paint the badges once so the operator sees
 * a result rather than a blank sidebar.
 *
 * The keybinding is the only thing here that touches a file the operator owns,
 * so it is the only step that is defensive about it: it refuses a chord already
 * in use, keeps a backup, validates with `herdr config check` BEFORE the config
 * is left in place, and restores the backup if that check fails. `--no-keys`
 * skips it entirely.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, lstatSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BIN, PLUGIN_ID, pluginRoot } from "./config.ts";
import { allStateTokens, herdrBin } from "./herdr.ts";
import { runSafe, errorMessage } from "./runtime.ts";
import { setAgentList } from "./store.ts";
import { syncAll } from "./sync.ts";
import { BADGE_TTL_MS, runningWatcher } from "./watch.ts";

/**
 * The one chord. Checked against Herdr 0.8.2's defaults, which use no `alt` at
 * all — `prefix+c` is new-tab, but `prefix+alt+c` is unclaimed.
 *
 * Herdr binds ONE chord after the prefix; multi-step sequences are rejected by
 * the parser outright. Don't "improve" this into `prefix+c+a`.
 */
export const TOGGLE_KEY = "prefix+alt+c";

const CONFIG_PATH =
  process.env.HERDR_CONFIG_PATH || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr", "config.toml");

const KEY_BLOCK = `
# cache-alert: mirror the cache badge into the agent list (the pane border
# always shows it; this is the second, opt-in sighting).
[[keys.command]]
key = "${TOGGLE_KEY}"
type = "plugin_action"
command = "${PLUGIN_ID}.toggle"
description = "Toggle the cache badge in the agent list"
`;

export { PLUGIN_ID };

export interface Step {
  ok: boolean;
  what: string;
  detail: string;
}

/**
 * The checkout this file lives in. `HERDR_PLUGIN_ROOT` is injected for plugin
 * commands; the CLI runs in a plain shell and has to work it out from `import.meta`.
 */
export { pluginRoot };

async function linkPlugin(root: string): Promise<Step> {
  // Every session is a separate server with its own plugin registry, so a link
  // into one leaves the others with no panes, actions or event hooks at all.
  const res = await onEveryServer(["plugin", "link", root]);
  if (res.done === 0) {
    return { ok: false, what: "plugin", detail: "could not link — is a Herdr server running?" };
  }
  // "did not answer", not "refused": the usual cause is a socket file left behind
  // by a server that is gone, and telling the operator to re-run there sends them
  // after a session that does not exist.
  const where = res.failed.length > 0 ? ` (${res.failed.join(", ")} did not answer — probably not running)` : "";
  return { ok: true, what: "plugin", detail: `linked ${PLUGIN_ID} into ${res.done} session(s) from ${root}${where}` };
}

/** Symlinks `bin/herdr-cache-alert` into ~/.local/bin, replacing our own old link. */
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
        return { ok: false, what: "cli", detail: `${link} exists and is not a symlink — left untouched` };
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
    detail: onPath ? `installed ${link}` : `installed ${link} — add ${dir} to your PATH to use it by name`,
  };
}

/**
 * Starts the watcher detached, so it outlives the shell or the action that ran
 * setup. Without it the badge would only repaint on Herdr events, which is
 * exactly when a countdown does not need repainting.
 */
async function startWatcher(root: string): Promise<Step> {
  const running = runningWatcher();
  if (running !== null) return { ok: true, what: "watcher", detail: `already running (pid ${running})` };
  const { spawn } = await import("node:child_process");
  const child = spawn("bash", [join(root, "scripts", "run.sh"), "cli", "watch"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { ok: true, what: "watcher", detail: `started (pid ${child.pid}) — ticks every 30s` };
}

/**
 * Adds the toggle keybinding to `config.toml`, or explains why it did not.
 *
 * The order matters and is the whole point: write, THEN validate, THEN keep —
 * restoring the backup if the validation fails. A config Herdr refuses to parse
 * costs the operator every binding they have, not just ours.
 */
async function installKeybinding(): Promise<Step> {
  if (!existsSync(CONFIG_PATH)) {
    return { ok: false, what: "keybinding", detail: `${CONFIG_PATH} does not exist — start Herdr once, then re-run setup` };
  }
  const before = readFileSync(CONFIG_PATH, "utf8");

  // Already ours: nothing to do. Already SOMEONE's: never take a chord the
  // operator has assigned, and say so rather than fail silently.
  if (before.includes(`${PLUGIN_ID}.toggle`)) {
    return { ok: true, what: "keybinding", detail: `${TOGGLE_KEY} is already bound to the toggle` };
  }
  if (new RegExp(`key\\s*=\\s*"${TOGGLE_KEY.replace(/\+/g, "\\+")}"`).test(before)) {
    return {
      ok: true,
      what: "keybinding",
      detail: `${TOGGLE_KEY} is already bound to something else — left alone. Bind \`${PLUGIN_ID}.toggle\` to a chord you prefer.`,
    };
  }

  const backup = `${CONFIG_PATH}.cache-alert-backup`;
  try {
    copyFileSync(CONFIG_PATH, backup);
    writeFileSync(CONFIG_PATH, before + KEY_BLOCK);
  } catch (err) {
    return { ok: false, what: "keybinding", detail: `could not write ${CONFIG_PATH}: ${errorMessage(err)}` };
  }

  const check = await runSafe([herdrBin()], ["config", "check"]);
  if (check.code !== 0) {
    writeFileSync(CONFIG_PATH, before);
    return {
      ok: false,
      what: "keybinding",
      detail: `${TOGGLE_KEY} did not validate — your config was restored untouched (${check.stdout.trim() || check.stderr.trim()})`,
    };
  }

  // Reload, so the key works now rather than after the operator's next restart.
  const reload = await runSafe([herdrBin()], ["server", "reload-config"]);
  const note = reload.code === 0 ? "" : " — run `herdr server reload-config` to activate it";
  return { ok: true, what: "keybinding", detail: `${TOGGLE_KEY} bound (backup at ${backup})${note}` };
}

/**
 * The sidebar block, which is what gives the badge COLOUR.
 *
 * Herdr styles a row token statically — one `fg` per token name — so one token
 * could only ever be one colour. Three state tokens, of which exactly one is
 * ever set, is what buys green/yellow/red.
 */
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

/** The `rows = ...` line inside SIDEBAR_BLOCK. Derived, so the two cannot drift. */
const ROWS_LINE = SIDEBAR_BLOCK.split("\n").find((line) => line.startsWith("rows = ")) ?? "";

/**
 * Reloads EVERY running Herdr server, and reports the ones that refused.
 *
 * `herdr --session <name>` is a whole separate server with its own socket and
 * its own copy of the config in memory. Reloading only the socket this shell
 * happens to point at leaves every other session running the OLD sidebar rows —
 * and the sidebar renders a `$cache_*` token only if the rows it has loaded
 * name it. So a session that missed the reload paints nothing on the row it was
 * asked to paint, forever, no matter how often the watcher repaints. Same trap
 * as the per-session watcher, one layer down.
 *
 * The result used to be discarded, which made a failed reload indistinguishable
 * from a successful one — the operator was told the feature was installed and
 * then saw nothing.
 */
function runningSockets(): Array<{ sock: string; name: string }> {
  const dir = join(homedir(), ".config", "herdr");
  const out: Array<{ sock: string; name: string }> = [];
  const def = join(dir, "herdr.sock");
  if (existsSync(def)) out.push({ sock: def, name: "default" });
  const sessions = join(dir, "sessions");
  if (existsSync(sessions)) {
    for (const name of readdirSync(sessions)) {
      const sock = join(sessions, name, "herdr.sock");
      if (existsSync(sock)) out.push({ sock, name });
    }
  }
  return out;
}

/**
 * Runs one `herdr` command against every server, and names the ones that
 * refused. `ok` is false only when NOTHING succeeded — a session whose socket
 * is stale on disk must not fail an otherwise good install.
 */
async function onEveryServer(args: string[]): Promise<{ done: number; failed: string[] }> {
  let done = 0;
  const failed: string[] = [];
  for (const { sock, name } of runningSockets()) {
    const res = await runSafe([herdrBin()], args, { HERDR_SOCKET_PATH: sock });
    if (res.code === 0) done += 1;
    else failed.push(name);
  }
  return { done, failed };
}

/**
 * Writes `content` to the config, keeping a backup and validating before leaving
 * it in place. The order is the whole point: write, THEN validate, THEN keep —
 * restoring the backup if it fails. A config Herdr refuses to parse costs the
 * operator every setting they have, not just ours.
 */
async function writeConfig(content: string, what: string, detail: string): Promise<Step> {
  const before = readFileSync(CONFIG_PATH, "utf8");
  try {
    copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.cache-alert-backup`);
    writeFileSync(CONFIG_PATH, content);
  } catch (err) {
    return { ok: false, what, detail: `could not write ${CONFIG_PATH}: ${errorMessage(err)}` };
  }
  const check = await runSafe([herdrBin()], ["config", "check"]);
  if (check.code !== 0) {
    writeFileSync(CONFIG_PATH, before);
    return {
      ok: false,
      what,
      detail: `did not validate — your config was restored untouched (${check.stdout.trim() || check.stderr.trim()})`,
    };
  }
  // Herdr does not hot-reload config.toml; without this the change sits inert.
  const reload = await onEveryServer(["server", "reload-config"]);
  if (reload.done === 0) {
    return { ok: false, what, detail: `${detail} — but no Herdr server accepted the reload, so it is not live yet. Run \`herdr server reload-config\`.` };
  }
  if (reload.failed.length > 0) {
    return { ok: true, what, detail: `${detail} (still stale in ${reload.failed.join(", ")} — run \`herdr server reload-config\` there)` };
  }
  return { ok: true, what, detail };
}

/**
 * Adds the sidebar block, but ONLY when the operator has no `[ui.sidebar.agents]`
 * of their own.
 *
 * Sidebar rows are a display preference somebody chose deliberately. Rewriting
 * one to insert our token would be taking a decision that is not ours, and a
 * TOML round-trip would eat their comments on the way through. So the moment
 * that section exists, this prints the line to paste and changes nothing.
 */
async function installSidebar(): Promise<Step> {
  if (!existsSync(CONFIG_PATH)) {
    return { ok: false, what: "sidebar", detail: `${CONFIG_PATH} does not exist — start Herdr once, then re-run setup` };
  }
  const before = readFileSync(CONFIG_PATH, "utf8");
  // A rows line carrying our tokens is one WE wrote, so bring it up to date in
  // place rather than leaving a half-configured sidebar behind. Only that one
  // line is rewritten: everything else in the file, including the operator's
  // comments, is untouched, which a TOML round-trip could not promise.
  const ours = before.split("\n").find((line) => line.startsWith("rows = ") && line.includes("$cache_"));
  if (ours) {
    if (ours === ROWS_LINE) {
      return { ok: true, what: "sidebar", detail: "the cache tokens are already in your sidebar rows" };
    }
    return writeConfig(before.replace(ours, ROWS_LINE), "sidebar", "updated the cache tokens in your sidebar rows");
  }
  if (/^\s*\[ui\.sidebar\.agents\]/m.test(before)) {
    return {
      ok: true,
      what: "sidebar",
      detail:
        "you already customise [ui.sidebar.agents] — left alone. Run `herdr-cache-alert sidebar-snippet` and paste the tokens into your own rows.",
    };
  }

  return writeConfig(before + SIDEBAR_BLOCK, "sidebar", "cache tokens added to the agent sidebar, coloured by state");
}

/** The tab-bar entry, as TOML. `root` is the checkout, so the path is absolute. */
export function tabBarEntry(root: string): string {
  // interval_seconds 5, not 1: the badge is denominated in minutes and the
  // watcher only republishes every 30s, so a faster poll buys nothing and spends
  // a process spawn doing it. timeout_seconds guards against a wedged socket —
  // Herdr clears the entry on timeout, which is the failure mode we want.
  return `{ type = "command", command = "${join(root, "bin", BIN)} tabbar", interval_seconds = 5, timeout_seconds = 3 }`;
}

/**
 * Adds the tab-bar status entry — the surface that works on a solo pane.
 *
 * The insertion point is the fiddly part. `tab_bar_right` belongs to `[ui]`, and
 * appending to the END of the file would drop it into whatever table happens to
 * be last — which, once we have written `[ui.sidebar.agents]`, is not `[ui]`.
 * TOML keys belong to the section above them, so this inserts directly after the
 * `[ui]` header instead.
 */
async function installTabBar(root: string): Promise<Step> {
  if (!existsSync(CONFIG_PATH)) {
    return { ok: false, what: "tab bar", detail: `${CONFIG_PATH} does not exist — start Herdr once, then re-run setup` };
  }
  const before = readFileSync(CONFIG_PATH, "utf8");
  if (before.includes(`${BIN} tabbar`)) {
    return { ok: true, what: "tab bar", detail: "the countdown is already in your tab bar" };
  }
  // Never rewrite an existing list: it is ordered, it is capped, and it is
  // theirs. Hand over the entry to paste and change nothing.
  if (/^\s*tab_bar_right\s*=/m.test(before)) {
    return {
      ok: true,
      what: "tab bar",
      detail: "you already set tab_bar_right — left alone. Run `herdr-cache-alert tabbar-snippet` and add the entry to your list.",
    };
  }

  const entry = `tab_bar_right = [${tabBarEntry(root)}]`;
  const comment = "# cache-alert: the prompt-cache countdown for the focused pane. Herdr re-runs\n# this on its own interval, which is why it keeps counting down while you are away.";
  const uiHeader = /^\[ui\]\s*$/m.exec(before);
  const next = uiHeader
    ? before.slice(0, uiHeader.index + uiHeader[0].length) + `\n${comment}\n${entry}` + before.slice(uiHeader.index + uiHeader[0].length)
    : `${before}\n[ui]\n${comment}\n${entry}\n`;

  const backup = `${CONFIG_PATH}.cache-alert-backup`;
  try {
    copyFileSync(CONFIG_PATH, backup);
    writeFileSync(CONFIG_PATH, next);
  } catch (err) {
    return { ok: false, what: "tab bar", detail: `could not write ${CONFIG_PATH}: ${errorMessage(err)}` };
  }
  const check = await runSafe([herdrBin()], ["config", "check"]);
  if (check.code !== 0) {
    writeFileSync(CONFIG_PATH, before);
    return {
      ok: false,
      what: "tab bar",
      detail: `the tab-bar entry did not validate — your config was restored untouched (${check.stdout.trim() || check.stderr.trim()})`,
    };
  }
  // Config is NOT hot-watched: without this the entry sits inert and the
  // operator concludes the feature is broken.
  await runSafe([herdrBin()], ["server", "reload-config"]);
  return { ok: true, what: "tab bar", detail: "countdown added to the tab bar — visible even on a pane alone in its tab" };
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
      detail: shown > 0 ? `painted ${shown} of ${painted.length} agent panes` : "no agent pane has a cache yet — badges appear after the first turn",
    };
  } catch (cause) {
    return { ok: false, what: "badges", detail: `could not paint yet (${errorMessage(cause)}) — the watcher paints within 30s` };
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
  if (!existsSync(CONFIG_PATH)) return { configured: [], missing: painted, unstyled: [] };
  const rows = readFileSync(CONFIG_PATH, "utf8")
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
    steps.push({ ok: true, what: "config", detail: `skipped (--no-keys) — nothing written to ${CONFIG_PATH}` });
  } else {
    const keys = await installKeybinding();
    const sidebar = await installSidebar();
    const tabbar = await installTabBar(root);
    steps.push(keys, sidebar, tabbar);
    // The agent-list badge IS the `$cache_*` tokens, so the switch is only worth
    // turning on when those tokens are actually in the operator's sidebar rows.
    // Turning it on without them would toggle something nothing renders.
    const tokensLive = sidebar.ok && !sidebar.detail.startsWith("you already customise");
    setAgentList(tokensLive);
    steps.push({
      ok: true,
      what: "agent list",
      detail: tokensLive
        ? "coloured $cache tokens ON — prefix+alt+c hides them"
        : "no badge: add the $cache tokens to ui.sidebar.agents.rows first, or the toggle has nothing to show",
    });
  }
  steps.push(await startWatcher(root));
  steps.push(await paintNow());
  return steps;
}
