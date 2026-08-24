/**
 * pane → cache state. The one place the numbers are decided.
 *
 * Two rules govern everything here:
 *
 *   MEASURED BEATS DOCUMENTED. If the harness's telemetry says the session
 *   wrote to a one-hour cache, that is the TTL — no documented rule, tier guess
 *   or environment sniff can outvote it.
 *
 *   WHEN UNSURE, BE PESSIMISTIC. An unknown tier takes the harness's SHORTEST
 *   rule. A wrong early warning costs a glance; a wrong "still warm" sends the
 *   operator back to a cache that expired ten minutes ago.
 */

import { observed, type CacheRule, type Sourced, type Tier } from "./claims.ts";
import type { PaneInfo } from "./herdr.ts";
import { adapterFor } from "./harness/index.ts";
import { ruleFor, type AdapterStore, type HarnessAdapter, type Probe, type TierDetection } from "./harness/types.ts";
import { getMemo, putMemo, type SessionMemo } from "./store.ts";
import type { Config } from "./config.ts";

export type Phase =
  /** Comfortably cached. */
  | "warm"
  /** Still cached, but the clock is nearly out. */
  | "expiring"
  /** No usable cache: the last turn missed, or the TTL has elapsed. */
  | "cold"
  /** Nothing is known. The badge stays OFF — silence beats a question mark. */
  | "unknown";

export interface CacheState {
  phase: Phase;
  /** Epoch ms the cache dies, when a clock exists at all. */
  expiresAt: number | null;
  secondsLeft: number | null;
  /** Why it is cold. `observed` = a turn came back cold; `expired` = the clock ran out. */
  coldReason: "observed" | "expired" | null;
  /** The TTL in force, with its provenance — this is what `explain` prints. */
  ttl: Sourced<number> | null;
  tier: TierDetection | null;
  rule: CacheRule | null;
  adapter: HarnessAdapter | null;
  probe: Probe | null;
  sessionId: string | null;
}

const UNKNOWN: CacheState = {
  phase: "unknown",
  expiresAt: null,
  secondsLeft: null,
  coldReason: null,
  ttl: null,
  tier: null,
  rule: null,
  adapter: null,
  probe: null,
  sessionId: null,
};

/**
 * The warn threshold, as a fraction of the TTL rather than a flat number.
 *
 * A flat 300s against a 5-minute TTL would mark every pane "expiring" from the
 * moment it was born, which is how a warning becomes wallpaper.
 */
export function warnSecondsFor(ttlSeconds: number): number {
  return Math.max(60, Math.round(ttlSeconds * 0.25));
}

/** A turn that read nothing from cache while writing to it missed. */
export function isColdTurn(probe: Probe): boolean {
  if (probe.cacheReadTokens === undefined) return false; // no telemetry ≠ cold
  return probe.cacheReadTokens === 0 && (probe.cacheCreationTokens ?? 0) > 0;
}

/**
 * The memo key is `<adapter>:<session>`, not the session alone.
 *
 * An adapter's memo holds ITS view of the session — the log file it resolved,
 * the TTL it measured. Two adapters pointed at one session (which happens the
 * moment an operator forces one with `CACHE_ALERT_HARNESS`) would otherwise
 * read each other's resolved log path and report numbers from a file they never
 * opened.
 */
export function memoKey(adapterId: string, sessionId: string): string {
  return `${adapterId}:${sessionId}`;
}

function storeFor(adapterId: string, sessionId: string): AdapterStore {
  const key = memoKey(adapterId, sessionId);
  return {
    get: () => getMemo(key),
    put: (patch: Partial<SessionMemo>) => putMemo(key, patch),
  };
}

/**
 * Reads a pane and decides what its cache is doing.
 *
 * Writes back to the store as a side effect: the tail offset, the last request
 * time and the cold mark all have to survive the next tick and the next server
 * restart. That is deliberate — `evaluate` is the only caller that has both the
 * fresh probe and the remembered state in hand.
 */
