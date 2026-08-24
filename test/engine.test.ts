/**
 * The precedence ladder is the load-bearing decision in this plugin, and it is
 * five deep:
 *
 *   observed now > observed earlier > harness config override > rule for the
 *   MODEL/UPSTREAM > tier rule
 *
 * Every rung exists because of a case that reading the code does not make
 * obvious — "observed earlier" stops the badge flipping between 59m and 4m
 * between turns, and `ttlForProbe` exists because OpenAI's lifetime follows the
 * model and opencode's follows the upstream provider, so a per-tier number is
 * wrong for one of them whichever value it takes. Reordering these silently
 * would still paint a plausible badge, which is exactly why it is tested.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, isColdTurn, memoKey, warnSecondsFor } from "../src/engine.ts";
import { ADAPTERS } from "../src/harness/index.ts";
import type { HarnessAdapter, Probe } from "../src/harness/types.ts";
import type { CacheRule, Sourced } from "../src/claims.ts";
import type { PaneInfo } from "../src/herdr.ts";
import type { Config } from "../src/config.ts";

const NOW = 1_700_000_000_000;

function sourced(value: number, note: string): Sourced<number> {
  return {
    value,
    confidence: "documented",
    note,
    source: { title: note, url: "https://example.invalid", retrievedAt: "2026-08-24" },
  };
}

const TIER_RULE: CacheRule = {
  id: "fake.tier",
  label: "the tier rule",
  harness: "fake",
  tier: "subscription",
  ttlSeconds: sourced(300, "tier"),
};

/** Registered per test and removed after, so the real registry is never left dirty. */
function withAdapter(over: Partial<HarnessAdapter>, run: (adapter: HarnessAdapter) => Promise<void>) {
  const adapter: HarnessAdapter = {
    id: `fake-${ADAPTERS.length}`,
    label: "Fake",
    detectTier: async () => ({ tier: "subscription", confidence: "certain", evidence: ["test"] }),
    probe: async () => null,
    rules: [TIER_RULE],
    ...over,
  };
  ADAPTERS.push(adapter);
  return run(adapter).finally(() => {
    ADAPTERS.splice(ADAPTERS.indexOf(adapter), 1);
  });
}

let sessionCounter = 0;
function pane(adapter: HarnessAdapter): PaneInfo {
  sessionCounter += 1;
  return {
    pane_id: "w1T:p2A",
    tab_id: "w1T:tP",
    agent: adapter.id,
    agent_session: { agent: adapter.id, value: `session-${sessionCounter}` },
  } as PaneInfo;
}

const CFG = {} as Config;
const probe = (over: Partial<Probe> = {}): Probe => ({
  lastRequestAt: NOW - 60_000,
  turnId: "turn-1",
  evidence: "test",
  ...over,
});

test("warnSecondsFor is a FRACTION, so a 5-minute TTL is not born expiring", () => {
  assert.equal(warnSecondsFor(3600), 900);
  // 25% of 300s is 75s, but the floor is 60 — and either way the pane starts warm.
  assert.ok(warnSecondsFor(300) < 300);
  assert.equal(warnSecondsFor(120), 60);
});

test("isColdTurn: no telemetry is NOT cold", () => {
  assert.equal(isColdTurn(probe()), false);
  assert.equal(isColdTurn(probe({ cacheReadTokens: 0, cacheCreationTokens: 4096 })), true);
  assert.equal(isColdTurn(probe({ cacheReadTokens: 4096, cacheCreationTokens: 0 })), false);
  // Read nothing AND wrote nothing: a turn that never touched the cache at all.
  assert.equal(isColdTurn(probe({ cacheReadTokens: 0, cacheCreationTokens: 0 })), false);
});

test("memoKey is <adapter>:<session>, never the session alone", () => {
  assert.equal(memoKey("claude", "abc"), "claude:abc");
  assert.notEqual(memoKey("claude", "abc"), memoKey("codex", "abc"));
});

test("an OBSERVED ttl beats the documented tier rule", async () => {
  await withAdapter(
    { probe: async () => probe({ observedTtlSeconds: sourced(3600, "observed") }) },
    async (adapter) => {
      const state = await evaluate(pane(adapter), CFG, NOW);
      assert.equal(state.ttl?.value, 3600);
    },
  );
});

test("ttlForProbe beats the tier rule, because tier is the wrong axis for some harnesses", async () => {
  await withAdapter(
    { probe: async () => probe({ model: "gpt-5.6" }), ttlForProbe: () => sourced(1800, "by model") },
    async (adapter) => {
      const state = await evaluate(pane(adapter), CFG, NOW);
      assert.equal(state.ttl?.value, 1800);
    },
  );
});

test("an operator override beats ttlForProbe", async () => {
  await withAdapter(
    {
      probe: async () => probe(),
      ttlForProbe: () => sourced(1800, "by model"),
      ttlOverride: () => sourced(999, "harness config"),
    },
    async (adapter) => {
      const state = await evaluate(pane(adapter), CFG, NOW);
      assert.equal(state.ttl?.value, 999);
    },
  );
});

