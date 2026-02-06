import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";

import { parser_pb } from "../runme/client";
import {
  NotebookStore,
  NotebookStoreItem,
  NotebookStoreItemType,
} from "./notebook";

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
// Notebook helpers
// ---------------------------------------------------------------------------

function createEmptyNotebookJson(): string {
  const notebook = create(parser_pb.NotebookSchema, { cells: [] });
  return toJsonString(parser_pb.NotebookSchema, notebook, {
    emitDefaultValues: true,
  });
}

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

/**
 * Encode a UTF-8 string to base64 using chunked processing to avoid
 * max call stack size errors on large payloads.
 */
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const CHUNK = 32768;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
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

  /** In-memory SHA256 hash map for conflict detection, keyed by relative path. */
  private readonly baseVersions = new Map<string, string>();

  constructor(
    baseURL: string,
    getAuthHeaders?: () => Promise<Record<string, string>>,
  ) {
    this.baseURL = baseURL.replace(/\/$/, "");
    this.getAuthHeaders = getAuthHeaders ?? (async () => ({}));
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
        if (!item.name.endsWith(".json")) {
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

    // Content is base64-encoded bytes.
    const text = atob(resp.content);

    return fromJsonString(parser_pb.NotebookSchema, text, {
      ignoreUnknownFields: true,
    });
  }

  async save(uri: string, notebook: parser_pb.Notebook): Promise<void> {
    const parsed = parseContentsUri(uri);
    if (parsed.kind !== "file") {
      throw new Error("ContentsNotebookStore.save expects a file URI");
    }

    const json = toJsonString(parser_pb.NotebookSchema, notebook, {
      emitDefaultValues: true,
    });

    const body: Record<string, unknown> = {
      path: parsed.relativePath,
      content: btoa(json),
      mode: "WRITE_MODE_OVERWRITE_ALWAYS",
    };

    // Use expected_version for conflict detection if we have a base version.
    const baseVersion = this.baseVersions.get(parsed.relativePath);
    if (baseVersion) {
      body.expectedVersion = baseVersion;
    }

    const resp = await this.rpc<WriteResponse>("Write", body);

    // Update base version after successful write.
    if (resp.info?.sha256Hex) {
      this.baseVersions.set(parsed.relativePath, resp.info.sha256Hex);
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
      content: utf8ToBase64(json),
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
export { buildContentsUri, buildRootUri, parseContentsUri };
export type { ParsedContentsUri };
