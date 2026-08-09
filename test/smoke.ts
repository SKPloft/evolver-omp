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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import factory from "../extensions/index.ts";
import { loadConfig } from "../extensions/config.ts";
import { cliPath, runInject } from "../extensions/hooks.ts";
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
  tools: string[];
} {
  const events: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
  const commands: string[] = [];
  const tools: string[] = [];
  return {
    events,
    commands,
    tools,
    pi: {
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
        (events[event] ??= []).push(handler);
      },
      registerCommand(name: string) {
        commands.push(name);
      },
      registerTool(def: Record<string, unknown>) {
        tools.push(String(def.name));
      },
      typebox: {
        Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
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
});
