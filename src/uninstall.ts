/**
 * `uninstall` — undo everything `setup` did, in the order that actually works.
 *
 * THE ORDER IS THE WHOLE POINT, and it is not the obvious one. This plugin is
 * self-healing on purpose: `[[startup]]` and five `[[events]]` hooks all run
 * `ensure`, which starts a watcher if the session has none. So clearing the
 * badges while the hooks are still registered fires a hook, which spawns a fresh
 * watcher, which repaints everything you just cleared. Removing it by hand in
 * the obvious order does not work, and looks like the badges "came back".
 *
 *   1. UNLINK from every server   — stops the hooks that resurrect the watcher
 *   2. STOP the watchers          — nothing left to repaint
 *   3. CLEAR the badges           — now they stay cleared
 *   4. strip the config blocks    — by MARKER, so only our bytes go
 *   5. remove the CLI symlink     — only ever a symlink, only ever ours
 *   6. remove the state directory — memos and heartbeats, all derived
 *
 * WHAT IT KEEPS, deliberately: the checkout, the config backup, and the
 * operator's own `config.toml` settings. Deleting a checkout somebody cloned is
 * not ours to do, and the backup is the one thing they would want if a config
 * edit went wrong.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BIN, PLUGIN_ID } from "./config.ts";
import {
  BLOCKS,
  configBackup,
  configPath,
  hasBlock,
  onEveryServer,
  removeBlock,
  stripLegacyBlocks,
  runningSockets,
  writeConfig,
  type Step,
} from "./config-toml.ts";
import { listPanes, setCacheBadge } from "./herdr.ts";
import { errorMessage } from "./runtime.ts";
import { STATE_DIR } from "./store.ts";
import { stopWatcher } from "./watch.ts";

export interface UninstallOptions {
  /** Leave `config.toml` exactly as it is — for someone who edited our block by hand. */
  keepConfig?: boolean;
  /** Report what would go, and change nothing. */
  dryRun?: boolean;
}

/** Step 1. Unlinking first is what stops the event hooks resurrecting the watcher. */
async function unlinkPlugin(dry: boolean): Promise<Step> {
  if (dry) return { ok: true, what: "plugin", detail: `would unlink ${PLUGIN_ID} from ${runningSockets().length} session(s)` };
  const res = await onEveryServer(["plugin", "unlink", PLUGIN_ID]);
  if (res.done === 0) return { ok: true, what: "plugin", detail: "no running server had it linked", skipped: true };
  const where = res.failed.length > 0 ? ` (${res.failed.join(", ")} did not answer)` : "";
  return { ok: true, what: "plugin", detail: `unlinked from ${res.done} session(s)${where}` };
}

/**
 * Step 2. Every session's watcher, not just this one — the pidfile is per
 * session and stopping "the" watcher leaves the others ticking.
 */
function stopWatchers(dry: boolean): Step {
  const sockets = runningSockets();
  if (dry) return { ok: true, what: "watcher", detail: `would stop the watcher in ${sockets.length} session(s)` };
  let stopped = 0;
  const was = process.env.HERDR_SOCKET_PATH;
  for (const { sock } of sockets) {
    // stopWatcher reads the pidfile named after HERDR_SOCKET_PATH, so the
    // variable is the only way to reach another session's watcher from here.
    process.env.HERDR_SOCKET_PATH = sock;
    if (stopWatcher()) stopped += 1;
  }
  if (was === undefined) delete process.env.HERDR_SOCKET_PATH;
  else process.env.HERDR_SOCKET_PATH = was;
  return stopped > 0
    ? { ok: true, what: "watcher", detail: `stopped ${stopped}` }
    : { ok: true, what: "watcher", detail: "none was running", skipped: true };
}

