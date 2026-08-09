// types.ts — minimal structural types for the omp/pi ExtensionAPI surface this
// example uses.
//
// In real usage, replace this with the official package:
//   import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
// (or "@earendil-works/pi-coding-agent" when targeting upstream pi — omp is a
// pi fork, so the surface is the same). Keeping a local structural type here
// makes the example load with zero dependencies, which `bun test` requires.
//
// The runtime values are treated as `unknown` and narrowed with type guards in
// the modules that consume them.

export interface EvolverConfig {
  /** Absolute path to an @evomap/evolver install, or null. */
  root: string | null;
  /** "off" | "shadow" | "enforce" — per-prompt distilled recall. Default off. */
  recallMode: "off" | "shadow" | "enforce";
  /** Node binary used to run evolver's hook scripts (plain Node CJS). */
  nodeBin: string;
  /** Hard timeout for spawning hook scripts (fail-open after this). */
  hookTimeoutMs: number;
  /** Extra environment forwarded to hook scripts. */
  env: Record<string, string>;
  /** Verbose logging to pi.logger. */
  debug: boolean;
}

/** Minimal structural slice of ExtensionAPI we consume (see header note). */
export interface OmpExtensionAPI {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  registerCommand(
    name: string,
    def: { description: string; handler: (args: string, ctx: unknown) => unknown },
  ): void;
  registerTool(def: Record<string, unknown>): void;
  /** Full TypeBox module (like `import { Type } from "typebox"`): Type.Object(...). */
  typebox: { Type: { Object(props: Record<string, unknown>): unknown } };
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void };
}

/** Narrow an unknown value to a plain object (type guard). */
export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Read a string field off an unknown object; returns "" when absent. */
export function strField(record: Record<string, unknown>, key: string): string {
  const v = record[key];
  return typeof v === "string" ? v : "";
}
