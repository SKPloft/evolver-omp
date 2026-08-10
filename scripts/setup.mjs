#!/usr/bin/env node
// setup.mjs — install / uninstall / verify the evolver-omp plugin for omp.
//
// The plugin is installed the STANDARD way: omp's native marketplace system
// (`omp plugin marketplace add <src>` + `omp plugin install evolver-omp@…`).
// That path loads the extension module declared in package.json#omp.extensions
// and the evolver MCP server declared in .omp-plugin/plugin.json, with the
// launcher resolved relative to the installed plugin (${OMP_PLUGIN_ROOT}) —
// no machine-specific paths, no hand-written config merges.
//
// This script is a thin convenience wrapper over those native commands plus
// the pieces the marketplace model has no concept of:
//   - the optional per-project AGENTS.md evolution section (`agents`),
//   - cleanup of the legacy hand-rolled install (extension symlink + mcp.json
//     entry) created by earlier versions of this script,
//   - diagnostics (`verify` / `status`).
//
// Usage:
//   node scripts/setup.mjs install   [--scope user|project] [--project DIR]
//                                    [--force] [--dry-run] [--agents]
//                                    [--marketplace SRC]
//   node scripts/setup.mjs uninstall [--scope user|project] [--project DIR]
//                                    [--dry-run] [--agents]
//   node scripts/setup.mjs agents inject|remove [--project DIR] [--dry-run]
//   node scripts/setup.mjs verify    [--project DIR]
//   node scripts/setup.mjs status
//
// `--scope user` (default) installs the plugin user-wide (plugins data root —
// ~/.omp/plugins by default, XDG-aware under `omp config init-xdg`), so it is
// available in EVERY session, in any project. `--scope project` scopes it to
// <project>/.omp/plugins. `--marketplace SRC` overrides the marketplace source
// (default: this repository directory; for published installs use the git
// shorthand, e.g. `--marketplace SKPloft/evolver-omp`).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const locate = require("./locate-evolver.cjs");

const PKG_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MCP_LAUNCHER = path.join(PKG_ROOT, "scripts", "evolver-mcp.cjs");
const EVOLVER_MARKER = "<!-- evolver-evolution-memory -->";
const PLUGIN_NAME = "evolver-omp";
const MARKETPLACE_NAME = "evolver-omp";
const OMP_BIN = process.env.EVOLVER_OMP || "omp";
const OMP_ROOT_VAR = "${OMP_PLUGIN_ROOT}";
const CLAUDE_ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { scope: "user", dryRun: false, force: false, agents: false, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scope") opts.scope = argv[++i];
    else if (arg === "--project") opts.project = argv[++i];
    else if (arg === "--marketplace") opts.marketplace = argv[++i];
    else if (arg === "--force") opts.force = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--agents") opts.agents = true;
    else if (arg === "--no-mcp" || arg === "--no-agents") {
      throw new Error(`'${arg}' was removed: the evolver MCP server is intrinsic to the plugin (declared in .omp-plugin/plugin.json), and the AGENTS.md section is opt-in via --agents`);
    }
    else opts.positional.push(arg);
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

function agentsMdPath(project) {
  return path.join(project, "AGENTS.md");
}

// ---------------------------------------------------------------------------
// fs helpers (atomic writes)
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

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`cannot parse ${filePath}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// omp CLI delegation
// ---------------------------------------------------------------------------

/** Run an `omp …` command. Returns its exit status. */
function runOmp(args, opts, cwd) {
  if (opts.dryRun) {
    log(opts, `[omp] would run: omp ${args.join(" ")}`);
    return 0;
  }
  const res = spawnSync(OMP_BIN, args, { stdio: "inherit", cwd });
  if (res.error) {
    if (res.error.code === "ENOENT") {
      console.error(`[omp] '${OMP_BIN}' not found on PATH — omp is required for install/uninstall.`);
    } else {
      console.error(`[omp] failed to run '${OMP_BIN}': ${res.error.message}`);
    }
    process.exit(1);
  }
  return res.status ?? 1;
}

/** Capture `omp …` stdout (UTF-8). Returns null when omp itself failed to
 * spawn (not on PATH), "" on a non-zero exit, else the combined output. */
function captureOmp(args, cwd) {
  const res = spawnSync(OMP_BIN, args, { encoding: "utf8", cwd });
  if (res.error) return null;
  if (res.status !== 0) return "";
  return `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
}

function ompAvailable() {
  return captureOmp(["plugin", "list"]) !== null;
}

