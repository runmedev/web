import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";

import { parser_pb } from "../runme/client";
import {
  type ConflictResult,
  NotebookStore,
  NotebookStoreItem,
  NotebookStoreItemType,
} from "./notebook";

// ---------------------------------------------------------------------------
// Markdown support
// ---------------------------------------------------------------------------

/** File extensions recognized as markdown notebooks. */
const MARKDOWN_EXTENSIONS = [".md", ".runme.md"];

function isMarkdownFile(name: string): boolean {
  return MARKDOWN_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function isNotebookFile(name: string): boolean {
  return name.endsWith(".json") || isMarkdownFile(name);
}

/**
 * Callbacks for converting between Markdown and Notebook proto.
 */
export interface MarkdownConverter {
  deserialize(source: Uint8Array): Promise<parser_pb.Notebook>;
  serialize(notebook: parser_pb.Notebook): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Ignore patterns
// ---------------------------------------------------------------------------

/** Directory names to skip when listing contents. */
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "__pycache__",
  ".DS_Store",
  ".vscode",
  ".idea",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
]);

/** Returns true for hidden files (dotfiles) that should not appear in listings. */
function isIgnoredFile(name: string): boolean {
  return name.startsWith(".");
}

// ---------------------------------------------------------------------------
// ContentsService RPC types (mirrors runme/contents/v1/contents.proto)
// ---------------------------------------------------------------------------

interface FileInfo {
  path: string;
  name: string;
  type: "FILE_TYPE_FILE" | "FILE_TYPE_DIRECTORY" | "FILE_TYPE_UNSPECIFIED";
  sizeBytes: string;
  lastModifiedUnixMs: string;
  sha256Hex: string;
}

interface ListResponse {
  items: FileInfo[];
}

interface ReadResponse {
  content: string; // base64-encoded bytes
  info: FileInfo;
}

interface WriteResponse {
  info: FileInfo;
}

interface RenameResponse {
  info: FileInfo;
}

interface StatResponse {
  info: FileInfo;
}

// ---------------------------------------------------------------------------
// URI helpers
// ---------------------------------------------------------------------------

/**
 * Build a contents:// URI.
 *
 * Format: `contents://<baseURL>/file/<encodedRelativePath>`
 *     or: `contents://<baseURL>/dir/<encodedRelativePath>`
 */
function buildContentsUri(
  baseURL: string,
  relativePath: string,
  kind: "file" | "directory",
): string {
  const prefix = kind === "file" ? "file" : "dir";
  const encoded = encodeURIComponent(relativePath);
  const cleanBase = baseURL.replace(/^https?:\/\//, "");
  return `contents://${cleanBase}/${prefix}/${encoded}`;
}

function buildRootUri(baseURL: string): string {
  return buildContentsUri(baseURL, "", "directory");
}

interface ParsedContentsUri {
  baseURL: string;
  kind: "file" | "directory";
  relativePath: string;
}

function parseContentsUri(uri: string): ParsedContentsUri {
  if (!uri.startsWith("contents://")) {
    throw new Error(`Invalid contents URI: ${uri}`);
  }

  const withoutScheme = uri.slice("contents://".length);

  // Find the /file/ or /dir/ separator.
  const fileIdx = withoutScheme.indexOf("/file/");
  const dirIdx = withoutScheme.indexOf("/dir/");

  let kind: "file" | "directory";
  let separatorIdx: number;
  let separatorLen: number;

  if (fileIdx !== -1 && (dirIdx === -1 || fileIdx < dirIdx)) {
    kind = "file";
    separatorIdx = fileIdx;
    separatorLen = "/file/".length;
  } else if (dirIdx !== -1) {
    kind = "directory";
    separatorIdx = dirIdx;
    separatorLen = "/dir/".length;
  } else {
    throw new Error(`Invalid contents URI (missing kind segment): ${uri}`);
  }

  const hostPort = withoutScheme.slice(0, separatorIdx);
  const encodedPath = withoutScheme.slice(separatorIdx + separatorLen);
  const relativePath = decodeURIComponent(encodedPath);

  // Path traversal protection.
  const segments = relativePath.split("/");
  if (segments.some((s) => s === ".." || s === ".")) {
    throw new Error(
      `Invalid contents URI (path traversal detected): ${uri}`,
    );
  }

  return {
    baseURL: `http://${hostPort}`,
    kind,
    relativePath,
  };
}

// ---------------------------------------------------------------------------
// Base64 helpers (UTF-8 safe)
// ---------------------------------------------------------------------------

/** Encode a UTF-8 string to base64, handling multi-byte characters correctly. */
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Notebook helpers
// ---------------------------------------------------------------------------

function createEmptyNotebookJson(): string {
  const notebook = create(parser_pb.NotebookSchema, { cells: [] });
  return toJsonString(parser_pb.NotebookSchema, notebook, {
    emitDefaultValues: true,
  });
}

/**
 * Generate a conflict filename by inserting a timestamp before the extension.
 */
function makeConflictName(originalName: string): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const dotIdx = originalName.lastIndexOf(".");
  if (dotIdx === -1) {
    return `${originalName}.conflict-${timestamp}`;
  }
  const base = originalName.slice(0, dotIdx);
  const ext = originalName.slice(dotIdx);
  return `${base}.conflict-${timestamp}${ext}`;
}

