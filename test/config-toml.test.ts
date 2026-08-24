/**
 * The marker machinery. Everything `uninstall` can promise rests on it: if a
 * block cannot be found exactly, removal is a guess at somebody else's file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { hasBlock, marked, readBlock, removeBlock, upsertBlock } from "../src/config-toml.ts";

const OTHER = '# theirs\n[ui]\nsidebar_width = 30\n\n[[keys.command]]\nkey = "prefix+z"\n';

test("a written block can be found, read back and removed exactly", () => {
  const installed = upsertBlock(OTHER, "sidebar", "[ui.sidebar.agents]\nrows = [1]", "eof");
  assert.ok(hasBlock(installed, "sidebar"));
  assert.ok(readBlock(installed, "sidebar")?.includes("rows = [1]"));
  // Byte-for-byte back to where we started, modulo trailing blank lines.
  assert.equal(removeBlock(installed, "sidebar").trim(), OTHER.trim());
});

test("upsert REPLACES its own block in place rather than adding a second", () => {
  const once = upsertBlock(OTHER, "sidebar", "rows = [1]", "eof");
  const twice = upsertBlock(once, "sidebar", "rows = [2]", "eof");
  assert.equal(twice.split("cache-alert:begin sidebar").length - 1, 1, "two copies of one block");
  assert.ok(twice.includes("rows = [2]"));
  assert.ok(!twice.includes("rows = [1]"));
});

test("a bare key goes INSIDE its table, not at the end of the file", () => {
  // A key appended at EOF lands in whatever table is last — here [[keys.command]],
  // where `tab_bar_right` is not valid and the config would be wrong.
  const out = upsertBlock(OTHER, "tab-bar", "tab_bar_right = [1]", { after: /^\[ui\]\s*$/m, orCreate: "[ui]" });
  const ui = out.indexOf("[ui]");
  const keys = out.indexOf("[[keys.command]]");
  const key = out.indexOf("tab_bar_right");
  assert.ok(ui < key && key < keys, "tab_bar_right must sit between [ui] and the next table");
});

test("no [ui] table yet, so one is written rather than the key orphaned", () => {
  const out = upsertBlock("onboarding = false\n", "tab-bar", "tab_bar_right = [1]", {
    after: /^\[ui\]\s*$/m,
    orCreate: "[ui]",
  });
  assert.ok(out.indexOf("[ui]") < out.indexOf("tab_bar_right"));
});

test("blocks do not interfere with each other", () => {
  let out = upsertBlock(OTHER, "sidebar", "A", "eof");
  out = upsertBlock(out, "keybinding", "B", "eof");
  assert.ok(hasBlock(out, "sidebar") && hasBlock(out, "keybinding"));
  const gone = removeBlock(out, "sidebar");
  assert.ok(!hasBlock(gone, "sidebar"));
  assert.ok(hasBlock(gone, "keybinding"), "removing one block must not take the other");
});

test("removing a block that was never there changes nothing", () => {
  assert.equal(removeBlock(OTHER, "sidebar"), OTHER);
  assert.equal(readBlock(OTHER, "sidebar"), null);
});

test("an END marker deleted by hand means REFUSE, not swallow the rest of the file", () => {
  const installed = upsertBlock(OTHER, "sidebar", "rows = [1]", "eof");
  const broken = installed.replace("# cache-alert:end sidebar", "");
  assert.equal(hasBlock(broken, "sidebar"), false);
  assert.equal(removeBlock(broken, "sidebar"), broken, "an unterminated block must be left for a human");
});

test("the begin marker names the remedy, and is matched on its PREFIX", () => {
  const block = marked("sidebar", "rows = [1]");
  assert.match(block, /uninstall/, "a marker the operator finds must say how to remove it");
  // The remedy text can be reworded later without orphaning blocks already written.
  const reworded = block.replace(/— remove with.*/, "— remove some other way");
  assert.ok(hasBlock(`${reworded}\n`, "sidebar"));
});

test("the legacy stripper must NOT reach inside our own markers", async () => {
  // The sidebar body opens with the very comment the pre-marker release used, so
  // an unguarded stripper eats the body from between our begin and end — leaving
  // an empty block and a sidebar that silently stopped rendering. That shipped.
  const { stripLegacyBlocks } = await import("../src/config-toml.ts");
  const { SIDEBAR_BLOCK } = await import("../src/setup.ts");
  const config = upsertBlock("onboarding = false\n", "sidebar", SIDEBAR_BLOCK.trim(), "eof");
  const after = stripLegacyBlocks(config);
  assert.equal(after, config, "our own block was modified");
  assert.ok(readBlock(after, "sidebar")?.includes("rows = "), "the rows line was eaten");
});

test("the legacy stripper DOES remove an unmarked block from an older release", async () => {
  const { stripLegacyBlocks } = await import("../src/config-toml.ts");
  const { SIDEBAR_BLOCK } = await import("../src/setup.ts");
  const old = `onboarding = false\n${SIDEBAR_BLOCK}`;
  const after = stripLegacyBlocks(old);
  assert.ok(!after.includes("rows = "), "the pre-marker block survived");
  assert.ok(after.includes("onboarding = false"), "it took the operator's line with it");
});
