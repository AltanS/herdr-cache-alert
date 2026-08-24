/**
 * Claude Code.
 *
 * The best-served adapter, because Claude Code writes a transcript we can read:
 * `~/.claude/projects/<slug>/<session-uuid>.jsonl`, one JSON object per line.
 * Herdr hands us that uuid in `pane.agent_session.value`, so the pane and the
 * transcript line up without any guessing.
 *
 * Each assistant entry carries `message.usage`, which answers BOTH questions
 * this plugin exists to answer:
 *   - `cache_read_input_tokens` = 0 with real work behind it → the turn was COLD
 *   - `cache_creation.ephemeral_1h_input_tokens` > 0 → the session is on the
 *     one-hour TTL, measured rather than assumed
 * The second one is why `detectTier` is a fallback here and not the main event.
 */

import { existsSync, readdirSync, openSync, readSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CacheRule, Sourced } from "../claims.ts";
import { observed } from "../claims.ts";
import type { PaneInfo } from "../herdr.ts";
import type { AdapterStore, HarnessAdapter, Probe, TierDetection } from "./types.ts";

const CACHING_DOC = {
  url: "https://code.claude.com/docs/en/prompt-caching",
  title: "How Claude Code uses prompt caching",
  publisher: "Anthropic",
  retrievedAt: "2026-08-24",
  kind: "vendor-doc",
} as const;

const API_DOC = {
  url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
  title: "Prompt caching — Claude Platform Docs",
  publisher: "Anthropic",
  retrievedAt: "2026-08-24",
  kind: "vendor-doc",
} as const;

const SLIDING: Sourced<boolean>["source"] = {
  ...CACHING_DOC,
  quote:
    "Cached prefixes expire after a period of inactivity. Each request that hits the cache resets the timer, so the cache stays warm as long as you keep working.",
};

export const CLAUDE_RULES: CacheRule[] = [
  {
    id: "claude.subscription",
    harness: "claude",
    tier: "subscription",
    label: "Claude Code on a Claude subscription (Pro/Max)",
    ttlSeconds: {
      value: 3600,
      confidence: "documented",
      source: {
        ...CACHING_DOC,
        quote:
          "On a Claude subscription, Claude Code requests the one-hour TTL automatically, so the cache survives breaks of up to an hour.",
      },
    },
    slidingWindow: true,
    automatic: true,
    sources: [SLIDING],
    notes: [
      "Drops to the five-minute TTL once you are over the plan limit and drawing on usage credits, because a 1h cache write costs more. ENABLE_PROMPT_CACHING_1H=1 keeps the hour.",
      "Subagents use the five-minute TTL even on a subscription — the automatic hour applies to the main conversation only.",
      "The cache is scoped to one machine AND one directory: two sessions in different directories never share it.",
    ],
  },
  {
    id: "claude.api",
    harness: "claude",
    tier: "api",
    label: "Claude Code on an API key or third-party provider",
    ttlSeconds: {
      value: 300,
      confidence: "documented",
      source: {
        ...CACHING_DOC,
        quote:
          "On an API key, Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, or Claude Platform on AWS, you pay the per-token rates, so the TTL stays at the cheaper five minutes by default.",
      },
    },
    minTokens: {
      value: 1024,
      confidence: "documented",
      note: "Model-dependent — 1024 for Sonnet-class models, 512 for the Opus/Fable class. The lower bound is used here.",
      source: {
        ...API_DOC,
        quote: "Shorter prompts cannot be cached, even if marked with `cache_control`.",
      },
    },
    slidingWindow: true,
    automatic: true,
    sources: [
      SLIDING,
      {
        ...CACHING_DOC,
        quote: "To opt into the one-hour TTL, set `ENABLE_PROMPT_CACHING_1H=1`.",
      },
    ],
    notes: [
      "ENABLE_PROMPT_CACHING_1H=1 buys the hour here too, at a higher cache-write rate.",
      "On Amazon Bedrock, caching support and 1h availability vary by model — zero cache tokens usually means the model does not support it.",
    ],
  },
];

