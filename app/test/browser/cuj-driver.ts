// @ts-nocheck
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

type CmdResult = { status: number; stdout: string; stderr: string };

const CURRENT_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR =
  CURRENT_FILE_DIR.endsWith("/.generated") || CURRENT_FILE_DIR.endsWith("\\.generated")
    ? dirname(CURRENT_FILE_DIR)
    : CURRENT_FILE_DIR;
const GENERATED_DIR = join(SCRIPT_DIR, ".generated");
const OUTPUT_ROOT = join(SCRIPT_DIR, "test-output");
const DRIVER_OUTPUT_DIR = join(OUTPUT_ROOT, "driver");
const SCENARIO_ENTRY = join(SCRIPT_DIR, "run-cuj-scenarios.ts");
const REPO_ROOT = process.env.CUJ_REPO_ROOT ?? resolve(SCRIPT_DIR, "..", "..", "..");
const BIN_DIR = join(REPO_ROOT, "bin");
const LOCAL_ARTIFACT_STORE = join(REPO_ROOT, ".artifacts", "cuj-runs");

const PR_NUMBER = process.env.CUJ_PR_NUMBER ?? "";
const SHOULD_UPLOAD = (process.env.CUJ_UPLOAD ?? "true").toLowerCase() !== "false";
const RELEASE_PREFIX = process.env.CUJ_RELEASE_PREFIX ?? "cuj-artifacts-pr";

function run(command: string): CmdResult {
  const result = spawnSync(command, { shell: true, encoding: "utf-8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runLogged(command: string, steps: Array<any>): CmdResult {
  const result = run(command);
  steps.push({
    command,
    status: result.status,
    stdout: result.stdout.slice(0, 6000),
    stderr: result.stderr.slice(0, 6000),
  });
  return result;
}

function listFiles(root: string, acc: string[] = []): string[] {
  if (!existsSync(root)) return acc;
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (full === DRIVER_OUTPUT_DIR) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      listFiles(full, acc);
      continue;
    }
    acc.push(full);
  }
  return acc;
}

function parseRepoFromOrigin(origin: string): string | null {
  const trimmed = origin.trim();
  if (!trimmed) return null;
  const ssh = trimmed.match(/^git@github\.com:(.+?)\.git$/);
  if (ssh?.[1]) return ssh[1];
  const https = trimmed.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (https?.[1]) return https[1];
  return null;
}

function resolveRepo(steps: Array<any>): { repo: string; source: string } {
  if (process.env.CUJ_REPO) {
    return { repo: process.env.CUJ_REPO, source: "CUJ_REPO" };
  }
  if (process.env.GITHUB_REPOSITORY) {
    return { repo: process.env.GITHUB_REPOSITORY, source: "GITHUB_REPOSITORY" };
  }

  const origin = runLogged("git config --get remote.origin.url", steps);
  if (origin.status === 0) {
    const parsed = parseRepoFromOrigin(origin.stdout);
    if (parsed) return { repo: parsed, source: "git remote.origin.url" };
  }

  return { repo: "runmedev/web", source: "default" };
}

function copyArtifactsToStore(artifacts: string[], runId: string): string[] {
  const runDir = join(LOCAL_ARTIFACT_STORE, runId);
  mkdirSync(runDir, { recursive: true });
  const copied: string[] = [];
  for (const relPath of artifacts) {
    const src = join(SCRIPT_DIR, relPath);
    if (!existsSync(src)) continue;
    const safeName = relPath.replace(/[\/]/g, "__");
    const dest = join(runDir, safeName);
    copyFileSync(src, dest);
    copied.push(dest);
  }
  return copied;
}


function uploadTo0x0(file: string, steps: Array<any>): string | null {
  const result = runLogged(`curl -fsS -F "file=@${file}" https://0x0.st`, steps);
  if (result.status !== 0) return null;
  const url = result.stdout.trim();
  return url.startsWith("http") ? url : null;
}

