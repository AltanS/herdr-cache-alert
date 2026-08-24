/**
 * The claim contract is the whole value of this plugin: the numbers can be
 * trusted because each one carries where it came from and when it was checked.
 * The contract is stated in CLAUDE.md as a rule for humans; this is the same
 * rule as a gate, applied to every claim the plugin actually ships.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { claimAgeDays, observed, staleClaims, type CacheRule, type Source } from "../src/claims.ts";
import { allRules } from "../src/harness/index.ts";

const AT = new Date("2026-08-24T12:00:00Z");

const source = (over: Partial<Source> = {}): Source => ({
  url: "https://example.invalid/doc",
  title: "A doc",
  publisher: "Example",
  retrievedAt: "2026-08-01",
  kind: "vendor-doc",
  ...over,
});

const rule = (over: Partial<CacheRule> = {}): CacheRule => ({
  id: "x.subscription",
  harness: "x",
  tier: "subscription",
  label: "X",
  ttlSeconds: { value: 300, confidence: "documented", source: source() },
  slidingWindow: true,
  automatic: true,
  sources: [],
  ...over,
});

test("claimAgeDays is Infinity for a date that cannot be read, so it always reads as stale", () => {
  assert.equal(claimAgeDays(source({ retrievedAt: "2026-08-24" }), AT), 0);
  assert.equal(claimAgeDays(source({ retrievedAt: "2026-08-01" }), AT), 23);
  assert.equal(claimAgeDays(source({ retrievedAt: "last tuesday" }), AT), Infinity);
  assert.equal(claimAgeDays(source({ retrievedAt: "" }), AT), Infinity);
});

test("staleClaims flags a claim past the threshold, and not one exactly on it", () => {
  const r = rule({ ttlSeconds: { value: 300, confidence: "documented", source: source({ retrievedAt: "2026-08-01" }) } });
  assert.equal(staleClaims([r], 23, AT).length, 0, "exactly at the limit is not yet stale");
  assert.equal(staleClaims([r], 22, AT).length, 1);
  assert.equal(staleClaims([r], 22, AT)[0]?.field, "ttlSeconds");
});

test("an OBSERVED claim never goes stale — it is re-measured on every probe", () => {
  const r = rule({
    ttlSeconds: observed(3600, "measured here", new Date("2020-01-01")),
  });
  assert.deepEqual(staleClaims([r], 1, AT), []);
});

test("staleClaims reaches minTokens and every extra source, not just the TTL", () => {
  const old = source({ retrievedAt: "2020-01-01" });
  const r = rule({
    ttlSeconds: { value: 300, confidence: "documented", source: old },
    minTokens: { value: 1024, confidence: "documented", source: old },
    sources: [old, old],
  });
  const fields = staleClaims([r], 30, AT).map((s) => s.field);
  assert.deepEqual(fields.toSorted(), ["minTokens", "sources[0]", "sources[1]", "ttlSeconds"]);
});

test("observed() stamps a real date and never carries a URL it did not read", () => {
  const o = observed(3600, "cache_creation.ephemeral_1h_input_tokens > 0", AT);
  assert.equal(o.confidence, "observed");
  assert.equal(o.source.retrievedAt, "2026-08-24");
  assert.equal(o.source.url, "");
  assert.equal(o.source.kind, "observed");
});

// --- the contract, applied to what actually ships -----------------------------

test("EVERY shipped rule has a stable, harness-scoped id, and no two collide", () => {
  const ids = allRules().map((r) => r.id);
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length, "duplicate rule id");
  for (const r of allRules()) {
    // Scoped by harness, but the SECOND half is not always the tier: opencode's
    // cache lifetime follows the upstream PROVIDER, which differs per session, so
    // its rules are `opencode.anthropic` and friends. Config names these ids, so
    // whatever they are they must not move.
    assert.ok(r.id.startsWith(`${r.harness}.`), r.id);
    assert.ok(r.id.length > r.harness.length + 1, r.id);
  }
});

test("EVERY shipped claim carries a real ISO date, because `claims --stale` runs on it", () => {
  for (const r of allRules()) {
    for (const [field, s] of claimSources(r)) {
      assert.match(s.retrievedAt, /^\d{4}-\d{2}-\d{2}$/, `${r.id} ${field}`);
      assert.ok(Number.isFinite(claimAgeDays(s, AT)), `${r.id} ${field} has an unparseable date`);
    }
  }
});

test("a `documented` claim must QUOTE the page — if it cannot be quoted it is not documented", () => {
  for (const r of allRules()) {
    if (r.ttlSeconds.confidence !== "documented") continue;
    assert.ok(r.ttlSeconds.source.url, `${r.id} claims documented with no URL`);
    assert.ok(r.ttlSeconds.source.quote, `${r.id} claims documented with no verbatim quote`);
  }
});

test("a claim BELOW documented must say what could not be confirmed", () => {
  for (const r of allRules()) {
    const c = r.ttlSeconds.confidence;
    if (c === "documented" || c === "observed") continue;
    assert.ok(r.ttlSeconds.note, `${r.id} is ${c} but records no note — an honest hole must be written down`);
  }
});

test("no shipped claim is `observed` — that is reserved for a live measurement", () => {
  for (const r of allRules()) {
    assert.notEqual(r.ttlSeconds.confidence, "observed", `${r.id} ships a hardcoded 'observed' claim`);
  }
});

test("every TTL is a positive number of seconds", () => {
  for (const r of allRules()) {
    assert.ok(r.ttlSeconds.value > 0, `${r.id} has a non-positive TTL`);
    assert.ok(r.ttlSeconds.value <= 24 * 3600, `${r.id} claims a TTL longer than a day`);
  }
});

test("every harness ships at least one rule, so no adapter can paint an unsourced number", () => {
  const byHarness = new Map<string, number>();
  for (const r of allRules()) byHarness.set(r.harness, (byHarness.get(r.harness) ?? 0) + 1);
  for (const [harness, count] of byHarness) assert.ok(count > 0, harness);
  assert.ok(byHarness.size >= 4, "claude, codex, opencode and openrouter all ship rules");
});

function claimSources(r: CacheRule): Array<[string, Source]> {
  const out: Array<[string, Source]> = [["ttlSeconds", r.ttlSeconds.source]];
  if (r.minTokens) out.push(["minTokens", r.minTokens.source]);
  r.sources.forEach((s, i) => out.push([`sources[${i}]`, s]));
  return out;
}
