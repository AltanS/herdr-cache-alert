/**
 * OpenRouter — a gateway, not a harness.
 *
 * Nothing calls itself "openrouter" in a pane: an agent reaches OpenRouter
 * through some other CLI, so Herdr labels the pane with that CLI's name. This
 * adapter therefore has no probe and is never auto-selected. It exists to be
 * FORCED (`CACHE_ALERT_HARNESS=openrouter`, or `forceHarness` in config) when
 * the operator knows their agent is pointed at a gateway, and to carry the
 * numbers, which differ sharply by upstream provider.
 *
 * It is also the worked example for the extension contract: rules and a tier
 * detector, no telemetry. That combination is legal and it still earns a
 * countdown.
 */

import type { CacheRule } from "../claims.ts";
import type { PaneInfo } from "../herdr.ts";
import type { HarnessAdapter, Probe, TierDetection } from "./types.ts";

const OR_DOC = {
  url: "https://openrouter.ai/docs/features/prompt-caching",
  title: "Prompt Caching — OpenRouter",
  publisher: "OpenRouter",
  retrievedAt: "2026-08-24",
  kind: "vendor-doc",
} as const;

/**
 * One rule per upstream, all under tier `api` — OpenRouter is billed per token
 * whichever model is behind it. `ruleFor` picks the shortest when the tier is
 * unknown, which for a gateway is the right default: the operator who has not
 * told us which upstream they are on gets the most pessimistic clock.
 */
export const OPENROUTER_RULES: CacheRule[] = [
  {
    id: "openrouter.google",
    harness: "openrouter",
    tier: "api",
    label: "OpenRouter → Google (implicit caching)",
    ttlSeconds: {
      value: 180,
      confidence: "documented",
      note: "OpenRouter gives a 3-5 minute range and says it varies. The LOW end is used, so the warning arrives early rather than late.",
      source: { ...OR_DOC, quote: "Note that the TTL is on average 3-5 minutes, but will vary" },
    },
    slidingWindow: false,
    automatic: true,
    sources: [{ ...OR_DOC, quote: "Note that the TTL is on average 3-5 minutes, but will vary" }],
    notes: ["Google's implicit cache is best-effort: a hit is never guaranteed, whatever the clock says."],
  },
  {
    id: "openrouter.anthropic",
    harness: "openrouter",
    tier: "api",
    label: "OpenRouter → Anthropic",
    ttlSeconds: {
      value: 300,
      confidence: "documented",
      note: 'Extendable to an hour by the CALLER sending "ttl": "1h". Most agent CLIs do not, so the default is assumed.',
      source: {
        ...OR_DOC,
        quote: 'By default, the cache expires after 5 minutes, but you can extend this to 1 hour by specifying "ttl": "1h"',
      },
    },
    slidingWindow: true,
    automatic: false,
    sources: [{ ...OR_DOC, quote: 'By default, the cache expires after 5 minutes' }],
    notes: ["Anthropic upstream needs explicit cache_control breakpoints — a client that sends none gets no cache at all."],
  },
  {
    id: "openrouter.openai",
    harness: "openrouter",
    tier: "api",
    label: "OpenRouter → OpenAI",
    ttlSeconds: {
      value: 1800,
      confidence: "documented",
      source: { ...OR_DOC, quote: "Cached prefixes have a minimum 30-minute TTL" },
    },
    minTokens: {
      value: 1024,
      confidence: "documented",
      source: { ...OR_DOC, quote: "There is a minimum prompt size of 1024 tokens." },
    },
    slidingWindow: true,
    automatic: true,
    sources: [
      { ...OR_DOC, quote: "Prompt caching with OpenAI is automated and does not require any additional configuration." },
    ],
  },
];

export const openrouterAdapter: HarnessAdapter = {
  id: "openrouter",
  label: "OpenRouter gateway",
  rules: OPENROUTER_RULES,
  async detectTier(_pane: PaneInfo): Promise<TierDetection> {
    return {
      tier: "api",
      confidence: "certain",
      evidence: ["a gateway is billed per token — there is no subscription tier to detect"],
    };
  },
  // No telemetry: OpenRouter's usage numbers live in an API response nobody
  // writes to disk. Returning null is the honest answer, and the engine falls
  // back to the pane activity it records itself.
  async probe(): Promise<Probe | null> {
    return null;
  },
};
