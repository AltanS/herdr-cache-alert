/**
 * The badge is what the operator actually reads, and it has been wrong twice:
 * `❄ COLD` once vanished because an "unchanged" paint was skipped, and `⚡ 44m`
 * read as "44 minutes old" until `left` was added. Both are one string away.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { badgeFor, humanLeft } from "../src/badge.ts";
import type { CacheState } from "../src/engine.ts";
import type { Config } from "../src/config.ts";

const CFG = { quietWhileWarm: false } as Config;
const QUIET = { quietWhileWarm: true } as Config;

const state = (over: Partial<CacheState>): CacheState =>
  ({ phase: "warm", secondsLeft: 600, ...over }) as CacheState;

test("humanLeft never exceeds three cells", () => {
  for (const seconds of [0, 59, 60, 3599, 3600, 86_400]) {
    assert.ok(humanLeft(seconds).length <= 3, `${seconds}s -> ${humanLeft(seconds)}`);
  }
});

test("humanLeft rounds DOWN, so the badge never promises time that is gone", () => {
  assert.equal(humanLeft(119), "1m");
  assert.equal(humanLeft(7199), "1h");
});

test("under a minute is <1m, not 0m", () => {
  assert.equal(humanLeft(59), "<1m");
  assert.equal(humanLeft(0), "<1m");
});

test("every badge says `left`, because the number is ambiguous without it", () => {
  assert.equal(badgeFor(state({ phase: "warm", secondsLeft: 2640 }), CFG), "⚡ 44m left");
  assert.equal(badgeFor(state({ phase: "expiring", secondsLeft: 240 }), CFG), "⚠ 4m left");
});

test("unknown paints NOTHING — never a `?`", () => {
  assert.equal(badgeFor(state({ phase: "unknown" }), CFG), null);
});

test("cold is a verdict, not a countdown", () => {
  assert.equal(badgeFor(state({ phase: "cold", secondsLeft: -900 }), CFG), "❄ COLD");
});

test("quietWhileWarm silences warm ONLY — bad news still gets through", () => {
  assert.equal(badgeFor(state({ phase: "warm" }), QUIET), null);
  assert.equal(badgeFor(state({ phase: "expiring", secondsLeft: 60 }), QUIET), "⚠ 1m left");
  assert.equal(badgeFor(state({ phase: "cold" }), QUIET), "❄ COLD");
});

test("the badge carries no ANSI escape — Herdr stores them verbatim and paints nothing", () => {
  for (const phase of ["warm", "expiring", "cold"] as const) {
    const out = badgeFor(state({ phase }), CFG) ?? "";
    assert.ok(!out.includes(""), `${phase} badge contains an escape`);
  }
});

test("the badge does not contain the word CACHE — the glyph is the label", () => {
  for (const phase of ["warm", "expiring", "cold"] as const) {
    assert.doesNotMatch(badgeFor(state({ phase }), CFG) ?? "", /cache/i);
  }
});
