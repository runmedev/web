import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { uploadCujArtifacts } from "./upload-cuj-artifacts.js";

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type Assertions = {
  total: number;
  passed: number;
  failed: number;
};

type CujSummary = {
  status: string;
  exit_code: number;
  assertions_total: number;
  assertions_passed: number;
  assertions_failed: number;
  run_id: string;
  run_attempt: string;
  sha: string;
};

type ServiceHandle = {
  name: string;
  process: ChildProcess;
  logPath: string;
  logStream: ReturnType<typeof createWriteStream>;
};

const CURRENT_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR =
  CURRENT_FILE_DIR.endsWith("/.generated") || CURRENT_FILE_DIR.endsWith("\\.generated")
    ? dirname(CURRENT_FILE_DIR)
    : CURRENT_FILE_DIR;
const GENERATED_DIR = join(SCRIPT_DIR, ".generated");
const OUTPUT_DIR = join(SCRIPT_DIR, "test-output");
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const APP_ROOT = resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_HTTP_TIMEOUT_MS = Number(process.env.CUJ_HTTP_TIMEOUT_MS ?? "20000");

function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<Response> {
  const withSignal: RequestInit = {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  };
  return fetch(input, withSignal);
}

const SCENARIO_DRIVERS = [join(SCRIPT_DIR, "test-scenario-hello-world.ts")];

