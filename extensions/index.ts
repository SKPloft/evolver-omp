// index.ts — evolver-omp: an omp (Oh My Pi) adaptation of Evolver.
//
// Style reference: pi's example extensions
// (github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions)
// and the OpenViking pi extension (examples/pi-coding-agent-extension), which
// wire a memory backend into the session via the pi/omp ExtensionAPI. omp is a
// pi fork, so the surface is the same; this file also loads under upstream pi
// (`pi -e extensions/index.ts`).
//
// What this extension wires — the two lifecycle hooks evolver v2 registers on
// every other host (`evolver inject ... --hook-stdin`):
//
//   session_start        -> evolver inject session-start   (memory hint)
//   before_agent_start   -> evolver inject prompt-recall   (distilled hints, opt-in)
//
// v2 deliberately dropped the v1 Stop/PostToolUse hook scripts (outcome
// recording + signal detection now live in the evolver daemon), so there is
// nothing to wire on session_shutdown or tool_result. The evolver_* MCP tools
// come from the @evomap/evolver-mcp server, declared in .omp-plugin/plugin.json
// and registered by omp's marketplace plugin loader — the same split as
// Evolver's own installers (hooks for lifecycle, MCP for tools).
import { createRequire } from "node:module";
import { runCapabilities } from "./capabilities.ts";
import { loadConfig } from "./config.ts";
import { pickString, runInject } from "./hooks.ts";
import { buildStatus, formatStatus } from "./status.ts";
import { asRecord, strField } from "./types.ts";
import type { EvolverConfig, OmpExtensionAPI } from "./types.ts";

// load the shared CJS locator (same module setup.mjs and the MCP launcher use)
const require = createRequire(import.meta.url);
const locate = require("../scripts/locate-evolver.cjs") as {
  findEvolverRoot: () => string | null;
};

const USAGE = [
  "[evolver] /evolver [status|capabilities|help]",
  "[evolver] status: integration diagnostics — evolver root, recall mode, MCP wiring, proxy, git",
  "[evolver] capabilities: per-runtime ingest/inject/execute matrix (read-only CLI call)",
  "[evolver] automatic in this session: session-start memory hint, opt-in per-prompt recall (EVOLVER_RECALL_MODE=shadow|enforce), evolver_* MCP tools for search/reuse/capture",
  "[evolver] background evolution: `evolver autoexec` (resident daemon; empty allowlist denies by default) or `evolver cycle --repo <path>` — check /evolver capabilities first",
  "[evolver] read-only CLI checks: `evolver status`, `evolver daily`, `evolver cycles`",
].join("\n");

const RUN_REMOVED = [
  "[evolver] `run` was Evolver v1's one-shot generator; v2 keeps it only as a compatibility shim that exits 2 without starting a task, so this plugin no longer spawns it.",
  "[evolver] Run /evolver capabilities to see which runtimes can execute here, `evolver autoexec` for the resident daemon, or `evolver cycle --repo <path>` for a repo-scoped cycle.",
].join("\n");

function readSessionId(ctx: unknown): string {
  const sessionManager = asRecord(asRecord(ctx).sessionManager);
  const getSessionId = sessionManager.getSessionId;
  if (typeof getSessionId !== "function") return "";
  return String(getSessionId.call(sessionManager));
}

function sessionCwd(ctx: unknown): string {
  return strField(asRecord(ctx), "cwd") || process.cwd();
}

function notify(uiValue: unknown, text: string, kind = "info"): void {
  const ui = asRecord(uiValue);
  const fn = ui.notify;
  if (typeof fn === "function") fn.call(ui, text, kind);
}

