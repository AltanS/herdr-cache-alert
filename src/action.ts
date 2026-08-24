#!/usr/bin/env bun
/**
 * Plugin action dispatcher.
 *
 * Herdr runs actions DETACHED, so stdout only reaches
 * `herdr plugin log list --plugin herdr.cache-alert`. Anything the operator
 * must see goes through a notification instead.
 */

import { badgeFor, explain } from "./badge.ts";
import { BIN, PLUGIN_ID, loadConfig } from "./config.ts";
import { evaluate } from "./engine.ts";
import { getPane, listPanes, notify, openPluginPane } from "./herdr.ts";
import { errorMessage } from "./runtime.ts";
import { setup } from "./setup.ts";
import { uninstall } from "./uninstall.ts";
import { agentListEnabled, setAgentList } from "./store.ts";
import { clearAll, syncAll } from "./sync.ts";
import { update } from "./update.ts";
import { BADGE_TTL_MS, runningWatcher, stopWatcher, watch } from "./watch.ts";

interface Context {
  focused_pane_id?: string | null;
}

const context: Context = (() => {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
  } catch {
    return {};
  }
})();

const focusedPane = () => {
  const id = context.focused_pane_id || process.env.HERDR_ACTIVE_PANE_ID;
  if (!id) throw new Error("no focused pane in the action context");
  return id;
};

const action = process.argv[2] ?? "";

try {
  switch (action) {
    case "explain": {
      const paneId = focusedPane();
      // Overlay, not popup: it covers the active pane and restores focus and
      // zoom on exit. `--width`/`--height` are rejected for anything but popup.
      await openPluginPane("panel", {
        placement: "overlay",
        env: { CACHE_ALERT_TARGET_PANE: paneId },
        focus: true,
      });
      break;
    }

    case "status": {
      // No popup: one pane, one sentence, straight into a notification.
      const paneId = focusedPane();
      const pane = await getPane(paneId);
      if (!pane) throw new Error(`pane ${paneId} is gone`);
      const cfg = loadConfig();
      const state = await evaluate(pane, cfg);
      const lines = explain(state);
      console.log(lines.join("\n"));
      await notify(`Cache ${badgeFor(state, cfg) ?? "unknown"}`, lines[lines.length - 1]);
      break;
    }

    case "toggle": {
      const on = !agentListEnabled();
      setAgentList(on);
      // Repaint now: a keypress that appears to do nothing for 30 seconds reads
      // as a broken binding, and the operator retries it back to where it was.
      await syncAll(BADGE_TTL_MS);
      console.log(`agent list badge ${on ? "on" : "off"}`);
      await notify(
        "cache-alert",
        on ? "Cache badge shown in the agent list" : "Cache badge hidden from the agent list — the tab bar and pane border keep it",
      );
      break;
    }

    case "uninstall": {
      // Detached, so stdout only reaches the plugin log. The notification is the
      // only thing the operator will see, and it has to name what was kept.
      const steps = await uninstall();
      for (const step of steps) console.log(`${step.ok ? "ok" : "!!"}  ${step.what}: ${step.detail}`);
      const bad = steps.filter((step) => !step.ok);
      await notify(
        "cache-alert removed",
        bad.length === 0
          ? "Badges cleared, config restored, watcher stopped. The checkout is still on disk."
          : `${bad.length} step(s) need you — see \`herdr plugin log list --plugin ${PLUGIN_ID}\``,
      );
      break;
    }

    case "sync": {
      const painted = await syncAll(BADGE_TTL_MS);
      console.log(painted.map((p) => `${p.paneId} ${p.badge ?? "(cleared)"}`).join("\n"));
      break;
    }

    case "watch-start": {
      // Runs in the foreground of this detached action process, which then IS
      // the watcher — Herdr keeps the process alive, so nothing to daemonise.
      await watch({ force: true });
      break;
    }

    case "watch-stop": {
      const stopped = stopWatcher();
      // Badges outlive the watcher by one `--ttl-ms` window, so clear them now
      // rather than leave a number ticking down that nothing is updating. The
      // tab marks are cleared with them — those are real renames, not metadata.
      await clearAll();
      await notify("cache-alert", stopped ? "Watcher stopped, badges cleared" : "No watcher was running");
      break;
    }

    case "setup": {
      const steps = await setup();
      for (const step of steps) console.log(`${step.ok ? "ok" : "FAILED"}  ${step.what}: ${step.detail}`);
      const failed = steps.filter((step) => !step.ok);
      await notify(
        "cache-alert",
        failed.length
          ? failed.map((step) => step.detail).join(" · ")
          : "Ready — badges appear on agent panes within 30s",
      );
      break;
    }

    case "update":
    case "update-major": {
      const steps = await update({ major: action === "update-major" });
      for (const step of steps) console.log(`${step.ok ? "ok" : "FAILED"}  ${step.what}: ${step.detail}`);
      const failed = steps.filter((step) => !step.ok);
      await notify(
        failed.length ? "cache-alert update failed" : "cache-alert",
        (failed.length ? failed : steps).map((step) => step.detail).join(" · "),
      );
      break;
    }

    case "doctor": {
      // Printed to `herdr plugin log list --plugin herdr.cache-alert`.
      const cfg = loadConfig();
      const rows = [];
      for (const pane of await listPanes()) {
        if (!pane.agent && !pane.agent_session) continue;
        const state = await evaluate(pane, cfg);
        rows.push({
          pane: pane.pane_id,
          phase: state.phase,
          ttl: state.ttl?.value ?? null,
          probe: state.probe?.evidence ?? null,
        });
      }
      console.log(JSON.stringify({ context, watcher: runningWatcher(), config: cfg, panes: rows }, null, 2));
      // A dead watcher is the one fault an operator cannot see in the log they
      // were told to read, so it goes in the notification rather than inside it.
      await notify(
        "cache-alert",
        runningWatcher() === null
          ? "Diagnostics in the plugin log — NO WATCHER RUNNING, so badges will not tick"
          : "Diagnostics in the plugin log — watcher is running",
      );
      break;
    }

    default:
      throw new Error(`unknown action "${action}"`);
  }
} catch (err) {
  const message = errorMessage(err);
  console.error(`${BIN}: ${message}`);
  await notify("cache-alert failed", message);
  process.exit(1);
}