export async function evaluate(
  pane: PaneInfo,
  cfg: Config,
  now = Date.now(),
  /**
   * WRITING IS OPT-IN, and the default is the safe one.
   *
   * The memo is a read-modify-write with no lock, and the callers are not one
   * process: five `[[events]]` hooks, the watcher, `status`, `doctor`, `panel`
   * and the toggle all evaluate. Four concurrent hook processes inside one
   * second were measured here. A lost update can drop `observedTtlSeconds`,
   * which is precedence level 2 — that flips a badge from 59m to 4m.
   *
   * So only the painter writes. Anything that merely DISPLAYS gets the default
   * and cannot corrupt what the painter remembers.
   */
  opts: { persist?: boolean } = {},
): Promise<CacheState> {
  const adapter = adapterFor(pane, cfg.forceHarness);
  if (!adapter) return UNKNOWN;

  const sessionId = pane.agent_session?.value ?? null;
  if (!sessionId) return { ...UNKNOWN, adapter };

  const store = storeFor(adapter.id, sessionId);
  const memo = store.get();
  // SAFETY: `forceTier` is operator configuration, so it is a free-form string
  // here. A value outside Tier simply matches no rule in `ruleFor`, which then
  // falls back to the harness's shortest — the same pessimistic path an
  // undetectable tier takes. A typo costs an early warning, never a wrong TTL.
  const forced = cfg.forceTier as Tier;
  const tier = cfg.forceTier
    ? { tier: forced, confidence: "certain" as const, evidence: [`forced by config: ${cfg.forceTier}`] }
    : await adapter.detectTier(pane);
  const rule = ruleFor(adapter, tier.tier);
  const probe = await adapter.probe(pane, store);

  // Precedence: measured now, measured earlier, harness config, the rule for the
  // model actually in use, the tier rule.
  //
  // The "measured earlier" step matters: a tick between turns has no probe to
  // read, and dropping back to the documented rule there would make the badge
  // flip between 1h and 5m depending on how recently the agent replied.
  //
  // `ttlForProbe` sits below operator configuration and above the tier rule. It
  // is still a documented rule, only aimed at what the session is really doing:
  // one Codex operator has both gpt-5.1-codex (5-10 minutes) and gpt-5.6 (30
  // minutes) in their logs, and a per-tier number is wrong for one of them.
  const remembered: Sourced<number> | null =
    memo && memo.observedTtlSeconds > 0
      ? observed(memo.observedTtlSeconds, "remembered from an earlier turn of this session")
      : null;
  const byProbe = probe ? (adapter.ttlForProbe?.(probe) ?? null) : null;
  const ttl =
    probe?.observedTtlSeconds ?? remembered ?? adapter.ttlOverride?.(pane) ?? byProbe ?? rule?.ttlSeconds ?? null;

  // A probe is the best clock. Without one, fall back to whatever the last probe
  // left behind — never to "now", which would paint a warm badge on a pane that
  // has been idle since yesterday.
  const lastRequestAt = probe?.lastRequestAt ?? memo?.lastRequestAt ?? 0;
  if (!ttl || lastRequestAt === 0) {
    return { ...UNKNOWN, adapter, tier, rule, probe, sessionId };
  }

  // A NEW turn re-judges the cold mark: cold sets it, warm clears it. An
  // unchanged turn id leaves the mark alone, so one cold turn is judged once.
  let lastColdAt = memo?.lastColdAt ?? 0;
  if (probe && probe.turnId !== memo?.lastTurnId && probe.cacheReadTokens !== undefined) {
    lastColdAt = isColdTurn(probe) ? probe.lastRequestAt : 0;
  }

  if (opts.persist === true) {
    store.put({
      lastTurnId: probe?.turnId ?? memo?.lastTurnId ?? "",
      lastRequestAt,
      lastColdAt,
      paneId: pane.pane_id,
      observedTtlSeconds: probe?.observedTtlSeconds?.value ?? memo?.observedTtlSeconds ?? 0,
    });
  }

  const expiresAt = lastRequestAt + ttl.value * 1000;
  const secondsLeft = Math.round((expiresAt - now) / 1000);

  // The observed cold mark is sticky: it survives until a warm turn clears it,
  // because the operator needs to see the miss they just paid for even if they
  // were looking elsewhere when it happened.
  if (lastColdAt > 0) {
    return { phase: "cold", expiresAt, secondsLeft, coldReason: "observed", ttl, tier, rule, adapter, probe, sessionId };
  }
  if (secondsLeft <= 0) {
    return { phase: "cold", expiresAt, secondsLeft, coldReason: "expired", ttl, tier, rule, adapter, probe, sessionId };
  }
  const phase: Phase = secondsLeft <= warnSecondsFor(ttl.value) ? "expiring" : "warm";
  return { phase, expiresAt, secondsLeft, coldReason: null, ttl, tier, rule, adapter, probe, sessionId };
}
