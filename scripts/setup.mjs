#!/usr/bin/env node
// setup.mjs — install / uninstall / verify the evolver-omp extension for omp.
//
// Mirrors `evolver setup-hooks --platform=<host>` from the upstream repo: it
// wires the extension into omp's auto-discovery, registers the evolver MCP
// server with omp's MCP config, and injects the evolution-memory section into
// the project's AGENTS.md. Nothing here requires the evolver package to be
// installed from source — the extension spawns evolver's own hook scripts from
// the resolved install at runtime.
//
// Usage:
//   node scripts/setup.mjs install   [--scope user|project] [--project DIR]
//                                    [--force] [--dry-run] [--no-mcp] [--no-agents]
//   node scripts/setup.mjs uninstall [--scope user|project] [--project DIR] [--dry-run]
//   node scripts/setup.mjs verify    [--project DIR]
//   node scripts/setup.mjs status
//
// `--scope user` (default) wires omp user-level config (~/.omp/agent):
// extension link + MCP server become available in EVERY session, in any
// project — no per-project step. `--scope project` restricts the extension
// link and MCP server to <project>/.omp (the AGENTS.md section always goes
// to the --project dir or the current dir).
import { createRequire } from "node:module";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const locate = require("./locate-evolver.cjs");

const PKG_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const EXT_SOURCE = path.join(PKG_ROOT, "extensions");
const MCP_LAUNCHER = path.join(PKG_ROOT, "scripts", "evolver-mcp.cjs");
const EVOLVER_MARKER = "<!-- evolver-evolution-memory -->";
const PLUGIN_NAME = "evolver-omp";
const NODE_BIN = process.env.EVOLVER_NODE || "node";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { scope: "user", dryRun: false, force: false, mcp: true, agents: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scope") opts.scope = argv[++i];
    else if (arg === "--project") opts.project = argv[++i];
    else if (arg === "--force") opts.force = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--no-mcp") opts.mcp = false;
    else if (arg === "--no-agents") opts.agents = false;
    else opts.command = arg;
  }
  if (opts.scope !== "user" && opts.scope !== "project") {
    throw new Error(`unknown scope: ${opts.scope} (use user|project)`);
  }
  return opts;
}

function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
}

function projectDir(opts) {
  return path.resolve(opts.project || process.cwd());
}

function userMcpFile() {
  return path.join(agentDir(), "mcp.json");
}

function projectMcpFile(project) {
  return path.join(project, ".omp", "mcp.json");
}

function mcpFileFor(opts) {
  return opts.scope === "user" ? userMcpFile() : projectMcpFile(projectDir(opts));
}

function agentsMdPath(project) {
  return path.join(project, "AGENTS.md");
}

// ---------------------------------------------------------------------------
// fs helpers (atomic writes, symlink safety)
// ---------------------------------------------------------------------------

function writeAtomic(filePath, content) {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

function log(opts, message) {
  const prefix = opts.dryRun ? "[dry-run] " : "";
  console.log(prefix + message);
}

function buildAgentsMdSection() {
  return `${EVOLVER_MARKER}
## Evolution Memory (Evolver)

This project uses evolver for self-evolution. The omp extension (evolver-omp) runs the lifecycle hooks:
1. Loads recent evolution memory at session start
2. (Opt-in) Per-prompt distilled recall when EVOLVER_RECALL_MODE=enforce or shadow

Use Evolver context only when it is directly relevant. Do not narrate routine Evolver checks, hook status, or empty recall/search results to the user.
Signals: log_error, perf_bottleneck, user_feature_request, capability_gap, deployment_issue, test_failure.`;
}

function injectAgentsMd(filePath, opts) {
  if (existsSync(filePath) && readFileSync(filePath, "utf8").includes(EVOLVER_MARKER)) {
    log(opts, `[AGENTS.md] section already present: ${filePath}`);
    return false;
  }
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : "\n";
  const content = existing + separator + buildAgentsMdSection() + "\n";
  if (!opts.dryRun) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeAtomic(filePath, content);
  }
  log(opts, `[AGENTS.md] injected evolution section into ${filePath}`);
  return true;
}

function removeAgentsMdSection(filePath, opts) {
  if (!existsSync(filePath)) return false;
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const idx = lines.findIndex((line) => line.includes(EVOLVER_MARKER));
  if (idx === -1) return false;
  // The section is the marker line, the `## Evolution Memory` heading, and the
  // content up to the next heading (or EOF). Consume our own heading first,
  // then stop at the next line starting with '#'.
  let end = idx + 1;
  let headingSeen = false;
  while (end < lines.length) {
    const line = lines[end];
    if (/^#{1,6}\s/.test(line)) {
      if (headingSeen) break;
      headingSeen = true;
    }
    end += 1;
  }
  const kept = lines.slice(0, idx).concat(lines.slice(end));
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  if (!opts.dryRun) writeAtomic(filePath, kept.join("\n") + "\n");
  log(opts, `[AGENTS.md] removed evolution section from ${filePath}`);
  return true;
}