function run(command: string, cwd = SCRIPT_DIR): CommandResult {
  const timeoutMs = Number(process.env.CUJ_CMD_TIMEOUT_MS ?? "240000");
  const result = spawnSync(command, {
    shell: true,
    encoding: "utf-8",
    cwd,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const errorCode =
    typeof result.error === "object" && result.error !== null && "code" in result.error
      ? String((result.error as { code?: string }).code ?? "")
      : "";
  const timedOut = errorCode === "ETIMEDOUT";
  const timeoutHint = timedOut ? `\n[CUJ] Command timed out after ${timeoutMs}ms: ${command}\n` : "";
  return {
    status: result.status ?? (timedOut ? 124 : 1),
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${timeoutHint}`,
  };
}

function runNodeScript(scriptPath: string, cwd: string): CommandResult {
  const timeoutMs = Number(process.env.CUJ_SCENARIO_TIMEOUT_MS ?? "240000");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const errorCode =
    typeof result.error === "object" && result.error !== null && "code" in result.error
      ? String((result.error as { code?: string }).code ?? "")
      : "";
  const timedOut = errorCode === "ETIMEDOUT";
  const timeoutHint = timedOut
    ? `\n[CUJ] Scenario process timed out after ${timeoutMs}ms: ${scriptPath}\n`
    : "";
  return {
    status: result.status ?? (timedOut ? 124 : 1),
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${timeoutHint}`,
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

function runOrThrow(command: string, cwd = SCRIPT_DIR): string {
  const result = run(command, cwd);
  printOutput(result.stdout, result.stderr);
  if (result.status !== 0) {
    throw new Error(`Command failed (${command}) with status ${result.status}`);
  }
  return result.stdout;
}

function startService(name: string, command: string, cwd: string, logPath: string): ServiceHandle {
  mkdirSync(dirname(logPath), { recursive: true });
  const logStream = createWriteStream(logPath, { flags: "w" });
  const child = spawn(command, {
    cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });
  child.on("exit", (code, signal) => {
    logStream.write(`[${name}] exited code=${code ?? "null"} signal=${signal ?? "null"}\n`);
    logStream.end();
  });

  return { name, process: child, logPath, logStream };
}

async function stopService(service: ServiceHandle): Promise<void> {
  const closeLogStream = (): void => {
    if (!service.logStream.closed && !service.logStream.destroyed) {
      service.logStream.end();
    }
  };

  if (service.process.exitCode !== null || service.process.killed) {
    closeLogStream();
    return;
  }
  service.process.kill("SIGTERM");
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      if (service.process.exitCode === null) {
        service.process.kill("SIGKILL");
      }
      resolveStop();
    }, 2500);
    service.process.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
  service.process.stdout?.destroy();
  service.process.stderr?.destroy();
  closeLogStream();
}

async function waitForHttp(url: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown";
  while (Date.now() < deadline) {
    try {
      const resp = await fetchWithTimeout(url, {}, 5_000);
      if (resp.ok || resp.status < 500) {
        return;
      }
      lastError = `HTTP ${resp.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${label} at ${url}: ${lastError}`);
}

function parseAssertions(output: string): Assertions {
  const pattern = /Assertions:\s*(\d+),\s*Passed:\s*(\d+),\s*Failed:\s*(\d+)/g;
  let match: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while ((match = pattern.exec(output)) !== null) {
    last = match;
  }
  if (!last) {
    return { total: 0, passed: 0, failed: 0 };
  }
  return {
    total: Number(last[1] ?? 0),
    passed: Number(last[2] ?? 0),
    failed: Number(last[3] ?? 0),
  };
}

function resolveRepo(): string | null {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }

  const remote = run("git remote get-url origin", REPO_ROOT);
  if (remote.status === 0 && remote.stdout.trim()) {
    const trimmed = remote.stdout.trim();
    const sshMatch = trimmed.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch?.[1]) {
      return sshMatch[1];
    }
  }

  const viaGh = run("gh repo view --json nameWithOwner --jq .nameWithOwner", REPO_ROOT);
  if (viaGh.status === 0 && viaGh.stdout.trim()) {
    return viaGh.stdout.trim();
  }
  return null;
}

function resolvePrNumber(): number | null {
  const explicit = process.env.CUJ_PR_NUMBER ?? process.env.PR_NUMBER;
  if (explicit) {
    const parsed = Number(explicit);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      const raw = readFileSync(eventPath, "utf-8");
      const event = JSON.parse(raw) as { pull_request?: { number?: number } };
      if (event.pull_request?.number) {
        return event.pull_request.number;
      }
    } catch {
      // Ignore parse errors; fall back to gh CLI.
    }
  }

  const viaGh = run("gh pr view --json number --jq .number", REPO_ROOT);
  if (viaGh.status === 0 && viaGh.stdout.trim()) {
    const parsed = Number(viaGh.stdout.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function resolveGithubToken(): string | null {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }
  const viaGh = run("gh auth token", REPO_ROOT);
  if (viaGh.status === 0 && viaGh.stdout.trim()) {
    return viaGh.stdout.trim();
  }
  return null;
}

async function postOrUpdatePrComment(commentFilePath: string): Promise<void> {
  const shouldComment = (process.env.CUJ_COMMENT ?? "false").toLowerCase() !== "false";
  if (!shouldComment) {
    console.log("[CUJ] Skipping PR comment (CUJ_COMMENT=false)");
    return;
  }

  const repo = resolveRepo();
  const prNumber = resolvePrNumber();
  const token = resolveGithubToken();

  if (!repo || !prNumber || !token) {
    console.log(
      `[CUJ] Skipping PR comment (repo=${repo ?? "missing"}, pr=${prNumber ?? "missing"}, token=${token ? "set" : "missing"})`,
    );
    return;
  }

  const marker = "<!-- cuj-report -->";
  const body = readFileSync(commentFilePath, "utf-8");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "runme-cuj-runner",
    "Content-Type": "application/json",
  };

  try {
    const commentsResp = await fetchWithTimeout(
      `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
      { headers },
      20_000,
    );
    if (!commentsResp.ok) {
      throw new Error(`Could not list PR comments: HTTP ${commentsResp.status}`);
    }
    const comments = (await commentsResp.json()) as Array<{ id: number; body?: string }>;
    const existing = comments.find((comment) => comment.body?.includes(marker));

    if (existing) {
      const updateResp = await fetchWithTimeout(
        `https://api.github.com/repos/${repo}/issues/comments/${existing.id}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ body }),
        },
        20_000,
      );
      if (!updateResp.ok) {
        throw new Error(`Could not update PR comment: HTTP ${updateResp.status}`);
      }
      console.log(`[CUJ] Updated PR comment ${existing.id} on ${repo}#${prNumber}`);
      return;
    }

    const createResp = await fetchWithTimeout(
      `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ body }),
      },
      20_000,
    );
    if (!createResp.ok) {
      throw new Error(`Could not create PR comment: HTTP ${createResp.status}`);
    }
    console.log(`[CUJ] Created PR comment on ${repo}#${prNumber}`);
  } catch (error) {
    const strictComment = (process.env.CUJ_COMMENT_STRICT ?? "false").toLowerCase() === "true";
    if (strictComment) {
      throw error;
    }
    console.warn(`[CUJ] PR comment failed but continuing: ${String(error)}`);
  }
}

