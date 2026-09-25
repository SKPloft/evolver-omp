// smoke.ts — end-to-end sanity checks for the evolver-omp extension.
//
// Runs with `bun test test/smoke.ts` (bun is omp's runtime, and the extension
// is loaded by omp through bun). Exercises:
//   1. evolver install + CLI + MCP stdio entry resolution (locate-evolver.cjs)
//   2. factory registration surface (events / command / tool)
//   3. real `evolver inject` round-trips via node (session-start, prompt-recall
//      off-by-default)
//   4. marketplace catalog + package.json manifest validity
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import factory from "../extensions/index.ts";
import { loadConfig } from "../extensions/config.ts";
import { cliPath, runInject } from "../extensions/hooks.ts";
import { detectMcp } from "../extensions/status.ts";
import type { OmpExtensionAPI } from "../extensions/types.ts";

const require = createRequire(import.meta.url);
const locate = require("../scripts/locate-evolver.cjs") as {
  findEvolverRoot(): string | null;
  resolveStdioEntry(root: string | null): string | null;
  resolveCliPath(root: string | null): string | null;
};

const PKG = path.resolve(import.meta.dir, "..");

function stubPi(): {
  pi: OmpExtensionAPI;
  events: Record<string, Array<(event: unknown, ctx: unknown) => unknown>>;
  commands: string[];
  commandHandlers: Record<string, (args: string, ctx: unknown) => unknown>;
  tools: string[];
} {
  const events: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
  const commands: string[] = [];
  const commandHandlers: Record<string, (args: string, ctx: unknown) => unknown> = {};
  const tools: string[] = [];
  return {
    events,
    commands,
    commandHandlers,
    tools,
    pi: {
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
        (events[event] ??= []).push(handler);
      },
      registerCommand(
        name: string,
        def: { description: string; handler: (args: string, ctx: unknown) => unknown },
      ) {
        commands.push(name);
        commandHandlers[name] = def.handler;
      },
      registerTool(def: Record<string, unknown>) {
        tools.push(String(def.name));
      },
      typebox: {
        Type: {
          Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
        },
      },
      logger: { info: () => {}, warn: () => {} },
    },
  };
}

describe("locate-evolver", () => {
  test("finds an evolver install, CLI entry and MCP stdio server", () => {
    const root = locate.findEvolverRoot();
    expect(root).toBeTruthy();
    const cli = locate.resolveCliPath(root);
    expect(cli).toBeTruthy();
    expect(existsSync(cli!)).toBe(true);
    const stdio = locate.resolveStdioEntry(root);
    expect(stdio).toBeTruthy();
    expect(existsSync(stdio!)).toBe(true);
  });
});

describe("extension factory", () => {
  test("registers lifecycle events, /evolver command and evolver_status tool", () => {
    const { pi, events, commands, tools } = stubPi();
    factory(pi);
    expect(Object.keys(events).sort()).toEqual(["before_agent_start", "session_start"]);
    expect(commands).toContain("evolver");
    expect(tools).toContain("evolver_status");
  });

  test("before_agent_start injects nothing when there is no session memory", async () => {
    const { pi, events } = stubPi();
    factory(pi);
    const handler = events["before_agent_start"][0];
    // session-start produced nothing yet, recall is off -> no injection
    const result = await handler({ prompt: "short" }, {});
    expect(result).toBeUndefined();
  });

  test("/evolver run reports a missing CLI instead of throwing", async () => {
    // An install root without bin/evolver.js (or index.js) resolves to no CLI,
    // so the run branch must report and return rather than spawn anything.
    const fakeRoot = mkdtempSync(path.join(tmpdir(), "evolver-omp-root-"));
    writeFileSync(
      path.join(fakeRoot, "package.json"),
      JSON.stringify({ name: "@evomap/evolver", version: "0.0.0" }),
    );
    const hadRoot = process.env.EVOLVER_ROOT;
    const notices: string[] = [];
    try {
      process.env.EVOLVER_ROOT = fakeRoot;
      const { pi, commandHandlers } = stubPi();
      factory(pi);
      await commandHandlers["evolver"]("run", {
        cwd: PKG,
        ui: { notify: (text: string) => notices.push(text) },
      });
    } finally {
      if (hadRoot) process.env.EVOLVER_ROOT = hadRoot;
      else delete process.env.EVOLVER_ROOT;
      rmSync(fakeRoot, { recursive: true, force: true });
    }
    expect(notices.join("\n")).toContain("CLI not found");
  });
});