// ---------------------------------------------------------------------------
// extension link
// ---------------------------------------------------------------------------

/** Where the extension is linked, by scope: user ~/.omp/agent/extensions vs
 * project <project>/.omp/extensions (both are omp native auto-discovery). */
function extensionLinkPath(opts) {
  const base = opts.scope === "project"
    ? path.join(projectDir(opts), ".omp", "extensions")
    : path.join(agentDir(), "extensions");
  return path.join(base, PLUGIN_NAME);
}

function linkExtension(opts) {
  const linkPath = extensionLinkPath(opts);
  const target = EXT_SOURCE;

  if (existsSync(linkPath)) {
    const st = lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      log(opts, `[extension] already linked: ${linkPath}`);
      return true;
    }
    if (!opts.force) {
      throw new Error(`${linkPath} exists and is not a symlink we created. Use --force to replace it.`);
    }
    if (!opts.dryRun) rmSync(linkPath, { recursive: true, force: true });
    log(opts, `[extension] removed existing non-symlink ${linkPath}`);
  }
  if (!opts.dryRun) {
    mkdirSync(path.dirname(linkPath), { recursive: true });
    symlinkSync(target, linkPath, "dir");
  }
  log(opts, `[extension] linked ${linkPath} -> ${target}`);
  return true;
}

function unlinkExtension(opts) {
  const linkPath = extensionLinkPath(opts);
  if (!existsSync(linkPath)) {
    log(opts, `[extension] nothing to remove: ${linkPath}`);
    return false;
  }
  if (!lstatSync(linkPath).isSymbolicLink()) {
    log(opts, `[extension] refusing to remove non-symlink ${linkPath} (remove manually)`);
    return false;
  }
  if (!opts.dryRun) unlinkSync(linkPath);
  log(opts, `[extension] removed link ${linkPath}`);
  return true;
}

// ---------------------------------------------------------------------------
// MCP config
// ---------------------------------------------------------------------------

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`cannot parse ${filePath}: ${err.message}`);
  }
}

function mergeMcp(filePath, opts) {
  const data = readJsonSafe(filePath);
  data.mcpServers = data.mcpServers ?? {};
  data.mcpServers.evolver = { type: "stdio", command: NODE_BIN, args: [MCP_LAUNCHER] };
  data._evolver_managed = true;
  if (!opts.dryRun) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeAtomic(filePath, JSON.stringify(data, null, 2) + "\n");
  }
  log(opts, `[mcp] registered 'evolver' server in ${filePath}`);
  return true;
}

