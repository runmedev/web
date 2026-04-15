import { copyFile, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_SOURCE_DIR = path.join(
  os.homedir(),
  "code",
  "codex",
  "codex-rs",
  "wasm-harness",
  "examples",
  "pkg",
);

const sourceDir = process.env.CODEX_WASM_PKG_DIR || DEFAULT_SOURCE_DIR;
const targetDir = path.resolve("assets/generated/codex-wasm");
const files = ["codex_wasm_harness.js", "codex_wasm_harness_bg.wasm"];

async function ensureDirectoryExists(dir) {
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`missing source directory: ${dir}`);
  }
}

await ensureDirectoryExists(sourceDir);
await mkdir(targetDir, { recursive: true });

for (const file of files) {
  const source = path.join(sourceDir, file);
  const target = path.join(targetDir, file);
  await copyFile(source, target);
  console.log(`synced ${file}`);
}

console.log(`copied Codex WASM assets into ${targetDir}`);