// ---------------------------------------------------------------------------
// ContentsNotebookStore
// ---------------------------------------------------------------------------

/**
 * ContentsNotebookStore implements `NotebookStore` using the backend
 * ContentsService (ConnectRPC). It talks to the Go backend over HTTP,
 * making it automatable in tests and CI (no user gestures required).
 *
 * URI scheme:
 *   contents://<host:port>/file/<encodedRelativePath>
 *   contents://<host:port>/dir/<encodedRelativePath>
 */
export class ContentsNotebookStore implements NotebookStore {
  private readonly baseURL: string;
  private readonly getAuthHeaders: () => Promise<Record<string, string>>;
  private readonly markdownConverter: MarkdownConverter | null;

  /** In-memory SHA256 hash map for conflict detection, keyed by relative path. */
  private readonly baseVersions = new Map<string, string>();

  constructor(
    baseURL: string,
    getAuthHeaders?: () => Promise<Record<string, string>>,
    markdownConverter?: MarkdownConverter,
  ) {
    this.baseURL = baseURL.replace(/\/$/, "");
    this.getAuthHeaders = getAuthHeaders ?? (async () => ({}));
    this.markdownConverter = markdownConverter ?? null;
  }

  // -----------------------------------------------------------------------
  // RPC helpers
  // -----------------------------------------------------------------------

