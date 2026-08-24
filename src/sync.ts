/**
 * Painting. Evaluate every agent pane, then put the badge where it can be seen.
 *
 * Both surfaces are written on every paint, because neither is reliable alone:
 *   - the pane's TOP BORDER (`--title`), which exists only while the pane
 *     SHARES A TAB and only while `ui.show_agent_labels_on_pane_borders` is on;
 *   - the AGENT LIST entry, via the `$cache_*` state tokens, which renders
 *     regardless of borders and is therefore the one that reaches a pane alone
 *     in its tab.
 *
 * There is deliberately NO tab-label fallback. Writing the countdown there means
 * renaming a tab every minute, which churns Herdr's event bus (our own rename
 * echoes back as `tab.renamed`) and makes the tab bar twitch; writing only a
 * cold mark there buys almost nothing now that the agent list carries the whole
 * badge. A lone pane with no agent list showing is simply unmarked.
 */

import { badgeFor } from "./badge.ts";
import { loadConfig, type Config } from "./config.ts";
import { evaluate, memoKey, type CacheState } from "./engine.ts";
import { getPane, getTab, listPanes, notify, renameTab, setCacheBadge, type CacheBadgeOptions, type PaneInfo } from "./herdr.ts";
import { agentListEnabled, getMemo, putMemo } from "./store.ts";

/**
 * The mark an earlier design wrote onto a lone pane's tab label.
 *
 * No longer painted — kept only so `clear` can strip one left behind by an
 * older install. A tab rename is a real edit to the operator's workspace, so
 * abandoning the feature without cleaning up after it would leave litter.
 */
const LEGACY_COLD_MARK = "❄";

/**
 * A monotonic sequence for `--seq`. Milliseconds since an arbitrary epoch fits
 * comfortably and orders correctly across the separate processes a tick spawns.
 */
const seq = () => Date.now() - 1_700_000_000_000;

export interface Painted {
  paneId: string;
  badge: string | null;
  state: CacheState;
}

/**
 * Paints one pane. `ttlMs` should be about twice the caller's tick, so a
 * watcher that dies takes its badge with it instead of leaving a stale number.
 */
export async function paintPane(pane: PaneInfo, cfg: Config, ttlMs: number): Promise<Painted> {
  // The one caller that WRITES. Everything else evaluates read-only, so there is
  // exactly one writer per pane per tick and no unlocked update to lose.
  const state = await evaluate(pane, cfg, Date.now(), { persist: true });
  const badge = badgeFor(state, cfg);
  // The memo key is `<adapter>:<session>`, never the session alone — two
  // adapters pointed at one session (which happens the moment someone sets
  // CACHE_ALERT_HARNESS) would otherwise share one entry. This used to write
  // `lastBadge` under the bare id, which put every session in the file twice.
  const key = state.adapter && state.sessionId ? memoKey(state.adapter.id, state.sessionId) : null;
  const memo = key ? getMemo(key) : null;

  // ALWAYS repaint, even when the string is identical.
  //
  // Skipping an unchanged badge looks like a free optimisation and is not: the
  // paint carries `--ttl-ms`, so a badge that is not re-reported EXPIRES and
  // disappears. `❄ COLD` never changes by definition, which made it the one
  // state that reliably vanished — exactly the state worth showing. The saving
  // was one socket round trip per pane per tick.
  const opts: CacheBadgeOptions = {
    seq: seq(),
    ttlMs,
    // Read per paint, not per process: the toggle is a keypress, and a watcher
    // that cached this at startup would ignore it until restarted.
    agentList: agentListEnabled(),
    // The active row has a different background, so it needs a different colour.
    focused: pane.focused,
  };
  // Assigned rather than spread: `phase` must be ABSENT for an unknown state,
  // because setCacheBadge reads its absence as "clear all three state tokens".
  if (state.phase !== "unknown") opts.phase = state.phase;
  await setCacheBadge(pane.pane_id, badge, opts);

  // The notification IS deduplicated: it interrupts, so it fires on the edge
  // into cold, not once per tick for as long as the pane stays there.
  const changed = !memo || memo.lastBadge !== (badge ?? "");
  if (changed) {
    if (key) putMemo(key, { lastBadge: badge ?? "" });
    if (cfg.notifyOnCold && state.phase === "cold" && state.coldReason === "observed") {
      await notify("Cache miss", `${pane.pane_id} rebuilt its prompt cache — that turn was billed as uncached input.`);
    }
  }
  return { paneId: pane.pane_id, badge, state };
}

/** Paints every pane Herdr says is running an agent. The startup and event hook. */
export async function syncAll(ttlMs: number, cfg = loadConfig()): Promise<Painted[]> {
  const panes = await listPanes();
  const out: Painted[] = [];
  for (const pane of panes) {
    if (!pane.agent && !pane.agent_session) continue;
    out.push(await paintPane(pane, cfg, ttlMs));
  }
  return out;
}

/**
 * Removes every trace: both badge surfaces, and any tab mark an older version
 * of this plugin left behind.
 *
 * The tab mark is the part that matters. A badge is scoped metadata Herdr drops
 * on its own, but a tab RENAME is a real edit to the operator's workspace —
 * leaving a ❄ on a tab after the plugin stops painting would be litter they
 * have to clean up by hand.
 */
export async function clearAll(): Promise<number> {
  const panes = await listPanes();
  for (const pane of panes) {
    await setCacheBadge(pane.pane_id, null);
    const tab = await getTab(pane.tab_id);
    if (tab?.label?.startsWith(`${LEGACY_COLD_MARK} `)) await renameTab(pane.tab_id, tab.label.slice(2));
  }
  return panes.length;
}

/** Paints one pane by id. Returns null when the pane is gone. */
export async function syncPane(paneId: string, ttlMs: number, cfg = loadConfig()): Promise<Painted | null> {
  const pane = await getPane(paneId);
  return pane ? paintPane(pane, cfg, ttlMs) : null;
}
