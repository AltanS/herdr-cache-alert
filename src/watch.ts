/**
 * The watcher: one process per Herdr session, ticking every WATCH TICK.
 *
 * A countdown cannot be event-driven. Herdr's events fire when something
 * happens, and the whole point of this plugin is the moment when NOTHING is
 * happening — an idle pane sliding toward expiry emits no events at all, so an
 * event-only badge would freeze at "⚡ 40m" and still say it an hour later.
 *
 * The cost of being wrong is bounded on both sides: every paint carries a
 * `--ttl-ms` of roughly two ticks, so if this process dies the badges clear
 * themselves within a tick instead of lying indefinitely.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, pluginRoot } from "./config.ts";
import { sleep, errorMessage } from "./runtime.ts";
import { STATE_DIR } from "./store.ts";
import { syncAll } from "./sync.ts";

/** Coarse on purpose: the badge shows minutes, so a finer tick buys nothing. */
export const TICK_MS = 30_000;

/** Twice the tick, so one missed tick is tolerated and two are not. */
export const BADGE_TTL_MS = TICK_MS * 2;

/**
 * The session this process is talking to, as a filename-safe word.
 *
 * `herdr --session <name>` is a WHOLE SEPARATE SERVER: its own socket, panes and
 * tab bar. Herdr injects `HERDR_SOCKET_PATH` so a plugin command reaches the
 * right one, and the default session's socket sits directly in the config dir
 * while a named one lives under `sessions/<name>/`.
 *
 * Exported for the tests: this reads an environment variable and slices a path,
 * and getting it wrong gives a session a watcher that is silently not its own.
 */
export function sessionKey(): string {
  const socket = process.env.HERDR_SOCKET_PATH ?? "";
  if (!socket) return "default";
  const parts = socket.split("/");
  const dir = parts[parts.length - 2] ?? "";
  // ".../herdr/herdr.sock" is the default session; ".../sessions/<name>/herdr.sock" is named.
  return dir && dir !== "herdr" ? dir.replace(/[^A-Za-z0-9._-]/g, "_") : "default";
}

/**
 * One HEARTBEAT FILE per session, and both halves of that matter.
 *
 * PER SESSION, because a single shared file made the SECOND session look like it
 * already had a watcher, so it silently got none. Its badges were then repainted
 * only by the `[[events]]` hooks, which fire when something HAPPENS — invisible
 * on a busy pane, but an idle one stops counting down and then expires.
 *
 * A HEARTBEAT rather than a bare pid, because `kill(pid, 0)` answers the wrong
 * question. It asks whether SOME process holds that number. Pids are recycled,
 * so a dead watcher can read as alive forever — that session loses its countdown
 * with nothing to show for it, and `stop` sends SIGTERM to a stranger. It also
 * cannot see a watcher killed with SIGKILL, which never runs the cleanup. A beat
 * that stopped is unambiguous: whoever owns the pid now is not ticking.
 */
const BEAT_FILE = join(STATE_DIR, `watch-${sessionKey()}.json`);

/** Where versions before the heartbeat wrote. Read so `stop` can still find them. */
const LEGACY_PID_FILE = join(STATE_DIR, `watch-${sessionKey()}.pid`);
const LEGACY_SHARED_PID_FILE = join(STATE_DIR, "watch.pid");

/**
 * Three missed ticks. Two would race the tick itself: a watcher that is mid-sweep
 * when the file is read has not beaten for however long the sweep takes.
 */
const BEAT_STALE_MS = TICK_MS * 3;

interface Heartbeat {
  pid: number;
  beatAt: number;
}

/** True when `pid` is a live process we may signal. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readBeat(): Heartbeat | null {
  try {
    // SAFETY: our own file, written by `beat` below. Anything else falls through
    // to null, which costs one extra watcher spawn rather than a wrong answer.
    const parsed = JSON.parse(readFileSync(BEAT_FILE, "utf8")) as Heartbeat;
    return parsed.pid > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function beat(): void {
  const tmp = `${BEAT_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, beatAt: Date.now() } satisfies Heartbeat));
  renameSync(tmp, BEAT_FILE);
}

/** A pid from a pre-heartbeat install, so `stop` can still end one. */
function legacyPid(): number | null {
  for (const file of [LEGACY_PID_FILE, LEGACY_SHARED_PID_FILE]) {
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, "utf8").trim());
    if (Number.isFinite(pid) && pid > 0 && alive(pid)) return pid;
    try {
      unlinkSync(file);
    } catch {}
  }
  return null;
}

