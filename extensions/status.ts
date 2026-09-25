// status.ts — runtime status for the /evolver command and evolver_status tool.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { asRecord, type EvolverConfig } from "./types.ts";
import { cliPath } from "./hooks.ts";

/** Plugin name used by the omp plugin registry, keyed `<name>@<marketplace>`. */
const PLUGIN_NAME = "evolver-omp";
/** Manifest dirs omp/Claude Code read, with the plugin-root var each one uses. */
const MCP_MANIFESTS = [
  { dir: ".omp-plugin", rootVar: "${OMP_PLUGIN_ROOT}" },
  { dir: ".claude-plugin", rootVar: "${CLAUDE_PLUGIN_ROOT}" },
];
const MCP_LAUNCHER = "scripts/evolver-mcp.cjs";

export interface McpStatus {
  /** "ok": the installed plugin registers the server; "broken": a declaration
   * exists but the launcher it points at does not; "absent": nothing declares it. */
  state: "ok" | "broken" | "absent";
  /** Where the declaration lives (install root, mcp.json, or null when absent). */
  source: string | null;
  /** Launcher path when ok; what is missing otherwise. */
  detail: string;
}

export interface EvolverStatus {
  root: string | null;
  version: string;
  cliOk: boolean;
  recallMode: string;
  proxyConfigured: boolean;
  mcp: McpStatus;
  gitRepo: boolean;
}

function readJson(file: string): unknown {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}

/** Launcher a manifest declares, resolved against the install root, or null. */
function manifestLauncher(manifestFile: string, installRoot: string, rootVar: string): string | null {
  const server = asRecord(asRecord(asRecord(readJson(manifestFile)).mcpServers).evolver);
  const args = server.args;
  if (!Array.isArray(args)) return null;
  const declared = `${rootVar}/${MCP_LAUNCHER}`;
  return args.includes(declared) ? path.join(installRoot, MCP_LAUNCHER) : null;
}

/** Status of one installed plugin copy, judged by what omp will actually load. */
function installMcp(installRoot: string): McpStatus {
  for (const { dir, rootVar } of MCP_MANIFESTS) {
    const manifest = path.join(installRoot, dir, "plugin.json");
    if (!existsSync(manifest)) continue;
    const launcher = manifestLauncher(manifest, installRoot, rootVar);
    if (!launcher) {
      return { state: "broken", source: manifest, detail: `no evolver MCP server in ${dir}/plugin.json` };
    }
    if (!existsSync(launcher)) {
      return { state: "broken", source: manifest, detail: `launcher missing: ${launcher}` };
    }
    return { state: "ok", source: installRoot, detail: launcher };
  }
  return { state: "broken", source: installRoot, detail: `no plugin manifest in ${installRoot}` };
}

/** Install roots omp's plugin registry lists for this plugin. */
function registryInstalls(file: string): string[] {
  const plugins = asRecord(asRecord(readJson(file)).plugins);
  const installs: string[] = [];
  for (const [id, entries] of Object.entries(plugins)) {
    if (!id.startsWith(`${PLUGIN_NAME}@`) || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      const installPath = asRecord(entry).installPath;
      if (typeof installPath === "string" && installPath) installs.push(installPath);
    }
  }
  return installs;
}

/**
 * Where the evolver MCP server comes from. Since the plugin is installed
 * through omp's marketplace, that is the `mcpServers.evolver` entry in the
 * INSTALLED plugin copy's manifest, with `${OMP_PLUGIN_ROOT}` resolved by omp;
 * the registry file is what tells us which copies are installed (a project
 * scope shadows the user one).
 */
export function detectMcp(cwd: string, home: string): McpStatus {
  let broken: McpStatus | null = null;
  for (const registry of [
    path.join(cwd, ".omp", "plugins", "installed_plugins.json"),
    path.join(home, ".omp", "plugins", "installed_plugins.json"),
  ]) {
    for (const installRoot of registryInstalls(registry)) {
      const status = installMcp(installRoot);
      if (status.state === "ok") return status;
      broken ??= status;
    }
  }
  // Hand-written mcp.json entries — the pre-marketplace install path.
  for (const file of [
    path.join(home, ".omp", "agent", "mcp.json"),
    path.join(home, ".omp", "agent", ".mcp.json"),
    path.join(cwd, ".omp", "mcp.json"),
    path.join(cwd, ".omp", ".mcp.json"),
    path.join(cwd, "mcp.json"),
    path.join(cwd, ".mcp.json"),
  ]) {
    const servers = asRecord(asRecord(readJson(file)).mcpServers);
    if (Object.keys(servers).some((name) => name.toLowerCase().includes("evolver"))) {
      return { state: "ok", source: file, detail: "hand-written mcp.json entry" };
    }
  }
  return broken ?? { state: "absent", source: null, detail: "no installed plugin registers it" };
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
    mcp: detectMcp(cwd, os.homedir()),
    gitRepo,
  };
}

export function formatStatus(s: EvolverStatus): string {
  const mcp = {
    ok: `configured (${s.mcp.source})`,
    broken: `broken — ${s.mcp.detail} (re-run: node scripts/setup.mjs install)`,
    absent: "not configured (install the plugin: node scripts/setup.mjs install)",
  }[s.mcp.state];
  const lines = [
    `[evolver] root: ${s.root ?? "NOT FOUND (install @evomap/evolver)"}`,
    `[evolver] version: ${s.version}`,
    `[evolver] cli (inject hooks): ${s.cliOk ? "ok" : "missing"}`,
    `[evolver] recall mode: ${s.recallMode} (set EVOLVER_RECALL_MODE=enforce|shadow for per-prompt distilled hints)`,
    `[evolver] mcp: ${mcp}`,
    `[evolver] proxy: ${s.proxyConfigured ? "configured" : "not configured (no ~/.evolver/settings.json)"}`,
    `[evolver] git: ${s.gitRepo ? "repo" : "not a git repo (recall/recording context may be limited)"}`,
  ];
  return lines.join("\n");
}
