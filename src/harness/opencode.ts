/**
 * opencode (`anomalyco/opencode`, formerly `sst/opencode`).
 *
 * Three things make this adapter different from the other two, and all three
 * shape the code below.
 *
 * **The session id is a gift from Herdr.** opencode's terminal title carries a
 * human title, never an id, and the TUI binds no discoverable port — so there is
 * no way to map a pane to a session from the outside. There does not need to be:
 * Herdr ships an opencode integration (`herdr integration install opencode`)
 * whose plugin reports opencode's own `sessionID` through
 * `pane.report_agent_session`, and drops subagent sessions so the pane keeps the
 * root one. That id arrives as `pane.agent_session.value` and is the whole
 * reason this adapter can read real numbers. Without the integration installed
 * there is no session id and this adapter correctly reports nothing.
 *
 * **The evidence is a live SQLite database, not a log.** `~/.local/share/opencode/opencode.db`
 * in WAL mode, owned by a running process. So: opened READ-ONLY, queried by
 * indexed key, never scanned. "Seek, don't stream" becomes "query, don't scan".
 *
 * **The cache rule is per-SESSION, not per-tier.** opencode is provider-agnostic
 * — every session records its own `providerID`, and the TTL is the upstream's,
 * not opencode's. A per-tier number would be wrong for most sessions, which is
 * what `ttlForProbe` is for.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { CacheRule, Sourced } from "../claims.ts";
import type { PaneInfo } from "../herdr.ts";
import { sqliteQuery } from "../runtime.ts";
import { OPENAI_REGIMES, openaiCacheRegime } from "./codex.ts";
import type { AdapterStore, HarnessAdapter, Probe, TierDetection } from "./types.ts";

const ANTHROPIC_DOC = {
  url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
  title: "Prompt caching — Claude Platform Docs",
  publisher: "Anthropic",
  retrievedAt: "2026-08-24",
  kind: "vendor-doc",
} as const;

const OR_DOC = {
  url: "https://openrouter.ai/docs/features/prompt-caching",
  title: "Prompt Caching — OpenRouter",
  publisher: "OpenRouter",
  retrievedAt: "2026-08-24",
  kind: "vendor-doc",
} as const;

const ANTHROPIC_TTL: Sourced<number> = {
  value: 300,
  confidence: "documented",
  note: "Extendable to an hour by the CALLER sending `\"ttl\": \"1h\"`. opencode is not known to, so the default is assumed. Anthropic also measures the lifetime from the START of the request, not the end of the response — a long streamed answer eats into it, so this countdown is very slightly generous.",
  source: { ...ANTHROPIC_DOC, quote: "By default, the cache has a 5-minute lifetime." },
};

const GOOGLE_TTL: Sourced<number> = {
  value: 180,
  confidence: "reported",
  note: "GAP: Google publishes no TTL for implicit caching. This is OpenRouter's restatement of upstream behaviour, and it gives a RANGE — the low end is used, so the warning arrives early rather than late.",
  source: { ...OR_DOC, quote: "Note that the TTL is on average 3-5 minutes, but will vary" },
};

/**
 * The pessimistic default, used whenever the upstream is unknown or publishes
 * nothing — xAI is the live example here: its docs describe caching as automatic
 * and say cache entries "can be evicted due to memory pressure", but state no
 * lifetime at all. Five minutes is the shortest rule any upstream documents, so
 * it is the safest thing to assume about an upstream that documents nothing.
 */
const UNKNOWN_TTL: Sourced<number> = {
  value: 300,
  confidence: "inferred",
  note: "GAP: this upstream publishes no cache TTL. Five minutes is the shortest lifetime any documented provider uses, assumed here so the badge is early rather than late. It is NOT a number this provider has confirmed.",
  source: { ...OR_DOC, quote: "Note that the TTL is on average 3-5 minutes, but will vary" },
};

/**
 * Rules are per-UPSTREAM and all under tier `api`, because that is the axis the
 * numbers actually vary on. `ruleFor` picks the shortest when the tier is
 * unknown, which for a provider-agnostic agent is the right default.
 */
