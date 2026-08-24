#!/usr/bin/env bun
/**
 * `herdr-cache-alert` — the shell surface.
 *
 * Also the plugin's own hook runner: `[[startup]]` and `[[events]]` in the
 * manifest call `cli sync`, so one code path paints whether the trigger was a
 * Herdr event, a watcher tick, or an operator typing.
 */

import { badgeFor, explain } from "./badge.ts";
import { claimAgeDays, staleClaims, type CacheRule } from "./claims.ts";
import { BIN, configPath, loadConfig } from "./config.ts";
import { evaluate } from "./engine.ts";
import { allRules } from "./harness/index.ts";
import { ADAPTERS } from "./harness/index.ts";
import { eventPaneId, getPane, listPanes, type PaneInfo } from "./herdr.ts";
import { agentListEnabled, allMemos, setAgentList, STATE_DIR } from "./store.ts";
import { clearAll, syncAll, syncPane } from "./sync.ts";
import { runTabbar } from "./tabbar.ts";
import { update, wantsMajor } from "./update.ts";
import { pluginRoot, setup, sidebarTokenReport, SIDEBAR_BLOCK, tabBarEntry, TOGGLE_KEY } from "./setup.ts";
import { keptAfterUninstall, uninstall } from "./uninstall.ts";
import { report } from "./report.ts";
import { BADGE_TTL_MS, ensureWatcher, runningWatcher, stopWatcher, watch } from "./watch.ts";

const argv = process.argv.slice(2);
const command = argv[0] ?? "status";
const flag = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const has = (name: string) => argv.includes(`--${name}`);

const USAGE = `${BIN} — prompt-cache countdown for Herdr agent panes

  status [--pane ID]     what every agent pane's cache is doing
  explain [--pane ID]    where a pane's number comes from, claim by claim
  rules [--json]         every cache rule this plugin ships, with sources
  claims [--stale DAYS]  cache claims nobody has re-verified lately
  toggle [on|off]        mirror the badge into the agent list (prefix+alt+c);
                         bare toggle flips it, and doctor reports the state
  sidebar-snippet        the [ui.sidebar.agents] rows that colour the badge
  tabbar-snippet         the ui.tab_bar_right entry that drives the countdown
  tabbar                 one line for Herdr's tab-bar status area — what the
                         ui.tab_bar_right command entry calls every few seconds
  sync                   paint every pane once (what the Herdr hooks call)
  ensure                      paint once, and start this session's watcher if it has none
  watch [--force|stop|status]
                         the ticking painter — one per Herdr session
  clear                  remove every badge this plugin painted
  setup [--no-keys]      link the plugin, install this CLI, bind the key, start the
                         watcher and paint once — safe to re-run
  uninstall [--dry-run] [--keep-config]
                         remove every trace, in the order that actually works
  update [--major]       advance the checkout and re-register it
  doctor                 resolved paths and detection state, for a bug report`;

/** The pane to act on: `--pane`, else the pane this command was invoked from. */
async function targetPane(): Promise<PaneInfo | null> {
  const id = flag("pane") ?? process.env.HERDR_ACTIVE_PANE_ID ?? null;
  return id ? getPane(id) : null;
}

/** Agent panes only — a shell pane has no cache and gets no row. */
async function agentPanes(): Promise<PaneInfo[]> {
  return (await listPanes()).filter((pane) => pane.agent || pane.agent_session);
}

function ruleLine(rule: CacheRule): string[] {
  const ttl = rule.ttlSeconds;
  const out = [
    `${rule.id}  —  ${rule.label}`,
    `  ttl        ${ttl.value}s (${ttl.confidence})`,
    `  window     ${rule.slidingWindow ? "sliding — each hit resets the clock" : "absolute — runs from cache creation"}`,
    `  caching    ${rule.automatic ? "automatic" : "needs explicit cache_control breakpoints"}`,
  ];
  if (rule.minTokens) out.push(`  min prefix ${rule.minTokens.value} tokens (${rule.minTokens.confidence})`);
  out.push(`  source     ${ttl.source.url || ttl.source.title} (checked ${ttl.source.retrievedAt}, ${claimAgeDays(ttl.source)}d ago)`);
  if (ttl.source.quote) out.push(`             "${ttl.source.quote}"`);
  if (ttl.note) out.push(`  note       ${ttl.note}`);
  for (const note of rule.notes ?? []) out.push(`  ·          ${note}`);
  return out;
}

