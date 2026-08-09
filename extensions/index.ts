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
// come from the @evomap/evolver-mcp server, configured by scripts/setup.mjs
// into omp's MCP config — the same split as Evolver's own installers (hooks
// for lifecycle, MCP for tools).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
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
      "Evolver status and manual operations. Use 'run' to trigger an evolution cycle.",
    handler: async (args, ctx) => {
      const config = ensureConfig();
      const arg = args.trim().toLowerCase();
      const ui = asRecord(ctx).ui;

      if (arg === "run") {
        const cli = cliPath(config.root);
        if (!cli) {
          notify(ui, "[evolver] CLI not found — install @evomap/evolver", "error");
          return;
        }
        notify(ui, "[evolver] running evolution cycle...", "info");
        const child = spawn(
          config.nodeBin,
          [cli, "run"],
          { cwd: sessionCwd(ctx), stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        child.stdout?.on("data", (chunk) => { output += String(chunk); });
        child.stderr?.on("data", (chunk) => { output += String(chunk); });
        child.on("error", (err) => {
          notify(ui, `[evolver] run failed: ${err.message}`, "error");
        });
        child.on("close", (code) => {
          const tail = output.trim().split("\n").slice(-6).join("\n");
          notify(ui, `[evolver] run exit ${code ?? "?"}\n${tail}`, code === 0 ? "info" : "warning");
        });
        return;
      }

      const status = await buildStatus(config, sessionCwd(ctx));
      notify(ui, formatStatus(status), "info");
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
