/**
 * OpenAI Codex CLI.
 *
 * Codex writes rollout logs to `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*-<session-id>.jsonl`.
 * They carry more than this adapter once believed:
 *
 *   - `event_msg` records of type `token_count` hold `payload.info.last_token_usage`,
 *     which includes `cached_input_tokens` — so warm/cold IS detectable here.
 *   - `turn_context` records hold `turn_id` and `model`, which is what makes the
 *     cache lifetime knowable at all (see `OPENAI_REGIMES`).
 *
 * An earlier version of this adapter asserted in its own doc comment that Codex
 * logged no cache counts, and painted a countdown only. That was wrong, and it
 * was wrong in the direction that costs the operator most: it silently discarded
 * the miss they had already paid for, out of a tail it was already reading.
 *
 * The TTL numbers are still the general OpenAI figures. OpenAI publishes nothing
 * Codex-specific, and that gap is recorded in the claims rather than papered
 * over: read `confidence` before trusting them.
 */

import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CacheRule, Sourced } from "../claims.ts";
import type { PaneInfo } from "../herdr.ts";
import type { AdapterStore, HarnessAdapter, Probe, TierDetection } from "./types.ts";

const OPENAI_CACHE_DOC = {
  url: "https://developers.openai.com/api/docs/guides/prompt-caching",
  title: "Prompt caching | OpenAI API",
  publisher: "OpenAI",
  retrievedAt: "2026-08-24",
  kind: "vendor-doc",
} as const;

/**
 * The Codex-specific hole, kept as a claim so it prints in `explain`.
 *
 * This page proves prompt caching APPLIES on a ChatGPT plan — it meters "Cached
 * input tokens" as its own rate-card column, at a tenth of the input rate. What
 * it does NOT state is a lifetime. No OpenAI page does, for Codex on a plan.
 */
const CODEX_PLAN_DOC = {
  url: "https://learn.chatgpt.com/docs/pricing",
  title: "Pricing — ChatGPT",
  publisher: "OpenAI",
  retrievedAt: "2026-08-24",
  kind: "vendor-doc",
  quote: "Usage is calculated in credits per million input tokens, cached input tokens, and output tokens.",
} as const;

/**
 * OpenAI runs TWO cache regimes at once, split by model generation, and a single
 * operator has both in their logs (`gpt-5.1-codex` and `gpt-5.6-sol` were both
 * observed on the machine this was written on). A per-TIER number is therefore
 * wrong for one of them whichever value it takes, which is why `ttlForProbe`
 * exists and why these are separate from the tier rules below.
 */
export const OPENAI_REGIMES = {
  modern: {
    value: 1800,
    confidence: "documented",
    note: "GPT-5.6 and later. `prompt_cache_options.ttl` accepts only `30m`, which is also the default, so this is the whole range rather than a typical case.",
    source: {
      ...OPENAI_CACHE_DOC,
      quote: "The 30-minute lifetime begins when the prefix is written and refreshes whenever the prefix is reused.",
    },
  },
  legacy: {
    value: 300,
    confidence: "documented",
    note: "Models before GPT-5.6. The documented range is 5-10 minutes idle with an hour as the ceiling; the LOW end is used, so the warning arrives early rather than late. Some models support opt-in extended retention of up to 24 hours — Codex is not known to request it, so it is not assumed here.",
    source: {
      ...OPENAI_CACHE_DOC,
      quote:
        "When using the in-memory policy, cached prefixes generally remain active for 5 to 10 minutes of inactivity, up to a maximum of one hour.",
    },
  },
} as const satisfies Record<string, Sourced<number>>;

const MIN_TOKENS: Sourced<number> = {
  value: 1024,
  confidence: "documented",
  source: { ...OPENAI_CACHE_DOC, quote: "By default, caching is enabled automatically for prompts that are 1,024 tokens or longer." },
};

const AUTOMATIC_SOURCE = {
  ...OPENAI_CACHE_DOC,
  quote: "By default, caching is enabled automatically for prompts that are 1,024 tokens or longer.",
};

/**
 * Which cache regime a model name falls under.
 *
 * The doc splits on "GPT-5.6 and later", so the split is read off the version in
 * the name. `null` means the name did not parse — an unknown model must NOT be
 * guessed into a regime, because guessing "modern" doubles the countdown on a
 * cache that is already gone. The caller falls back to the pessimistic tier rule.
 */
export function openaiCacheRegime(model: string): keyof typeof OPENAI_REGIMES | null {
  const match = /gpt-(\d+)\.(\d+)/i.exec(model);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  if (major > 5) return "modern";
  return major === 5 && minor >= 6 ? "modern" : "legacy";
}

/**
 * Both tiers carry the LEGACY number, deliberately.
 *
 * These rules are the fallback for when the model is not known — an early tick,
 * a tail with no `turn_context` in it. The engine's standing instruction there
 * is to be pessimistic, and 5 minutes is the shorter of the two regimes. When
 * the model IS known, `ttlForProbe` overrides this with the right one.
 */
