import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";

import { parser_pb } from "../runme/client";
import {
  NotebookStore,
  NotebookStoreItem,
  NotebookStoreItemType,
} from "./notebook";

const GAPI_SCRIPT_SRC = "https://apis.google.com/js/api.js";

// VERSION_FIELDS is the fields we want to return when fetching metadata to determine the file version
// https://developers.google.com/workspace/drive/api/guides/fields-parameter
const VERSION_FIELDS = "md5Checksum,headRevisionId,version";

let gapiScriptPromise: Promise<void> | null = null;
let clientPromise: Promise<GapiDriveFilesClient> | null = null;

// Minimal type definitions that describe just the specific pieces of the global
// gapi client that this module relies on. This keeps the usage of window.gapi
// type-safe without pulling in the full Google typings.
type GapiLoadOptions = {
  callback: () => void;
  onerror?: (error: unknown) => void;
};

export type DriveDoc = {
  id?: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
  content?: string;
};

type GapiDriveFileMethods = {
  create: (request: Record<string, unknown>) => Promise<unknown>;
  update: (request: Record<string, unknown>) => Promise<unknown>;
  get: (request: Record<string, unknown>) => Promise<unknown>;
  list: (request: Record<string, unknown>) => Promise<unknown>;
};

type GapiRequestArgs = {
  path: string;
  method?: string;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
};

interface GapiGlobal {
  load: (name: string, options: GapiLoadOptions) => void;
  client: {
    load: (name: string, version: string) => Promise<void>;
    setToken: (token: { access_token: string }) => void;
    drive: {
      files: GapiDriveFileMethods;
    };
    request: (args: GapiRequestArgs) => Promise<unknown>;
  };
}

type DriveCreateResponse = { result?: DriveDoc };
type DriveUpdateResponse = { result?: DriveDoc };
type DriveListResponse = { result?: { files?: DriveDoc[] } };

class GapiDriveFilesClient {
  private readonly files: GapiDriveFileMethods;

  constructor(private readonly gapi: GapiGlobal) {
    this.files = this.gapi.client.drive.files;
  }

  // setContent uploads content to a Google Drive file using a media upload.
  // https://content.googleapis.com/upload/drive/v3/files/19uA730OLadqxfEUgUHN35YAQDAt2Pcax?uploadType=media&alt=json
  // It looks like gapi unlike node clients don't have helper methods for media uploads
  // so we have to do it manually.
  //
  // The API reference says you can update media and metadata in a single request but I couldn't quite
  // figure it out so it seemed easier to just use two requests; one which updates metadata (name, mimeType)
  // and another which uploads the content.
  private async setContent(
    fileId: string,
    content: string,
    mimeType?: string,
  ): Promise<void> {
    const encoder = new TextEncoder();
    const byteLength = encoder.encode(content).byteLength;
    await this.gapi.client.request({
      path: `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}`,
      method: "PATCH",
      params: {
        uploadType: "media",
        // If we don't set this we get a 404 because the file isn't in "My Drive."
        supportsAllDrives: "true",
      },
      headers: {
        Authorization: `Bearer ${this.gapi.client["getToken"]()?.access_token}`,
        "Content-Type": mimeType ?? "application/octet-stream",
        "Content-Length": String(byteLength),
      },
      body: content,
    });
  }

  private buildResource(doc: DriveDoc): Record<string, unknown> {
    const resource: Record<string, unknown> = {};
    if (typeof doc.name === "string") {
      resource.name = doc.name;
    }
    if (typeof doc.mimeType === "string") {
      resource.mimeType = doc.mimeType;
    }
    if (Array.isArray(doc.parents)) {
      resource.parents = doc.parents;
    }
    return resource;
  }

  async create(doc: DriveDoc): Promise<DriveDoc> {
    const resource = this.buildResource(doc);
    const response = (await this.files.create({
      resource,
      fields: "id,name,mimeType,parents",
      supportsAllDrives: true,
    } as Record<string, unknown>)) as DriveCreateResponse;
    const file = response.result ?? {};
    if (file.id && doc.content !== undefined) {
      console.log(`Setting content for new Drive file ${file.id}`);
      await this.setContent(file.id, doc.content, doc.mimeType);
    }
    return file;
  }

