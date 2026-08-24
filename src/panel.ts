/**
 * The detail popup: why does this pane's badge say what it says.
 *
 * Deliberately not a TUI. There is nothing here to navigate, select or edit —
 * it is one screen of provenance, read once and dismissed. So it prints, waits
 * for a key, and leaves. Anything more would be a widget in search of a job.
 *
 * `CACHE_ALERT_TARGET_PANE` names the pane to explain; the `explain` action
 * sets it when it opens this.
 */

import { explain } from "./badge.ts";
import { BIN, loadConfig } from "./config.ts";
import { evaluate } from "./engine.ts";
import { getPane, listPanes } from "./herdr.ts";

// Bold/dim/reset only — no palette. The popup inherits the operator's Herdr
// theme, and hardcoding colours would fight it.
const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

const cfg = loadConfig();
const wanted = process.env.CACHE_ALERT_TARGET_PANE ?? "";
const pane = wanted
  ? await getPane(wanted)
  : ((await listPanes()).find((p) => p.focused && (p.agent || p.agent_session)) ?? null);

console.clear();
if (!pane) {
  console.log(`${bold}cache-alert${reset}\n`);
  console.log("No agent pane to explain.");
  console.log(`${dim}Open this from an agent pane, or run \`${BIN} explain --pane <id>\`.${reset}`);
} else {
  const state = await evaluate(pane, cfg);
  console.log(`${bold}cache-alert${reset} ${dim}· pane ${pane.pane_id}${reset}\n`);
  for (const line of explain(state)) {
    // Indented continuation lines are supporting detail; dim them so the
    // headline facts stay readable at a glance.
    console.log(line.startsWith(" ") ? `${dim}${line}${reset}` : line);
  }
  if (state.rule?.notes?.length) {
    console.log(`\n${bold}worth knowing${reset}`);
    for (const note of state.rule.notes) console.log(`${dim}  · ${note}${reset}`);
  }
}

console.log(`\n${dim}press any key to close${reset}`);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.once("data", () => process.exit(0));
} else {
  process.exit(0);
}
