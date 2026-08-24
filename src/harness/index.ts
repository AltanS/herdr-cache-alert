/**
 * The adapter registry.
 *
 * Adding a harness: write one file exporting a `HarnessAdapter`, add it to
 * `ADAPTERS`. That is the whole contract — `id` must equal the `agent` label
 * Herdr reports for the pane (`herdr pane list` shows it), and the map does the
 * routing. No adapter inspects a pane to decide whether it owns it.
 */

import type { CacheRule } from "../claims.ts";
import type { PaneInfo } from "../herdr.ts";
import type { HarnessAdapter } from "./types.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { opencodeAdapter } from "./opencode.ts";
import { openrouterAdapter } from "./openrouter.ts";

export const ADAPTERS: HarnessAdapter[] = [claudeAdapter, codexAdapter, opencodeAdapter, openrouterAdapter];

/**
 * Searched, not indexed. A map built once at import would freeze the registry at
 * module load, which contradicts the contract above ("add it to ADAPTERS") and
 * makes the whole engine untestable — a test cannot register a fake harness.
 * Four entries; the scan costs nothing.
 */
export function adapterById(id: string): HarnessAdapter | null {
  return ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

/**
 * The adapter for a pane, or null when nothing claims it.
 *
 * `agent` appears only once Herdr has DETECTED an agent; `agent_session.agent`
 * is set earlier, which is why both are consulted. Null is a normal answer — a
 * shell pane has no cache to report and must be left unpainted.
 */
export function adapterFor(pane: PaneInfo, force = ""): HarnessAdapter | null {
  if (force) return adapterById(force);
  const label = pane.agent || pane.agent_session?.agent || "";
  return label ? adapterById(label) : null;
}

/** Every rule the plugin ships — what `cache-alert rules` and `claims` iterate. */
export function allRules(): CacheRule[] {
  return ADAPTERS.flatMap((adapter) => adapter.rules);
}

export type { HarnessAdapter };