function marketplaceRegistered() {
  const out = captureOmp(["plugin", "marketplace", "list"]);
  return out !== null && out.includes(MARKETPLACE_NAME);
}

/** Installed in the requested scope. `omp plugin list` labels entries
 * `(user)` / `(project)` (a shadowed user entry still shows `(user)`); run it
 * from the project dir so a project-scoped registry is in the aggregate. */
function pluginInstalled(opts) {
  const cwd = opts.scope === "project" ? projectDir(opts) : undefined;
  const out = captureOmp(["plugin", "list"], cwd);
  if (out === null) return false;
  const label = opts.scope === "project" ? "(project)" : "(user)";
  return out.split("\n").some(
    (line) => line.includes(`${PLUGIN_NAME}@${MARKETPLACE_NAME}`) && line.includes(label),
  );
}

// ---------------------------------------------------------------------------
// legacy state cleanup (pre-marketplace installs)
// ---------------------------------------------------------------------------

/** Remove the extension symlink + mcp.json entry written by old setup.mjs. */
function cleanLegacy(opts) {
  // 1. extension symlink: ~/.omp/agent/extensions/evolver-omp (user) or
  //    <project>/.omp/extensions/evolver-omp (project).
  const bases = opts.scope === "project"
    ? [path.join(projectDir(opts), ".omp", "extensions")]
    : [path.join(agentDir(), "extensions")];
  for (const base of bases) {
    const linkPath = path.join(base, PLUGIN_NAME);
    if (!existsSync(linkPath)) continue;
    const st = lstatSync(linkPath);
    if (!st.isSymbolicLink()) {
      log(opts, `[legacy] ${linkPath} exists and is not a symlink — leaving it (remove manually)`);
      continue;
    }
    const target = readlinkSync(linkPath);
    if (!existsSync(path.join(target, "index.ts"))) {
      log(opts, `[legacy] ${linkPath} -> ${target} is not the evolver-omp extensions dir — leaving it`);
      continue;
    }
    if (!opts.dryRun) unlinkSync(linkPath);
    log(opts, `[legacy] removed extension symlink ${linkPath}`);
  }

  // 2. mcp.json entry written by old setup.mjs (stamped _evolver_managed).
  const mcpFiles = opts.scope === "project"
    ? [path.join(projectDir(opts), ".omp", "mcp.json")]
    : [path.join(agentDir(), "mcp.json")];
  for (const file of mcpFiles) {
    if (!existsSync(file)) continue;
    const data = readJsonSafe(file);
    if (!data.mcpServers || typeof data.mcpServers !== "object") continue;
    if (!data.mcpServers.evolver) continue;
    if (!data._evolver_managed) {
      log(opts, `[legacy] ${file} has an 'evolver' server but no _evolver_managed marker — leaving it`);
      continue;
    }
    delete data.mcpServers.evolver;
    if (Object.keys(data.mcpServers).length === 0) delete data.mcpServers;
    delete data._evolver_managed;
    if (!opts.dryRun) writeAtomic(file, JSON.stringify(data, null, 2) + "\n");
    log(opts, `[legacy] removed managed 'evolver' server from ${file}`);
  }
}

