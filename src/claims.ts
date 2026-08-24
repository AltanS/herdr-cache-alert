/**
 * Sourced claims — the contract every cache number in this plugin must satisfy.
 *
 * Cache lifetimes are VENDOR BEHAVIOUR, not a standard. They are changed without
 * warning, they differ between a subscription and an API key, and half of what
 * is written about them online is someone's guess. So no bare constant is
 * allowed anywhere in `src/harness/`: a number ships with a link, a date, and
 * the sentence it came from, or it does not ship.
 *
 * `retrievedAt` is the load-bearing field. `cache-alert claims --stale` turns a
 * number nobody has re-checked in months into a visible warning, so the table
 * rots loudly instead of silently.
 */

export type Confidence =
  /** Stated outright in the vendor's own documentation. */
  | "documented"
  /** Stated by the vendor somewhere softer — a blog, a changelog, a support reply. */
  | "reported"
  /** Nobody documents it; derived from what IS documented. Say so out loud. */
  | "inferred"
  /** Measured from the harness's own telemetry on this machine. Beats all of the above. */
  | "observed";

export interface Source {
  /** The exact page the claim was read on. Never a search result, never a guess. */
  url: string;
  title: string;
  publisher: string;
  /** ISO date (YYYY-MM-DD) the claim was last checked against that page. */
  retrievedAt: string;
  /** Verbatim from the page. If it cannot be quoted, it is not `documented`. */
  quote?: string;
  kind: "vendor-doc" | "vendor-blog" | "vendor-changelog" | "community" | "observed";
}

export interface Sourced<T> {
  value: T;
  confidence: Confidence;
  source: Source;
  /** Anything a reader needs in order to not misread `value`. */
  note?: string;
}

/** Convenience for the observed case, where the "source" is this machine. */
export function observed<T>(value: T, evidence: string, at: Date = new Date()): Sourced<T> {
  return {
    value,
    confidence: "observed",
    source: {
      url: "",
      title: evidence,
      publisher: "local telemetry",
      retrievedAt: at.toISOString().slice(0, 10),
      kind: "observed",
    },
  };
}

export type Tier = "subscription" | "api" | "unknown";

export interface CacheRule {
  /** Stable id, `<harness>.<tier>` — what config and `--force-rule` name. */
  id: string;
  harness: string;
  tier: Tier;
  /** What an operator would call this setup. */
  label: string;
  /** Idle seconds before the cached prefix is gone. THE number this plugin exists for. */
  ttlSeconds: Sourced<number>;
  /** Smallest cacheable prefix, where the vendor states one. */
  minTokens?: Sourced<number>;
  /** Does a cache hit restart the clock, or does the TTL run from creation? */
  slidingWindow: boolean;
  /** Implicit caching, or does the caller have to place cache_control breakpoints? */
  automatic: boolean;
  /** Backing for `slidingWindow`, `automatic`, and anything in `notes`. */
  sources: Source[];
  notes?: string[];
}

/** Days between `retrievedAt` and now. Infinity when the date is unparseable. */
export function claimAgeDays(source: Source, now: Date = new Date()): number {
  const at = Date.parse(source.retrievedAt);
  if (Number.isNaN(at)) return Infinity;
  return Math.floor((now.getTime() - at) / 86_400_000);
}

export interface StaleClaim {
  ruleId: string;
  field: string;
  ageDays: number;
  source: Source;
}

/** Every claim in `rules` older than `maxDays`. Feeds `cache-alert claims --stale`. */
export function staleClaims(rules: readonly CacheRule[], maxDays: number, now: Date = new Date()): StaleClaim[] {
  const out: StaleClaim[] = [];
  const check = (ruleId: string, field: string, source: Source) => {
    // An observed claim is re-measured on every probe, so it cannot go stale.
    if (source.kind === "observed") return;
    const ageDays = claimAgeDays(source, now);
    if (ageDays > maxDays) out.push({ ruleId, field, ageDays, source });
  };
  for (const rule of rules) {
    check(rule.id, "ttlSeconds", rule.ttlSeconds.source);
    if (rule.minTokens) check(rule.id, "minTokens", rule.minTokens.source);
    rule.sources.forEach((source, i) => check(rule.id, `sources[${i}]`, source));
  }
  return out;
}
