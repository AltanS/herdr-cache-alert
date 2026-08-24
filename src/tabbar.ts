/**
 * The always-on surface: one entry in Herdr's tab-bar status area.
 *
 * This is the only surface that satisfies both halves of the problem, and it
 * does so by being PULL rather than push:
 *
 *   - The tab bar exists over a pane alone in its tab. Pane borders do not
 *     (Herdr draws them around SPLIT panes only), which is what made every
 *     chrome-based badge invisible on a single-pane tab.
 *   - Herdr re-runs a `command` entry every `interval_seconds` by itself. Nothing
 *     has to redraw and nobody has to push. That is exactly what Claude Code's
 *     statusline could not do: it only repaints on turn activity, so walking away
 *     froze it at the number it last rendered — and since the TTL resets on every
 *     request, that number was always the full hour. It counted down never.
 *
 * Contract Herdr imposes, all of it load-bearing:
 *   - Only the LAST LINE of successful output is used. One line, always.
 *   - Empty output CLEARS the entry. That is how "silence over noise" comes free
 *     here: no data means we print nothing and the slot empties itself.
 *   - Anything diagnostic must go to stderr or it eats the badge.
 */

import { getPane, getTab } from "./herdr.ts";

/**
 * Reads the badge the watcher already published, rather than probing again.
 *
 * Two reasons. Every surface then shows the same string at the same moment —
 * a tab bar disagreeing with the sidebar would be a bug report. And this runs
 * every few seconds forever, so it stays at one socket round trip instead of a
 * transcript seek.
 *
 * It inherits the right failure mode for free: the token carries `--ttl-ms`, so
 * if the watcher dies the token expires, this prints nothing, and the tab bar
 * clears itself. Blank rather than wrong.
 */
export async function tabbarLine(): Promise<string> {
  // Herdr sets this for command entries, the same context custom keybindings get.
  const paneId = process.env.HERDR_ACTIVE_PANE_ID;
  if (!paneId) return "";
  const pane = await getPane(paneId);
  if (!pane) return "";

  // A SPLIT tab already shows a badge on every pane's own border, and those are
  // per-pane. The tab bar can only ever describe the FOCUSED pane, so leaving it
  // on during a split states one pane's number above a row of panes that each
  // have their own — the reading is ambiguous exactly when there is most to read.
  // This surface is the fallback for a pane that has no border, so it stands down
  // as soon as the borders appear.
  const tab = await getTab(pane.tab_id);
  if (tab && tab.pane_count > 1) return "";

  return pane.tokens?.cache ?? "";
}

export async function runTabbar(): Promise<void> {
  // No trailing newline and no second line: the last line is the badge, and a
  // stray blank one would clear the entry instead.
  const line = await tabbarLine();
  if (line) process.stdout.write(line);
}