export const CODEX_RULES: CacheRule[] = [
  {
    id: "codex.subscription",
    harness: "codex",
    tier: "subscription",
    label: "Codex CLI signed in with a ChatGPT plan",
    ttlSeconds: { ...OPENAI_REGIMES.legacy },
    minTokens: { ...MIN_TOKENS },
    slidingWindow: true,
    automatic: true,
    sources: [AUTOMATIC_SOURCE, CODEX_PLAN_DOC],
    notes: [
      "GAP: OpenAI publishes no cache TTL for Codex on a ChatGPT plan. The pricing page proves caching applies and is billed at a tenth of the input rate, but names no lifetime. These are the general API figures applied to Codex's request shape.",
      "This is the FALLBACK figure, used only until a turn reveals the model. See `ttlForProbe` for the number actually painted on a live session.",
    ],
  },
  {
    id: "codex.api",
    harness: "codex",
    tier: "api",
    label: "Codex CLI on an OpenAI API key",
    ttlSeconds: { ...OPENAI_REGIMES.legacy },
    minTokens: { ...MIN_TOKENS },
    slidingWindow: true,
    automatic: true,
    sources: [AUTOMATIC_SOURCE],
    notes: [
      "The shorter of OpenAI's two regimes, used until the model is known. GPT-5.6 and later get 30 minutes instead.",
      "A cache miss follows any change to the prefix, which for Codex includes the model, the tool set, and the working directory.",
    ],
  },
];

const SESSIONS_ROOT = join(homedir(), ".codex", "sessions");

/**
 * The rollout log for a session id.
 *
 * Codex buries the file under a `yyyy/mm/dd` path and prefixes the name with the
 * start timestamp, so the id alone does not give the path. Walking the tree
 * newest-day-first finds it in a couple of `readdir`s instead of a full scan,
 * and the answer is memoised by the caller.
 */
export function findRollout(sessionId: string, root = SESSIONS_ROOT): string | null {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return null;
  const suffix = `-${sessionId}.jsonl`;
  const descend = (dir: string, depth: number): string | null => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    if (depth === 0) {
      const hit = names.find((name) => name.endsWith(suffix));
      return hit ? join(dir, hit) : null;
    }
    // Newest first: a live session is almost always under today's date.
    for (const name of names.toSorted().toReversed()) {
      try {
        if (!statSync(join(dir, name)).isDirectory()) continue;
      } catch {
        continue;
      }
      const found = descend(join(dir, name), depth - 1);
      if (found) return found;
    }
    return null;
  };
  return descend(root, 3);
}

/**
 * 128 KB, matching the Claude adapter, and always the same window.
 *
 * `turn_context` is written once per turn while `token_count` is written many
 * times, so the model can sit much further back than the newest cache numbers.
 * A smaller tail finds the tokens and loses the model, which silently demotes
 * every GPT-5.6 session to the 5-minute rule.
 */
const TAIL_BYTES = 128 * 1024;

function tailText(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * The shape of a rollout line, as far as this adapter cares.
 *
 * Every field is optional because the file belongs to Codex, not to us: it is
 * third-party JSONL whose schema moves between releases. Declaring the shape and
 * decoding once at this boundary is what keeps `typeof` checks out of the rest
 * of the adapter.
 */
interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
}

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    turn_id?: string;
    model?: string;
    info?: { last_token_usage?: TokenUsage };
  };
}

function parseLine(line: string): RolloutLine | null {
  try {
    // SAFETY: third-party JSONL. Every field on RolloutLine is optional and every
    // read below is guarded, so a schema change degrades to "no data" rather than
    // to a wrong number.
    return JSON.parse(line) as RolloutLine;
  } catch {
    return null;
  }
}

/** A token count only counts when it is a real number; a missing field is not a zero. */
function tokenCount(value: number | undefined): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