  private async rpc<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const authHeaders = await this.getAuthHeaders();
    const resp = await fetch(
      `${this.baseURL}/runme.contents.v1.ContentsService/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify(body),
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `ContentsService.${method} failed (${resp.status}): ${text}`,
      );
    }

    return resp.json() as Promise<T>;
  }

  // -----------------------------------------------------------------------
  // Public helpers
  // -----------------------------------------------------------------------

  /**
   * Returns the root URI for this store.
   */
  getRootUri(): string {
    return buildRootUri(this.baseURL);
  }

  // -----------------------------------------------------------------------
  // NotebookStore implementation
  // -----------------------------------------------------------------------

  async list(uri: string): Promise<NotebookStoreItem[]> {
    const parsed = parseContentsUri(uri);
    if (parsed.kind !== "directory") {
      throw new Error("ContentsNotebookStore.list expects a directory URI");
    }

    const resp = await this.rpc<ListResponse>("List", {
      path: parsed.relativePath || ".",
      includeHashes: false,
    });

    const items: NotebookStoreItem[] = [];
    for (const item of resp.items ?? []) {
      if (item.type === "FILE_TYPE_FILE") {
        if (!isNotebookFile(item.name) || isIgnoredFile(item.name)) {
          continue;
        }
        const childUri = buildContentsUri(this.baseURL, item.path, "file");
        items.push({
          uri: childUri,
          name: item.name,
          type: NotebookStoreItemType.File,
          children: [],
          parents: [uri],
        });
      } else if (item.type === "FILE_TYPE_DIRECTORY") {
        if (IGNORED_DIRECTORIES.has(item.name)) {
          continue;
        }
        const childUri = buildContentsUri(this.baseURL, item.path, "directory");
        items.push({
          uri: childUri,
          name: item.name,
          type: NotebookStoreItemType.Folder,
          children: [],
          parents: [uri],
        });
      }
    }

    // Sort: folders first, then alphabetically.
    items.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === NotebookStoreItemType.Folder ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return items;
  }

  async load(uri: string): Promise<parser_pb.Notebook> {
    const parsed = parseContentsUri(uri);
    if (parsed.kind !== "file") {
      throw new Error("ContentsNotebookStore.load expects a file URI");
    }

    const resp = await this.rpc<ReadResponse>("Read", {
      path: parsed.relativePath,
      includeHash: true,
    });

    // Store base version for conflict detection.
    if (resp.info?.sha256Hex) {
      this.baseVersions.set(parsed.relativePath, resp.info.sha256Hex);
    }

    // Content is base64-encoded bytes. Decode to a proper Uint8Array to
    // handle non-ASCII (UTF-8) content correctly — atob() alone produces a
    // binary string that mangles multi-byte characters.
    const binary = atob(resp.content);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);

    // Markdown files need to be deserialized via the ParserService.
    const fileName = parsed.relativePath.split("/").pop() ?? "";
    if (isMarkdownFile(fileName)) {
      if (!this.markdownConverter) {
        throw new Error(
          "Markdown converter is required to load .md files. Configure a ParserService connection.",
        );
      }
      return this.markdownConverter.deserialize(bytes);
    }

    return fromJsonString(parser_pb.NotebookSchema, text, {
      ignoreUnknownFields: true,
    });
  }

  async save(uri: string, notebook: parser_pb.Notebook): Promise<ConflictResult> {
    const parsed = parseContentsUri(uri);
    if (parsed.kind !== "file") {
      throw new Error("ContentsNotebookStore.save expects a file URI");
    }

    // Determine serialization format based on file extension.
    const fileName = parsed.relativePath.split("/").pop() ?? "";
    let serialized: string;
    if (isMarkdownFile(fileName)) {
      if (!this.markdownConverter) {
        throw new Error(
          "Markdown converter is required to save .md files. Configure a ParserService connection.",
        );
      }
      const bytes = await this.markdownConverter.serialize(notebook);
      serialized = new TextDecoder().decode(bytes);
    } else {
      serialized = toJsonString(parser_pb.NotebookSchema, notebook, {
        emitDefaultValues: true,
      });
    }

    const body: Record<string, unknown> = {
      path: parsed.relativePath,
      content: utf8ToBase64(serialized),
      mode: "WRITE_MODE_OVERWRITE_ALWAYS",
    };

    // Use expected_version for conflict detection if we have a base version.
    const baseVersion = this.baseVersions.get(parsed.relativePath);
    if (baseVersion) {
      body.expectedVersion = baseVersion;
    }

    try {
      const resp = await this.rpc<WriteResponse>("Write", body);

      // Update base version after successful write.
      if (resp.info?.sha256Hex) {
        this.baseVersions.set(parsed.relativePath, resp.info.sha256Hex);
      }

      return { conflicted: false };
    } catch (error) {
      // Check if this is a version conflict (HTTP 409).
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes("(409)") || errorMsg.includes("version mismatch")) {
        // Fork-on-conflict: save under a conflict filename.
        const segments = parsed.relativePath.split("/");
        const originalName = segments[segments.length - 1];
        const conflictName = makeConflictName(originalName);
        const parentRelPath = segments.slice(0, -1).join("/");
        const conflictPath = parentRelPath
          ? `${parentRelPath}/${conflictName}`
          : conflictName;

        const conflictResp = await this.rpc<WriteResponse>("Write", {
          path: conflictPath,
          content: utf8ToBase64(serialized),
          mode: "WRITE_MODE_FAIL_IF_EXISTS",
        });

        if (conflictResp.info?.sha256Hex) {
          this.baseVersions.set(conflictPath, conflictResp.info.sha256Hex);
        }

        return { conflicted: true, conflictFileName: conflictName };
      }

      // Re-throw non-conflict errors.
      throw error;
    }
  }

  async create(parentUri: string, name: string): Promise<NotebookStoreItem> {
    const parsed = parseContentsUri(parentUri);
    if (parsed.kind !== "directory") {
      throw new Error(
        "ContentsNotebookStore.create expects a directory URI",
      );
    }

    // Ensure .json extension.
    const safeName = name.endsWith(".json") ? name : `${name}.json`;

    const relPath = parsed.relativePath
      ? `${parsed.relativePath}/${safeName}`
      : safeName;

    const json = createEmptyNotebookJson();

    const resp = await this.rpc<WriteResponse>("Write", {
      path: relPath,
      content: btoa(json),
      mode: "WRITE_MODE_FAIL_IF_EXISTS",
    });

    if (resp.info?.sha256Hex) {
      this.baseVersions.set(relPath, resp.info.sha256Hex);
    }

    const fileUri = buildContentsUri(this.baseURL, relPath, "file");
    return {
      uri: fileUri,
      name: safeName,
      type: NotebookStoreItemType.File,
      children: [],
      parents: [parentUri],
    };
  }

  async rename(uri: string, newName: string): Promise<NotebookStoreItem> {
    const parsed = parseContentsUri(uri);
    if (parsed.kind !== "file") {
      throw new Error("ContentsNotebookStore.rename expects a file URI");
    }

    // Ensure .json extension so the file remains visible via list().
    const safeName = newName.endsWith(".json") ? newName : `${newName}.json`;

    const segments = parsed.relativePath.split("/");
    const parentRelPath = segments.slice(0, -1).join("/");
    const newRelPath = parentRelPath ? `${parentRelPath}/${safeName}` : safeName;

    const body: Record<string, unknown> = {
      oldPath: parsed.relativePath,
      newPath: newRelPath,
    };

    const baseVersion = this.baseVersions.get(parsed.relativePath);
    if (baseVersion) {
      body.expectedVersion = baseVersion;
    }

    const resp = await this.rpc<RenameResponse>("Rename", body);

    // Clean up old version, set new.
    this.baseVersions.delete(parsed.relativePath);
    if (resp.info?.sha256Hex) {
      this.baseVersions.set(newRelPath, resp.info.sha256Hex);
    }

    const newUri = buildContentsUri(this.baseURL, newRelPath, "file");
    const parentUri = buildContentsUri(this.baseURL, parentRelPath, "directory");

    return {
      uri: newUri,
      name: safeName,
      type: NotebookStoreItemType.File,
      children: [],
      parents: [parentUri],
    };
  }

  async getMetadata(uri: string): Promise<NotebookStoreItem | null> {
    const parsed = parseContentsUri(uri);

    try {
      const resp = await this.rpc<StatResponse>("Stat", {
        path: parsed.relativePath || ".",
      });

      if (!resp.info) {
        return null;
      }

      const type =
        resp.info.type === "FILE_TYPE_FILE"
          ? NotebookStoreItemType.File
          : NotebookStoreItemType.Folder;

      const segments = parsed.relativePath.split("/").filter(Boolean);
      const parentRelPath = segments.slice(0, -1).join("/");
      const parentUri =
        segments.length > 0
          ? buildContentsUri(this.baseURL, parentRelPath, "directory")
          : buildRootUri(this.baseURL);

      return {
        uri,
        name: resp.info.name,
        type,
        children: [],
        parents: [parentUri],
      };
    } catch {
      return null;
    }
  }

  async getType(uri: string): Promise<NotebookStoreItemType> {
    const parsed = parseContentsUri(uri);
    return parsed.kind === "file"
      ? NotebookStoreItemType.File
      : NotebookStoreItemType.Folder;
  }
}

// Exported for testing.
export { buildContentsUri, buildRootUri, parseContentsUri, makeConflictName };
export type { ParsedContentsUri };
