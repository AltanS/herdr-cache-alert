/**
 * Every edit this plugin makes to the operator's `config.toml`, in one place.
 *
 * Three separate hand-rolled strategies used to live in `setup.ts` — append at
 * EOF, insert after `[ui]`, replace a line found by `startsWith`. Each had its
 * own copy of the backup/validate/restore dance, and one of them reloaded only a
 * single server. That is how a second session kept a stale sidebar for a whole
 * release.
 *
 * Two rules govern this file:
 *
 *   OUR BLOCKS ARE MARKED. Everything we write sits between
 *   `# cache-alert:begin <name>` and `# cache-alert:end <name>`. That is what
 *   makes `setup` idempotent and `uninstall` exact. Matching prose comments with
 *   a regex works right up until the operator reflows a comment, and then it
 *   either misses the block or eats a line that was theirs.
 *
 *   WE NEVER TOUCH WHAT WE DID NOT WRITE. No TOML round-trip — that would
 *   reformat the file and eat every comment in it. Only whole marked regions are
 *   inserted, replaced or removed; the bytes outside them come through
 *   untouched, and a key the operator set themselves is reported, not rewritten.
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { herdrBin } from "./herdr.ts";
import { errorMessage, runSafe } from "./runtime.ts";

/**
 * Resolved on every CALL, never captured at module load.
 *
 * A module-level const freezes whatever `HERDR_CONFIG_PATH` said at import time,
 * which makes the value depend on which module loaded first — untestable, and a
 * trap for anything that sets the variable to reach another server's config.
 */
export function configPath(): string {
  return (
    process.env.HERDR_CONFIG_PATH || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr", "config.toml")
  );
}

export function configBackup(): string {
  return `${configPath()}.cache-alert-backup`;
}

/** One result line from `setup` or `uninstall`. */
export interface Step {
  ok: boolean;
  what: string;
  detail: string;
  /** Nothing needed doing. Printed differently, and never a failure. */
  skipped?: boolean;
}

const MARK = "cache-alert";
const begin = (name: string) => `# ${MARK}:begin ${name}`;
const end = (name: string) => `# ${MARK}:end ${name}`;

/** Wraps `body` in this plugin's markers, with the remedy named on the first line. */
export function marked(name: string, body: string): string {
  return `${begin(name)} — remove with \`herdr-cache-alert uninstall\`\n${body.trim()}\n${end(name)}`;
}

/**
 * The marked region called `name`, as a [start, end) byte range, or null.
 *
 * The begin marker is matched on its PREFIX, so the remedy text on that line can
 * be reworded in a later release without orphaning every block already written.
 */
function region(text: string, name: string): { start: number; end: number } | null {
  const lines = text.split("\n");
  const from = lines.findIndex((line) => line.startsWith(begin(name)));
  if (from === -1) return null;
  const to = lines.findIndex((line, i) => i > from && line.trimEnd() === end(name));
  // An unterminated block means someone deleted the end marker by hand. Refuse
  // to guess where it stopped rather than swallow the rest of the file.
  if (to === -1) return null;
  const start = lines.slice(0, from).reduce((n, line) => n + line.length + 1, 0);
  const length = lines.slice(from, to + 1).reduce((n, line) => n + line.length + 1, 0);
  return { start, end: start + length };
}

/** Where a NEW block goes. An existing one is always replaced where it already is. */
export type Anchor = "eof" | { after: RegExp; orCreate: string };

export function hasBlock(text: string, name: string): boolean {
  return region(text, name) !== null;
}

/** The marked block's current text, or null when it is not there. */
export function readBlock(text: string, name: string): string | null {
  const at = region(text, name);
  return at === null ? null : text.slice(at.start, at.end).replace(/\n$/, "");
}

/**
 * Writes the marked block, replacing an older copy of itself in place.
 *
 * `anchor` decides where a NEW block goes. `"eof"` is right for anything that
 * opens its own table; `{ after: /^\[ui\]\s*$/m, orCreate: "[ui]" }` is required for a bare key,
 * because a key appended at EOF lands in whatever table happens to be last —
 * not the one you meant. `herdr config check` catches that only when the key is
 * unknown in the table it landed in, so a key valid in both fails SILENTLY.
 */
export function upsertBlock(text: string, name: string, body: string, anchor: Anchor): string {
  const block = marked(name, body);
  const at = region(text, name);
  if (at !== null) return text.slice(0, at.start) + block + "\n" + text.slice(at.end);
  const tail = text.replace(/\n*$/, "");
  if (anchor === "eof") return `${tail}\n\n${block}\n`;
  const header = anchor.after.exec(text);
  // No such table yet, so write the header ourselves. Appending the bare key
  // instead is the trap this parameter exists to avoid.
  if (header === null) return `${tail}\n\n${anchor.orCreate}\n${block}\n`;
  const cut = header.index + header[0].length;
  return `${text.slice(0, cut)}\n${block}${text.slice(cut)}`;
}

/** Removes the marked block and the blank line it left behind. */
export function removeBlock(text: string, name: string): string {
  const at = region(text, name);
  if (at === null) return text;
  return (text.slice(0, at.start) + text.slice(at.end)).replace(/\n{3,}/g, "\n\n");
}

/**
 * The three regions this plugin writes. Named, because `uninstall` removes them
 * by name and a typo must be a compile error rather than a block left behind.
 */