export const OPENCODE_RULES: CacheRule[] = [
  {
    id: "opencode.anthropic",
    harness: "opencode",
    tier: "api",
    label: "opencode → Anthropic",
    ttlSeconds: { ...ANTHROPIC_TTL },
    slidingWindow: true,
    automatic: false,
    sources: [{ ...ANTHROPIC_DOC, quote: "The cache is refreshed for no additional cost each time the cached content is used." }],
    notes: ["Anthropic needs explicit cache_control breakpoints — a client that sends none gets no cache at all."],
  },
  {
    id: "opencode.openai",
    harness: "opencode",
    tier: "api",
    label: "opencode → OpenAI",
    ttlSeconds: { ...OPENAI_REGIMES.legacy },
    slidingWindow: true,
    automatic: true,
    sources: [OPENAI_REGIMES.legacy.source, OPENAI_REGIMES.modern.source],
    notes: [
      "OpenAI runs two regimes split by model generation. This rule carries the shorter one; a session whose model parses as GPT-5.6 or later gets 30 minutes through `ttlForProbe`.",
    ],
  },
  {
    id: "opencode.google",
    harness: "opencode",
    tier: "api",
    label: "opencode → Google",
    ttlSeconds: { ...GOOGLE_TTL },
    slidingWindow: false,
    automatic: true,
    sources: [{ ...OR_DOC, quote: "Note that the TTL is on average 3-5 minutes, but will vary" }],
    notes: ["Google's implicit cache is best-effort: a hit is never guaranteed, whatever the clock says."],
  },
  {
    id: "opencode.unknown",
    harness: "opencode",
    tier: "api",
    label: "opencode → an upstream that documents no TTL",
    ttlSeconds: { ...UNKNOWN_TTL },
    slidingWindow: false,
    automatic: true,
    sources: [
      {
        url: "https://docs.x.ai/developers/advanced-api-usage/prompt-caching",
        title: "Prompt caching — xAI",
        publisher: "xAI",
        retrievedAt: "2026-08-24",
        kind: "vendor-doc",
        quote: "Cache entries can be evicted due to memory pressure, and requests may be routed to different servers.",
      },
    ],
    notes: [
      "GAP: xAI (and several smaller upstreams) document that caching happens but never how long it lasts. The countdown here is an assumption, not a claim — the WARM/COLD verdict from opencode's own token counts is the trustworthy part of this badge.",
    ],
  },
];

/** Where opencode keeps its database, honouring the same XDG variable it does. */
function dbPath(): string {
  const override = process.env.OPENCODE_DB;
  if (override) return override;
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "opencode.db");
}

/**
 * One assistant message, as stored in `message.data`.
 *
 * opencode's own schema (`packages/schema/src/v1/session.ts`) declares
 * `tokens.cache.read` / `.write` alongside `providerID` and `modelID`. Declaring
 * the shape here and decoding once keeps `typeof` narrowing out of the adapter.
 */
interface MessageData {
  role?: string;
  providerID?: string;
  modelID?: string;
  time?: { created?: number; completed?: number };
  tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
}

/** The columns this adapter selects from `message`. */
interface MessageRow {
  data: string;
  time_created: number;
}

function parseMessage(row: MessageRow): MessageData | null {
  try {
    // SAFETY: opencode's JSON blob, not ours. Every field on MessageData is
    // optional and every read is guarded, so a schema move degrades to "no data".
    return JSON.parse(row.data) as MessageData;
  } catch {
    return null;
  }
}

function tokenCount(value: number | undefined): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The upstream behind a session, as `providerID:modelID`.
 *
 * OpenRouter is a gateway, so `providerID` is `openrouter` for everything and the
 * REAL upstream is the vendor prefix on the model id (`openai/gpt-5.6-sol`,
 * `x-ai/grok-4.6`). Unwrapping that is what lets a gateway session get its
 * upstream's rule instead of the pessimistic default.
 */
export function upstreamOf(providerId: string, modelId: string): string {
  const provider = providerId.toLowerCase();
  if (provider !== "openrouter") return provider;
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash).toLowerCase() : provider;
}

const RULE_BY_UPSTREAM = new Map<string, string>([
  ["anthropic", "opencode.anthropic"],
  ["openai", "opencode.openai"],
  ["google", "opencode.google"],
  ["google-vertex", "opencode.google"],
]);

async function probe(pane: PaneInfo, store: AdapterStore): Promise<Probe | null> {
  const sessionId = pane.agent_session?.value;
  // Herdr's opencode integration reports the session id and nothing else does.
  // A pane without one is a pane where the integration is not installed.
  if (!sessionId || pane.agent_session?.kind !== "id") return null;

  const path = store.get()?.logPath || dbPath();
  if (!existsSync(path)) return null;

  // Newest messages for this session only, by indexed key. A handful, because the
  // last row may be the operator's own message rather than an assistant turn.
  const rows = await sqliteQuery<MessageRow>(
    path,
    "select data, time_created from message where session_id = ? order by time_created desc limit 12",
    [sessionId],
  );
  if (rows.length === 0) return null;
  store.put({ logPath: path });

  for (const row of rows) {
    const message = parseMessage(row);
    if (!message || message.role !== "assistant" || !message.tokens) continue;

    // `time.completed` is when the turn finished; `time.created` is when it
    // started. Either beats the row's own column, which tracks the row and not
    // the request.
    const at = message.time?.completed ?? message.time?.created ?? row.time_created;
    if (!Number.isFinite(at)) continue;

    const cacheReadTokens = tokenCount(message.tokens.cache?.read);
    const cacheCreationTokens = tokenCount(message.tokens.cache?.write);
    const provider = message.providerID ?? "";
    const model = message.modelID ?? "";

    return {
      lastRequestAt: at,
      // Message ids are unique per turn, and `time_created` stands in for one:
      // two assistant turns cannot share a millisecond in this schema.
      turnId: String(row.time_created),
      cacheReadTokens,
      cacheCreationTokens,
      model: provider && model ? `${provider}:${model}` : model || undefined,
      evidence: `${path} (${provider || "?"}:${model || "?"}, cache read ${cacheReadTokens ?? "?"})`,
    };
  }
  return null;
}

