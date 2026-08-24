/**
 * Thin wrapper over the `herdr` CLI. Every command we use returns
 * `{"id":..,"result":{..}}` on stdout and a JSON error on stderr with exit 1.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./runtime.ts";
import { PLUGIN_ID } from "./config.ts";

/**
 * Where to find the `herdr` CLI.
 *
 * Herdr injects `HERDR_BIN_PATH` into plugin commands, so a pane always knows.
 * Nothing else does: a plain `ssh host 'herdr-cache-alert sync'` gets a
 * non-interactive shell whose PATH never sourced a profile, and spawning a bare
 * `herdr` there dies with ENOENT. Same reason `scripts/run.sh` hunts for Bun
 * rather than trusting PATH — check the usual install locations too.
 */
export function herdrBin(): string {
  const explicit = process.env.HERDR_BIN_PATH;
  if (explicit) return explicit;
  const home = homedir();
  // PATH first, so an operator's own build still wins; the well-known
  // locations are the fallback, in `run.sh`'s order.
  const dirs = [
    ...(process.env.PATH ?? "").split(":").filter(Boolean),
    join(home, ".local", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  for (const dir of dirs) {
    const candidate = join(dir, "herdr");
    if (existsSync(candidate)) return candidate;
  }
  // Not found on disk: fall back to the name and let PATH try. The caller
  // reports the spawn failure; guessing a path here would only hide it.
  return "herdr";
}

const BIN = herdrBin();

export class HerdrError extends Error {
  // Declared and assigned separately rather than as constructor parameter
  // properties: those are not erasable syntax, and Node runs this file by
  // stripping types, not compiling them.
  readonly args: string[];
  readonly code: number;
  readonly stderr: string;

  constructor(args: string[], code: number, stderr: string) {
    super(`herdr ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

export async function herdr(...args: string[]): Promise<any> {
  const { stdout, stderr, code } = await run([BIN], args);
  if (code !== 0) throw new HerdrError(args, code, stderr);
  try {
    return JSON.parse(stdout).result;
  } catch {
    return { raw: stdout };
  }
}

/** Same as herdr() but returns null instead of throwing. */
export async function tryHerdr(...args: string[]): Promise<any | null> {
  try {
    return await herdr(...args);
  } catch {
    return null;
  }
}

/**
 * How Herdr names the agent session running in a pane.
 *
 * `value` is the harness's OWN session identifier — for Claude Code the
 * transcript uuid, which is the whole reason this plugin can read real cache
 * numbers instead of guessing. `kind` says what `value` means, so an adapter
 * must check it rather than assume an id.
 */
export interface AgentSession {
  agent: string;
  kind: string;
  source: string;
  value: string;
}

export interface PaneInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  /** Present once Herdr has DETECTED an agent. `agent_session` can arrive first. */
  agent?: string | null;
  agent_session?: AgentSession | null;
  agent_status?: string;
  cwd?: string | null;
  foreground_cwd?: string | null;
  label?: string | null;
  terminal_title?: string | null;
  /** Display-only metadata other sources (and we) have reported. */
  tokens?: Record<string, string>;
  focused: boolean;
}

export const getPane = (paneId: string): Promise<PaneInfo | null> =>
  tryHerdr("pane", "get", paneId).then((r) => r?.pane ?? null);

export const listPanes = async (): Promise<PaneInfo[]> =>
  (await tryHerdr("pane", "list"))?.panes ?? [];

export const notify = (title: string, body?: string) =>
  tryHerdr("notification", "show", title, ...(body ? ["--body", body] : []));

/**
 * What a pane id looks like: `w1T:p17`, `w654f9f0c0dd67e:pS`.
 *
 * Base36-ish on BOTH sides, not decimal — a digits-only pattern matches the
 * common case and silently rejects the rest.
 */
const PANE_ID = /^[A-Za-z0-9]+:[A-Za-z0-9]+$/;

/**
 * The pane an `[[events]]` hook fired for, when there is one.
 *
 * The manifest names events DOTTED (`pane.agent_detected`); the payload spells
 * the same event snake_case and nests the detail under `data`:
 * `{"event":"pane_agent_status_changed","data":{"pane_id":"w2H:p1",...}}`.
 * Verified against a live server — do not infer this shape from the manifest.
 *
 * This is what lets a hook repaint ONE pane instead of all of them.
 * `pane.agent_status_changed` fires whenever any agent changes state, which on a
 * busy workspace is several times a second, and a full sweep costs a probe per
 * pane. Returns null for a payload without a pane, where a full sweep is right.
 */
export function eventPaneId(): string | null {
  const raw = process.env.HERDR_PLUGIN_EVENT_JSON;
  if (!raw) return null;
  try {
    // SAFETY: Herdr's own payload, decoded at the boundary and then checked
    // against what a pane id actually looks like. Anything else falls through to
    // null, which costs a full sweep rather than painting a pane that is not there.
    const payload = JSON.parse(raw) as { data?: { pane_id?: string } };
    const id = payload.data?.pane_id ?? "";
    return PANE_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The metadata source we own. Scoping every write to it keeps other plugins' marks intact. */
export const METADATA_SOURCE = "cache-alert";

/**
 * One token per state, so the sidebar can COLOUR them differently.
 *
 * `ui.sidebar.agents.rows` styles a token statically — one `fg` per token, fixed
 * in config. A single `$cache` token can therefore only ever be one colour. So
 * we report the badge under a per-state name and clear the other two, and the
 * operator styles each: green, yellow, red. Exactly one is ever set, so the row
 * shows exactly one value.
 *
 * `cache` is reported alongside as the state-agnostic name, for anyone who wants
 * one uncoloured token instead of three.
 */
export const STATE_TOKENS = { warm: "cache_warm", expiring: "cache_expiring", cold: "cache_cold" } as const;

/**
 * The same three states again, for the row under the cursor.
 *
 * Herdr draws the ACTIVE sidebar row on `active_row_bg`, which on a dark theme is
 * a LIGHT grey — measured `#d2d3da` here against `#23273a` for its neighbours.
 * One static colour cannot serve both: the best possible compromise is about
 * 3.1:1 on each, which is why a green tuned for the dark rows disappeared on the
 * active one and a mid-tone read poorly on both.
 *
 * Since the style is fixed per token NAME, the way to vary it is to report a
 * different name — exactly the trick that already gives three states one colour
 * each. `_focus` variants carry dark colours for the light row; the plain ones
 * stay bright for the dark rows. That buys 4.8:1 or better everywhere.
 *
 * Exactly one of the SIX is ever set.
 */
const FOCUS_SUFFIX = "_focus";

/** Every token name this plugin may set, so a paint can clear the rest. */
export function allStateTokens(): string[] {
  return Object.values(STATE_TOKENS).flatMap((name) => [name, `${name}${FOCUS_SUFFIX}`]);
}

/**
 * Paints the cache badge, on BOTH surfaces Herdr offers.
 *
 * `--title` lands on the pane's top border. That border only exists while the
 * pane shares a tab, and only while `ui.show_agent_labels_on_pane_borders` is
 * true — two conditions the plugin cannot check and does not control.
 *
 * The state tokens land in the agent list, which renders regardless of borders
 * and regardless of how many panes a tab holds. They are governed by the
 * agent-list switch (`opts.agentList`, bound to prefix+alt+c), and when it is off
 * they are actively CLEARED rather than merely skipped, so switching off cleans
 * up after itself.
 *
 * All of it is scoped to our own metadata source, so clearing never disturbs a
 * title or a name another source reported.
 */
export interface CacheBadgeOptions {
  seq?: number;
  ttlMs?: number;
  /** Show the badge in the agent list, via the per-phase state tokens. */
  agentList?: boolean;
  /** Is this the pane under the cursor? Picks the `_focus` colour variant. */
  focused?: boolean;
  /** Which state token to set. Omit to clear all three. */
  phase?: keyof typeof STATE_TOKENS;
}

export async function setCacheBadge(
  paneId: string,
  badge: string | null,
  opts: CacheBadgeOptions = {},
): Promise<void> {
  const args = ["pane", "report-metadata", paneId, "--source", METADATA_SOURCE];
  if (badge) {
    args.push("--title", badge, "--token", `cache=${badge}`);
  } else {
    args.push("--clear-title", "--clear-token", "cache");
  }
  // At most one state token is ever set, and the rest are cleared, so a pane that
  // goes from warm to cold does not keep showing both in the sidebar.
  //
  // These tokens ARE the agent-list badge — Herdr renders whichever ones the
  // operator named in `ui.sidebar.agents.rows`, styled per token. So the
  // agent-list switch governs them, and nothing else.
  const wanted =
    badge && opts.agentList && opts.phase
      ? `${STATE_TOKENS[opts.phase]}${opts.focused ? FOCUS_SUFFIX : ""}`
      : "";
  for (const token of allStateTokens()) {
    if (token === wanted) args.push("--token", `${token}=${badge}`);
    else args.push("--clear-token", token);
  }
  // NEVER --display-agent, and always clear it.
  //
  // It REPLACES the agent's name, so the badge had to be pasted onto the name to
  // avoid losing it — and once the state tokens existed, the row rendered the
  // badge TWICE: once squeezed into the name column and truncated (`⚡ 35m le…`),
  // once in full from the token beside it. Clearing on every paint also means an
  // upgrade from a version that set this cleans up after itself.
  args.push("--clear-display-agent");
  // `--seq` makes a late report lose to a newer one: ticks are spawned
  // processes and they do not finish in the order they started.
  if (opts.seq !== undefined) args.push("--seq", String(opts.seq));
  // `--ttl-ms` is what makes a dead watcher self-clear. Without it, killing the
  // watcher freezes a number on the border that keeps looking authoritative.
  if (opts.ttlMs !== undefined) args.push("--ttl-ms", String(opts.ttlMs));
  await tryHerdr(...args);
}

export interface TabInfo {
  tab_id: string;
  label?: string | null;
  pane_count: number;
}

export const getTab = (tabId: string): Promise<TabInfo | null> =>
  tryHerdr("tab", "get", tabId).then((r) => r?.tab ?? null);

export const renameTab = (tabId: string, label: string) => tryHerdr("tab", "rename", tabId, label);

export async function openPluginPane(
  entrypoint: string,
  opts: {
    placement?: string;
    targetPane?: string;
    width?: string;
    height?: string;
    env?: Record<string, string>;
    focus?: boolean;
  } = {},
): Promise<string | null> {
  const args = ["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", entrypoint];
  if (opts.placement) args.push("--placement", opts.placement);
  if (opts.targetPane) args.push("--target-pane", opts.targetPane);
  if (opts.width) args.push("--width", opts.width);
  if (opts.height) args.push("--height", opts.height);
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--env", `${k}=${v}`);
  args.push(opts.focus ? "--focus" : "--no-focus");
  const res = await herdr(...args);
  return res?.plugin_pane?.pane?.pane_id ?? res?.pane?.pane_id ?? null;
}