export const BLOCKS = {
  keys: "keybinding",
  sidebar: "sidebar",
  tabbar: "tab-bar",
} as const;

/**
 * Removes the UNMARKED blocks written before markers existed.
 *
 * Releases up to 0.1.1 wrote prose comments and no markers, so `uninstall` could
 * not find its own work and `setup` could not replace it. Matching that prose is
 * exactly the fragile thing markers exist to avoid — which is why this runs ONCE,
 * on the way to writing a marked block over the top.
 *
 * IT IS SKIPPED FOR ANY BLOCK THAT ALREADY HAS MARKERS, and that guard is not
 * optional. The sidebar block's body still opens with the same comment the
 * legacy version used, so without it these patterns reach INSIDE our own markers
 * and eat the body — leaving a begin and an end with nothing between them, and
 * an operator whose sidebar rows silently vanished on a re-run. That happened.
 *
 * Delete this when no install can still be that old.
 */
export function stripLegacyBlocks(text: string): string {
  let out = text;
  if (!hasBlock(out, BLOCKS.keys)) {
    // Our comment pair, the table header, and its four keys.
    out = out.replace(
      /\n?# cache-alert: mirror the cache badge[\s\S]*?\ndescription = "Toggle the cache badge in the agent list"\n/,
      "\n",
    );
  }
  if (!hasBlock(out, BLOCKS.sidebar)) {
    out = out.replace(/\n?# cache-alert: show the prompt-cache countdown[\s\S]*?\nrows = \[\[.*?\]\]\n/, "\n");
  }
  if (!hasBlock(out, BLOCKS.tabbar)) {
    out = out.replace(/\n?# cache-alert: the prompt-cache countdown[\s\S]*?\ntab_bar_right = \[.*?\]\n/, "\n");
  }
  return out;
}

// --- servers ------------------------------------------------------------------

/**
 * Every Herdr server with a socket on disk.
 *
 * `herdr --session <name>` is a WHOLE SEPARATE SERVER — its own plugin registry
 * and its own parsed copy of this file. Anything that installs into "the" server
 * reaches exactly one of them, which is how a second session ran a release
 * behind for a whole version.
 */
export function runningSockets(): Array<{ sock: string; name: string }> {
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
 * Runs one `herdr` command against every server, and names the ones that did not
 * answer. A socket file outlives the server that made it, so a failure here is
 * usually a session that is simply gone — never a reason to fail an install.
 */
export async function onEveryServer(args: string[]): Promise<{ done: number; failed: string[] }> {
  let done = 0;
  const failed: string[] = [];
  for (const { sock, name } of runningSockets()) {
    const res = await runSafe([herdrBin()], args, { HERDR_SOCKET_PATH: sock });
    if (res.code === 0) done += 1;
    else failed.push(name);
  }
  return { done, failed };
}

// --- writing ------------------------------------------------------------------

/**
 * Writes the config the careful way, and it is the ONLY way this plugin writes it.
 *
 * VALIDATION HAPPENS ON A THROWAWAY COPY, before the operator's file is touched
 * at all. Writing first and restoring on failure also works, but it leaves a
 * window in which their config is broken — and if the process dies in that
 * window, it stays broken. `herdr config check` honours `HERDR_CONFIG_PATH`,
 * which is what makes the dry run possible.
 *
 * Only then: back up, write, and reload every server. Herdr does not hot-reload
 * this file, and an unreloaded change sits inert while the operator concludes
 * the feature is broken.
 */
export async function writeConfig(content: string, what: string, detail: string): Promise<Step> {
  if (!existsSync(configPath())) {
    return { ok: false, what, detail: `${configPath()} does not exist — start Herdr once, then try again` };
  }
  if (readFileSync(configPath(), "utf8") === content) return { ok: true, what, detail, skipped: true };

  const probe = `${configPath()}.cache-alert-probe`;
  try {
    writeFileSync(probe, content);
    const check = await runSafe([herdrBin()], ["config", "check"], { HERDR_CONFIG_PATH: probe });
    if (check.code !== 0) {
      return {
        ok: false,
        what,
        detail: `would not validate, so your config was NOT touched (${check.stdout.trim() || check.stderr.trim()})`,
      };
    }
  } catch (cause) {
    return { ok: false, what, detail: `could not test the change: ${errorMessage(cause)}` };
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      /* nothing to clean up */
    }
  }

  try {
    copyFileSync(configPath(), configBackup());
    writeFileSync(configPath(), content);
  } catch (cause) {
    return { ok: false, what, detail: `could not write ${configPath()}: ${errorMessage(cause)}` };
  }

  const reload = await onEveryServer(["server", "reload-config"]);
  if (reload.done === 0) {
    return { ok: false, what, detail: `${detail} — but no Herdr server accepted the reload. Run \`herdr server reload-config\`.` };
  }
  if (reload.failed.length > 0) {
    return { ok: true, what, detail: `${detail} (${reload.failed.join(", ")} did not answer — probably not running)` };
  }
  return { ok: true, what, detail };
}

/** Removes the backup `writeConfig` leaves behind. Only ever ours, by name. */
export function dropBackup(): boolean {
  if (!existsSync(configBackup())) return false;
  try {
    unlinkSync(configBackup());
    return true;
  } catch {
    return false;
  }
}
