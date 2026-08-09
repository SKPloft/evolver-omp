// status.ts — runtime status for the /evolver command and evolver_status tool.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvolverConfig } from "./types.ts";
import { cliPath } from "./hooks.ts";

export interface EvolverStatus {
  root: string | null;
  version: string;
  cliOk: boolean;
  recallMode: string;
  proxyConfigured: boolean;
  mcpConfigured: string | null;
  gitRepo: boolean;
}

function mcpFileNamesServer(file: string, name: string): boolean {
  try {
    if (!existsSync(file)) return false;
    const raw = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: unknown };
    if (!raw.mcpServers || typeof raw.mcpServers !== "object") return false;
    return Object.keys(raw.mcpServers as Record<string, unknown>).some(
      (n) => n.toLowerCase().includes(name),
    );
  } catch {
    return false;
  }
}

function detectMcpConfig(cwd: string): string | null {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".omp", "agent", "mcp.json"),
    path.join(home, ".omp", "agent", ".mcp.json"),
    path.join(cwd, ".omp", "mcp.json"),
    path.join(cwd, ".omp", ".mcp.json"),
    path.join(cwd, "mcp.json"),
    path.join(cwd, ".mcp.json"),
  ];
  for (const file of candidates) {
    if (mcpFileNamesServer(file, "evolver")) return file;
  }
  return null;
}

export async function buildStatus(cfg: EvolverConfig, cwd: string): Promise<EvolverStatus> {
  let version = "unknown";
  const cli = cliPath(cfg.root);
  if (cli) {
    try {
      const res = spawnSync(cfg.nodeBin, [cli, "-v"], {
        encoding: "utf8",
        timeout: 5000,
      });
      if (res.status === 0 && typeof res.stdout === "string" && res.stdout.trim()) {
        version = res.stdout.trim();
      }
    } catch { /* keep unknown */ }
  }

  let gitRepo = false;
  try {
    const res = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      cwd,
      timeout: 5000,
    });
    gitRepo = res.status === 0 && String(res.stdout ?? "").trim() === "true";
  } catch { /* not a repo */ }

  return {
    root: cfg.root,
    version,
    cliOk: cliPath(cfg.root) !== null,
    recallMode: cfg.recallMode,
    proxyConfigured: existsSync(path.join(os.homedir(), ".evolver", "settings.json")),
    mcpConfigured: detectMcpConfig(cwd),
    gitRepo,
  };
}

export function formatStatus(s: EvolverStatus): string {
  const lines = [
    `[evolver] root: ${s.root ?? "NOT FOUND (install @evomap/evolver)"}`,
    `[evolver] version: ${s.version}`,
    `[evolver] cli (inject hooks): ${s.cliOk ? "ok" : "missing"}`,
    `[evolver] recall mode: ${s.recallMode} (set EVOLVER_RECALL_MODE=enforce|shadow for per-prompt distilled hints)`,
    `[evolver] mcp: ${s.mcpConfigured ? `configured (${s.mcpConfigured})` : "not configured (run scripts/setup.mjs)"}`,
    `[evolver] proxy: ${s.proxyConfigured ? "configured" : "not configured (no ~/.evolver/settings.json)"}`,
    `[evolver] git: ${s.gitRepo ? "repo" : "not a git repo (recall/recording context may be limited)"}`,
  ];
  return lines.join("\n");
}
