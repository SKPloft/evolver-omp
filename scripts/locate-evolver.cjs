#!/usr/bin/env node
// locate-evolver.cjs
// Single source of truth for locating an @evomap/evolver install and its MCP
// server entry. Shared by the omp extension (extensions/*), the MCP launcher
// (scripts/evolver-mcp.cjs) and the installer (scripts/setup.mjs).
//
// Why this exists: evolver's own _runtimePaths.js allowlist of global install
// roots does NOT include the mise layout
// (~/.local/share/mise/installs/node/<ver>/lib/node_modules) nor a `which
// evolver` resolution, so on machines like this one its findEvolverRoot()
// silently returns null and every hook script fails open with no context.
// This locator covers the missing roots and lets the adapter export
// EVOLVER_ROOT explicitly to the spawned scripts.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

function isEvolverPackageJson(filePath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return !!pkg && (pkg.name === '@evomap/evolver' || pkg.name === 'evolver');
  } catch {
    return false;
  }
}

// A directory is an evolver install root iff it contains a package.json
// naming @evomap/evolver (or the legacy bare `evolver`).
function isRoot(dir) {
  if (!dir) return false;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return isEvolverPackageJson(path.join(dir, 'package.json'));
}

// Walk up from a bin entry (which may be a symlink, e.g. mise shims) to the
// package root whose package.json names evolver.
function rootFromBin(binPath) {
  let real = binPath;
  try { real = fs.realpathSync(binPath); } catch { /* keep original */ }
  let dir = path.dirname(real);
  for (let i = 0; i < 8 && dir && dir !== path.dirname(dir); i += 1) {
    if (isRoot(dir)) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function which(cmd) {
  try {
    const out = spawnSync('which', [cmd], { encoding: 'utf8', timeout: 5000 });
    const p = out.status === 0 ? String(out.stdout || '').trim() : '';
    return p || null;
  } catch {
    return null;
  }
}

// Trusted, user/system-scoped install roots. process.cwd() is intentionally
// NOT included (a hostile workspace must not be able to plant a fake
// @evomap/evolver that supplies attacker-controlled memory context) — same
// policy as evolver's own _runtimePaths.js.
function scanGlobalRoots() {
  const home = os.homedir();
  const out = [];
  // mise: ~/.local/share/mise/installs/node/<version>/lib/node_modules
  const miseNodeDir = path.join(home, '.local', 'share', 'mise', 'installs', 'node');
  try {
    for (const ver of fs.readdirSync(miseNodeDir)) {
      out.push(path.join(miseNodeDir, ver, 'lib', 'node_modules', '@evomap', 'evolver'));
    }
  } catch { /* no mise */ }
  for (const base of [
    path.join(home, '.npm-global', 'lib', 'node_modules'),
    path.join(home, '.local', 'lib', 'node_modules'),
    '/usr/lib/node_modules',
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    '/home/linuxbrew/.linuxbrew/lib/node_modules',
  ]) {
    out.push(path.join(base, '@evomap', 'evolver'));
  }
  return out;
}

function findEvolverRoot() {
  if (process.env.EVOLVER_ROOT && isRoot(process.env.EVOLVER_ROOT)) {
    return process.env.EVOLVER_ROOT;
  }
  const bin = which('evolver');
  if (bin) {
    const fromBin = rootFromBin(bin);
    if (fromBin) return fromBin;
  }
  for (const candidate of scanGlobalRoots()) {
    if (isRoot(candidate)) return candidate;
  }
  return null;
}

// Resolve the @evomap/evolver-mcp stdio server entry inside an evolver install.
function resolveStdioEntry(root) {
  if (!root) return null;
  const candidates = [process.env.EVOLVER_MCP_STDIO || ''];
  const nested = path.join(root, 'node_modules', '@evomap', 'evolver-mcp', 'dist', 'stdio.js');
  candidates.push(nested);
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // Hoisted / differently-named layouts.
  try {
    const scopeDir = path.join(root, 'node_modules', '@evomap');
    for (const name of fs.readdirSync(scopeDir)) {
      if (!name.startsWith('evolver-mcp')) continue;
      const p = path.join(scopeDir, name, 'dist', 'stdio.js');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* no nested scope */ }
  return null;
}

// Resolve the evolver CLI entry inside an install. v2 packages ship
// `bin/evolver.js` (ESM wrapper that loads @evomap/evolver-cli); v1 source
// checkouts ship `index.js`. The hook contract (`evolver inject ...`) runs
// through whichever entry exists.
function resolveCliPath(root) {
  if (!root) return null;
  for (const candidate of [
    process.env.EVOLVER_CLI || '',
    path.join(root, 'bin', 'evolver.js'),
    path.join(root, 'index.js'),
  ]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const root = findEvolverRoot();
  if (args.includes('--stdio')) {
    process.stdout.write((root ? resolveStdioEntry(root) : null) || '');
    return;
  }
  if (args.includes('--cli')) {
    process.stdout.write((root ? resolveCliPath(root) : null) || '');
    return;
  }
  process.stdout.write(root || '');
}

if (require.main === module) main();

module.exports = { findEvolverRoot, resolveStdioEntry, resolveCliPath, isRoot, rootFromBin, which };
