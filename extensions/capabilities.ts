// capabilities.ts — `evolver cycle capabilities --json` in /evolver's words.
//
// Evolver v2 scores every runtime separately for ingest / inject / execute /
// verify / resume, and an `unsupported` cell stays unsupported: the answer is a
// missing containment contract upstream, never "pick another runner". The
// matrix is read-only (no task, no login, no spend), which is why it is the
// first thing to look at before asking the CLI to evolve anything.
import { spawnSync } from "node:child_process";
import { cliPath } from "./hooks.ts";
import { asRecord, type EvolverConfig } from "./types.ts";

const COLUMNS = ["ingest", "inject", "execute"] as const;

export function formatCapabilities(manifest: unknown): string {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    return "[evolver] capabilities: the installed CLI returned no runtime matrix.";
  }
  const rows = manifest.map((entry) => {
    const runtime = asRecord(entry);
    const cells = COLUMNS.map((column) => `${column}=${String(asRecord(runtime[column]).status ?? "?")}`);
    return `[evolver] ${String(runtime.runtime ?? "?")}: ${cells.join(" ")}`;
  });
  return [
    "[evolver] runtime capabilities (`unsupported` is missing upstream, not a runner choice):",
    ...rows,
  ].join("\n");
}

/** Capability matrix as text; fail-open like the rest of the extension. */
export function runCapabilities(cfg: EvolverConfig, cwd: string): string {
  const cli = cliPath(cfg.root);
  if (!cli) return "[evolver] capabilities: CLI not found — install @evomap/evolver";
  const res = spawnSync(cfg.nodeBin, [cli, "cycle", "capabilities", "--json"], {
    encoding: "utf8",
    cwd,
    timeout: cfg.hookTimeoutMs,
  });
  if (res.error) {
    return `[evolver] capabilities: CLI did not answer (${res.error.code ?? res.error.message})`;
  }
  try {
    return formatCapabilities(JSON.parse(String(res.stdout ?? "")));
  } catch {
    return `[evolver] capabilities: unreadable CLI output (exit ${res.status ?? "?"})`;
  }
}
