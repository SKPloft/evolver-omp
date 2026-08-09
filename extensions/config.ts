// config.ts — runtime knobs for the evolver-omp extension.
//
// Everything is driven by environment variables (same style as evolver's own
// adapters: EVOLVER_RECALL_MODE, EVOLVER_ROOT, A2A_*, EVOMAP_*, ...). No
// config file of its own, so the extension works wherever it is dropped in.
import type { EvolverConfig } from "./types.ts";

const DEFAULTS = {
  recallMode: "off" as const,
  hookTimeoutMs: 10_000,
  nodeBin: "node",
};

function boolish(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "off" || v === "no") return false;
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  return fallback;
}

function recallMode(value: string | undefined): "off" | "shadow" | "enforce" {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "shadow" || v === "enforce" ? v : "off";
}

/**
 * Build the extension configuration.
 *
 * @param root Absolute path to an @evomap/evolver install (may be null; the
 *   factory re-resolves lazily at session_start).
 */
export function loadConfig(root: string | null): EvolverConfig {
  const env = process.env;
  const hookTimeoutMs = Number(env.EVOLVER_HOOK_TIMEOUT_MS);
  return {
    root,
    recallMode: recallMode(env.EVOLVER_RECALL_MODE),
    nodeBin: env.EVOLVER_NODE?.trim() || DEFAULTS.nodeBin,
    hookTimeoutMs: Number.isFinite(hookTimeoutMs) && hookTimeoutMs > 0
      ? hookTimeoutMs
      : DEFAULTS.hookTimeoutMs,
    debug: boolish(env.EVOLVER_DEBUG, false),
    env: {
      // Forward the evolver/Hub knobs the hook scripts consult.
      EVOLVER_HOOK_HOST: "omp",
      ...(env.EVOLVER_RECALL_MODE ? { EVOLVER_RECALL_MODE: env.EVOLVER_RECALL_MODE } : {}),
      ...(env.EVOLVER_SETTINGS_DIR ? { EVOLVER_SETTINGS_DIR: env.EVOLVER_SETTINGS_DIR } : {}),
      ...(env.EVOLVER_SESSION_STATE_DIR ? { EVOLVER_SESSION_STATE_DIR: env.EVOLVER_SESSION_STATE_DIR } : {}),
      ...(env.EVOLVER_HOOK_LOG_DIR ? { EVOLVER_HOOK_LOG_DIR: env.EVOLVER_HOOK_LOG_DIR } : {}),
      ...(env.A2A_HUB_URL ? { A2A_HUB_URL: env.A2A_HUB_URL } : {}),
      ...(env.EVOMAP_HUB_URL ? { EVOMAP_HUB_URL: env.EVOMAP_HUB_URL } : {}),
      ...(env.A2A_NODE_ID ? { A2A_NODE_ID: env.A2A_NODE_ID } : {}),
      ...(env.EVOMAP_NODE_ID ? { EVOMAP_NODE_ID: env.EVOMAP_NODE_ID } : {}),
      ...(env.A2A_NODE_SECRET ? { A2A_NODE_SECRET: env.A2A_NODE_SECRET } : {}),
      ...(env.EVOMAP_API_KEY ? { EVOMAP_API_KEY: env.EVOMAP_API_KEY } : {}),
      ...(env.EVOMAP_PROXY ? { EVOMAP_PROXY: env.EVOMAP_PROXY } : {}),
      ...(env.GITHUB_TOKEN ? { GITHUB_TOKEN: env.GITHUB_TOKEN } : {}),
    },
  };
}

/** True when a spawned hook script must never be allowed to stall a session. */
export function isFailOpen(cfg: EvolverConfig): boolean {
  return true;
}