export default function evolverOmp(pi: OmpExtensionAPI) {
  const log = (message: string) => pi.logger?.info?.(message);

  // Session-scoped state, resolved lazily so the factory stays fast at load.
  let cfg: EvolverConfig | null = null;
  let sessionId = "";
  let sessionStartCtx = "";

  const ensureConfig = (): EvolverConfig => {
    if (!cfg) {
      cfg = loadConfig(locate.findEvolverRoot());
    }
    return cfg;
  };

  // --- session start: recent evolution memory (plain text on stdout) -------
  pi.on("session_start", async (_event, ctx) => {
    try {
      const config = ensureConfig();
      sessionId = readSessionId(ctx);
      const result = runInject(
        config,
        "session-start",
        { session_id: sessionId, source: "omp" },
        undefined,
        sessionCwd(ctx),
      );
      sessionStartCtx = result.text;
      if (config.debug) {
        log(`[evolver] session_start: inject ok=${result.ok} ctx=${sessionStartCtx.length} chars`);
      }
    } catch {
      // fail-open: evolver must never affect the session
    }
  });

  // --- prompt: inject session memory + (opt-in) distilled recall -----------
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const config = ensureConfig();
      const additions: string[] = [];
      if (sessionStartCtx) additions.push(sessionStartCtx);

      if (config.recallMode !== "off") {
        const prompt = strField(asRecord(event), "prompt").trim();
        if (prompt.length >= 8) {
          const result = runInject(
            config,
            "prompt-recall",
            { prompt, session_id: sessionId, cwd: sessionCwd(ctx) },
            undefined,
            sessionCwd(ctx),
          );
          // prompt-recall returns JSON: { additionalContext, ... } or {}
          const hint = pickString(result.payload, "additionalContext", "agent_message");
          if (hint) additions.push(hint);
        }
      }

      if (additions.length === 0) return;

      // omp: event.systemPrompt is string[] and the result chains parts
      // ({ systemPrompt?: string[] }); upstream pi: a single string that is
      // replaced wholesale. Handle both so the same file runs in each harness.
      const systemPrompt = asRecord(event).systemPrompt;
      if (Array.isArray(systemPrompt)) {
        return { systemPrompt: [...(systemPrompt as string[]), ...additions] };
      }
      if (typeof systemPrompt === "string" && systemPrompt) {
        return { systemPrompt: systemPrompt + "\n\n" + additions.join("\n\n") };
      }
      return undefined;
    } catch {
      return undefined;
    }
  });

  // --- /evolver command -----------------------------------------------------
  pi.registerCommand("evolver", {
    description:
      "Evolver status, per-runtime capability matrix and v2 usage. Evolver v2 dropped the one-shot `run`.",
    handler: async (args, ctx) => {
      const config = ensureConfig();
      const arg = args.trim().toLowerCase();
      const ui = asRecord(ctx).ui;

      if (arg === "help" || arg === "?") {
        notify(ui, USAGE, "info");
        return;
      }
      if (arg === "run") {
        // Evolver v2 keeps `run` only as a v1 compatibility shim that exits 2
        // without starting anything, so there is no one-shot to drive here.
        notify(ui, RUN_REMOVED, "warning");
        return;
      }
      if (arg === "capabilities" || arg === "caps") {
        notify(ui, runCapabilities(config, sessionCwd(ctx)), "info");
        return;
      }
      if (arg === "" || arg === "status") {
        notify(ui, formatStatus(await buildStatus(config, sessionCwd(ctx))), "info");
        return;
      }
      notify(ui, `[evolver] unknown argument '${arg}'\n${USAGE}`, "warning");
    },
  });

  // --- evolver_status tool --------------------------------------------------
  pi.registerTool({
    name: "evolver_status",
    label: "Evolver Status",
    description:
      "Report the evolver (GEP self-evolution engine) integration status: install root, version, CLI availability, recall mode, MCP and proxy configuration.",
    parameters: pi.typebox.Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const config = ensureConfig();
      const status = await buildStatus(config, process.cwd());
      return {
        content: [{ type: "text", text: formatStatus(status) }],
        details: { status },
      };
    },
  });
}
