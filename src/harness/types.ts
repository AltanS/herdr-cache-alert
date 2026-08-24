/**
 * The extension point.
 *
 * A harness is one way of talking to a model — Claude Code on a subscription,
 * Codex against the OpenAI API, an OpenRouter gateway. Each has its own cache
 * rules and its own idea of where the evidence lives, so each gets an adapter.
 *
 * Adding one is a single file exporting a `HarnessAdapter` plus one line in
 * `index.ts`. There is deliberately no `matches(pane)` hook: Herdr already
 * labels the pane's agent, and the registry is a map from that label onto an
 * adapter. Fuzzy self-matching would eventually let two adapters claim one pane,
 * and the loser would be whichever one happened to be registered second.
 */

import type { CacheRule, Sourced, Tier } from "../claims.ts";
import type { PaneInfo } from "../herdr.ts";
import type { SessionMemo } from "../store.ts";

/**
 * What an adapter concluded about how this pane is billed, and why.
 *
 * `evidence` is not decoration — it is what `cache-alert explain` prints when
 * an operator asks why the badge says what it says. Tier detection is guesswork
 * dressed as fact otherwise.
 */
export interface TierDetection {
  tier: Tier;
  confidence: "certain" | "likely" | "guess";
  evidence: string[];
}

/** One measurement of what the harness actually did on its last turn. */
export interface Probe {
  /** Epoch ms of the last outbound request. The clock the TTL runs against. */
  lastRequestAt: number;
  /** Identifies the turn, so one cold turn is judged once and not on every tick. */
  turnId: string;
  /** Tokens served FROM cache on that turn. */
  cacheReadTokens?: number;
  /** Tokens written TO cache on that turn. */
  cacheCreationTokens?: number;
  /**
   * TTL the harness itself asked for, when its telemetry says. This BEATS any
   * documented rule: it is what happened, not what should happen.
   */
  observedTtlSeconds?: Sourced<number>;
  model?: string;
  /** Where this came from, for `explain`. */
  evidence: string;
}

/**
 * The slice of persisted state an adapter is allowed to touch.
 *
 * Adapters need to remember tail offsets and resolved log paths across
 * restarts. Handing them the plugin's own store keeps that in one file with one
 * ageing policy, instead of each adapter inventing its own dotfile.
 */
export interface AdapterStore {
  get(): SessionMemo | null;
  put(patch: Partial<SessionMemo>): SessionMemo;
}

export interface HarnessAdapter {
  /** Matches the `agent` label Herdr reports for the pane. */
  id: string;
  label: string;
  /**
   * Subscription or API key? Cheap, and allowed to be wrong — which is why it
   * returns its confidence. The engine assumes the SHORTER TTL when unsure: a
   * wrong "5m" warns early, a wrong "1h" promises a cache that is already gone.
   */
  detectTier(pane: PaneInfo): Promise<TierDetection>;
  /**
   * Read the harness's own telemetry. `null` when there is none to read — a
   * fresh session, an adapter with no log to tail, a pane adopted mid-flight.
   * Never guess here; the engine paints nothing rather than paint a fiction.
   */
  probe(pane: PaneInfo, store: AdapterStore): Promise<Probe | null>;
  /**
   * A TTL the harness's OWN configuration forces, regardless of tier — Claude
   * Code's `ENABLE_PROMPT_CACHING_1H` is the motivating case. Ranks above the
   * tier rule and below anything measured.
   */
  ttlOverride?(pane: PaneInfo): Sourced<number> | null;
  /**
   * A TTL implied by what the probe FOUND, rather than by the tier.
   *
   * Tier is the wrong axis for some harnesses and pretending otherwise ships a
   * wrong number. OpenAI's cache lifetime follows the MODEL — 30 minutes on
   * GPT-5.6 and later, 5-10 minutes idle on everything before it — and both
   * appear in one operator's rollout logs. opencode is worse: it is a different
   * upstream provider per session, so its cache rule is not knowable until the
   * session has been read.
   *
   * Optional, so every existing adapter keeps working untouched. Ranks below
   * operator configuration and above the tier rule: it is still a documented
   * rule, only a better-aimed one.
   */
  ttlForProbe?(probe: Probe): Sourced<number> | null;
  /** Every (tier) rule this harness ships. Sourced, or it does not ship. */
  rules: CacheRule[];
}

/** The rule for a tier, falling back to the shortest TTL the harness knows. */
export function ruleFor(adapter: HarnessAdapter, tier: Tier): CacheRule | null {
  const exact = adapter.rules.find((rule) => rule.tier === tier);
  if (exact) return exact;
  // Unknown tier: take the most pessimistic rule the harness has. Being early
  // is a nuisance; being late is a cold cache the operator was told was warm.
  let shortest: CacheRule | null = null;
  for (const rule of adapter.rules) {
    if (shortest === null || rule.ttlSeconds.value < shortest.ttlSeconds.value) shortest = rule;
  }
  return shortest;
}