test("the tier rule is the LAST resort, not the first answer", async () => {
  await withAdapter({ probe: async () => probe() }, async (adapter) => {
    const state = await evaluate(pane(adapter), CFG, NOW);
    assert.equal(state.ttl?.value, 300);
    assert.equal(state.rule?.id, "fake.tier");
  });
});

test("an UNKNOWN tier takes the shortest rule the harness has, never the longest", async () => {
  const long: CacheRule = { ...TIER_RULE, id: "fake.long", tier: "api", ttlSeconds: sourced(3600, "long") };
  await withAdapter(
    {
      rules: [long, TIER_RULE],
      detectTier: async () => ({ tier: "unknown", confidence: "guess", evidence: ["nothing found"] }),
      probe: async () => probe(),
    },
    async (adapter) => {
      const state = await evaluate(pane(adapter), CFG, NOW);
      assert.equal(state.ttl?.value, 300, "a wrong 'still warm' is worse than a wrong early warning");
    },
  );
});

test("a tick with no probe falls back to what was OBSERVED EARLIER, not to the documented rule", async () => {
  await withAdapter({ probe: async () => probe({ observedTtlSeconds: sourced(3600, "observed") }) }, async (adapter) => {
    const p = pane(adapter);
    // The turn that measured the TTL. Only the painter persists.
    const first = await evaluate(p, CFG, NOW, { persist: true });
    assert.equal(first.ttl?.value, 3600);

    // A later tick between turns: the tail holds no new turn, so there is no probe.
    adapter.probe = async () => null;
    const later = await evaluate(p, CFG, NOW + 60_000);
    assert.equal(later.ttl?.value, 3600, "dropping to the tier rule here makes the badge flip 59m <-> 4m");
  });
});

test("PERSISTENCE IS OPT-IN: a read-only evaluate leaves nothing behind", async () => {
  await withAdapter({ probe: async () => probe({ observedTtlSeconds: sourced(3600, "observed") }) }, async (adapter) => {
    const p = pane(adapter);
    await evaluate(p, CFG, NOW); // the default — display only
    adapter.probe = async () => null;
    const later = await evaluate(p, CFG, NOW + 60_000);
    assert.equal(later.phase, "unknown", "a displaying caller must not be able to write the memo");
  });
});

test("a cold turn is STICKY until a warm turn on a NEW turn id clears it", async () => {
  await withAdapter(
    { probe: async () => probe({ turnId: "t1", cacheReadTokens: 0, cacheCreationTokens: 8192 }) },
    async (adapter) => {
      const p = pane(adapter);
      const cold = await evaluate(p, CFG, NOW, { persist: true });
      assert.equal(cold.phase, "cold");
      assert.equal(cold.coldReason, "observed");

      // The SAME turn seen again must not re-judge anything.
      const again = await evaluate(p, CFG, NOW + 1000, { persist: true });
      assert.equal(again.phase, "cold");

      // A new, warm turn clears the mark.
      adapter.probe = async () => probe({ turnId: "t2", cacheReadTokens: 9000, cacheCreationTokens: 0 });
      const warm = await evaluate(p, CFG, NOW + 2000, { persist: true });
      assert.equal(warm.phase, "warm");
      assert.equal(warm.coldReason, null);
    },
  );
});

test("an elapsed clock is cold for a DIFFERENT reason, and says so", async () => {
  await withAdapter({ probe: async () => probe({ lastRequestAt: NOW - 3_600_000 }) }, async (adapter) => {
    const state = await evaluate(pane(adapter), CFG, NOW);
    assert.equal(state.phase, "cold");
    assert.equal(state.coldReason, "expired");
  });
});

test("no probe and no memory paints NOTHING — never a badge dated `now`", async () => {
  await withAdapter({ probe: async () => null }, async (adapter) => {
    const state = await evaluate(pane(adapter), CFG, NOW);
    assert.equal(state.phase, "unknown");
    assert.equal(state.expiresAt, null);
  });
});

test("a pane with no session is unknown, and a pane with no adapter has no adapter", async () => {
  await withAdapter({}, async (adapter) => {
    const bare = { ...pane(adapter), agent_session: undefined } as PaneInfo;
    const state = await evaluate(bare, CFG, NOW);
    assert.equal(state.phase, "unknown");
    assert.equal(state.adapter?.id, adapter.id);

    const shell = { pane_id: "w1T:p9", tab_id: "w1T:tP" } as PaneInfo;
    assert.equal((await evaluate(shell, CFG, NOW)).adapter, null);
  });
});

test("expiring is entered at the warn threshold, not before", async () => {
  await withAdapter(
    { rules: [{ ...TIER_RULE, ttlSeconds: sourced(3600, "hour") }], probe: async () => probe() },
    async (adapter) => {
      const p = pane(adapter);
      // 3600s TTL warns at 900s. lastRequestAt is NOW - 60_000, so 3540s remain.
      assert.equal((await evaluate(p, CFG, NOW)).phase, "warm");
      assert.equal((await evaluate(p, CFG, NOW + 2_700_000)).phase, "expiring");
    },
  );
});
