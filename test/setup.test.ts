/**
 * `setup` edits a file the operator owns, and the sidebar block inside it is a
 * contract with three separate parsers: Herdr's TOML reader, Herdr's sidebar
 * token validator (which rejects a named colour and any unknown key), and this
 * plugin's own painter. A block that satisfies two of the three fails silently
 * on the third — the sidebar simply renders nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allStateTokens } from "../src/herdr.ts";
import {
  SIDEBAR_BLOCK,
  TOGGLE_KEY,
  integrationRemedy,
  isGithubInstall,
  outdatedHint,
  parseIntegrationStatus,
  sidebarTokenReport,
  tabBarEntry,
} from "../src/setup.ts";

const ROWS_LINE = SIDEBAR_BLOCK.split("\n").find((line) => line.startsWith("rows = ")) ?? "";

/**
 * Points the plugin at a throwaway config and asks what it makes of it.
 *
 * No dynamic-import trick any more: the config path is resolved on every CALL,
 * so setting the variable is enough. A path captured at module load would make
 * the answer depend on which module happened to import first.
 */
function reportFor(toml: string) {
  const dir = mkdtempSync(join(tmpdir(), "cache-alert-test-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, toml);
  process.env.HERDR_CONFIG_PATH = path;
  return sidebarTokenReport();
}

test("the sidebar block styles EVERY token the painter can set", () => {
  const styled = [...ROWS_LINE.matchAll(/token = "\$([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(styled.toSorted(), allStateTokens().toSorted());
});

test("every fg is #RGB or #RRGGBB — Herdr REJECTS a named theme colour", () => {
  const colours = [...ROWS_LINE.matchAll(/fg = "([^"]+)"/g)].map((m) => m[1] ?? "");
  assert.ok(colours.length > 0);
  for (const colour of colours) assert.match(colour, /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, colour);
});

test("the focused variants are DARK and the plain ones BRIGHT, or one row is unreadable", () => {
  // Herdr draws the active row on `active_row_bg` — measured #d2d3da here against
  // #23273a for its neighbours. One static colour cannot serve both.
  const entries = [...ROWS_LINE.matchAll(/token = "\$([A-Za-z0-9_]+)", fg = "#([0-9a-fA-F]{6})"/g)];
  assert.equal(entries.length, 6, "all six must be six-digit, or this check cannot compare them");
  for (const [, name = "", hex = ""] of entries) {
    const lum = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).reduce((a, b) => a + b, 0) / 3;
    if (name.endsWith("_focus")) assert.ok(lum < 128, `${name} (#${hex}) is too light for the pale active row`);
    else assert.ok(lum > 128, `${name} (#${hex}) is too dark for the dark normal rows`);
  }
});

test("the block declares the table it needs, so appending it cannot land in another", () => {
  assert.ok(SIDEBAR_BLOCK.includes("[ui.sidebar.agents]"));
  assert.ok(SIDEBAR_BLOCK.indexOf("[ui.sidebar.agents]") < SIDEBAR_BLOCK.indexOf("rows = "));
});

test("the tab bar entry is a COMMAND entry, which is what makes the surface pull", () => {
  const entry = tabBarEntry("/plugins/cache-alert");
  assert.match(entry, /command/);
  assert.match(entry, /interval_seconds/, "without an interval nothing re-runs it while the pane is idle");
  assert.ok(entry.includes("/plugins/cache-alert"), "the entry must name the checkout it runs from");
});

test("the toggle chord uses alt, which Herdr 0.8.2's own defaults do not", () => {
  assert.equal(TOGGLE_KEY, "prefix+alt+c");
});

test("sidebarTokenReport finds nothing missing when the config is ours", () => {
  const report = reportFor(SIDEBAR_BLOCK);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.unstyled, []);
  assert.equal(report.configured.length, 6);
});

test("a config that predates the _focus tokens is reported as MISSING them", () => {
  const old = '[ui.sidebar.agents]\nrows = [["agent", { token = "$cache_warm", fg = "#a6e3a1" }]]\n';
  const report = reportFor(old);
  assert.deepEqual(report.configured, ["cache_warm"]);
  assert.equal(report.missing.length, 5);
  assert.ok(report.missing.includes("cache_warm_focus"));
});

test("a config naming a token we no longer paint is reported as UNSTYLED", () => {
  const stale = '[ui.sidebar.agents]\nrows = [["agent", { token = "$cache_ancient", fg = "#fff" }]]\n';
  const report = reportFor(stale);
  assert.deepEqual(report.unstyled, ["cache_ancient"]);
});

test("a config with no cache row at all leaves every token missing", () => {
  const report = reportFor('[ui]\nsidebar_width = 30\n');
  assert.deepEqual(report.configured, []);
  assert.equal(report.missing.length, 6);
});

test("a MOVED checkout is repointed, not reported as already installed", async () => {
  // The old form tested only "does any `herdr-cache-alert tabbar` line exist".
  // After a re-clone that line names a directory that is gone: the command fails,
  // the entry clears itself, and the tab bar silently goes blank — while setup
  // says "already in your tab bar". This asserts the two entries differ, which is
  // what installTabBar now compares.
  const here = tabBarEntry("/home/x/checkout-a");
  const moved = tabBarEntry("/home/x/checkout-b");
  assert.notEqual(here, moved);
  assert.ok(here.includes("/home/x/checkout-a"));
  assert.ok(!here.includes("/home/x/checkout-b"));
});

test("the three `herdr integration status` line shapes all parse", () => {
  const states = parseIntegrationStatus(
    [
      "claude: current (v8) (/home/x/.claude/hooks/herdr-agent-state.sh)",
      "codex: outdated (v4 < v8) (/home/x/.codex/herdr-agent-state.sh)",
      "opencode: not installed (/home/x/.config/opencode/plugins/herdr-agent-state.js)",
      "antigravity-cli: not installed (/home/x/.gemini/config/hooks/herdr-agent-state.sh)",
      "",
      "some other line entirely",
    ].join("\n"),
  );
  assert.equal(states.get("claude"), "current");
  assert.equal(states.get("codex"), "outdated");
  assert.equal(states.get("opencode"), "not installed");
  // Herdr adds harnesses release by release, and a hyphen is legal in an id.
  assert.equal(states.get("antigravity-cli"), "not installed");
  assert.equal(states.size, 4);
});

test("a missing hook is reported with the install command AND the reason", () => {
  // Without the hook a pane has no session id, so the plugin paints nothing and
  // NOTHING reports an error. The remedy line is the only place it surfaces.
  const remedy = integrationRemedy("claude");
  assert.match(remedy, /herdr integration install claude/);
  assert.match(remedy, /restart Claude/);
  assert.match(remedy, /no session id/);
  assert.ok(!remedy.includes("—"), "no em dash in operator-facing text");
});

test("an OUTDATED hook is a hint, not a demand: it still reports the session id", () => {
  // Measured: this machine ran the v4 Claude hook for weeks and painted the
  // whole time. Marking it `!` would make a healthy install exit 1.
  const hint = outdatedHint(["opencode"]);
  assert.match(hint, /herdr integration install opencode/);
  assert.match(hint, /hook outdated/);
  assert.ok(!hint.includes("\u2014"), "no em dash in operator-facing text");
  const both = outdatedHint(["codex", "opencode"]);
  assert.match(both, /^codex, opencode hooks outdated,/);
  assert.match(both, /install codex` and `herdr integration install opencode` update them$/);
});

test("a GitHub install is NOT linked again, and a plain clone still is", () => {
  // `herdr plugin install owner/repo` unpacks under <config dir>/plugins/github/
  // and registers the plugin on disk for every server, present and future.
  // Linking it again registers a second copy of the same plugin id.
  const dir = "/home/x/.config/herdr";
  assert.ok(isGithubInstall(`${dir}/plugins/github/herdr.cache-alert-ab12cd`, dir));
  assert.ok(!isGithubInstall("/home/x/playground/herdr-cache-alert", dir));
  // A sibling directory whose name merely STARTS with the prefix is not inside it.
  assert.ok(!isGithubInstall(`${dir}/plugins/github-mirror/herdr.cache-alert`, dir));
});
