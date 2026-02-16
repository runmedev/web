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

function printOutput(stdout: string, stderr: string): void {
  if (stdout.trim()) {
    process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  }
  if (stderr.trim()) {
    process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
  }
}

let failures = 0;

for (const scenarioDriver of SCENARIO_DRIVERS) {
  const basename = scenarioDriver.split("/").at(-1) ?? scenarioDriver;
  console.log(`[CUJ] Running ${basename}`);

  // Compile each TS scenario into .generated so Node can execute it.
  const compileResult = run(
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
  printOutput(compileResult.stdout, compileResult.stderr);
  if (compileResult.status !== 0) {
    failures += 1;
    console.error(`[CUJ] Failed ${basename} (compile exit ${compileResult.status})`);
    console.log("");
    continue;
  }

  const compiled = join(
    GENERATED_DIR,
    `${basename.replace(/\.ts$/, "")}.js`,
  );
  const runResult = run(`node ${compiled}`);
  printOutput(runResult.stdout, runResult.stderr);
  if (runResult.status !== 0) {
    failures += 1;
    console.error(`[CUJ] Failed ${basename} (exit ${runResult.status})`);
    console.log("");
    continue;
  }

  console.log(`[CUJ] Completed ${basename}`);
  console.log("");
}

if (failures > 0) {
  console.error(`[CUJ] ${failures} scenario(s) failed`);
  process.exit(1);
}