/** Step 3. Scoped to our own metadata source, so nothing another plugin wrote is touched. */
async function clearBadges(dry: boolean): Promise<Step> {
  const was = process.env.HERDR_SOCKET_PATH;
  let cleared = 0;
  try {
    for (const { sock } of runningSockets()) {
      process.env.HERDR_SOCKET_PATH = sock;
      const panes = await listPanes();
      if (dry) {
        cleared += panes.length;
        continue;
      }
      for (const pane of panes) {
        await setCacheBadge(pane.pane_id, null);
        cleared += 1;
      }
    }
  } catch (cause) {
    return { ok: false, what: "badges", detail: `could not clear: ${errorMessage(cause)}` };
  } finally {
    if (was === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = was;
  }
  return { ok: true, what: "badges", detail: `${dry ? "would clear" : "cleared"} ${cleared} pane(s)` };
}

/** Step 4. By MARKER. Nothing outside our own begin/end pair is read or written. */
async function stripConfig(dry: boolean): Promise<Step> {
  if (!existsSync(configPath())) return { ok: true, what: "config", detail: "nothing to remove", skipped: true };
  const before = readFileSync(configPath(), "utf8");
  const names = Object.values(BLOCKS);
  const present = names.filter((name) => hasBlock(before, name));
  let after = before;
  for (const name of names) after = removeBlock(after, name);
  // An install from before markers existed leaves prose comments instead.
  after = stripLegacyBlocks(after);
  if (after === before) return { ok: true, what: "config", detail: "nothing of ours was in it", skipped: true };
  const what = present.length > 0 ? present.join(", ") : "an older unmarked block";
  if (dry) return { ok: true, what: "config", detail: `would remove ${what}` };
  return writeConfig(after, "config", `removed ${what}`);
}

/** Step 5. Only ever a symlink, and only ever one pointing into a cache-alert checkout. */
function removeCli(dry: boolean): Step {
  const link = join(homedir(), ".local", "bin", BIN);
  if (!existsSync(link) && lstatSync(link, { throwIfNoEntry: false }) === undefined) {
    return { ok: true, what: "cli", detail: "not installed", skipped: true };
  }
  if (!lstatSync(link).isSymbolicLink()) {
    return { ok: false, what: "cli", detail: `${link} is a real file, not our symlink — left untouched` };
  }
  if (dry) return { ok: true, what: "cli", detail: `would remove ${link} -> ${readlinkSync(link)}` };
  try {
    unlinkSync(link);
  } catch (cause) {
    return { ok: false, what: "cli", detail: `could not remove ${link}: ${errorMessage(cause)}` };
  }
  return { ok: true, what: "cli", detail: `removed ${link}` };
}

/** Step 6. Memos, the agent-list switch and the heartbeats — all derived, all ours. */
function removeState(dry: boolean): Step {
  if (!existsSync(STATE_DIR)) return { ok: true, what: "state", detail: "nothing stored", skipped: true };
  if (dry) return { ok: true, what: "state", detail: `would remove ${STATE_DIR}` };
  try {
    rmSync(STATE_DIR, { recursive: true, force: true });
  } catch (cause) {
    return { ok: false, what: "state", detail: `could not remove ${STATE_DIR}: ${errorMessage(cause)}` };
  }
  return { ok: true, what: "state", detail: `removed ${STATE_DIR}` };
}

export async function uninstall(options: UninstallOptions = {}): Promise<Step[]> {
  const dry = options.dryRun === true;
  const steps: Step[] = [await unlinkPlugin(dry), stopWatchers(dry), await clearBadges(dry)];
  steps.push(
    options.keepConfig === true
      ? { ok: true, what: "config", detail: `kept (--keep-config) — ${configPath()} untouched`, skipped: true }
      : await stripConfig(dry),
  );
  steps.push(removeCli(dry), removeState(dry));
  return steps;
}

/** What `uninstall` deliberately leaves behind, for the closing note. */
export function keptAfterUninstall(root: string): string[] {
  const kept = [`the checkout at ${root} — delete it yourself if you want it gone`];
  if (existsSync(configBackup())) kept.push(`${configBackup()} — your config as it was before we edited it`);
  return kept;
}