mkdirSync(DRIVER_OUTPUT_DIR, { recursive: true });
const steps: Array<any> = [];
const resolvedRepo = resolveRepo(steps);
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}`;

const envInfo = {
  tokenPresent: Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN),
  hasGh: run("command -v gh").status === 0,
  hasGo: run("command -v go").status === 0,
  repo: resolvedRepo.repo,
  repoSource: resolvedRepo.source,
  prNumber: PR_NUMBER,
  uploadRequested: SHOULD_UPLOAD,
  repoRoot: REPO_ROOT,
  binDir: BIN_DIR,
  artifactStore: LOCAL_ARTIFACT_STORE,
};

if (envInfo.hasGh) {
  runLogged("gh auth status -h github.com", steps);
}

let runmeReady = false;
if (envInfo.hasGo) {
  const install = runLogged(
    `mkdir -p ${BIN_DIR} && timeout 180s env GOBIN=${BIN_DIR} go install github.com/runmedev/runme/v3@main`,
    steps,
  );
  if (install.status === 0) {
    const version = runLogged(`${join(BIN_DIR, "runme")} --version`, steps);
    runmeReady = version.status === 0;
  }
}

const compile = runLogged(
  [
    "npx tsc",
    "--target es2020",
    "--module nodenext",
    "--moduleResolution nodenext",
    "--esModuleInterop",
    "--skipLibCheck",
    `--outDir ${GENERATED_DIR}`,
    SCENARIO_ENTRY,
  ].join(" "),
  steps,
);

let scenarioStatus = 1;
if (compile.status === 0) {
  const runResult = runLogged(`node ${join(GENERATED_DIR, "run-cuj-scenarios.js")}`, steps);
  scenarioStatus = runResult.status;
}

const artifacts = listFiles(OUTPUT_ROOT).map((file) => relative(SCRIPT_DIR, file));
const copiedArtifacts = copyArtifactsToStore(artifacts, runId).map((p) => relative(REPO_ROOT, p));

let releaseTag = "";
let uploadedUrls: string[] = [];
const uploadDiagnostics: string[] = [];

if (SHOULD_UPLOAD && PR_NUMBER && envInfo.hasGh && envInfo.tokenPresent) {
  releaseTag = `${RELEASE_PREFIX}-${PR_NUMBER}`;
  const releaseView = runLogged(`gh release view ${releaseTag} --repo ${resolvedRepo.repo}`, steps);
  let releaseReady = releaseView.status === 0;
  if (!releaseReady) {
    uploadDiagnostics.push("release not found; attempting create");
    const create = runLogged(
      `gh release create ${releaseTag} --repo ${resolvedRepo.repo} --title "CUJ artifacts for PR #${PR_NUMBER}" --notes "Automated CUJ artifact bundle uploads for PR #${PR_NUMBER}."`,
      steps,
    );
    releaseReady = create.status === 0;
    if (!releaseReady) uploadDiagnostics.push("release create failed (likely missing Contents:write)");
  }

  const runDir = join(LOCAL_ARTIFACT_STORE, runId);
  const bundleTar = join(DRIVER_OUTPUT_DIR, `bundle-${runId}.tar.gz`);
  runLogged(`tar -czf ${bundleTar} -C ${runDir} .`, steps);

  const absoluteCopied = copiedArtifacts.map((p) => join(REPO_ROOT, p));
  const filesToUpload = [bundleTar, ...absoluteCopied].filter((f) => existsSync(f));

  if (releaseReady && filesToUpload.length > 0) {
    const releaseUpload = runLogged(
      `gh release upload ${releaseTag} --repo ${resolvedRepo.repo} --clobber ${filesToUpload.map((f) => `"${f}"`).join(" ")}`,
      steps,
    );
    if (releaseUpload.status !== 0) uploadDiagnostics.push("release upload failed");
    const assets = runLogged(
      `gh release view ${releaseTag} --repo ${resolvedRepo.repo} --json assets --jq '.assets[].url'`,
      steps,
    );
    if (assets.status === 0) {
      uploadedUrls = assets.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  // Fallback for tokens without releases permission: publish direct public links via 0x0.st
  if (uploadedUrls.length === 0) {
    uploadDiagnostics.push("no GitHub release URLs available; attempting external upload fallback");
    for (const file of filesToUpload) {
      const url = uploadTo0x0(file, steps);
      if (url) uploadedUrls.push(url);
      else uploadDiagnostics.push(`external upload failed for ${file}`);
    }
  }
}

const summary = {
  ok: compile.status === 0 && scenarioStatus === 0,
  env: envInfo,
  runmeReady,
  compileStatus: compile.status,
  scenarioStatus,
  artifacts,
  copiedArtifacts,
  releaseTag,
  uploadedUrls,
  uploadDiagnostics,
  steps,
};

writeFileSync(join(DRIVER_OUTPUT_DIR, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");

const lines = [
  `# CUJ Driver Summary`,
  "",
  `- Repo: ${resolvedRepo.repo} (${resolvedRepo.source})`,
  `- PR: ${PR_NUMBER || "<unset>"}`,
  `- Run ID: ${runId}`,
  `- Runme installed via go: ${runmeReady}`,
  `- Compile status: ${compile.status}`,
  `- Scenario status: ${scenarioStatus}`,
  `- Upload requested: ${SHOULD_UPLOAD}`,
  `- Release tag: ${releaseTag || "<none>"}`,
  "",
  "## Artifacts found",
  ...artifacts.map((a) => `- ${a}`),
  "",
  "## Local copied artifacts",
  ...copiedArtifacts.map((a) => `- ${a}`),
  "",
  "## Uploaded artifact URLs",
  ...(uploadedUrls.length ? uploadedUrls.map((u) => `- ${u}`) : ["- <none>"]),
  "",
  "## Upload diagnostics",
  ...(uploadDiagnostics.length ? uploadDiagnostics.map((d) => `- ${d}`) : ["- <none>"]),
  "",
  "## Commands",
  ...steps.map((s) => `- [${s.status}] ${s.command}`),
  "",
];

writeFileSync(join(DRIVER_OUTPUT_DIR, "summary.md"), lines.join("\n"), "utf-8");

if (SHOULD_UPLOAD && PR_NUMBER && envInfo.hasGh && envInfo.tokenPresent) {
  const commentResult = runLogged(
    `gh pr comment ${PR_NUMBER} --repo ${resolvedRepo.repo} --body-file ${join(DRIVER_OUTPUT_DIR, "summary.md")}`,
    steps,
  );
  writeFileSync(
    join(DRIVER_OUTPUT_DIR, "upload-result.txt"),
    `${commentResult.status}\n${commentResult.stdout}\n${commentResult.stderr}\n`,
    "utf-8",
  );
}

process.exit(summary.ok ? 0 : 1);
