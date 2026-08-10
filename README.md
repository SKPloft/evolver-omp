# evolver-omp

> ⚠️ **This repository is 100% AI/LLM-driven. Review everything before use — use at your own risk.**
>
> 本仓库完全由 AI/LLM 驱动生成，使用前请自行审查，风险自负。

An [omp](https://omp.sh) (Oh My Pi) adaptation of [Evolver](https://github.com/EvoMap/evolver) — the GEP-powered self-evolution engine for AI agents. omp is a pi fork, so this is written as a pi-style extension and also loads under upstream pi.

Installed as an omp **marketplace plugin** (the standard omp mechanism): the extension module comes from `package.json#omp.extensions`, the MCP server from `.omp-plugin/plugin.json`, and the launcher is resolved relative to the installed plugin — no machine-specific paths, no hand-written config edits.

## What it does

| Lifecycle | Hook | Effect |
|---|---|---|
| `session_start` | `evolver inject session-start` | injects recent evolution memory into the system prompt |
| `before_agent_start` | `evolver inject prompt-recall` | opt-in per-prompt distilled GEP hints (`EVOLVER_RECALL_MODE=enforce\|shadow`) |
| any time | `evolver_*` MCP tools | full Evolver tool surface via `@evomap/evolver-mcp` |
| `/evolver` | status + manual `run` | integration diagnostics and manual evolution cycle |

Everything is fail-open: if evolver is missing or broken, the hooks return `{}` and the session is unaffected.

## Install (standard omp marketplace)

Prerequisite: `@evomap/evolver` v2 installed and resolvable (`npm i -g @evomap/evolver`, or set `EVOLVER_ROOT`; `scripts/locate-evolver.cjs` also covers the mise layout).

Published install (once, global — available in every session):

```bash
omp plugin marketplace add SKPloft/evolver-omp   # or: omp plugin marketplace add ./path/to/evolver-omp
omp plugin install evolver-omp@evolver-omp
```

Or use the included bootstrap, which runs exactly those two commands (plus optional extras):

```bash
node scripts/setup.mjs install            # add marketplace + install, user scope
node scripts/setup.mjs install --agents   # also inject the AGENTS.md evolution section (per-project sugar)
```

Then restart omp (extension modules load at startup; `/reload-plugins` refreshes MCP servers), and check:

```bash
/mcp list        # 'evolver-omp:evolver' should appear; /mcp test evolver-omp:evolver
/evolver         # status; /evolver run triggers an evolution cycle
EVOLVER_RECALL_MODE=enforce omp   # opt into per-prompt recall
```

Per-project isolation: `omp plugin install --scope project evolver-omp@evolver-omp` (or `node scripts/setup.mjs install --scope project --project <repo>`).

Upgrade / uninstall are the standard commands:

```bash
omp plugin upgrade evolver-omp@evolver-omp
omp plugin uninstall evolver-omp@evolver-omp      # or: node scripts/setup.mjs uninstall
```

`node scripts/setup.mjs verify | status` for diagnostics. Earlier versions of this repo installed via a hand-rolled symlink + mcp.json merge; `setup.mjs install/uninstall` detects and cleans that legacy state automatically.

## Optional: AGENTS.md evolution section

A static per-project section telling the agent the project uses evolver and when to use it (useful while the memory store is still empty). Not part of the plugin model — opt in explicitly:

```bash
node scripts/setup.mjs agents inject --project <repo>   # add the section
node scripts/setup.mjs agents remove --project <repo>   # remove it
```

## Upstream pi

pi has no marketplace concept; its standard install is `pi install <source>` (npm:/git:/local path), which auto-discovers the conventional `extensions/` directory:

```bash
pi install /path/to/evolver-omp        # or: pi install git:github.com/SKPloft/evolver-omp
```

`pi -e extensions/index.ts` also loads the extension, but pi's docs frame `-e` as the quick-test path — use `pi install` for a permanent install. The MCP server and AGENTS.md bits are omp-specific.

## Claude Code

The `.claude-plugin/marketplace.json` catalog is installable in Claude Code (`/plugin marketplace add` + `/plugin install evolver-omp@evolver-omp`) and now ships a `.claude-plugin/plugin.json` declaring the evolver MCP server, so Claude Code users get the `evolver_*` MCP tools. The extension hooks (session memory injection, `/evolver` command) are omp/pi-specific — Claude Code plugins cannot load runtime extension modules, so that part does not carry over.

## Notes

- The v2 hooks (`evolver inject ... --hook-stdin`) follow the same design as upstream Evolver's installers (hooks for lifecycle, MCP for tools), but upstream `evolver setup-hooks` has no omp/pi runtime and its generated MCP configs embed absolute machine paths; this repo's portable launcher (`scripts/evolver-mcp.cjs`) is what keeps marketplace-distributed configs machine-independent.
- Targets evolver **v2** (`evolver inject ... --hook-stdin`). The upstream main branch still shows the v1 hook-script layout; v2 dropped the v1 Stop/PostToolUse scripts in favor of the daemon.
- Evolver's own install-root allowlist omits the mise layout; `locate-evolver.cjs` covers it and exports `EVOLVER_ROOT` to spawned CLI processes.
- License: GPL-3.0-or-later (same as Evolver).

## Migration from earlier versions

- Earlier `setup.mjs` accepted `--no-mcp` / `--no-agents`; both are removed (they now fail with an explicit error). The MCP server is intrinsic to the plugin — it is declared in `.omp-plugin/plugin.json` and always ships with an install. The AGENTS.md section is opt-in via `--agents` or `node scripts/setup.mjs agents inject`.
- Re-running `install` no longer refreshes an existing AGENTS.md section (it never did so once the marker was present; remove it explicitly with `agents remove`).
- Legacy installs (old symlink + mcp.json entry) are detected and cleaned by `install` / `uninstall` automatically.

## Structure

```
extensions/          pi-style omp extension (zero-dependency TS), loaded via package.json#omp.extensions
scripts/
  locate-evolver.cjs evolver install + CLI + MCP entry resolution (covers mise)
  evolver-mcp.cjs    portable MCP launcher (no machine-specific paths in config)
  setup.mjs          bootstrap over `omp plugin` + AGENTS.md sugar + diagnostics
test/smoke.ts        bun smoke tests (locator, hooks round-trip, packaging)
.omp-plugin/         omp marketplace catalog + plugin manifest (MCP server declaration)
.claude-plugin/      Claude Code catalog + plugin manifest (MCP server only)
```
