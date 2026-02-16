import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, posix, resolve } from "node:path";

export type CujSummary = {
  status: string;
  exit_code: number;
  assertions_total: number;
  assertions_passed: number;
  assertions_failed: number;
  run_id: string;
  run_attempt: string;
  sha: string;
};

type UploadedFile = {
  relative_path: string;
  object_name: string;
  size_bytes: number;
  content_type: string;
  url: string;
};

export type UploadResult = {
  bucket: string;
  prefix: string;
  indexUrl: string;
  manifestUrl: string;
  prCommentPath: string;
  summary: CujSummary;
};

export type UploadOptions = {
  outputDir?: string;
  bucket?: string;
  prefix?: string;
  summary?: Partial<CujSummary>;
};

const DEFAULT_UPLOAD_HTTP_TIMEOUT_MS = Number(
  process.env.CUJ_UPLOAD_HTTP_TIMEOUT_MS ?? process.env.CUJ_HTTP_TIMEOUT_MS ?? "120000",
);

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function getEnvNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getAccessToken(): string {
  const explicit = process.env.GOOGLE_OAUTH_ACCESS_TOKEN ?? process.env.GCP_ACCESS_TOKEN;
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }

  // Prefer ADC; fall back to active gcloud user/service account auth for local runs.
  let result = spawnSync("gcloud", ["auth", "application-default", "print-access-token"], {
    encoding: "utf-8",
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    result = spawnSync("gcloud", ["auth", "print-access-token"], {
      encoding: "utf-8",
    });
  }

  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not obtain Google access token. stderr: ${result.stderr.trim()}`);
  }

  const token = result.stdout.trim();
  return token;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = posix.join(normalizePath(dir), entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webm":
      return "video/webm";
    case ".gif":
      return "image/gif";
    case ".txt":
    case ".log":
    case ".md":
      return "text/plain; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function encodeObjectPath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function gcsHttpUrl(bucket: string, objectName: string): string {
  return `https://storage.googleapis.com/${bucket}/${encodeObjectPath(objectName)}`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function uploadObject(
  token: string,
  bucket: string,
  objectName: string,
  absolutePath: string,
): Promise<UploadedFile> {
  const body = await readFile(absolutePath);
  const contentType = contentTypeFor(absolutePath);
  const uploadUrl =
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o` +
    `?uploadType=media&name=${encodeURIComponent(objectName)}`;

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    },
    body,
    signal: AbortSignal.timeout(DEFAULT_UPLOAD_HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Upload failed for ${absolutePath} -> gs://${bucket}/${objectName}: ` +
        `${response.status} ${response.statusText} ${errorText}`,
    );
  }

  return {
    relative_path: absolutePath,
    object_name: objectName,
    size_bytes: body.byteLength,
    content_type: contentType,
    url: gcsHttpUrl(bucket, objectName),
  };
}

function relativePath(root: string, absolutePath: string): string {
  const normalizedRoot = normalizePath(root);
  const normalizedAbs = normalizePath(absolutePath);
  const withSlash = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  if (normalizedAbs.startsWith(withSlash)) {
    return normalizedAbs.slice(withSlash.length);
  }
  return normalizedAbs;
}

function buildDefaultSummary(): CujSummary {
  const runId = process.env.GITHUB_RUN_ID ?? `${Date.now()}`;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
  return {
    status: process.env.CUJ_STATUS ?? "UNKNOWN",
    exit_code: getEnvNumber("CUJ_EXIT", -1),
    assertions_total: getEnvNumber("CUJ_ASSERTIONS_TOTAL", 0),
    assertions_passed: getEnvNumber("CUJ_ASSERTIONS_PASSED", 0),
    assertions_failed: getEnvNumber("CUJ_ASSERTIONS_FAILED", 0),
    run_id: runId,
    run_attempt: runAttempt,
    sha: process.env.GITHUB_SHA ?? "",
  };
}