/** The `auth.json` entries, by provider id. Only `type` is read — never a key. */
interface AuthEntry {
  type?: string;
}

function readAuthTypes(path: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    // SAFETY: operator's credential file. Only each entry's `type` discriminator
    // is read; no key, token or refresh value is read, logged or stored.
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, AuthEntry>;
    for (const [provider, entry] of Object.entries(parsed)) {
      const kind = entry?.type;
      if (kind) out.set(provider, kind);
    }
  } catch {
    /* unreadable or absent: the caller reports an unknown tier */
  }
  return out;
}

/**
 * Subscription or API key?
 *
 * This matters LESS here than for the other harnesses and the evidence says so:
 * opencode's cache lifetime is set by the upstream provider, not by how the
 * operator pays. The tier is reported for `explain`, and the number that gets
 * painted comes from `ttlForProbe`.
 *
 * `auth.json` stores one entry per provider with a `type` of `oauth` (a browser
 * login, i.e. a subscription) or `api` (a key). Only that discriminator is read.
 */
async function detectTier(_pane: PaneInfo): Promise<TierDetection> {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const authPath = join(dataHome, "opencode", "auth.json");
  const evidence: string[] = ["opencode's cache rule follows the upstream provider, not the payment tier"];

  if (!existsSync(authPath)) {
    evidence.push("no opencode auth.json found");
    return { tier: "unknown", confidence: "guess", evidence };
  }

  const types = readAuthTypes(authPath);
  if (types.size === 0) {
    evidence.push("opencode auth.json holds no readable provider entries");
    return { tier: "unknown", confidence: "guess", evidence };
  }

  const providers = [...types.keys()].toSorted().join(", ");
  const kinds = new Set(types.values());
  evidence.push(`opencode auth.json configures: ${providers}`);

  if (kinds.has("api") && !kinds.has("oauth")) return { tier: "api", confidence: "likely", evidence };
  if (kinds.has("oauth") && !kinds.has("api")) return { tier: "subscription", confidence: "likely", evidence };
  // Both kinds present: which one this SESSION used is not knowable from the
  // credential file, so the tier stays a guess rather than a coin toss.
  evidence.push("both a subscription login and an API key are configured");
  return { tier: "unknown", confidence: "guess", evidence };
}

/**
 * The rule for the upstream this session is really on.
 *
 * `probe.model` arrives as `providerID:modelID`. Gateway sessions are unwrapped
 * to their true upstream first, and an OpenAI upstream is then split again by
 * model generation, because OpenAI's own lifetime depends on it.
 */
function ttlForProbe(p: Probe): Sourced<number> | null {
  if (!p.model) return null;
  const colon = p.model.indexOf(":");
  if (colon < 0) return null;
  const providerId = p.model.slice(0, colon);
  const modelId = p.model.slice(colon + 1);
  const upstream = upstreamOf(providerId, modelId);

  if (upstream === "openai") {
    // The vendor prefix is not part of the model name OpenAI documents, so strip
    // it before asking which regime the name falls under. An unrecognised name
    // takes the shorter regime rather than no rule at all: the upstream IS known
    // to be OpenAI here, and only the generation is in doubt.
    const bare = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
    const chosen = openaiCacheRegime(bare) === "modern" ? OPENAI_REGIMES.modern : OPENAI_REGIMES.legacy;
    return { ...chosen, note: `${bare}: ${chosen.note}` };
  }

  const ruleId = RULE_BY_UPSTREAM.get(upstream);
  const rule = OPENCODE_RULES.find((candidate) => candidate.id === ruleId);
  if (!rule) {
    return { ...UNKNOWN_TTL, note: `${upstream} publishes no cache TTL. ${UNKNOWN_TTL.note}` };
  }
  return { ...rule.ttlSeconds, note: `${upstream}: ${rule.ttlSeconds.note ?? ""}`.trim() };
}

export const opencodeAdapter: HarnessAdapter = {
  id: "opencode",
  label: "opencode",
  rules: OPENCODE_RULES,
  detectTier,
  probe,
  ttlForProbe,
};