async function probe(pane: PaneInfo, store: AdapterStore): Promise<Probe | null> {
  const sessionId = pane.agent_session?.value;
  if (!sessionId || pane.agent_session?.kind !== "id") return null;

  const memo = store.get();
  let path = memo?.logPath ?? "";
  if (!path || !existsSync(path)) {
    path = findRollout(sessionId) ?? "";
    if (!path) return null;
    store.put({ logPath: path });
  }

  const text = tailText(path);
  if (!text) return null;

  let lastRequestAt = 0;
  let stamp = "";
  let turnId = "";
  let model: string | undefined;
  let usage: TokenUsage | undefined;

  // Backwards, newest first, taking the first of each thing we need. The three
  // live on DIFFERENT records: the clock on any timestamped line, the cache
  // numbers on `token_count`, the turn id and model on `turn_context`.
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]?.trim();
    if (!raw) continue;
    const entry = parseLine(raw);
    if (!entry) continue;

    if (lastRequestAt === 0) {
      const at = Date.parse(entry.timestamp ?? "");
      if (!Number.isNaN(at)) {
        lastRequestAt = at;
        stamp = entry.timestamp ?? "";
      }
    }
    // `last_token_usage` is the TURN; `total_token_usage` is a running total that
    // reaches millions and would read as permanently warm. Only ever the former.
    if (!usage && entry.payload?.type === "token_count") {
      usage = entry.payload.info?.last_token_usage;
    }
    if (!turnId && entry.type === "turn_context") {
      turnId = entry.payload?.turn_id ?? "";
      model = entry.payload?.model;
    }
    if (lastRequestAt !== 0 && usage && turnId) break;
  }

  if (lastRequestAt === 0) return null;

  const cacheReadTokens = tokenCount(usage?.cached_input_tokens);
  const cacheCreationTokens = tokenCount(usage?.cache_write_input_tokens);
  const detail = usage ? `cache read ${cacheReadTokens ?? "?"}` : "no token_count in tail";

  return {
    lastRequestAt,
    // The turn id keeps a cold turn judged once. Falling back to the timestamp
    // is correct but coarser: `token_count` fires many times per turn, so a
    // timestamp key re-judges the same turn on every tick.
    turnId: turnId || String(lastRequestAt),
    cacheReadTokens,
    cacheCreationTokens,
    model,
    evidence: `${path} (${stamp}${model ? `, ${model}` : ""}, ${detail})`,
  };
}

/**
 * The `~/.codex/auth.json` fields that name a plan. No token VALUE is ever read.
 *
 * Codex's Rust source exposes a rich `id_token` with a `chatgpt_plan_type` on it,
 * and it is tempting to read the plan straight off that. On DISK `id_token` is a
 * JWT string, so getting the plan would mean decoding the credential itself —
 * which is exactly what this plugin promises never to do. It is typed as the
 * string it is so nobody reaches into it by accident.
 */
interface CodexAuth {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  tokens?: { access_token?: string; id_token?: string };
}

function readAuth(path: string): CodexAuth | null {
  try {
    // SAFETY: operator's credential file. Only the plan-naming fields declared on
    // CodexAuth are read; no token value is read, logged or stored.
    return JSON.parse(readFileSync(path, "utf8")) as CodexAuth;
  } catch {
    return null;
  }
}

/**
 * ChatGPT plan or API key?
 *
 * Newer Codex builds record the answer outright in `auth_mode`, which is
 * stronger than the presence check this used to do — so when it is there, the
 * detection is `certain`. It is NOT always there: the file on the machine this
 * was written against has no `auth_mode` at all, which is why the presence
 * fallback below stays.
 *
 * Only the fields that NAME A PLAN are read here — never a token value.
 */
async function detectTier(_pane: PaneInfo): Promise<TierDetection> {
  const evidence: string[] = [];
  const authPath = join(homedir(), ".codex", "auth.json");
  if (existsSync(authPath)) {
    const auth = readAuth(authPath);
    if (!auth) {
      evidence.push("~/.codex/auth.json is unreadable");
    } else {
      const mode = auth.auth_mode?.toLowerCase() ?? "";
      const hasKey = (auth.OPENAI_API_KEY ?? "").length > 0;
      const hasOauth = Boolean(auth.tokens?.access_token);

      if (mode.startsWith("chatgpt")) {
        evidence.push(`~/.codex/auth.json auth_mode is "${auth.auth_mode}"`);
        return { tier: "subscription", confidence: "certain", evidence };
      }
      if (mode === "apikey") {
        evidence.push("~/.codex/auth.json auth_mode is an API key");
        return { tier: "api", confidence: "certain", evidence };
      }
      // No auth_mode: an older Codex, or a file written by another tool. Fall
      // back to which slot is filled.
      if (hasOauth && !hasKey) {
        evidence.push("~/.codex/auth.json holds a ChatGPT login and no API key");
        return { tier: "subscription", confidence: "likely", evidence };
      }
      if (hasKey) {
        evidence.push("~/.codex/auth.json holds an API key");
        return { tier: "api", confidence: hasOauth ? "guess" : "likely", evidence };
      }
    }
  }
  if (process.env.OPENAI_API_KEY) {
    evidence.push("OPENAI_API_KEY is in the environment");
    return { tier: "api", confidence: "guess", evidence };
  }
  evidence.push("no Codex credentials found — the shorter of OpenAI's two cache regimes is assumed");
  return { tier: "unknown", confidence: "guess", evidence };
}

/**
 * The TTL for the model this session is actually on.
 *
 * Returns null for an unrecognised model rather than picking a regime, so an
 * unknown name falls back to the pessimistic tier rule instead of being promoted
 * to 30 minutes on no evidence.
 */
function ttlForProbe(p: Probe): Sourced<number> | null {
  if (!p.model) return null;
  const regime = openaiCacheRegime(p.model);
  if (!regime) return null;
  const rule = OPENAI_REGIMES[regime];
  return { ...rule, note: `${p.model}: ${rule.note}` };
}

export const codexAdapter: HarnessAdapter = {
  id: "codex",
  label: "Codex CLI",
  rules: CODEX_RULES,
  detectTier,
  probe,
  ttlForProbe,
};
