/**
 * `sessionKey` decides WHICH heartbeat file this process claims, and a wrong
 * answer is invisible: two sessions sharing one key means the second silently
 * gets no watcher, and its badges then freeze between events. That shipped once.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sessionKey, outdated, BADGE_TTL_MS, TICK_MS } from "../src/watch.ts";

afterEach(() => {
  delete process.env.HERDR_SOCKET_PATH;
});

test("no socket means the default session", () => {
  assert.equal(sessionKey(), "default");
});

test("the default session's socket sits directly in the config dir", () => {
  process.env.HERDR_SOCKET_PATH = "/home/x/.config/herdr/herdr.sock";
  assert.equal(sessionKey(), "default");
});

test("a named session is keyed by its own directory", () => {
  process.env.HERDR_SOCKET_PATH = "/home/x/.config/herdr/sessions/collie-demo/herdr.sock";
  assert.equal(sessionKey(), "collie-demo");
});

test("two different sessions never share a key", () => {
  process.env.HERDR_SOCKET_PATH = "/home/x/.config/herdr/sessions/a/herdr.sock";
  const a = sessionKey();
  process.env.HERDR_SOCKET_PATH = "/home/x/.config/herdr/sessions/b/herdr.sock";
  assert.notEqual(a, sessionKey());
});

test("a session name that is not filename-safe cannot escape the state dir", () => {
  process.env.HERDR_SOCKET_PATH = "/home/x/.config/herdr/sessions/../../etc/herdr.sock";
  const key = sessionKey();
  assert.ok(!key.includes("/"));
  assert.ok(!key.includes(".."), key);
});

test("the badge TTL outlives one missed tick and not two", () => {
  assert.ok(BADGE_TTL_MS > TICK_MS, "a badge that expires before the next tick flickers");
  assert.ok(BADGE_TTL_MS < TICK_MS * 3, "a dead watcher must not leave an authoritative-looking number");
});

test("a watcher from an older checkout is outdated, so the hooks replace it", () => {
  // A watcher never re-reads its own code. One left on old code repainted every
  // pane the old way each tick, and the hooks repainted it back: a flicker every 30s.
  assert.equal(outdated({ version: "0.5.0" }, "1.0.0"), true);
  assert.equal(outdated({}, "1.0.0"), true, "a beat from before versioned beats is outdated too");
  assert.equal(outdated({ version: "1.0.0" }, "1.0.0"), false);
});

test("an unreadable manifest never replaces a healthy watcher", () => {
  assert.equal(outdated({ version: "1.0.0" }, null), false);
  assert.equal(outdated(null, "1.0.0"), false, "no beat is no watcher, not an old one");
});
