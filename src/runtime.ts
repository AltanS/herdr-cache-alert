/**
 * The handful of things Bun and Node spell differently.
 *
 * cache-alert runs on either: Bun if the host has it, otherwise Node ≥ 22, which
 * executes TypeScript directly (bare `node file.ts` from 23.6, and behind
 * `--experimental-strip-types` before that — `scripts/run.sh` passes the flag
 * when it is needed). Keeping the divergence in one file is what makes that
 * cheap; nothing else in `src/` may reach for a runtime-specific global.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const isBun = "Bun" in globalThis;

export const sleep = (ms: number): Promise<void> => delay(ms);

/**
 * The message from a caught value.
 *
 * `catch` binds `unknown`, and `(err as Error).message` is a lie the moment
 * something throws a string or a plain object — it yields `undefined`, which
 * then prints as "undefined" in an operator-facing error. The parameter is named
 * `cause` because that is the one name the anti-slop rule accepts for an
 * unavoidable `unknown`: this IS the boundary where a thrown value is decoded.
 */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs a command to completion, capturing its output. */
export function run(cmd: string[], args: string[], env?: Record<string, string>): Promise<RunResult> {
  const [bin, ...rest] = [...cmd, ...args];
  return new Promise((resolve, reject) => {
    const proc = nodeSpawn(bin!, rest, {
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => (stdout += d));
    proc.stderr?.on("data", (d: Buffer) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

/**
 * `run` that reports a missing binary instead of rejecting.
 *
 * A spawn ENOENT arrives as an error EVENT, not an exit code, so `run` rejects
 * — which aborts a caller mid-report with a stack trace. Callers that spawn
 * something the operator may plausibly not have (`git`, or `herdr` from a
 * non-interactive ssh shell whose PATH never sourced a profile) want the shell's
 * own "not found" code instead.
 */
export async function runSafe(cmd: string[], args: string[], env?: Record<string, string>): Promise<RunResult> {
  try {
    return await run(cmd, args, env);
  } catch (err) {
    return { stdout: "", stderr: errorMessage(err), code: 127 };
  }
}

/** What a `?` placeholder may be bound to. Enough for the queries this plugin runs. */
export type SqlParam = string | number;

/**
 * The two runtimes' database handles, reduced to what this file uses.
 *
 * Declared structurally rather than imported: a static import of `bun:sqlite`
 * is a hard failure under Node and vice versa, and each runtime's own class
 * already satisfies this shape.
 */
interface SqliteHandle {
  prepare(sql: string): { all(...params: SqlParam[]): unknown[] };
  close(): void;
}

/**
 * Opens a SQLite database READ-ONLY and runs one query.
 *
 * Both runtimes ship SQLite, so this needs no dependency — but they spell it
 * differently (`bun:sqlite` `Database`, `node:sqlite` `DatabaseSync`, and even
 * the read-only option differs in case), which is precisely what this file is
 * for. The import is dynamic because a static `bun:sqlite` import is a hard
 * parse error under Node and vice versa.
 *
 * Read-only is not a nicety. The database belongs to a LIVE agent process; this
 * plugin must never be the reason an operator's session loses a write. A caller
 * gets `[]` on any failure — a locked file, a missing database, a schema that
 * moved — because no adapter should paint a badge off a database it could not
 * open.
 *
 * `Row` is supplied by the caller so the decoded shape has an owner. Rows are
 * still third-party data: name the columns you selected and nothing else.
 */
export async function sqliteQuery<Row>(path: string, sql: string, params: readonly SqlParam[] = []): Promise<Row[]> {
  let db: SqliteHandle | null = null;
  try {
    // Note `readOnly` against `readonly`: the two runtimes disagree on the
    // casing, and an unrecognised option is silently IGNORED rather than
    // rejected — which would open a live database for writing.
    db = isBun
      ? new (await import("bun:sqlite")).Database(path, { readonly: true })
      : new (await import("node:sqlite")).DatabaseSync(path, { readOnly: true });
    const rows = db.prepare(sql).all(...params);
    // SAFETY: the caller names `Row` after the columns its own SQL selected, and
    // every field is read through a guard. A schema change surfaces as missing
    // fields rather than as a throw, which is why this is the only assertion.
    return rows as Row[];
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* already gone */
    }
  }
}