// ---------------------------------------------------------------------------
// AGENTS.md section (optional per-project sugar)
// ---------------------------------------------------------------------------

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

  // Legacy state from old setup.mjs installs would double-load the extension
  // alongside the marketplace copy — clean it first.
  cleanLegacy(opts);

  // 1. register the marketplace (idempotent).
  if (marketplaceRegistered()) {
    console.log(`[omp] marketplace '${MARKETPLACE_NAME}' already registered`);
  } else {
    const src = opts.marketplace || PKG_ROOT;
    console.log(`[omp] adding marketplace '${MARKETPLACE_NAME}' from ${src}`);
    const status = runOmp(["plugin", "marketplace", "add", src], opts);
    if (status !== 0) {
      console.error(`[omp] marketplace add failed (exit ${status}) — aborting.`);
      process.exitCode = status;
      return;
    }
  }

  // 2. install the plugin through omp's native installer.
  if (pluginInstalled(opts) && !opts.force) {
    console.log(`[omp] plugin '${PLUGIN_NAME}@${MARKETPLACE_NAME}' already installed at scope '${opts.scope}' (use --force to reinstall)`);
  } else {
    const args = ["plugin", "install"];
    if (opts.force) args.push("--force");
    if (opts.scope) args.push("--scope", opts.scope);
    args.push(`${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
    console.log(`[omp] running: omp ${args.join(" ")}`);
    const status = runOmp(args, opts, opts.scope === "project" ? project : undefined);
    if (status !== 0) {
      console.error(`[omp] plugin install failed (exit ${status}) — aborting.`);
      process.exitCode = status;
      return;
    }
  }

  // 3. optional per-project AGENTS.md section.
  if (opts.agents) {
    injectAgentsMd(agentsMdPath(project), opts);
  }

  if (opts.dryRun) {
    console.log("");
    console.log("[omp] Dry run — no changes were made. Re-run without --dry-run to install.");
    return;
  }

  console.log("");
  console.log("[omp] Installation complete. Next steps:");
  console.log("[omp]   1. Restart omp (extension modules load at startup); /reload-plugins refreshes MCP servers.");
  console.log("[omp]   2. Run /mcp list — the 'evolver-omp:evolver' server should appear; /mcp test evolver-omp:evolver to verify.");
  console.log("[omp]   3. Run /evolver to see status; /evolver run triggers an evolution cycle.");
  console.log("[omp]   4. Opt into per-prompt distilled recall: set EVOLVER_RECALL_MODE=enforce (or shadow to preview).");
  console.log("[omp]   5. Verify the install: node scripts/setup.mjs verify");
}

function cmdUninstall(opts) {
  const project = projectDir(opts);
  console.log(`[omp] evolver-omp uninstaller (scope=${opts.scope})`);

  cleanLegacy(opts);

  if (!ompAvailable()) {
    console.warn(`[omp] '${OMP_BIN}' not found on PATH — skipping the omp plugin uninstall. Legacy artifacts above are still cleaned; run it again once omp is available.`);
  } else if (pluginInstalled(opts)) {
    const args = ["plugin", "uninstall"];
    if (opts.scope) args.push("--scope", opts.scope);
    args.push(`${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
    console.log(`[omp] running: omp ${args.join(" ")}`);
    const status = runOmp(args, opts, opts.scope === "project" ? project : undefined);
    if (status !== 0) {
      console.error(`[omp] plugin uninstall failed (exit ${status}).`);
      process.exitCode = status;
      return;
    }
  } else {
    console.log(`[omp] plugin not installed at scope '${opts.scope}' — nothing to uninstall via omp`);
  }

  if (opts.agents) {
    removeAgentsMdSection(agentsMdPath(project), opts);
  }
  console.log("[omp] Uninstall complete.");
}

function cmdAgents(action, opts) {
  const file = agentsMdPath(projectDir(opts));
  if (action === "inject") injectAgentsMd(file, opts);
  else if (action === "remove") removeAgentsMdSection(file, opts);
  else throw new Error(`unknown agents action: ${action} (use inject|remove)`);
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

  const ompOk = ompAvailable();
  add("omp_cli", ompOk, ompOk ? `'${OMP_BIN}' on PATH` : `'${OMP_BIN}' not found on PATH`);

  const mkt = marketplaceRegistered();
  add("marketplace_registered", mkt, mkt ? `'${MARKETPLACE_NAME}' in omp plugin marketplace list` : "not registered (run install)");

  const inst = pluginInstalled(opts);
  add("plugin_installed", inst, inst ? `${PLUGIN_NAME} in omp plugin list (scope '${opts.scope}')` : `not installed at scope '${opts.scope}' (run install)`);

  for (const [dir, varName] of [
    [".omp-plugin", OMP_ROOT_VAR],
    [".claude-plugin", CLAUDE_ROOT_VAR],
  ]) {
    const manifestPath = path.join(PKG_ROOT, dir, "plugin.json");
    const manifest = readJsonSafe(manifestPath);
    const server = manifest.mcpServers && manifest.mcpServers.evolver;
    const ok = manifest.name === PLUGIN_NAME
      && server && server.command === "node"
      && Array.isArray(server.args) && server.args.includes(`${varName}/scripts/evolver-mcp.cjs`);
    add(`mcp_decl_${dir}`, ok, ok ? `${dir}/plugin.json declares evolver server` : `${dir}/plugin.json missing or wrong evolver declaration`);
  }
  add("mcp_launcher", existsSync(MCP_LAUNCHER), MCP_LAUNCHER);
  if (root) {
    const stdio = locate.resolveStdioEntry(root);
    add("mcp_stdio", !!stdio, stdio ?? "evolver-mcp stdio server not resolvable");
  }

  // Validate the INSTALLED plugin copy (per the scope registry) matches the
  // shipped packaging — a stale cache would fail this even if the source repo
  // manifests are fine.
  const registryPaths = [path.join(os.homedir(), ".omp", "plugins", "installed_plugins.json")];
  if (opts.scope === "project" || opts.project) {
    registryPaths.push(path.join(projectDir(opts), ".omp", "plugins", "installed_plugins.json"));
  }
  let foundInstall = false;
  for (const regPath of registryPaths) {
    if (!existsSync(regPath)) continue;
    const reg = readJsonSafe(regPath);
    const entries = reg.plugins && reg.plugins[`${PLUGIN_NAME}@${MARKETPLACE_NAME}`];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const wantScope = opts.scope === "project" ? "project" : "user";
      if (entry.scope !== wantScope) continue;
      foundInstall = true;
      const installRoot = entry.installPath;
      const decl = readJsonSafe(path.join(installRoot, ".omp-plugin", "plugin.json"));
      const server = decl.mcpServers && decl.mcpServers.evolver;
      const declOk = !!server && Array.isArray(server.args)
        && server.args.includes(`${OMP_ROOT_VAR}/scripts/evolver-mcp.cjs`)
        && existsSync(path.join(installRoot, "scripts", "evolver-mcp.cjs"));
      add("installed_copy_valid", declOk,
        declOk ? `installed copy at ${installRoot} declares evolver MCP + launcher`
          : `installed copy at ${installRoot} missing/wrong MCP declaration`);
    }
  }
  if (!foundInstall) {
    addOptional("installed_copy", false, "installed copy not found in registry files (install first, or check for an XDG plugins root)");
  }

  // AGENTS.md evolution section is optional per-project sugar.
  const agentsFile = agentsMdPath(project);
  const agentsOk = existsSync(agentsFile) && readFileSync(agentsFile, "utf8").includes(EVOLVER_MARKER);
  addOptional("agents_md_section", agentsOk, agentsOk
    ? agentsFile
    : `missing in ${agentsFile} (optional — run 'node scripts/setup.mjs agents inject --project <dir>')`);

  for (const c of checks) {
    console.log(`[omp]   ${c.ok ? "[OK]  " : "[FAIL]"} ${c.id} -- ${c.detail}`);
  }
  for (const c of optional) {
    console.log(`[omp]   [opt]  ${c.id} -- ${c.detail}`);
  }
  const allOk = checks.every((c) => c.ok);
  console.log(`[omp] ${allOk ? "All required checks passed." : "Some required checks failed."}`);
  console.log("[omp] Re-run install to repair: node scripts/setup.mjs install");
  process.exitCode = allOk ? 0 : 1;
}

