// hooks.ts — run evolver's lifecycle hooks through the evolver CLI.
//
// Evolver v2 (npm @evomap/evolver 2.x) exposes its per-harness hooks as CLI
// commands — every installer in `@evomap/evolver-mcp/dist/*Installer.js`
// registers `evolver inject ... --hook-stdin` for the host's hook slots:
//
//   session_start   -> `evolver inject session-start`    plain-text memory
//                      hint on stdout ('' when nothing to inject)
//   per prompt      -> `evolver inject prompt-recall`    JSON on stdout with
//                      `additionalContext` ({} when off or no match)
//
// Both are stdin/stdout filters: the payload goes in on stdin as JSON, the
// result comes back on stdout. v2 deliberately dropped the v1 Stop/PostToolUse
// scripts (outcome recording + signal detection moved into the evolver
// daemon), so this adapter only wires the two remaining hooks — matching
// exactly what `evolver setup-hooks` writes for Claude Code / opencode.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { EvolverConfig } from "./types.ts";

export interface HookResult {
  ok: boolean;
  /** Raw (trimmed) stdout — session-start emits plain text here. */
  text: string;
  /** Parsed stdout JSON ({} when stdout is not JSON, e.g. session-start). */
  payload: Record<string, unknown>;
}

/** Absolute path to the evolver CLI entry (v2: bin/evolver.js; v1: index.js). */
export function cliPath(root: string | null): string | null {
  if (!root) return null;
  for (const candidate of [path.join(root, "bin", "evolver.js"), path.join(root, "index.js")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Run one evolver hook via the CLI. Never throws; never blocks longer than the
 * timeout. Fail-open contract (mirrors evolver's own hook watchdogs): any
 * error or unparseable output yields `{ ok: false, text: "", payload: {} }`,
 * so the agent session is never affected by evolver being broken.
 */
export function runInject(
  cfg: EvolverConfig,
  subcommand: "session-start" | "prompt-recall",
  payload: Record<string, unknown>,
  timeoutMs?: number,
  cwd?: string,
): HookResult {
  const cli = cliPath(cfg.root);
  if (!cli) {
    return { ok: false, text: "", payload: {} };
  }
  try {
    const res = spawnSync(
      cfg.nodeBin,
      [cli, "inject", subcommand, "--hook-stdin"],
      {
        input: JSON.stringify(payload ?? {}),
        encoding: "utf8",
        timeout: timeoutMs ?? cfg.hookTimeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        cwd: cwd ?? process.cwd(),
        // EVOLVER_ROOT lets the CLI's own resolution agree with our locator.
        env: { ...process.env, ...cfg.env, EVOLVER_ROOT: cfg.root ?? "" },
      },
    );
    if (res.error || res.status !== 0) {
      return { ok: false, text: "", payload: {} };
    }
    const text = String(res.stdout ?? "").trim();
    let payloadOut: Record<string, unknown> = {};
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payloadOut = parsed as Record<string, unknown>;
        }
      } catch {
        // session-start prints plain text — not a failure
      }
    }
    return { ok: true, text, payload: payloadOut };
  } catch {
    return { ok: false, text: "", payload: {} };
  }
}

/** Read the first present string field from a hook result. */
export function pickString(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}
