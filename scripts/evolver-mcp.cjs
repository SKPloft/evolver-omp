#!/usr/bin/env node
// evolver-mcp.cjs — launcher for the @evomap/evolver-mcp stdio server.
//
// The plugin manifests (.omp-plugin/plugin.json for omp, .claude-plugin/plugin.json
// for Claude Code) declare the evolver server with a ${OMP_PLUGIN_ROOT}/
// ${CLAUDE_PLUGIN_ROOT}-relative path to this launcher, so the config stays
// portable: the launcher resolves the evolver root with the same locator the
// extension uses (scripts/locate-evolver.cjs) and execs the real server.
//
// Overrides:
//   EVOLVER_MCP_STDIO  absolute path to the stdio.js entry (bypasses lookup)
//   EVOLVER_NODE       node binary used to run the server
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { findEvolverRoot, resolveStdioEntry } = require('./locate-evolver.cjs');

const root = findEvolverRoot();
const entry = resolveStdioEntry(root);
if (!entry) {
  process.stderr.write(
    '[evolver-mcp] Cannot resolve @evomap/evolver-mcp stdio server. ' +
    'Install @evomap/evolver, or set EVOLVER_MCP_STDIO to the dist/stdio.js path.\n'
  );
  process.exit(1);
}

const nodeBin = process.env.EVOLVER_NODE || 'node';
const child = spawn(nodeBin, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (err) => {
  process.stderr.write(`[evolver-mcp] failed to start: ${err.message || String(err)}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(code == null ? (signal ? 1 : 0) : code);
});
