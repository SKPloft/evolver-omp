# evolver-omp

> ⚠️ **This repository is 100% AI/LLM-driven. Review everything before use — use at your own risk.**
>
> 本仓库完全由 AI/LLM 驱动生成，使用前请自行审查，风险自负。

An [omp](https://omp.sh) (Oh My Pi) adaptation of [Evolver](https://github.com/EvoMap/evolver) — the GEP-powered self-evolution engine for AI agents. omp is a pi fork, so this is written as a pi-style example extension and also loads under upstream pi (`pi -e extensions/index.ts`).

## What it does

| Lifecycle | Hook | Effect |
|---|---|---|
| `session_start` | `evolver inject session-start` | injects recent evolution memory into the system prompt |
| `before_agent_start` | `evolver inject prompt-recall` | opt-in per-prompt distilled GEP hints (`EVOLVER_RECALL_MODE=enforce\|shadow`) |
| any time | `evolver_*` MCP tools | full Evolver tool surface via `@evomap/evolver-mcp` |
| `/evolver` | status + manual `run` | integration diagnostics and manual evolution cycle |

Everything is fail-open: if evolver is missing or broken, the hooks return `{}` and the session is unaffected.

## Install (one-time, global)

```bash
npm i -g @evomap/evolver        # prerequisite (v2)
cd evolver-omp
node scripts/setup.mjs install  # user scope: ~/.omp/agent, enabled in every session
# restart omp, then:
#   /mcp list     -> 'evolver' server should appear
#   /evolver      -> status
#   EVOLVER_RECALL_MODE=enforce omp   # opt into per-prompt recall
```

Per-project isolation: `node scripts/setup.mjs install --scope project --project <repo>` (extension + MCP land in `<repo>/.omp/`).

`node scripts/setup.mjs verify | status | uninstall` for the rest of the lifecycle.

## Structure

```
extensions/          pi-style omp extension (zero-dependency TS)
scripts/
  locate-evolver.cjs evolver install + CLI + MCP entry resolution (covers mise)
  evolver-mcp.cjs    portable MCP launcher (no machine-specific paths in config)
  setup.mjs          install / uninstall / verify / status
test/smoke.ts        bun smoke tests (locator, hooks round-trip, packaging)
.omp-plugin/         omp marketplace catalog
.claude-plugin/      Claude Code-compatible fallback catalog
```

## Notes

- Targets evolver **v2** (`evolver inject ... --hook-stdin`). The upstream main branch still shows the v1 hook-script layout; v2 dropped the v1 Stop/PostToolUse scripts in favor of the daemon.
- Evolver's own install-root allowlist omits the mise layout; `locate-evolver.cjs` covers it and exports `EVOLVER_ROOT` to spawned CLI processes.
- License: GPL-3.0-or-later (same as Evolver).