async function publishCommitStatus(indexUrl: string, summary: CujSummary): Promise<void> {
  const shouldPublishStatus = (process.env.CUJ_STATUS_CHECK ?? "true").toLowerCase() !== "false";
  if (!shouldPublishStatus) {
    console.log("[CUJ] Skipping commit status (CUJ_STATUS_CHECK=false)");
    return;
  }

  const repo = resolveRepo();
  const token = resolveGithubToken();
  const sha = summary.sha || process.env.GITHUB_SHA ||
    run("git rev-parse HEAD", REPO_ROOT).stdout.trim();
  if (!repo || !token || !sha) {
    console.log(
      `[CUJ] Skipping commit status (repo=${repo ?? "missing"}, token=${token ? "set" : "missing"}, sha=${sha || "missing"})`,
    );
    return;
  }

  const context = process.env.CUJ_STATUS_CONTEXT ?? "app-tests";
  const rawState = (process.env.CUJ_STATUS_STATE ?? "success").toLowerCase();
  const state = rawState === "error" || rawState === "failure" || rawState === "pending"
    ? rawState
    : "success";
  const description = (
    summary.assertions_failed > 0
      ? `CUJ artifacts ready (${summary.assertions_failed} assertion failures)`
      : "CUJ artifacts ready"
  ).slice(0, 140);

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "runme-cuj-runner",
    "Content-Type": "application/json",
  };

  try {
    const response = await fetchWithTimeout(
      `https://api.github.com/repos/${repo}/statuses/${sha}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          state,
          context,
          target_url: indexUrl,
          description,
        }),
      },
      20_000,
    );
    if (!response.ok) {
      throw new Error(`Could not publish commit status: HTTP ${response.status}`);
    }
    console.log(`[CUJ] Published commit status '${context}' for ${repo}@${sha}`);
  } catch (error) {
    const strictStatus = (process.env.CUJ_STATUS_STRICT ?? "false").toLowerCase() === "true";
    if (strictStatus) {
      throw error;
    }
    console.warn(`[CUJ] Commit status failed but continuing: ${String(error)}`);
  }
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const manageServers = (process.env.CUJ_MANAGE_SERVERS ?? "true").toLowerCase() !== "false";
  const frontendUrl = process.env.CUJ_FRONTEND_URL ?? "http://localhost:5173";
  const backendUrl = process.env.CUJ_BACKEND_URL ?? "http://localhost:9977";
  const frontendCmd = process.env.CUJ_FRONTEND_CMD ?? "pnpm run dev:app";
  const backendCmd = process.env.CUJ_BACKEND_CMD ?? "python3 -m http.server 9977";
  const frontendCwd = resolve(process.env.CUJ_FRONTEND_CWD ?? REPO_ROOT);
  const backendCwd = resolve(process.env.CUJ_BACKEND_CWD ?? REPO_ROOT);

  const services: ServiceHandle[] = [];
  try {
    if (manageServers) {
      const frontendUp = await fetch(frontendUrl).then(() => true).catch(() => false);
      if (!frontendUp) {
        services.push(
          startService("frontend", frontendCmd, frontendCwd, join(OUTPUT_DIR, "frontend.log")),
        );
      }

      const backendUp = await fetch(backendUrl).then(() => true).catch(() => false);
      if (!backendUp) {
        services.push(
          startService("backend", backendCmd, backendCwd, join(OUTPUT_DIR, "backend.log")),
        );
      }

      await waitForHttp(frontendUrl, 90_000, "frontend");
      await waitForHttp(backendUrl, 30_000, "backend");
    }

    let failures = 0;
    const aggregateAssertions: Assertions = { total: 0, passed: 0, failed: 0 };

    for (const scenarioDriver of SCENARIO_DRIVERS) {
      const basename = scenarioDriver.split("/").at(-1) ?? scenarioDriver;
      console.log(`[CUJ] Running ${basename}`);

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
        APP_ROOT,
      );
      printOutput(compileResult.stdout, compileResult.stderr);
      if (compileResult.status !== 0) {
        failures += 1;
        console.error(`[CUJ] Failed ${basename} (compile exit ${compileResult.status})`);
        continue;
      }

      const compiled = join(GENERATED_DIR, `${basename.replace(/\.ts$/, "")}.js`);
      const runResult = runNodeScript(compiled, APP_ROOT);
      printOutput(runResult.stdout, runResult.stderr);

      const assertions = parseAssertions(`${runResult.stdout}\n${runResult.stderr}`);
      aggregateAssertions.total += assertions.total;
      aggregateAssertions.passed += assertions.passed;
      aggregateAssertions.failed += assertions.failed;

      if (runResult.status !== 0) {
        failures += 1;
        console.error(`[CUJ] Failed ${basename} (exit ${runResult.status})`);
      } else {
        console.log(`[CUJ] Completed ${basename}`);
      }
      console.log("");
    }

    const summary: CujSummary = {
      status: failures > 0 ? "FAIL" : "PASS",
      exit_code: failures > 0 ? 1 : 0,
      assertions_total: aggregateAssertions.total,
      assertions_passed: aggregateAssertions.passed,
      assertions_failed: aggregateAssertions.failed,
      run_id: process.env.GITHUB_RUN_ID ?? `${Date.now()}`,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
      sha: process.env.GITHUB_SHA ?? "",
    };
    const summaryPath = join(OUTPUT_DIR, "summary.json");
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8");

    const shouldUpload = (process.env.CUJ_UPLOAD ?? "true").toLowerCase() !== "false";
    if (shouldUpload) {
      const repo = resolveRepo();
      if (repo && !process.env.GITHUB_REPOSITORY) {
        process.env.GITHUB_REPOSITORY = repo;
      }
      const uploadPrefix = process.env.CUJ_ARTIFACT_PREFIX ??
        (repo
          ? `cuj-runs/${repo.replace(/\//g, "-")}/${summary.run_id}/${summary.run_attempt}`
          : undefined);
      const uploadResult = await uploadCujArtifacts({
        outputDir: OUTPUT_DIR,
        bucket: process.env.CUJ_ARTIFACT_BUCKET ?? "runme-dev-assets",
        prefix: uploadPrefix,
        summary,
      });
      await publishCommitStatus(uploadResult.indexUrl, summary);
      await postOrUpdatePrComment(uploadResult.prCommentPath);
      console.log(`[CUJ] Artifact index: ${uploadResult.indexUrl}`);
    } else {
      console.log("[CUJ] Skipping artifact upload (CUJ_UPLOAD=false)");
    }

    if (failures > 0) {
      const failOnScenarioFailure =
        (process.env.CUJ_FAIL_ON_SCENARIO_FAILURE ?? "true").toLowerCase() === "true";
      if (failOnScenarioFailure) {
        console.error(`[CUJ] ${failures} scenario(s) failed`);
        process.exit(1);
      }
      console.warn(
        `[CUJ] ${failures} scenario(s) failed but continuing (CUJ_FAIL_ON_SCENARIO_FAILURE=false)`,
      );
    }
  } finally {
    await Promise.all(services.map((service) => stopService(service)));
  }
}

main().catch((error) => {
  console.error(`[CUJ] Fatal error: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