  async update(doc: DriveDoc): Promise<DriveDoc> {
    if (!doc.id) {
      throw new Error("Drive file id is required for update");
    }
    const resource = this.buildResource(doc);
    let file: DriveDoc = { id: doc.id };
    if (Object.keys(resource).length > 0) {
      const response = (await this.files.update({
        fileId: doc.id,
        resource,
        fields: "id,name,mimeType,parents",
        supportsAllDrives: true,
      } as Record<string, unknown>)) as DriveUpdateResponse;
      file = response.result ?? { id: doc.id };
    } else {
      file = {
        id: doc.id,
        name: doc.name,
        mimeType: doc.mimeType,
        parents: doc.parents,
      };
    }

    if (doc.content !== undefined && file.id) {
      await this.setContent(file.id, doc.content, doc.mimeType);
    }

    return file;
  }

  get(
    request: Record<string, unknown>,
  ): Promise<{ body?: string; result?: unknown }> {
    return this.files.get(request as any) as Promise<{
      body?: string;
      result?: unknown;
    }>;
  }

  list(request: Record<string, unknown>): Promise<DriveListResponse> {
    return this.files.list(request as any) as Promise<DriveListResponse>;
  }

  async ensureParent(file: DriveDoc, parentId?: string): Promise<DriveDoc> {
    if (!file.id || !parentId) {
      return file;
    }
    if ((file.parents ?? []).includes(parentId)) {
      return file;
    }
    const request: Record<string, unknown> = {
      fileId: file.id,
      addParents: parentId,
      supportsAllDrives: true,
      fields: "id,name,mimeType,parents",
    };
    if ((file.parents ?? []).includes("root")) {
      request.removeParents = "root";
    }
    const response = (await this.files.update(request)) as DriveUpdateResponse;
    return response.result ?? file;
  }
}

// Augment the browser Window type so TypeScript knows that the Google API
// script may attach a gapi object at runtime. This lets the rest of the module
// access window.gapi without falling back to any-typed shims.
declare global {
  interface Window {
    gapi?: GapiGlobal;
  }
}