function unmergeMcp(filePath, opts) {
  if (!existsSync(filePath)) return false;
  const data = readJsonSafe(filePath);
  if (!data.mcpServers || typeof data.mcpServers !== "object") return false;
  if (!data.mcpServers.evolver) return false;
  delete data.mcpServers.evolver;
  if (Object.keys(data.mcpServers).length === 0) delete data.mcpServers;
  delete data._evolver_managed;
  if (!opts.dryRun) writeAtomic(filePath, JSON.stringify(data, null, 2) + "\n");
  log(opts, `[mcp] removed 'evolver' server from ${filePath}`);
  return true;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function cmdInstall(opts) {
  const project = projectDir(opts);
  console.log(`[omp] evolver-omp installer (scope=${opts.scope}, project=${project})`);

  const root = locate.findEvolverRoot();
  if (!root) {
    console.warn("[omp] WARNING: could not locate an @evomap/evolver install. The inject hooks and the MCP launcher need it. Install with `npm i -g @evomap/evolver` or set EVOLVER_ROOT.");
  } else {
    console.log(`[omp] evolver root: ${root}`);
    const cli = locate.resolveCliPath(root);
    if (!cli) {
      console.warn(`[omp] WARNING: no CLI entry (bin/evolver.js or index.js) found in ${root} — inject hooks will be unavailable.`);
    } else {
      console.log(`[omp] evolver cli: ${cli}`);
    }
  }

  linkExtension(opts);

  if (opts.mcp) {
    mergeMcp(mcpFileFor(opts), opts);
  }

  if (opts.agents) {
    injectAgentsMd(agentsMdPath(project), opts);
  }

  console.log("");
  console.log("[omp] Installation complete. Next steps:");
  console.log(`[omp]   1. Restart omp (extensions load at startup).`);
  if (opts.mcp) {
    console.log(`[omp]   2. Run /mcp list — the 'evolver' server should appear; /mcp test evolver to verify.`);
  }
  console.log(`[omp]   3. Run /evolver to see status; /evolver run triggers an evolution cycle.`);
  console.log(`[omp]   4. Opt into per-prompt distilled recall: set EVOLVER_RECALL_MODE=enforce (or shadow to preview).`);
  console.log(`[omp]   5. Verify the install: node ${path.join(PKG_ROOT, "scripts", "setup.mjs")} verify`);
}

function cmdUninstall(opts) {
  console.log(`[omp] evolver-omp uninstaller (scope=${opts.scope})`);
  unlinkExtension(opts);
  if (opts.mcp) unmergeMcp(mcpFileFor(opts), opts);
  if (opts.agents) removeAgentsMdSection(agentsMdPath(projectDir(opts)), opts);
  console.log("[omp] Uninstall complete.");
}

function cmdVerify(opts) {
  const project = projectDir(opts);
  const checks = [];
  const optional = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });
  const addOptional = (id, ok, detail) => optional.push({ id, ok, detail });

  const root = locate.findEvolverRoot();
  add("evolver_root", !!root, root ?? "not found (install @evomap/evolver or set EVOLVER_ROOT)");
  if (root) {
    const cli = locate.resolveCliPath(root);
    add("evolver_cli", !!cli, cli ?? "no bin/evolver.js or index.js in install");
  }

  const linkPath = extensionLinkPath(opts);
  const linked = existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink();
  add("extension_link", linked, linked ? linkPath : `missing: ${linkPath}`);
  if (linked) {
    add("extension_entry", existsSync(path.join(EXT_SOURCE, "index.ts")),
      path.join(EXT_SOURCE, "index.ts"));
  }

  const mcpFile = mcpFileFor(opts);
  let mcpOk = false;
  if (existsSync(mcpFile)) {
    const data = readJsonSafe(mcpFile);
    mcpOk = !!(data.mcpServers && data.mcpServers.evolver);
  }
  add("mcp_evolver", mcpOk, mcpOk ? `registered in ${mcpFile}` : `missing in ${mcpFile}`);
  if (mcpOk) {
    add("mcp_launcher", existsSync(MCP_LAUNCHER), MCP_LAUNCHER);
    const stdio = locate.resolveStdioEntry(root);
    add("mcp_stdio", !!stdio, stdio ?? "evolver-mcp stdio server not resolvable");
  }

  // AGENTS.md evolution section is optional per-project sugar; missing it is
  // not an install failure (install --no-agents / --project <dir>).
  const agentsFile = agentsMdPath(project);
  const agentsOk = existsSync(agentsFile) && readFileSync(agentsFile, "utf8").includes(EVOLVER_MARKER);
  addOptional("agents_md_section", agentsOk, agentsOk
    ? agentsFile
    : `missing in ${agentsFile} (optional — run install --project <dir> to add)`);

  for (const c of checks) {
    console.log(`[omp]   ${c.ok ? "[OK]  " : "[FAIL]"} ${c.id} -- ${c.detail}`);
  }
  for (const c of optional) {
    console.log(`[omp]   [opt]  ${c.id} -- ${c.detail}`);
  }
  const allOk = checks.every((c) => c.ok);
  console.log(`[omp] ${allOk ? "All required checks passed." : "Some required checks failed."}`);
  console.log("[omp] Re-run install to repair: node scripts/setup.mjs install --force");
  process.exitCode = allOk ? 0 : 1;
}

function cmdStatus() {
  const root = locate.findEvolverRoot();
  console.log(`evolver root     : ${root ?? "not found"}`);
  console.log(`evolver cli      : ${locate.resolveCliPath(root) ?? "not resolvable"}`);
  console.log(`mcp stdio        : ${locate.resolveStdioEntry(root) ?? "not resolvable"}`);
  console.log(`user link        : ${path.join(agentDir(), "extensions", PLUGIN_NAME)}`);
  console.log(`project link     : <project>/.omp/extensions/${PLUGIN_NAME} (with --scope project)`);
  console.log(`user mcp file    : ${userMcpFile()}`);
  console.log(`project mcp file : <project>/.omp/mcp.json (with --scope project)`);
  console.log(`mcp launcher     : ${MCP_LAUNCHER}`);
}

// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  switch (opts.command) {
    case "install": cmdInstall(opts); break;
    case "uninstall": cmdUninstall(opts); break;
    case "verify": cmdVerify(opts); break;
    case "status": cmdStatus(); break;
    default:
      console.error("usage: node scripts/setup.mjs <install|uninstall|verify|status> [--scope user|project] [--project DIR] [--force] [--dry-run] [--no-mcp] [--no-agents]");
      process.exitCode = 1;
  }
}

main();
