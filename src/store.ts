/**
 * Derived, throwaway state — one JSON file for the whole plugin.
 *
 * Nothing here is user data. Every field can be recomputed from the harness's
 * own logs, so the file is a memo, not a record: losing it costs one cold-hit
 * mark, never anything the operator wrote.
 *
 * Keyed by AGENT SESSION ID, never by pane id. Pane ids are not reused but they
 * do change on move and on server restart, so a pane-keyed memo forgets its
 * cold mark exactly when the operator is most likely to be looking. The session
 * id is the harness's own identifier for the conversation whose cache this is —
 * when it changes, the cache genuinely is a different one.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PLUGIN_ID } from "./config.ts";

/**
 * MUST mirror what Herdr injects (`HERDR_PLUGIN_STATE_DIR`). The fallback
 * reproduces Herdr's own layout exactly, because the CLI runs in a plain shell
 * where that variable is absent — if the fallback drifts, the watcher and the
 * CLI silently read two different files.
 */
export const STATE_DIR =
  process.env.HERDR_PLUGIN_STATE_DIR ||
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "herdr", "plugins", PLUGIN_ID);

const STATE_FILE = join(STATE_DIR, "state.json");

/** What we remember about one agent session between ticks. */
export interface SessionMemo {
  /** `message.id` of the last turn we judged, so one cold turn alerts once. */
  lastTurnId: string;
  /** Epoch ms of the last turn that came back cold. 0 = never seen one. */
  lastColdAt: number;
  /** The badge string last painted, so an unchanged badge costs no API call. */
  lastBadge: string;
  /** Epoch ms of the last outbound request we have evidence for. */
  lastRequestAt: number;
  /** Seconds of TTL last OBSERVED in the harness's own telemetry. 0 = never. */
  observedTtlSeconds: number;
  /** Resolved path to the harness log this session reads, so a glob runs once. */
  logPath: string;
  /** The pane this session was last seen in — for repainting after a restart. */
  paneId: string;
  /** Epoch ms this memo was last touched — the basis for ageing panes out. */
  seenAt: number;
}

interface StateFile {
  version: 1;
  sessions: Record<string, SessionMemo>;
}

const EMPTY: StateFile = { version: 1, sessions: {} };

/** Sessions untouched for this long are dropped on the next write. */
const STALE_MS = 24 * 60 * 60 * 1000;

function read(): StateFile {
  try {
    // SAFETY: this file has exactly one writer — this module — and it only ever
    // writes a StateFile. A hand-edited or truncated file throws in JSON.parse
    // and is caught below, which resets to EMPTY; the memo is derived state, so
    // losing it costs one repaint.
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as StateFile;
    if (parsed?.version === 1 && parsed.sessions) return parsed;
  } catch {}
  return { ...EMPTY, sessions: {} };
}

/**
 * Read-modify-write, atomically.
 *
 * Several watchers may tick at once (one per pane is a legitimate setup), so the
 * write goes to a temp file and is renamed over the target — a torn state.json
 * would make every pane forget its cold mark at once. No lock: a lost update
 * here costs one repaint, and a lock costs a stuck plugin.
 */
export function mutate<T>(fn: (state: StateFile) => T): T {
  mkdirSync(STATE_DIR, { recursive: true });
  const state = read();
  const result = fn(state);
  const cutoff = Date.now() - STALE_MS;
  for (const [sessionId, memo] of Object.entries(state.sessions)) {
    if (memo.seenAt < cutoff) delete state.sessions[sessionId];
  }
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
  return result;
}

const BLANK: SessionMemo = {
  lastTurnId: "",
  lastColdAt: 0,
  lastBadge: "",
  lastRequestAt: 0,
  observedTtlSeconds: 0,
  logPath: "",
  paneId: "",
  seenAt: 0,
};

/**
 * The agent-list switch, in its OWN file — and that separation is the point.
 *
 * DEFAULT ON. The pane border is the nicer surface but it is not always there:
 * Herdr draws pane chrome only around SPLIT panes, so a pane alone in its tab
 * has nowhere to put the badge — and `ui.pane_outer_borders = true` does not
 * change that (tested). On a workspace of single-pane tabs, a border-only badge
 * is a plugin that shows nothing. The agent list needs no border, so it is what
 * makes the plugin work everywhere; prefix+alt+c quiets it.
 *
 * `state.json` is written by every tick, once per pane, through a
 * read-modify-write with no lock. That is fine for memos, where a lost update
 * costs one repaint. It is NOT fine for a decision the operator made: a watcher
 * that read state.json just before the toggle wrote it puts the old value back
 * a millisecond later, and the keypress silently undoes itself. That happened.
 *
 * This file has exactly one writer — the toggle — so there is nothing to race.
 *
 * It is deliberately not in `config.json` either: that file is the operator's,
 * hand-edited and possibly in version control, and a keypress has no business
 * rewriting it. The pane border badge is never affected by this switch.
 */
const SWITCH_FILE = join(STATE_DIR, "switch.json");

export function agentListEnabled(): boolean {
  try {
    // Only an explicit `false` turns it off. A missing file is a fresh install,
    // which must show something rather than nothing.
    return JSON.parse(readFileSync(SWITCH_FILE, "utf8"))?.agentList !== false;
  } catch {
    return true;
  }
}

/** Sets the agent-list switch and returns the new value. */
export function setAgentList(on: boolean): boolean {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${SWITCH_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ agentList: on }, null, 2));
  renameSync(tmp, SWITCH_FILE);
  return on;
}

export function getMemo(sessionId: string): SessionMemo | null {
  return read().sessions[sessionId] ?? null;
}

/** Every session we still remember — what the startup repaint sweeps. */
export function allMemos(): Array<{ sessionId: string; memo: SessionMemo }> {
  return Object.entries(read().sessions).map(([sessionId, memo]) => ({ sessionId, memo }));
}

export function putMemo(sessionId: string, patch: Partial<SessionMemo>): SessionMemo {
  return mutate((state) => {
    const current: SessionMemo = state.sessions[sessionId] ?? { ...BLANK };
    const next: SessionMemo = { ...current, ...patch, seenAt: Date.now() };
    state.sessions[sessionId] = next;
    return next;
  });
}

export function forgetSession(sessionId: string): void {
  mutate((state) => {
    delete state.sessions[sessionId];
  });
}
