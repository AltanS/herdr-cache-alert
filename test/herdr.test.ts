/**
 * The two places this plugin reads Herdr's own shapes, both of which have
 * already been got wrong once:
 *
 *   - the token NAMES, which are a public interface with a copy in the
 *     operator's config.toml and another in every running server's memory;
 *   - the EVENT payload, whose spelling differs from the manifest's.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { allStateTokens, eventPaneId, STATE_TOKENS } from "../src/herdr.ts";

afterEach(() => {
  delete process.env.HERDR_PLUGIN_EVENT_JSON;
});

test("every state has a plain token and a _focus token, and they are distinct", () => {
  const tokens = allStateTokens();
  assert.equal(tokens.length, 6);
  assert.equal(new Set(tokens).size, 6);
  for (const base of Object.values(STATE_TOKENS)) {
    assert.ok(tokens.includes(base));
    assert.ok(tokens.includes(`${base}_focus`), `${base} has no focused variant`);
  }
});

test("token names are ADDITIVE-ONLY: these six must not change", () => {
  // A rename paints a name the operator's config does not style, so the sidebar
  // renders NOTHING — and the paint still succeeds, so nothing reports an error.
  // If this test fails, the change is a MAJOR version, not a MINOR one.
  assert.deepEqual(allStateTokens().toSorted(), [
    "cache_cold",
    "cache_cold_focus",
    "cache_expiring",
    "cache_expiring_focus",
    "cache_warm",
    "cache_warm_focus",
  ]);
});

test("the six names are exactly the three states, each with and without _focus", () => {
  // The earlier version of this test claimed no name may be a prefix of another.
  // That is FALSE by design — `cache_warm` is a prefix of `cache_warm_focus` —
  // and the old assertion compared `${a}=` against a bare name, so it could never
  // fail. `--token` is `name=value` on the wire, so a shared prefix is harmless;
  // what actually matters is that the set is exactly the pairs and nothing else.
  const tokens = allStateTokens();
  const bases = Object.values(STATE_TOKENS);
  const focused = tokens.filter((t) => t.endsWith("_focus"));
  const plain = tokens.filter((t) => !t.endsWith("_focus"));
  assert.deepEqual(plain.toSorted(), [...bases].toSorted());
  assert.deepEqual(
    focused.map((t) => t.slice(0, -"_focus".length)).toSorted(),
    [...bases].toSorted(),
    "a focus token with no matching state would never be painted",
  );
});

test("eventPaneId reads the payload's snake_case shape, not the manifest's dotted one", () => {
  process.env.HERDR_PLUGIN_EVENT_JSON = JSON.stringify({
    event: "pane_agent_status_changed",
    data: { type: "pane_agent_status_changed", pane_id: "w2H:p1", agent: "claude" },
  });
  assert.equal(eventPaneId(), "w2H:p1");
});

test("eventPaneId accepts a base36-ish pane id, not just digits", () => {
  process.env.HERDR_PLUGIN_EVENT_JSON = JSON.stringify({ data: { pane_id: "w654f9f0c0dd67e:pS" } });
  assert.equal(eventPaneId(), "w654f9f0c0dd67e:pS");
});

test("eventPaneId returns null rather than a wrong pane, so the caller sweeps instead", () => {
  assert.equal(eventPaneId(), null, "no event at all");

  for (const raw of ["", "not json", "{}", '{"data":{}}', '{"data":{"pane_id":""}}', '{"data":{"pane_id":"nope"}}']) {
    process.env.HERDR_PLUGIN_EVENT_JSON = raw;
    assert.equal(eventPaneId(), null, `payload ${JSON.stringify(raw)}`);
  }
});

test("a pane id at the TOP level is not accepted — the real payload nests it under data", () => {
  process.env.HERDR_PLUGIN_EVENT_JSON = JSON.stringify({ pane_id: "w2H:p1" });
  assert.equal(eventPaneId(), null);
});