/**
 * The running watcher's pid, or null.
 *
 * Both conditions are required. A live pid with a stale beat is a recycled pid or
 * a hung process; a fresh beat from a dead pid cannot happen but costs nothing to
 * exclude. A stale file is removed here so the next caller does not re-read it.
 */
export function runningWatcher(): number | null {
  const hb = readBeat();
  if (hb && alive(hb.pid) && Date.now() - hb.beatAt < BEAT_STALE_MS) return hb.pid;
  if (hb) {
    try {
      unlinkSync(BEAT_FILE);
    } catch {}
  }
  return legacyPid();
}

export function stopWatcher(): boolean {
  const pid = runningWatcher();
  if (pid === null) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  return true;
}

/**
 * Starts this session's watcher if it has none. The `[[startup]]` and `[[events]]`
 * hooks both run through here, which is what makes a dead watcher self-healing:
 * the next thing that happens repairs it, rather than it staying dead until the
 * operator notices a frozen badge.
 *
 * A second watcher is refused rather than allowed to double-paint — two of these
 * would fight over `--seq` and burn twice the socket traffic for one badge.
 */
export async function ensureWatcher(): Promise<{ pid: number; started: boolean } | null> {
  const running = runningWatcher();
  if (running !== null) return { pid: running, started: false };
  try {
    const { spawn } = await import("node:child_process");
    // Through `run.sh`, so the child picks a runtime the same way every other
    // entry point does. Detached and unref'd: this must outlive the hook that
    // spawned it, which Herdr reaps as soon as it exits.
    const child = spawn("bash", [join(pluginRoot(), "scripts", "run.sh"), "cli", "watch"], {
      detached: true,
      stdio: "ignore",
      // The session matters: the child inherits HERDR_SOCKET_PATH, which is what
      // makes it watch the server this hook fired on rather than the default one.
      env: process.env,
    });
    child.unref();
    return child.pid === undefined ? null : { pid: child.pid, started: true };
  } catch {
    return null;
  }
}

/**
 * Claims the heartbeat file for this process, atomically.
 *
 * `wx` is O_CREAT|O_EXCL: exactly one of two racing watchers can create the
 * file, and the loser stands down. The previous write-then-read-back was a
 * TOCTOU — A writes, A checks, B writes, B checks, and both pass.
 *
 * An existing file is only stolen when its beat has stopped, which is what makes
 * a SIGKILLed watcher replaceable without the operator deleting anything.
 */
function claim(): boolean {
  mkdirSync(STATE_DIR, { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, beatAt: Date.now() } satisfies Heartbeat);
  try {
    writeFileSync(BEAT_FILE, mine, { flag: "wx" });
    return true;
  } catch {
    if (runningWatcher() !== null) return false;
    // runningWatcher() removed the stale file, so this create is the same race
    // as the first one and the same rule decides it.
    try {
      writeFileSync(BEAT_FILE, mine, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }
}

export async function watch(opts: { force?: boolean } = {}): Promise<never | void> {
  if (!claim()) {
    if (!opts.force) {
      const existing = runningWatcher();
      console.error(`cache-alert: a watcher is already running (pid ${existing}). Stop it first, or pass --force.`);
      process.exit(1);
    }
    // --force must STOP the incumbent, not just overwrite its file. Taking the
    // file alone left both processes ticking and the file changing owner every
    // 30s, which made `watch stop` a coin flip between them.
    stopWatcher();
    beat();
  }

  const clean = () => {
    try {
      if (readBeat()?.pid === process.pid) unlinkSync(BEAT_FILE);
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", clean);
  process.on("SIGINT", clean);

  // Re-read config every tick: an operator editing config.json should not have
  // to restart a background process to see the effect.
  for (;;) {
    // Stand down if the file has changed hands. Two watchers can otherwise
    // coexist by a route `claim()` cannot see: this process wedges past
    // BEAT_STALE_MS, `ensure` spawns a replacement, and when this one unwedges
    // both beat forever. The file names exactly ONE pid, so at most one process
    // reads its own — the tie-break is total and no mutual stand-down is possible.
    const held = readBeat();
    if (held !== null && held.pid !== process.pid && Date.now() - held.beatAt < BEAT_STALE_MS) {
      process.exit(0);
    }
    // Beat FIRST. A sweep that throws must still prove this process is alive, or
    // a Herdr restart — which fails every call for a few seconds — would let the
    // beat go stale and a second watcher take over from a healthy one.
    beat();
    try {
      await syncAll(BADGE_TTL_MS, loadConfig());
    } catch (err) {
      // A tick that throws must not take the watcher with it — the badge should
      // simply come back rather than need a manual relaunch.
      console.error(`cache-alert: tick failed: ${errorMessage(err)}`);
    }
    await sleep(TICK_MS);
  }
}