function cmdStatus(opts) {
  const root = locate.findEvolverRoot();
  console.log(`omp binary         : ${ompAvailable() ? `'${OMP_BIN}' found` : `'${OMP_BIN}' NOT found on PATH`}`);
  console.log(`evolver root       : ${root ?? "not found"}`);
  console.log(`evolver cli        : ${locate.resolveCliPath(root) ?? "not resolvable"}`);
  console.log(`mcp stdio          : ${locate.resolveStdioEntry(root) ?? "not resolvable"}`);
  console.log(`marketplace        : ${marketplaceRegistered() ? `'${MARKETPLACE_NAME}' registered` : `'${MARKETPLACE_NAME}' NOT registered`}`);
  console.log(`plugin (${opts.scope}) : ${pluginInstalled(opts) ? `'${PLUGIN_NAME}@${MARKETPLACE_NAME}' installed` : `'${PLUGIN_NAME}@${MARKETPLACE_NAME}' NOT installed`}`);
  console.log(`marketplace source : ${PKG_ROOT} (default; --marketplace to override)`);
  console.log(`mcp launcher       : ${MCP_LAUNCHER}`);
}

// ---------------------------------------------------------------------------

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  const command = opts.positional[0];
  switch (command) {
    case "install": cmdInstall(opts); break;
    case "uninstall": cmdUninstall(opts); break;
    case "agents": {
      try {
        cmdAgents(opts.positional[1], opts);
      } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
      }
      break;
    }
    case "verify": cmdVerify(opts); break;
    case "status": cmdStatus(opts); break;
    default:
      console.error("usage: node scripts/setup.mjs <install|uninstall|agents inject|remove|verify|status> [--scope user|project] [--project DIR] [--force] [--dry-run] [--agents] [--marketplace SRC]");
      process.exitCode = 1;
  }
}

main();
