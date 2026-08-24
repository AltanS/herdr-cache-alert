/** User config, read from $HERDR_PLUGIN_CONFIG_DIR/config.json (all keys optional). */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** The plugin id in `herdr-plugin.toml`. Every `herdr plugin …` call needs it. */
export const PLUGIN_ID = "herdr.cache-alert";

/** The installed command name. Namespaced, like the plugin. */
export const BIN = "herdr-cache-alert";

/**
 * Where this checkout lives.
 *
 * Herdr injects `HERDR_PLUGIN_ROOT` for anything it launches; the fallback walks
 * up from this file for a plain CLI run. It lives here rather than in setup.ts so
 * the watcher can reach it without importing setup, which imports the watcher.
 */
export function pluginRoot(): string {
  const injected = process.env.HERDR_PLUGIN_ROOT;
  if (injected) return injected;
  return dirname(dirname(new URL(import.meta.url).pathname));
}

export interface Config {
  /** Seconds left at which the badge turns to the warning style. */
  warnSeconds: number;
  /** Hide the badge entirely while the cache is comfortably warm. */
  quietWhileWarm: boolean;
  /** Raise a Herdr notification when a turn comes back as a cold hit. */
  notifyOnCold: boolean;
  /** How long a cold-hit mark stays on the badge after the cold turn, in seconds. */
  coldStickySeconds: number;
  /** Milliseconds between ticks in the watcher. */
  pollMs: number;
  /**
   * Warn when a cache claim has not been re-verified in this many days. Cache
   * rules are vendor behaviour, not standards — they move, and a stale number
   * shown with confidence is worse than no number.
   */
  claimStaleDays: number;
  /** Force a harness adapter instead of detecting one. Empty means detect. */
  forceHarness: string;
  /** Force a tier (`subscription` | `api`) instead of detecting one. Empty means detect. */
  forceTier: string;
}

const DEFAULTS: Config = {
  warnSeconds: 300,
  quietWhileWarm: false,
  notifyOnCold: false,
  coldStickySeconds: 120,
  pollMs: 5000,
  claimStaleDays: 180,
  forceHarness: "",
  forceTier: "",
};

/** Mirrors Herdr's own plugin config layout — see the note on STATE_DIR in store.ts. */
const HERDR_HOME = process.env.HERDR_CONFIG_PATH
  ? dirname(process.env.HERDR_CONFIG_PATH)
  : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr");

export const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR || join(HERDR_HOME, "plugins", "config", PLUGIN_ID);

export const configPath = join(CONFIG_DIR, "config.json");

export function loadConfig(): Config {
  let fromFile: Partial<Config> = {};
  try {
    fromFile = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {}
  const cfg = { ...DEFAULTS, ...fromFile };
  if (process.env.CACHE_ALERT_HARNESS) cfg.forceHarness = process.env.CACHE_ALERT_HARNESS;
  if (process.env.CACHE_ALERT_TIER) cfg.forceTier = process.env.CACHE_ALERT_TIER;
  if (process.env.CACHE_ALERT_QUIET === "1") cfg.quietWhileWarm = true;
  return cfg;
}