export async function uploadCujArtifacts(options: UploadOptions = {}): Promise<UploadResult> {
  const outputDir = resolve(options.outputDir ?? process.env.CUJ_OUTPUT_DIR ?? "test/browser/test-output");
  const outputStat = await stat(outputDir).catch(() => null);
  if (!outputStat || !outputStat.isDirectory()) {
    throw new Error(`CUJ output directory not found: ${outputDir}`);
  }

  const bucket = options.bucket ?? process.env.CUJ_ARTIFACT_BUCKET ?? "runme-dev-assets";
  const repository = process.env.GITHUB_REPOSITORY ?? "local/local";
  const runId = process.env.GITHUB_RUN_ID ?? `${Date.now()}`;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
  const safeRepo = repository.replace(/\//g, "-");
  const prefix =
    options.prefix ??
    process.env.CUJ_ARTIFACT_PREFIX ??
    posix.join("cuj-runs", safeRepo, runId, runAttempt);

  const summaryPath = posix.join(normalizePath(outputDir), "summary.json");
  let summary: CujSummary = {
    ...buildDefaultSummary(),
    ...(options.summary ?? {}),
  };

  const summaryRaw = await readFile(summaryPath, "utf-8").catch(() => "");
  if (summaryRaw.trim()) {
    try {
      summary = {
        ...(JSON.parse(summaryRaw) as CujSummary),
        ...(options.summary ?? {}),
      };
    } catch (error) {
      console.warn(`Could not parse summary.json at ${summaryPath}: ${error}`);
    }
  }

  const excluded = new Set([
    "gcs-manifest.json",
    "gcs-summary.json",
    "index.html",
    "index.md",
    "pr-comment.md",
  ]);

  const absoluteFiles = await listFilesRecursive(outputDir);
  const filesToUpload = absoluteFiles
    .map((absolute) => ({
      absolute,
      relative: relativePath(outputDir, absolute),
    }))
    .filter((file) => !excluded.has(file.relative))
    .sort((a, b) => a.relative.localeCompare(b.relative));

  if (filesToUpload.length === 0) {
    throw new Error(`No files found to upload in ${outputDir}`);
  }

  const token = getAccessToken();
  const uploaded: UploadedFile[] = [];
  for (const file of filesToUpload) {
    const objectName = posix.join(prefix, normalizePath(file.relative));
    const result = await uploadObject(token, bucket, objectName, file.absolute);
    uploaded.push({
      ...result,
      relative_path: file.relative,
    });
  }

  const urlByName = new Map<string, string>();
  for (const file of uploaded) {
    urlByName.set(file.relative_path, file.url);
  }

  const movieUrl = urlByName.get("scenario-hello-world-walkthrough.webm") ?? "";
  const initialPngUrl = urlByName.get("scenario-hello-world-01-initial.png") ?? "";
  const afterRunPngUrl = urlByName.get("scenario-hello-world-06-after-run.png") ?? "";
  const afterRunTxtUrl = urlByName.get("scenario-hello-world-06-after-run.txt") ?? "";
  const runLogUrl = urlByName.get("cuj-run.log") ?? "";

  const manifest = {
    bucket,
    prefix,
    summary,
    uploaded_files: uploaded,
  };
  const manifestPath = posix.join(normalizePath(outputDir), "gcs-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  const manifestObject = posix.join(prefix, "gcs-manifest.json");
  const manifestUpload = await uploadObject(token, bucket, manifestObject, manifestPath);

  const indexHtmlPath = posix.join(normalizePath(outputDir), "index.html");
  const indexMdPath = posix.join(normalizePath(outputDir), "index.md");
  const indexTitle = `CUJ Artifacts: ${repository} run ${runId}`;
  const indexHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(indexTitle)}</title>
  <style>
    body { font-family: sans-serif; margin: 24px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f6f8fa; }
    code { background: #f6f8fa; padding: 2px 4px; }
    img { max-width: 100%; border: 1px solid #ddd; }
    video { max-width: 100%; border: 1px solid #ddd; }
  </style>
</head>
<body>
  <h1>${escapeHtml(indexTitle)}</h1>
  <p>Status: <strong>${escapeHtml(summary.status)}</strong></p>
  <p>Assertions: ${summary.assertions_total} total, ${summary.assertions_passed} passed, ${summary.assertions_failed} failed</p>
  <p>Manifest: <a href="${manifestUpload.url}">${manifestUpload.url}</a></p>
  <h2>Primary Artifacts</h2>
  <ul>
    <li>Movie: <a href="${movieUrl}">${movieUrl || "not found"}</a></li>
    <li>Initial PNG: <a href="${initialPngUrl}">${initialPngUrl || "not found"}</a></li>
    <li>After-run PNG: <a href="${afterRunPngUrl}">${afterRunPngUrl || "not found"}</a></li>
    <li>After-run TXT: <a href="${afterRunTxtUrl}">${afterRunTxtUrl || "not found"}</a></li>
    <li>CUJ log: <a href="${runLogUrl}">${runLogUrl || "not found"}</a></li>
  </ul>
  ${
    movieUrl
      ? `<h3>Movie Preview</h3><video controls preload="metadata" src="${movieUrl}"></video>`
      : ""
  }
  ${
    initialPngUrl
      ? `<h3>Initial Screenshot</h3><img alt="CUJ initial screenshot" src="${initialPngUrl}" />`
      : ""
  }
  <h2>All Uploaded Files</h2>
  <table>
    <thead>
      <tr><th>Path</th><th>Type</th><th>Size (bytes)</th><th>URL</th></tr>
    </thead>
    <tbody>
      ${uploaded
        .map(
          (file) =>
            `<tr><td><code>${escapeHtml(file.relative_path)}</code></td><td>${escapeHtml(
              file.content_type,
            )}</td><td>${file.size_bytes}</td><td><a href="${file.url}">${escapeHtml(
              file.url,
            )}</a></td></tr>`,
        )
        .join("\n")}
    </tbody>
  </table>
</body>
</html>`;

  const indexMd = [
    `# ${indexTitle}`,
    "",
    `- Status: ${summary.status}`,
    `- Assertions: ${summary.assertions_total} total, ${summary.assertions_passed} passed, ${summary.assertions_failed} failed`,
    `- Manifest: ${manifestUpload.url}`,
    "",
    "## Primary artifacts",
    "",
    `- Movie: ${movieUrl || "not found"}`,
    `- Initial PNG: ${initialPngUrl || "not found"}`,
    `- After-run PNG: ${afterRunPngUrl || "not found"}`,
    `- After-run TXT: ${afterRunTxtUrl || "not found"}`,
    `- CUJ log: ${runLogUrl || "not found"}`,
    "",
    "## All files",
    "",
    ...uploaded.map((file) => `- \`${file.relative_path}\`: ${file.url}`),
    "",
  ].join("\n");

  await writeFile(indexHtmlPath, indexHtml, "utf-8");
  await writeFile(indexMdPath, indexMd, "utf-8");

  const indexHtmlObject = posix.join(prefix, "index.html");
  const indexMdObject = posix.join(prefix, "index.md");
  const indexHtmlUpload = await uploadObject(token, bucket, indexHtmlObject, indexHtmlPath);
  await uploadObject(token, bucket, indexMdObject, indexMdPath);

  const prComment = [
    "<!-- cuj-report -->",
    "## CUJ Results",
    "",
    "| Scenario | Status | Assertions | Artifacts |",
    "| --- | --- | --- | --- |",
    `| hello-world-local-notebook | ${summary.status} | ${summary.assertions_total} total (${summary.assertions_passed} pass / ${summary.assertions_failed} fail) | [movie](${movieUrl || indexHtmlUpload.url}) · [initial png](${initialPngUrl || indexHtmlUpload.url}) · [after-run png](${afterRunPngUrl || indexHtmlUpload.url}) · [after-run txt](${afterRunTxtUrl || indexHtmlUpload.url}) |`,
    "",
    `- [Browse all files](${indexHtmlUpload.url})`,
    `- [Manifest JSON](${manifestUpload.url})`,
    "",
  ].join("\n");
  const prCommentPath = posix.join(normalizePath(outputDir), "pr-comment.md");
  await writeFile(prCommentPath, prComment, "utf-8");

  const gcsSummary = {
    bucket,
    prefix,
    index_url: indexHtmlUpload.url,
    manifest_url: manifestUpload.url,
    pr_comment_path: prCommentPath,
    file_count: uploaded.length,
    summary,
    urls: {
      movie: movieUrl,
      initial_png: initialPngUrl,
      after_run_png: afterRunPngUrl,
      after_run_txt: afterRunTxtUrl,
      cuj_log: runLogUrl,
    },
  };
  const gcsSummaryPath = posix.join(normalizePath(outputDir), "gcs-summary.json");
  await writeFile(gcsSummaryPath, JSON.stringify(gcsSummary, null, 2), "utf-8");

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `gcs_index_url=${indexHtmlUpload.url}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `gcs_manifest_url=${manifestUpload.url}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `gcs_file_count=${uploaded.length}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `pr_comment_path=${prCommentPath}\n`);
  }

  console.log(`Uploaded ${uploaded.length} files to gs://${bucket}/${prefix}`);
  console.log(`Index: ${indexHtmlUpload.url}`);
  console.log(`Manifest: ${manifestUpload.url}`);

  return {
    bucket,
    prefix,
    indexUrl: indexHtmlUpload.url,
    manifestUrl: manifestUpload.url,
    prCommentPath,
    summary,
  };
}

async function main(): Promise<void> {
  await uploadCujArtifacts();
}

if (import.meta.url === new URL(process.argv[1], "file://").href) {
  main().catch((error) => {
    console.error(`upload-cuj-artifacts failed: ${error instanceof Error ? error.stack : error}`);
    process.exit(1);
  });
}
