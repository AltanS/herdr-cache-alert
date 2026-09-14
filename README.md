# Cache Alert

A [Herdr](https://herdr.dev) plugin. It adds a prompt-cache countdown to every agent pane and marks
turns that missed the cache.

A cold turn re-reads the full conversation at full input price. The badge shows remaining cache
time and flags turns that paid full price anyway.

![The cache badge in the Herdr agent list and tab bar](docs/agent-list.png)

## Install

Requires **Herdr 0.8+** and **Node 22.6+ or [Bun](https://bun.sh)**. No build step.

```bash
herdr plugin install AltanS/herdr-cache-alert
herdr plugin action invoke setup --plugin herdr.cache-alert
herdr integration install claude     # or codex, opencode; then restart the agent
```

The integration hook maps panes to sessions. Without it, the plugin displays nothing.

### It needs lines in `config.toml`

A Herdr plugin cannot change how Herdr draws its screen. Most of the badge depends on lines in
`~/.config/herdr/config.toml`. **Setup adds them for you**, each between
`# cache-alert:begin` and `# cache-alert:end` markers:

| you see | needs a config line? |
| --- | --- |
| badge next to the agent name, in the sidebar | no |
| badge colours in the sidebar | yes, `ui.sidebar.agents.rows` |
| countdown in the tab bar | yes, `ui.tab_bar_right` |
| badge on split pane borders | yes, `ui.show_agent_labels_on_pane_borders = true` |
| `prefix+alt+c` toggle | yes, a `[[keys.command]]` entry |

Setup never changes a line outside its markers. When you already set one of these keys yourself, setup
keeps your value and tells you. You can run setup again at any time to repair an install.

## What you see

| badge | meaning |
| --- | --- |
| `⚡ 44m left` | warm: the cache survives 44 more idle minutes |
| `⚡ 4m left` | expiring: under 25% of the TTL left, yellow in the sidebar |
| `❄ COLD` | the last turn missed the cache |
| *(nothing)* | unknown |

Each message resets the countdown to the full TTL. Badges appear in the tab bar, on split-pane
borders, and in the agent sidebar. Press `prefix+alt+c` to toggle the badge in the sidebar.

<img src="docs/sidebar-states.png" alt="Agents in the Herdr sidebar with warm and cold cache badges" width="420">

## Remote clients

Clients attached via `herdr --remote` use their local `config.toml`, not the server's. So the table
above applies to the client machine: without those lines, the agent sidebar shows no badge. The
border badge still shows. To get the sidebar badge, colors, tab bar entries, and keybindings,
merge the blocks into the client config:

```bash
ssh <server> '~/.local/bin/herdr-cache-alert client-config' \
  < ~/.config/herdr/config.toml > /tmp/herdr.toml \
  && HERDR_CONFIG_PATH=/tmp/herdr.toml herdr config check \
  && cp ~/.config/herdr/config.toml ~/.config/herdr/config.toml.bak \
  && mv /tmp/herdr.toml ~/.config/herdr/config.toml
```

Reattach after running this. To inherit the server's keybindings directly, attach with
`herdr --remote <server> --remote-keybindings server`.

## Nothing showing?

1. `herdr integration status` shows the hook, and you restarted the agent after installing it.
2. `herdr-cache-alert doctor` shows a `session` for the pane.
3. `herdr-cache-alert watch status` shows a running watcher.
4. You ran `herdr server reload-config` after editing `config.toml`.

## Where the numbers come from

Every TTL in the source links to documentation, a quote, and a verification date. Run
`herdr-cache-alert claims --stale` to list outdated entries. Log-measured TTLs override
documented values. When unsure, the plugin applies the shorter TTL.

The plugin parses Claude Code transcripts, Codex rollout logs, and the opencode session database.
OpenRouter has a cache rule in this plugin but no logs to read. Set
`CACHE_ALERT_HARNESS=openrouter` to enable it.

## Commands and config

Run `herdr-cache-alert help` for the full command list. Common commands: `status`, `explain`,
`doctor`, `update`, `uninstall`.

Configure optional settings in `~/.config/herdr/plugins/config/herdr.cache-alert/config.json`:

| key | default | effect |
| --- | --- | --- |
| `quietWhileWarm` | `false` | show nothing until the cache is in trouble |
| `notifyOnCold` | `false` | send a Herdr notification on a cache miss |
| `coldStickySeconds` | `120` | how long a cold mark stays |
| `forceHarness` / `forceTier` | `""` | skip detection |

## Development

```bash
git clone git@github.com:AltanS/herdr-cache-alert.git && bun install
herdr plugin link "$PWD"     # re-run after any manifest change
bun run lint && bun x tsc --noEmit && bun run test
```

Read [CLAUDE.md](./CLAUDE.md) for claim contracts, versioning rules, and Herdr API quirks.

## License

MIT © Altan Sarisin