describe("mcp status detection", () => {
  /** A marketplace install copy: manifest (+ launcher unless omitted). */
  function installCopy(root: string, withLauncher = true): void {
    mkdirSync(path.join(root, ".omp-plugin"), { recursive: true });
    writeFileSync(
      path.join(root, ".omp-plugin", "plugin.json"),
      JSON.stringify({
        name: "evolver-omp",
        mcpServers: {
          evolver: { command: "node", args: ["${OMP_PLUGIN_ROOT}/scripts/evolver-mcp.cjs"] },
        },
      }),
    );
    if (!withLauncher) return;
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "evolver-mcp.cjs"), "// launcher\n");
  }

  function homeWithRegistry(home: string, installRoot: string): void {
    mkdirSync(path.join(home, ".omp", "plugins"), { recursive: true });
    writeFileSync(
      path.join(home, ".omp", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "evolver-omp@evolver-omp": [{ scope: "user", installPath: installRoot, version: "0.1.0" }],
        },
      }),
    );
  }

  test("configured when the registry's install copy declares the server", () => {
    const base = mkdtempSync(path.join(tmpdir(), "evolver-omp-mcp-ok-"));
    try {
      const installRoot = path.join(base, "install");
      const home = path.join(base, "home");
      installCopy(installRoot);
      homeWithRegistry(home, installRoot);
      expect(detectMcp(path.join(base, "project"), home)).toEqual({
        state: "ok",
        source: installRoot,
        detail: path.join(installRoot, "scripts", "evolver-mcp.cjs"),
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("broken when the registered install copy lost its launcher", () => {
    const base = mkdtempSync(path.join(tmpdir(), "evolver-omp-mcp-broken-"));
    try {
      const installRoot = path.join(base, "install");
      const home = path.join(base, "home");
      installCopy(installRoot, false);
      homeWithRegistry(home, installRoot);
      const status = detectMcp(path.join(base, "project"), home);
      expect(status.state).toBe("broken");
      expect(status.detail).toContain("launcher missing");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("configured from a hand-written mcp.json entry (pre-marketplace installs)", () => {
    const base = mkdtempSync(path.join(tmpdir(), "evolver-omp-mcp-legacy-"));
    try {
      const project = path.join(base, "project");
      mkdirSync(path.join(project, ".omp"), { recursive: true });
      writeFileSync(
        path.join(project, ".omp", "mcp.json"),
        JSON.stringify({ mcpServers: { evolver: { command: "node", args: ["launcher.cjs"] } } }),
      );
      expect(detectMcp(project, path.join(base, "home"))).toEqual({
        state: "ok",
        source: path.join(project, ".omp", "mcp.json"),
        detail: "hand-written mcp.json entry",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("absent when nothing installs or declares the server", () => {
    const base = mkdtempSync(path.join(tmpdir(), "evolver-omp-mcp-absent-"));
    try {
      expect(detectMcp(path.join(base, "project"), path.join(base, "home"))).toEqual({
        state: "absent",
        source: null,
        detail: "no installed plugin registers it",
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("evolver inject round-trips (real CLI via node)", () => {
  const root = locate.findEvolverRoot();
  const cfg = loadConfig(root);
  // Hermetic home so the CLI never touches the user's real ~/.evomap.
  const fakeHome = mkdtempSync(path.join(tmpdir(), "evolver-omp-home-"));

  test("session-start returns a memory hint or empty stdout, never crashes", () => {
    const hadHome = process.env.EVOMAP_DIR;
    try {
      process.env.EVOMAP_DIR = fakeHome;
      const result = runInject(
        cfg, "session-start",
        { session_id: "smoke-session", source: "omp" },
        15_000, PKG,
      );
      expect(result.ok).toBe(true);
      // No approved genes yet -> either empty or a non-empty hint string.
      expect(typeof result.text).toBe("string");
      if (result.text) {
        expect(result.text.length).toBeGreaterThan(0);
      }
    } finally {
      if (hadHome) process.env.EVOMAP_DIR = hadHome; else delete process.env.EVOMAP_DIR;
    }
  });

  test("prompt-recall is off by default and injects nothing", () => {
    const hadMode = process.env.EVOLVER_RECALL_MODE;
    const hadHome = process.env.EVOMAP_DIR;
    delete process.env.EVOLVER_RECALL_MODE;
    try {
      process.env.EVOMAP_DIR = fakeHome;
      const result = runInject(
        cfg, "prompt-recall",
        { prompt: "please fix the failing test suite", session_id: "smoke-session" },
        15_000, PKG,
      );
      expect(result.ok).toBe(true);
      expect(result.payload).toEqual({});
      expect(result.text).toBe("{}");
    } finally {
      if (hadMode) process.env.EVOLVER_RECALL_MODE = hadMode;
      else delete process.env.EVOLVER_RECALL_MODE;
      if (hadHome) process.env.EVOMAP_DIR = hadHome; else delete process.env.EVOMAP_DIR;
    }
  });

  test("cliPath rejects a missing install", () => {
    expect(cliPath(null)).toBeNull();
  });
});

describe("marketplace packaging", () => {
  test("catalogs are valid Claude Code-compatible marketplace JSON", () => {
    for (const file of [".omp-plugin/marketplace.json", ".claude-plugin/marketplace.json"]) {
      const data = JSON.parse(readFileSync(path.join(PKG, file), "utf8")) as {
        name: string;
        owner?: { name?: string };
        plugins?: Array<{ name?: string; source?: string }>;
      };
      expect(data.name.length).toBeGreaterThan(0);
      expect(data.owner?.name).toBeTruthy();
      expect(data.plugins?.length).toBe(1);
      expect(data.plugins?.[0]?.name).toBe("evolver-omp");
      expect(data.plugins?.[0]?.source).toBe("./");
    }
  });

  test("package.json declares omp.extensions pointing at real files", () => {
    const pkg = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8")) as {
      omp?: { extensions?: string[] };
    };
    expect(Array.isArray(pkg.omp?.extensions)).toBe(true);
    for (const entry of pkg.omp?.extensions ?? []) {
      expect(existsSync(path.join(PKG, entry))).toBe(true);
    }
  });

  test("plugin.json manifests declare the evolver MCP server with root-relative launcher", () => {
    const pkg = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8")) as { version?: string };
    for (const [dir, rootVar] of [
      [".omp-plugin", "${OMP_PLUGIN_ROOT}"],
      [".claude-plugin", "${CLAUDE_PLUGIN_ROOT}"],
    ] as const) {
      const manifest = JSON.parse(readFileSync(path.join(PKG, dir, "plugin.json"), "utf8")) as {
        name?: string;
        version?: string;
        mcpServers?: Record<string, { command?: string; args?: string[] }>;
      };
      expect(manifest.name).toBe("evolver-omp");
      expect(manifest.version).toBe(pkg.version);
      const server = manifest.mcpServers?.evolver;
      expect(server).toBeTruthy();
      expect(server?.command).toBe("node");
      expect(server?.args).toEqual([`${rootVar}/scripts/evolver-mcp.cjs`]);
      expect(existsSync(path.join(PKG, "scripts", "evolver-mcp.cjs"))).toBe(true);
    }
  });
});
