/**
 * The badge — 4 to 6 cells on the pane's top border.
 *
 * The word "CACHE" is not on it. At a glance the operator needs ONE fact: is the
 * next turn going to be fast and cheap, or slow and expensive. The state is the
 * label, so the columns go to the number instead of to a noun.
 *
 *   ⚡ 38m left   warm — plenty of clock left
 *   ⚠ 4m left    expiring — finish the thought or accept the rebuild
 *   ❄ COLD       no cache: the last turn missed, or the clock ran out
 *   (nothing)    unknown — never a "?", which is clutter that teaches nothing
 *
 * "left" earns its four cells. Without it the number is ambiguous — a reader's
 * first guess is just as likely to be "the cache is 38 minutes OLD". The border
 * title has an 80-character budget, so brevity was never the binding constraint.
 *
 * NO COLOUR. Herdr's client does not render ANSI escapes in pane metadata
 * (verified: they are stored verbatim and do not paint), so the glyph is the
 * only channel the state has. Do not reintroduce escape codes here.
 *
 * Minutes, never seconds: the surface repaints on a coarse tick, and a
 * second-by-second countdown that is 20 seconds stale reads as a bug.
 */

import type { CacheState } from "./engine.ts";
import type { Config } from "./config.ts";

/** `38m`, `2h`, `<1m` — always at most three cells. */
export function humanLeft(secondsLeft: number): string {
  if (secondsLeft < 60) return "<1m";
  const minutes = Math.floor(secondsLeft / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/** The string to paint, or null to paint nothing at all. */
export function badgeFor(state: CacheState, cfg: Config): string | null {
  switch (state.phase) {
    case "unknown":
      return null;
    case "cold":
      return "❄ COLD";
    case "expiring":
      return `⚠ ${humanLeft(state.secondsLeft ?? 0)} left`;
    case "warm":
      // Some operators only want to hear from this plugin when there is bad
      // news. Silence while warm is that setting.
      return cfg.quietWhileWarm ? null : `⚡ ${humanLeft(state.secondsLeft ?? 0)} left`;
  }
}

/** One line for a human: what the badge means and where the number came from. */
export function explain(state: CacheState): string[] {
  if (!state.adapter) return ["no cache adapter claims this pane — it is not running a harness this plugin knows"];
  const lines: string[] = [`harness: ${state.adapter.label}`];
  if (state.tier) {
    lines.push(`tier: ${state.tier.tier} (${state.tier.confidence})`);
    for (const why of state.tier.evidence) lines.push(`  · ${why}`);
  }
  if (state.rule) lines.push(`rule: ${state.rule.id} — ${state.rule.label}`);
  if (state.ttl) {
    lines.push(`ttl: ${state.ttl.value}s (${state.ttl.confidence})`);
    if (state.ttl.note) lines.push(`  note: ${state.ttl.note}`);
    const source = state.ttl.source;
    lines.push(`  source: ${source.title}${source.url ? ` — ${source.url}` : ""} (checked ${source.retrievedAt})`);
    if (source.quote) lines.push(`  "${source.quote}"`);
  }
  if (state.probe) {
    const read = state.probe.cacheReadTokens;
    const written = state.probe.cacheCreationTokens;
    lines.push(
      read === undefined
        ? "last turn: no cache telemetry on this harness — countdown only, cold hits cannot be detected"
        : `last turn: ${read} tokens read from cache, ${written ?? 0} written`,
    );
    lines.push(`  evidence: ${state.probe.evidence}`);
  } else {
    lines.push(
      "last turn: not in the log's tail right now — the clock below runs from the last turn that was seen",
    );
  }
  lines.push(
    state.phase === "cold" && state.coldReason === "observed"
      ? "state: COLD — the last turn read nothing from cache. That turn was billed at full input price."
      : state.phase === "cold"
        ? "state: COLD — the TTL elapsed, so the next turn rebuilds the whole prefix."
        : state.phase === "unknown"
          ? "state: unknown — no clock could be established, so nothing is painted on this pane."
          : `state: ${state.phase} — ${state.secondsLeft}s left`,
  );
  return lines;
}
