// @ts-nocheck
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * run-cuj-scenarios.ts - TypeScript orchestrator for all implemented CUJ
 * browser scenario drivers.
 *
 * This intentionally keeps orchestration logic in TypeScript so CUJ scripting
 * remains in one language and is easier to maintain than mixed shell + TS.
 */

const CURRENT_FILE_DIR = dirname(fileURLToPath(import.meta.url));
// When this file is compiled to .generated, use the parent directory as the
// source script directory so relative paths still resolve correctly.
const SCRIPT_DIR =
  CURRENT_FILE_DIR.endsWith("/.generated") || CURRENT_FILE_DIR.endsWith("\\.generated")
    ? dirname(CURRENT_FILE_DIR)
    : CURRENT_FILE_DIR;
const GENERATED_DIR = join(SCRIPT_DIR, ".generated");

/**
 * Keep this list aligned with docs-dev/cujs/*.md scenario docs.
 */
const SCENARIO_DRIVERS = [join(SCRIPT_DIR, "test-scenario-hello-world.ts")];

/**
 * Run shell commands and return status/stdout/stderr for robust reporting.
 */
function run(command: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, {
    shell: true,
    encoding: "utf-8",
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Run shell command and throw when it fails.
 */
function runOrThrow(command: string): string {
  const result = run(command);
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command}\n${result.stderr}`);
  }
  return result.stdout;
}

for (const scenarioDriver of SCENARIO_DRIVERS) {
  const basename = scenarioDriver.split("/").at(-1) ?? scenarioDriver;
  console.log(`[CUJ] Running ${basename}`);

  // Compile each TS scenario into .generated so Node can execute it.
  runOrThrow(
    [
      "pnpm exec tsc",
      "--target es2020",
      "--module nodenext",
      "--moduleResolution nodenext",
      "--esModuleInterop",
      "--skipLibCheck",
      `--outDir ${GENERATED_DIR}`,
      scenarioDriver,
    ].join(" "),
  );

  const compiled = join(
    GENERATED_DIR,
    `${basename.replace(/\.ts$/, "")}.js`,
  );
  runOrThrow(`node ${compiled}`);

  console.log(`[CUJ] Completed ${basename}`);
  console.log("");
}