/**
 * Claude Code's own TTL variables. Documented, and they beat the tier outright —
 * an API-key session with ENABLE_PROMPT_CACHING_1H=1 really does hold the hour.
 *
 * Caveat worth knowing: this reads OUR environment. It is the operator's shell
 * environment, which is usually the pane's too, but Herdr exposes no per-pane
 * environment, so "usually" is as strong as this gets.
 */
function ttlOverride(): Sourced<number> | null {
  if (process.env.FORCE_PROMPT_CACHING_5M === "1") {
    return {
      value: 300,
      confidence: "documented",
      note: "FORCE_PROMPT_CACHING_5M=1 is set in this process's environment",
      source: {
        ...CACHING_DOC,
        quote: "Set `FORCE_PROMPT_CACHING_5M=1` to force the five-minute TTL regardless of authentication.",
      },
    };
  }
  if (process.env.ENABLE_PROMPT_CACHING_1H === "1") {
    return {
      value: 3600,
      confidence: "documented",
      note: "ENABLE_PROMPT_CACHING_1H=1 is set in this process's environment",
      source: { ...CACHING_DOC, quote: "To opt into the one-hour TTL, set `ENABLE_PROMPT_CACHING_1H=1`." },
    };
  }
  return null;
}

/**
 * Subscription or API key?
 *
 * Ranked, because every single signal here can lie. `ANTHROPIC_API_KEY` being
 * SET does not mean it is USED — an OAuth login wins over it, and an
 * `apiKeyHelper` supplies one without the variable existing at all. And Herdr
 * exposes no per-pane environment, so what we read is the environment of THIS
 * process, which is the operator's, not necessarily the pane's.
 *
 * Hence the confidence field, and hence the engine's rule of taking the shorter
 * TTL whenever confidence is not `certain`.
 */
async function detectTier(): Promise<TierDetection> {
  const evidence: string[] = [];

  // A third-party provider is unambiguous: those never run on subscription billing.
  const provider = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].find(
    (name) => process.env[name] === "1",
  );
  if (provider) {
    evidence.push(`${provider}=1 — a third-party provider is billed per token`);
    return { tier: "api", confidence: "certain", evidence };
  }
  if (process.env.ANTHROPIC_BASE_URL) {
    evidence.push("ANTHROPIC_BASE_URL is set — requests go through a gateway, which bills per token");
    return { tier: "api", confidence: "likely", evidence };
  }

  // The ONE field of the credentials file this plugin is allowed to look at.
  // Declaring the shape this narrowly is the enforcement: there is no property
  // here to read a token through.
  interface ClaudeCredentials {
    claudeAiOauth?: { subscriptionType?: string };
  }

  // The OAuth credentials file names the subscription outright. Only ONE field
  // is read: the rest of that file is access and refresh TOKENS, which this
  // plugin must never touch, log, or copy anywhere.
  const credsPath = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(credsPath)) {
    try {
      // SAFETY: the operator's credential file. Only `subscriptionType` is
      // declared and only it is read; the access and refresh tokens beside it
      // are never named, so they cannot be reached by accident.
      const creds = JSON.parse(readFileSync(credsPath, "utf8")) as ClaudeCredentials;
      const kind = creds.claudeAiOauth?.subscriptionType ?? "";
      if (kind) {
        evidence.push(`~/.claude/.credentials.json names an active "${kind}" subscription`);
        if (process.env.ANTHROPIC_API_KEY) {
          evidence.push("ANTHROPIC_API_KEY is also set — an OAuth login takes precedence over it");
          return { tier: "subscription", confidence: "likely", evidence };
        }
        return { tier: "subscription", confidence: "certain", evidence };
      }
    } catch {
      evidence.push("~/.claude/.credentials.json is unreadable");
    }
  }

  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    evidence.push("an API key is in the environment and no subscription login was found");
    return { tier: "api", confidence: "likely", evidence };
  }

  evidence.push("no subscription login and no API key found — this process may not share the pane's environment");
  return { tier: "unknown", confidence: "guess", evidence };
}