function loadGapiScript(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(
      new Error("Google APIs are only available in a browser environment"),
    );
  }

  if (window.gapi?.load) {
    return Promise.resolve();
  }

  if (!gapiScriptPromise) {
    gapiScriptPromise = new Promise<void>((resolve, reject) => {
      const existingScript = document.querySelector<HTMLScriptElement>(
        `script[src="${GAPI_SCRIPT_SRC}"]`,
      );

      if (existingScript) {
        existingScript.addEventListener("load", () => resolve(), {
          once: true,
        });
        existingScript.addEventListener("error", reject, { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = GAPI_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  return gapiScriptPromise.then(() => {
    if (!window.gapi?.load) {
      throw new Error("Google API script loaded but gapi is unavailable");
    }
  });
}

async function ensureGapi(): Promise<typeof window.gapi> {
  if (typeof window === "undefined") {
    throw new Error("Google APIs are only available in a browser environment");
  }

  if (!window.gapi?.load) {
    await loadGapiScript();
  }

  if (!window.gapi?.load) {
    throw new Error("Google API script failed to initialize gapi");
  }

  return window.gapi;
}

// ensureDriveFilesClient creates a gapi client for the Google Drive Files API
// by loading the discovery document for the Drive API v3.
// it is parameterized by the accessToken.
//
// TODO(jlewi): Does it make sense to take the accessToken as a parameter?
// This seems like it means we need to recreate the client every time the token expires.
// The more common pattern seems to be to have the client take a reference to a class/function
// which can be called to get get a token and which handles refreshing the token as needed.
async function ensureDriveFilesClient(
  accessToken: string,
): Promise<GapiDriveFilesClient> {
  const gapi = await ensureGapi();

  if (!clientPromise) {
    clientPromise = new Promise((resolve, reject) => {
      gapi.load("client", {
        callback: async () => {
          try {
            await gapi.client.load("drive", "v3");
            resolve(new GapiDriveFilesClient(gapi));
          } catch (error) {
            reject(error);
          }
        },
        onerror: (error: unknown) => reject(error),
      });
    }).catch((error) => {
      clientPromise = null;
      throw error;
    });
  }

  const client = await clientPromise;
  gapi.client.setToken({ access_token: accessToken });
  return client;
}

function validateDriveId(id: string | null | undefined): string {
  if (!id) {
    throw new Error("Google Drive URI is missing a file identifier");
  }
  const trimmed = id.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error(
      `Google Drive identifier contains invalid characters: ${id}`,
    );
  }
  return trimmed;
}

export function driveFileUrl(id: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
}

export function driveFolderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;
}

export interface DriveItem {
  id: string;
  type: NotebookStoreItemType;
}

type DriveFileMetadata = {
  id?: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
};

export function parseDriveItem(uri: string): DriveItem {
  if (!uri) {
    throw new Error("Google Drive URI must be provided");
  }

  const trimmed = uri.trim();
  let id: string | undefined;
  let type: NotebookStoreItemType = NotebookStoreItemType.File;

  try {
    const url = new URL(trimmed);
    const pathname = url.pathname;

    if (/\/folders\//.test(pathname)) {
      type = NotebookStoreItemType.Folder;
      id = pathname.match(/\/folders\/([^/]+)/)?.[1];
    } else if (/\/file\//.test(pathname) || /\/d\//.test(pathname)) {
      id = pathname.match(/\/d\/([^/]+)/)?.[1];
    }

    if (!id) {
      const queryId = url.searchParams.get("id");
      if (queryId) {
        id = queryId;
      }
    }

    if (!id && url.hash) {
      const hashId = url.hash.match(/id=([^&]+)/)?.[1];
      if (hashId) {
        id = hashId;
      }
    }

    if (!id) {
      id = pathname.split("/").filter(Boolean).pop();
    }
  } catch {
    // Not a full URL, fall back to raw identifier below.
  }

  if (!id && /^[A-Za-z0-9_-]+$/.test(trimmed)) {
    id = trimmed;
  }

  if (!id) {
    throw new Error(
      `Unable to extract a Google Drive identifier from URI: ${uri}`,
    );
  }

  id = validateDriveId(id);
  return { id, type };
}

function createInitialNotebookJson(): string {
  const notebook = create(parser_pb.NotebookSchema, {
    cells: [],
  });
  return toJsonString(parser_pb.NotebookSchema, notebook, {
    emitDefaultValues: true,
  });
}

function extractBody(response: { body?: string; result?: unknown }): string {
  if (typeof response.body === "string") {
    return response.body;
  }
  if (typeof response.result === "string") {
    return response.result;
  }
  if (response.result && typeof response.result === "object") {
    return JSON.stringify(response.result);
  }
  throw new Error("Google Drive response did not include any content");
}

export class DriveNotebookStore implements NotebookStore {
  // ensureAccessToken is injected because it comes from the GoogleAuthContext
  constructor(private readonly ensureAccessToken: () => Promise<string>) {}

  private readonly lastReadVersion = new Map<string, string>();

  private async getFilesClient(): Promise<GapiDriveFilesClient> {
    const token = await this.ensureAccessToken();
    return ensureDriveFilesClient(token);
  }

  async create(parentUri: string, name: string): Promise<NotebookStoreItem> {
    const { id, type } = parseDriveItem(parentUri);
    if (type !== NotebookStoreItemType.Folder) {
      throw new Error("DriveNotebookStore.create expects a folder URI");
    }
    const client = await this.getFilesClient();
    let file = await client.create({
      name,
      mimeType: "application/json",
      parents: [id],
      content: createInitialNotebookJson(),
    });

    if (!file.id) {
      throw new Error("Failed to create Google Drive notebook file");
    }
    file = await client.ensureParent(file, id);
    const isFolder = file.mimeType === "application/vnd.google-apps.folder";
    return {
      uri: isFolder ? driveFolderUrl(file.id) : driveFileUrl(file.id),
      name: file.name ?? name,
      type: isFolder
        ? NotebookStoreItemType.Folder
        : NotebookStoreItemType.File,
      children: [],
      remoteUri: isFolder ? driveFolderUrl(file.id) : driveFileUrl(file.id),
      parents: [parentUri],
    };
  }

  async save(uri: string, notebook: parser_pb.Notebook): Promise<void> {
    const { id, type } = parseDriveItem(uri);
    if (type !== NotebookStoreItemType.File) {
      throw new Error("DriveNotebookStore.save expects a file URI");
    }
    const client = await this.getFilesClient();
    const metadataResponse = await client.get({
      fileId: id,
      supportsAllDrives: true,
      //fields: "md5Checksum",
      fields: VERSION_FIELDS,
    });
    const remoteMd5 =
      (metadataResponse.result as { md5Checksum?: string } | undefined)
        ?.md5Checksum ?? null;
    const lastRead = this.lastReadVersion.get(uri) ?? null;
    if (lastRead && remoteMd5 && remoteMd5 !== lastRead) {
      console.error(
        "DriveNotebookStore.save aborted due to checksum mismatch",
        {
          uri,
          expected: lastRead,
          actual: remoteMd5,
        },
      );
      return;
    }
    const json = toJsonString(parser_pb.NotebookSchema, notebook, {
      emitDefaultValues: true,
    });

    await client.update({
      id,
      mimeType: "application/json",
      content: json,
    });
    const updatedMetadataResponse = await client.get({
      fileId: id,
      supportsAllDrives: true,
      fields: VERSION_FIELDS,
    });
    const updatedMd5 =
      (updatedMetadataResponse.result as { md5Checksum?: string } | undefined)
        ?.md5Checksum ?? null;
    if (updatedMd5) {
      this.lastReadVersion.set(uri, updatedMd5);
    } else {
      this.lastReadVersion.delete(uri);
    }
  }

  async load(uri: string): Promise<parser_pb.Notebook> {
    const { id, type } = parseDriveItem(uri);
    if (type !== NotebookStoreItemType.File) {
      throw new Error("DriveNotebookStore.load expects a file URI");
    }
    const client = await this.getFilesClient();
    const metadataResponse = await client.get({
      fileId: id,
      supportsAllDrives: true,
      fields: VERSION_FIELDS,
    });
    const md5 =
      (metadataResponse.result as { md5Checksum?: string } | undefined)
        ?.md5Checksum ?? null;
    if (md5) {
      this.lastReadVersion.set(uri, md5);
    } else {
      this.lastReadVersion.delete(uri);
    }
    const response = await client.get({
      fileId: id,
      supportsAllDrives: true,
      alt: "media",
    });

    const body = extractBody(response);

    return fromJsonString(parser_pb.NotebookSchema, body, {
      ignoreUnknownFields: true,
    });
  }

  async list(uri: string): Promise<NotebookStoreItem[]> {
    const { id, type } = parseDriveItem(uri);
    if (type !== NotebookStoreItemType.Folder) {
      throw new Error(
        "Google Drive URI must reference a folder to list contents",
      );
    }
    const client = await this.getFilesClient();
    const response = await client.list({
      q: `'${id}' in parents and trashed = false`,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      orderBy: "name",
      fields: "files(id,name,mimeType)",
    });

    const files = (response.result?.files ?? []).filter(
      (file): file is DriveDoc & { id: string } => Boolean(file?.id),
    );

    return files.map((file) => {
      const isFolder = file.mimeType === "application/vnd.google-apps.folder";
      return {
        uri: isFolder ? driveFolderUrl(file.id) : driveFileUrl(file.id),
        name: file.name ?? "Untitled item",
        type: isFolder
          ? NotebookStoreItemType.Folder
          : NotebookStoreItemType.File,
        children: [],
        remoteUri: isFolder ? driveFolderUrl(file.id) : driveFileUrl(file.id),
        parents: [],
      };
    });
  }

  async getType(uri: string): Promise<NotebookStoreItemType> {
    return parseDriveItem(uri).type;
  }

  async getChecksum(uri: string): Promise<string | null> {
    const { id, type } = parseDriveItem(uri);
    if (type !== NotebookStoreItemType.File) {
      throw new Error("DriveNotebookStore.getChecksum expects a file URI");
    }
    const client = await this.getFilesClient();
    const metadataResponse = await client.get({
      fileId: id,
      supportsAllDrives: true,
      //fields: "md5Checksum",
      fields: VERSION_FIELDS,
    });
    return (
      (metadataResponse.result as { md5Checksum?: string } | undefined)
        ?.md5Checksum ?? null
    );
  }

  async rename(uri: string, name: string): Promise<NotebookStoreItem> {
    const { id, type } = parseDriveItem(uri);
    if (type !== NotebookStoreItemType.File) {
      throw new Error("DriveNotebookStore.rename expects a file URI");
    }
    const client = await this.getFilesClient();
    const file = await client.update({
      id,
      name,
    });

    const fileId = file.id ?? id;
    const mimeType = file.mimeType;
    const isFolder = mimeType === "application/vnd.google-apps.folder";
    return {
      uri: isFolder ? driveFolderUrl(fileId) : driveFileUrl(fileId),
      name: file.name ?? name,
      type: isFolder
        ? NotebookStoreItemType.Folder
        : NotebookStoreItemType.File,
      children: [],
      remoteUri: isFolder ? driveFolderUrl(fileId) : driveFileUrl(fileId),
      parents: [],
    };
  }

  /**
   * Save arbitrary file content to Drive. Intended for non-notebook sidecars
   * such as Markdown indexes.
   */
  async saveContent(
    uri: string,
    content: string,
    mimeType: string = "application/octet-stream",
  ): Promise<void> {
    const { id, type } = parseDriveItem(uri);
    if (type !== NotebookStoreItemType.File) {
      throw new Error("DriveNotebookStore.saveContent expects a file URI");
    }
    const client = await this.getFilesClient();
    await client.update({
      id,
      mimeType,
      content,
    });
  }

  async getMetadata(uri: string): Promise<NotebookStoreItem | null> {
    const { id, type } = parseDriveItem(uri);
    if (
      type !== NotebookStoreItemType.File &&
      type !== NotebookStoreItemType.Folder
    ) {
      return null;
    }
    const client = await this.getFilesClient();
    const response = await client.get({
      fileId: id,
      supportsAllDrives: true,
      fields: "id,name,mimeType,parents",
    });
    const result = response.result as {
      name?: string;
      mimeType?: string;
      parents?: string[];
    };
    const isFolder =
      result?.mimeType === "application/vnd.google-apps.folder";
    const resolvedType = isFolder
      ? NotebookStoreItemType.Folder
      : NotebookStoreItemType.File;
    const parentIds = Array.isArray(result.parents)
      ? result.parents.filter((parentId): parentId is string =>
          Boolean(parentId),
        )
      : [];
    const parentUris = parentIds.map((parentId) => {
      if (parentId === "root") {
        return parentId;
      }
      return driveFolderUrl(parentId);
    });
    return {
      uri,
      name: result?.name ?? uri,
      type: resolvedType,
      children: [],
      remoteUri: uri,
      parents: parentUris,
    };
  }
}

export async function fetchDriveItemWithParents(
  uri: string,
  ensureAccessToken: () => Promise<string>,
): Promise<{ item: NotebookStoreItem; parents: NotebookStoreItem[] }> {
  const { id, type } = parseDriveItem(uri);
  if (
    type !== NotebookStoreItemType.File &&
    type !== NotebookStoreItemType.Folder
  ) {
    throw new Error("Unsupported Google Drive item type");
  }

  const client = await ensureDriveFilesClient(await ensureAccessToken());

  const metadataResponse = await client.get({
    fileId: id,
    supportsAllDrives: true,
    fields: "id,name,mimeType,parents",
  });

  const meta = (metadataResponse.result ?? {}) as DriveFileMetadata;
  if (!meta.id) {
    throw new Error("Google Drive did not return file metadata");
  }

  const parentIds = Array.isArray(meta.parents) ? meta.parents : [];
  const parentUris = parentIds
    .filter((parentId): parentId is string => Boolean(parentId))
    .map((parentId) => (parentId === "root" ? parentId : driveFolderUrl(parentId)));

  const isFolder = meta.mimeType === "application/vnd.google-apps.folder";
  const item: NotebookStoreItem = {
    uri: isFolder ? driveFolderUrl(meta.id) : driveFileUrl(meta.id),
    name: meta.name ?? "Untitled item",
    type: isFolder ? NotebookStoreItemType.Folder : NotebookStoreItemType.File,
    children: [],
    remoteUri: isFolder ? driveFolderUrl(meta.id) : driveFileUrl(meta.id),
    parents: parentUris,
  };

  const parents: NotebookStoreItem[] = [];
  for (const parentId of parentIds) {
    try {
      const parentResponse = await client.get({
        fileId: parentId,
        supportsAllDrives: true,
        fields: "id,name,mimeType",
      });
      const parentMeta = (parentResponse.result ?? {}) as DriveFileMetadata;
      if (!parentMeta.id) {
        continue;
      }
      const parentIsFolder =
        parentMeta.mimeType === "application/vnd.google-apps.folder";
      parents.push({
        uri: parentIsFolder
          ? driveFolderUrl(parentMeta.id)
          : driveFileUrl(parentMeta.id),
        name: parentMeta.name ?? "Untitled folder",
        type: parentIsFolder
          ? NotebookStoreItemType.Folder
          : NotebookStoreItemType.File,
        children: [],
        remoteUri: parentIsFolder
          ? driveFolderUrl(parentMeta.id)
          : driveFileUrl(parentMeta.id),
        parents: [],
      });
    } catch (error) {
      console.error("Failed to fetch drive parent metadata", parentId, error);
    }
  }

  return { item, parents };
}