async function main(): Promise<number> {
  const cfg = loadConfig();

  switch (command) {
    case "status": {
      const one = await targetPane();
      const panes = one ? [one] : await agentPanes();
      if (!panes.length) {
        console.log("no agent panes — is Herdr running, and has it detected an agent?");
        return 0;
      }
      for (const pane of panes) {
        const state = await evaluate(pane, cfg);
        const badge = badgeFor(state, cfg) ?? "—";
        // A long-idle pane is minus-hundreds-of-thousands of seconds, which is
        // true and useless. Past expiry, the badge already says COLD.
        const left =
          state.secondsLeft === null ? "" : state.secondsLeft > 0 ? `${state.secondsLeft}s left` : "expired";
        const harness = state.adapter?.label ?? "unknown harness";
        console.log(`${pane.pane_id.padEnd(12)} ${badge.padEnd(8)} ${state.phase.padEnd(9)} ${harness.padEnd(16)} ${left}`);
      }
      return 0;
    }

    case "explain": {
      const pane = (await targetPane()) ?? (await agentPanes())[0];
      if (!pane) {
        console.error("no pane to explain — pass --pane <id>");
        return 1;
      }
      console.log(`pane ${pane.pane_id}`);
      for (const line of explain(await evaluate(pane, cfg))) console.log(`  ${line}`);
      return 0;
    }

    case "rules": {
      const rules = allRules();
      if (has("json")) {
        console.log(JSON.stringify(rules, null, 2));
        return 0;
      }
      for (const rule of rules) {
        for (const line of ruleLine(rule)) console.log(line);
        console.log("");
      }
      return 0;
    }

    case "claims": {
      const maxDays = Number(flag("stale") ?? cfg.claimStaleDays);
      const stale = staleClaims(allRules(), maxDays);
      if (!stale.length) {
        console.log(`✓ every claim has been checked within ${maxDays} days`);
        return 0;
      }
      // Non-zero exit so this can gate a release: a cache rule nobody has
      // re-read in six months is a number this plugin should stop asserting.
      console.log(`${stale.length} claim(s) not verified in ${maxDays} days:`);
      for (const claim of stale) {
        console.log(`  ${claim.ruleId}.${claim.field} — ${claim.ageDays}d old — ${claim.source.url || claim.source.title}`);
      }
      return 1;
    }

    case "toggle": {
      const asked = argv[1] ?? "";
      // Anything that is not on/off/empty is a TYPO, not a request to flip.
      // Silently toggling on `toggle status` leaves the operator believing they
      // read the state when they in fact changed it.
      if (asked && asked !== "on" && asked !== "off") {
        console.error(`${BIN}: toggle takes "on", "off", or nothing at all — got "${asked}"`);
        return 2;
      }
      const on = asked === "on" ? true : asked === "off" ? false : !agentListEnabled();
      setAgentList(on);
      // Repaint immediately rather than leave the operator waiting up to a full
      // tick to see whether their keypress did anything.
      await syncAll(BADGE_TTL_MS, cfg);
      console.log(on ? "agent list: badge ON" : "agent list: badge OFF (the pane border keeps it)");
      return 0;
    }

    case "tabbar": {
      await runTabbar();
      return 0;
    }

    case "tabbar-snippet": {
      console.log(`# add to your [ui] tab_bar_right list:\n${tabBarEntry(pluginRoot())}`);
      return 0;
    }

    case "sidebar-snippet": {
      console.log(SIDEBAR_BLOCK.trim());
      return 0;
    }

    case "sync": {
      const painted = await syncAll(BADGE_TTL_MS, cfg);
      for (const p of painted) console.log(`${p.paneId} ${p.badge ?? "(cleared)"}`);
      return 0;
    }

    // What Herdr's startup and event hooks run. Painting once is the easy half;
    // the important half is that a session which has no watcher gets one. The
    // watcher is per-session and nothing else starts it, so a server restart, a
    // crashed tick, or simply attaching a second session would otherwise leave
    // that session repainting on events alone — which stops the moment the
    // agent goes idle, and idle is exactly what this plugin is about.
    case "ensure": {
      const w = await ensureWatcher();
      if (w) console.log(`watcher ${w.started ? "started" : "already running"} (pid ${w.pid})`);
      // An event hook names ONE pane, so repaint only that one. A full sweep
      // costs a probe per pane, and `pane.agent_status_changed` fires several
      // times a second on a busy workspace — measured four full sweeps of
      // eleven panes inside one second here. Startup has no event and still
      // sweeps, which is what it is for.
      const only = eventPaneId();
      if (only) {
        const one = await syncPane(only, BADGE_TTL_MS, cfg);
        console.log(one ? `${one.paneId} ${one.badge ?? "(cleared)"}` : `${only} (gone)`);
        return 0;
      }
      const painted = await syncAll(BADGE_TTL_MS, cfg);
      for (const p of painted) console.log(`${p.paneId} ${p.badge ?? "(cleared)"}`);
      return 0;
    }

    case "watch": {
      const sub = argv[1] ?? "";
      if (sub === "stop") {
        console.log(stopWatcher() ? "watcher stopped" : "no watcher was running");
        return 0;
      }
      if (sub === "status") {
        const pid = runningWatcher();
        console.log(pid === null ? "no watcher running" : `watcher running (pid ${pid})`);
        return 0;
      }
      await watch({ force: has("force") });
      return 0;
    }

    case "clear": {
      const count = await clearAll();
      console.log(`cleared every cache-alert badge and tab mark across ${count} pane(s)`);
      return 0;
    }

    case "setup": {
      const steps = await setup({ noKeys: has("no-keys") });
      // The footer is the part people actually act on: the badge is ambient and
      // easy to miss, and the toggle is invisible unless somebody says the chord.
      const notes = [
        `keys: ${TOGGLE_KEY} → show or hide the badge in the agent list`,
        "next: leave a pane idle and watch the number fall. `herdr-cache-alert explain` says where it comes from.",
        "undo: `herdr-cache-alert uninstall` removes every trace, config included.",
      ];
      return report(steps, steps.every((step) => step.ok) ? notes : [...notes, "", "Fix the `!` lines above and re-run — setup is safe to run again."]);
    }

    case "uninstall": {
      const steps = await uninstall({ keepConfig: has("keep-config"), dryRun: has("dry-run") });
      if (has("dry-run")) {
        return report(steps, ["Nothing was changed. Re-run without --dry-run to do it."]);
      }
      const kept = keptAfterUninstall(pluginRoot());
      return report(steps, ["kept:", ...kept.map((line) => `  ${line}`)]);
    }

    case "update": {
      const steps = await update({ major: wantsMajor(argv) });
      for (const step of steps) console.log(`${step.ok ? "ok" : "FAILED"}  ${step.what}: ${step.detail}`);
      return steps.every((step) => step.ok) ? 0 : 1;
    }

    case "doctor": {
      const panes = await agentPanes();
      const rows = [];
      for (const pane of panes) {
        const state = await evaluate(pane, cfg);
        rows.push({
          pane: pane.pane_id,
          agent: pane.agent ?? pane.agent_session?.agent ?? null,
          session: state.sessionId,
          adapter: state.adapter?.id ?? null,
          tier: state.tier?.tier ?? null,
          tierConfidence: state.tier?.confidence ?? null,
          ttlSeconds: state.ttl?.value ?? null,
          ttlConfidence: state.ttl?.confidence ?? null,
          phase: state.phase,
          probe: state.probe?.evidence ?? null,
        });
      }
      console.log(
        JSON.stringify(
          {
            pluginRoot: process.env.HERDR_PLUGIN_ROOT ?? null,
            stateDir: STATE_DIR,
            configPath,
            config: cfg,
            adapters: ADAPTERS.map((a) => ({ id: a.id, label: a.label, rules: a.rules.map((r) => r.id) })),
            watcher: runningWatcher(),
            agentListBadge: agentListEnabled(),
            // A token this version paints but the config does not style renders
            // as nothing, and the paint still succeeds — so it can only be
            // found by comparing the two lists.
            sidebarTokens: sidebarTokenReport(),
            rememberedSessions: allMemos().length,
            panes: rows,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;

    default:
      console.error(`${BIN}: unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

process.exit(await main());