/**
 * The transcript for a session uuid.
 *
 * Found by GLOB, never by reimplementing Claude Code's cwd→slug rule: that rule
 * has to survive dots, spaces and worktree paths, and a near-miss here is a
 * silent "no data" rather than an error. The resolved path is memoised, so the
 * directory scan happens once per session, not once per tick.
 */
export function findTranscript(sessionId: string, root = join(homedir(), ".claude", "projects")): string | null {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return null; // never let an id become a path traversal
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * How much of the tail to read. Big enough to contain the last assistant turn
 * even after a few large tool results, small enough to be free.
 */
const TAIL_BYTES = 128 * 1024;

/**
 * Reads the last TAIL_BYTES of a file.
 *
 * ALWAYS the same window — never a remembered offset. A resume-from-offset read
 * is the right shape for streaming every turn, and the wrong shape for this:
 * all we ever want is the NEWEST turn, and a tick where nothing new was written
 * would read zero bytes and conclude, wrongly, that there is no turn at all.
 *
 * The seek is what keeps this cheap. A transcript directory on this machine
 * measured 3.7 GB, so reading whole files per tick was never an option.
 */
function readTail(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) return "";
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, start);
    const text = buffer.toString("utf8");
    // Unless we started at byte 0, the first line is a fragment of one.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

interface Usage {
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
}

/**
 * The TTL this session is actually running on, read off the turn itself.
 *
 * `usage.cache_creation` splits the write between the two TTLs, so a turn that
 * wrote 1h tokens proves the session asked for the hour. This outranks every
 * documented rule and every environment guess in the engine — it is the one
 * claim in the whole plugin that is measured rather than cited.
 */
function ttlFromUsage(usage: Usage, path: string): Sourced<number> | undefined {
  const split = usage.cache_creation;
  if (!split) return undefined;
  const hour = split.ephemeral_1h_input_tokens ?? 0;
  const fiveMin = split.ephemeral_5m_input_tokens ?? 0;
  if (hour > 0) return observed(3600, `${hour} tokens written to the 1h cache in ${path}`);
  if (fiveMin > 0) return observed(300, `${fiveMin} tokens written to the 5m cache in ${path}`);
  return undefined;
}

async function probe(pane: PaneInfo, store: AdapterStore): Promise<Probe | null> {
  const sessionId = pane.agent_session?.value;
  if (!sessionId || pane.agent_session?.kind !== "id") return null;

  const memo = store.get();
  let path = memo?.logPath ?? "";
  if (!path || !existsSync(path)) {
    path = findTranscript(sessionId) ?? "";
    if (!path) return null;
    store.put({ logPath: path });
  }

  const tail = readTail(path);
  if (tail === null) return null;

  // Walk backwards: the newest assistant turn is the only one that matters, and
  // the tail usually holds several.
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !line.includes('"assistant"')) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    const usage: Usage = entry.message?.usage ?? {};
    const at = Date.parse(entry.timestamp ?? "");
    if (Number.isNaN(at)) continue;
    return {
      lastRequestAt: at,
      turnId: entry.message?.id ?? entry.uuid ?? String(at),
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      observedTtlSeconds: ttlFromUsage(usage, path),
      model: entry.message?.model,
      evidence: `${path} (${entry.timestamp})`,
    };
  }

  // The tail held no assistant turn at all — a session that has only just
  // started, or one turn larger than the window. The engine falls back to what
  // the last successful probe left in the store.
  return null;
}

export const claudeAdapter: HarnessAdapter = {
  id: "claude",
  label: "Claude Code",
  rules: CLAUDE_RULES,
  async detectTier(_pane: PaneInfo): Promise<TierDetection> {
    return detectTier();
  },
  ttlOverride: () => ttlOverride(),
  probe,
};
