import { create } from "@bufbuild/protobuf";

import { parser_pb } from "../contexts/CellContext";
import { NotebookData, type NotebookSnapshot } from "./notebookData";
import { appLogger } from "./logging/runtime";
import type { NotebookDataLike } from "./runtime/runmeConsole";
import type { LocalNotebooks } from "../storage/local";
import { getNotebookSessionPersistence } from "./notebookSessionPersistence";
import {
  getNotebookOwnershipManager,
  type NotebookLease,
  type NotebookOwnershipManager,
  type NotebookOwnershipRecord,
} from "./tabCoordination/notebookOwnership";

export type NotebookTabState =
  | "resolving"
  | "loading"
  | "loaded"
  | "blocked"
  | "error";

export interface OpenNotebookEntry {
  uri: string;
  requestedUri: string;
  name: string;
  state: NotebookTabState;
  errorMessage?: string;
  owner?: NotebookOwnershipRecord | null;
}

export interface OpenNotebookResult {
  localUri: string;
  entry: OpenNotebookEntry;
}

export interface NotebookDataControllerSnapshot {
  openNotebooks: OpenNotebookEntry[];
}

type NotebookDataHandle = {
  data: NotebookData;
  unsubscribe: () => void;
  loaded: boolean;
};

function createEmptyNotebook(): parser_pb.Notebook {
  return create(parser_pb.NotebookSchema, {
    cells: [],
    metadata: {},
  });
}

function isLocalFileUri(uri: string): boolean {
  return uri.startsWith("local://file/");
}

function deriveDisplayName(uri: string): string {
  try {
    const url = new URL(uri);
    const tail = url.pathname.split("/").filter(Boolean).pop();
    if (tail) {
      return decodeURIComponent(tail);
    }
  } catch {
    // Fall through to the URI segment heuristic.
  }
  return uri.split("/").filter(Boolean).pop() ?? uri;
}

export class NotebookDataController {
  private static instance: NotebookDataController | null = null;

  static getInstance(): NotebookDataController {
    if (!NotebookDataController.instance) {
      NotebookDataController.instance = new NotebookDataController();
    }
    return NotebookDataController.instance;
  }

  static resetForTests(): void {
    NotebookDataController.instance?.dispose();
    NotebookDataController.instance = null;
  }

  private localNotebooks: LocalNotebooks | null = null;
  private ownershipManager: NotebookOwnershipManager = getNotebookOwnershipManager();
  private readonly notebooks = new Map<string, NotebookDataHandle>();
  private readonly leases = new Map<string, NotebookLease>();
  private openNotebooks: OpenNotebookEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private snapshot: NotebookDataControllerSnapshot = { openNotebooks: [] };
  private restored = false;

  getSnapshot(): NotebookDataControllerSnapshot {
    this.ensureRestored();
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.ensureRestored();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  configureStores(options: { localNotebooks: LocalNotebooks | null }): void {
    this.ensureRestored();
    this.localNotebooks = options.localNotebooks;
    for (const handle of this.notebooks.values()) {
      handle.data.setNotebookStore(
        this.createOwnedNotebookStore(handle.data.getUri()),
      );
    }
    if (this.localNotebooks) {
      void this.loadOpenNotebooks();
    }
  }

  configureOwnershipManager(manager: NotebookOwnershipManager): void {
    this.ownershipManager = manager;
  }

  async openNotebook(
    uri: string,
    options?: { name?: string },
  ): Promise<OpenNotebookResult> {
    this.ensureRestored();
    const requestedUri = uri.trim();
    if (!requestedUri) {
      throw new Error("openNotebook requires a non-empty URI");
    }

    const localUri = await this.resolveLocalUri(requestedUri, options?.name);
    const name = await this.resolveNotebookName(localUri, options?.name);
    let entry = this.upsertOpenEntry({
      uri: localUri,
      requestedUri,
      name,
      state: "loading",
      errorMessage: undefined,
      owner: undefined,
    });

    const acquireResult = await this.ownershipManager.acquire(localUri);
    if (acquireResult.status === "unsupported") {
      entry = this.upsertOpenEntry({
        ...entry,
        state: "error",
        errorMessage:
          "This browser does not support safe multi-tab notebook ownership. Use a browser with Web Locks support, or close other Runme tabs before editing.",
      });
      return { localUri, entry };
    }
    if (acquireResult.status === "blocked") {
      entry = this.upsertOpenEntry({
        ...entry,
        state: "blocked",
        owner: acquireResult.owner,
        errorMessage: undefined,
      });
      return { localUri, entry };
    }
    this.leases.set(localUri, acquireResult.lease);

    const handle = this.ensureNotebookData({
      uri: localUri,
      name,
      loaded: false,
    });

    if (this.localNotebooks) {
      try {
        const notebook = await this.localNotebooks.load(localUri);
        handle.data.setNotebookStore(this.createOwnedNotebookStore(localUri));
        handle.data.loadNotebook(notebook, { persist: false });
        handle.loaded = true;
        entry = this.upsertOpenEntry({
          ...entry,
          name: await this.resolveNotebookName(localUri, name),
          state: "loaded",
          errorMessage: undefined,
          owner: undefined,
        });
      } catch (error) {
        this.releaseLease(localUri);
        entry = this.upsertOpenEntry({
          ...entry,
          state: "error",
          errorMessage: String(error),
        });
      }
    }

    return { localUri, entry };
  }

  closeNotebook(localUri: string): string | null {
    this.ensureRestored();
    const index = this.openNotebooks.findIndex((item) => item.uri === localUri);
    if (index === -1) {
      return null;
    }
    const fallback =
      index > 0
        ? this.openNotebooks[index - 1]?.uri ?? null
        : this.openNotebooks[index + 1]?.uri ?? null;
    this.removeNotebook(localUri);
    return fallback;
  }

  getNotebookData(localUri: string): NotebookData | undefined {
    return this.notebooks.get(localUri)?.data;
  }

  getOpenNotebooks(): OpenNotebookEntry[] {
    this.ensureRestored();
    return this.openNotebooks;
  }

  getNotebookSnapshot(localUri: string): NotebookSnapshot | null {
    return this.getNotebookData(localUri)?.getSnapshot() ?? null;
  }

  private async resolveLocalUri(uri: string, name?: string): Promise<string> {
    if (isLocalFileUri(uri)) {
      return uri;
    }
    if (!this.localNotebooks) {
      throw new Error("Notebook store is not ready");
    }
    return this.localNotebooks.addFile(uri, name);
  }

  private async resolveNotebookName(uri: string, fallbackName?: string): Promise<string> {
    if (fallbackName?.trim()) {
      return fallbackName;
    }
    if (this.localNotebooks && uri.startsWith("local://")) {
      try {
        const metadata = await this.localNotebooks.getMetadata(uri);
        if (metadata?.name) {
          return metadata.name;
        }
      } catch {
        // Fall back to URI-derived name.
      }
    }
    return deriveDisplayName(uri);
  }

  private ensureNotebookData({
    uri,
    name,
    notebook,
    loaded = false,
  }: {
    uri: string;
    name: string;
    notebook?: parser_pb.Notebook;
    loaded?: boolean;
  }): NotebookDataHandle {
    const existing = this.notebooks.get(uri);
    if (existing) {
      existing.data.setNotebookStore(this.createOwnedNotebookStore(uri));
      return existing;
    }

    const data = new NotebookData({
      uri,
      name,
      notebook: notebook ?? createEmptyNotebook(),
      notebookStore: this.createOwnedNotebookStore(uri),
      loaded,
      resolveNotebookForAppKernel: (target?: unknown) => {
        const targetUri = this.resolveTargetUri(target);
        if (!targetUri) {
          return this.getOwnedNotebookData(uri);
        }
        return this.getOwnedNotebookData(targetUri);
      },
      listNotebooksForAppKernel: () => this.listNotebookDataLike(uri),
    });
    const unsubscribe = data.subscribe(() => this.emit());
    const handle = { data, unsubscribe, loaded };
    this.notebooks.set(uri, handle);
    this.emit();
    return handle;
  }

  private resolveTargetUri(target?: unknown): string | null {
    if (typeof target === "string" && target.trim() !== "") {
      return target.trim();
    }
    if (
      typeof target === "object" &&
      target &&
      "uri" in target &&
      typeof (target as { uri?: unknown }).uri === "string" &&
      (target as { uri: string }).uri.trim() !== ""
    ) {
      return (target as { uri: string }).uri.trim();
    }
    if (
      typeof target === "object" &&
      target &&
      "handle" in target &&
      typeof (target as { handle?: { uri?: unknown } }).handle?.uri ===
        "string" &&
      (target as { handle: { uri: string } }).handle.uri.trim() !== ""
    ) {
      return (target as { handle: { uri: string } }).handle.uri.trim();
    }
    return null;
  }

  private listNotebookDataLike(currentUri: string): NotebookDataLike[] {
    const notebooksByUri = new Map<string, NotebookDataLike>();
    for (const handle of this.notebooks.values()) {
      if (!this.leases.has(handle.data.getUri())) {
        continue;
      }
      notebooksByUri.set(handle.data.getUri(), handle.data);
    }
    const current = this.getOwnedNotebookData(currentUri);
    if (current && !notebooksByUri.has(current.getUri())) {
      notebooksByUri.set(current.getUri(), current);
    }
    return Array.from(notebooksByUri.values());
  }

  private getOwnedNotebookData(uri: string): NotebookData | null {
    if (!this.leases.has(uri)) {
      return null;
    }
    return this.notebooks.get(uri)?.data ?? null;
  }

  private upsertOpenEntry(entry: OpenNotebookEntry): OpenNotebookEntry {
    let changed = false;
    const next = this.openNotebooks.map((item) => {
      if (item.uri !== entry.uri) {
        return item;
      }
      changed = true;
      return entry;
    });
    this.openNotebooks = changed ? next : [...this.openNotebooks, entry];
    this.emit();
    this.persist();
    return entry;
  }

  private removeNotebook(uri: string): void {
    this.releaseLease(uri);
    const handle = this.notebooks.get(uri);
    if (handle) {
      handle.unsubscribe();
    }
    this.notebooks.delete(uri);
    this.openNotebooks = this.openNotebooks.filter((item) => item.uri !== uri);
    this.emit();
    this.persist();
  }

  private releaseLease(uri: string): void {
    this.leases.get(uri)?.release();
    this.leases.delete(uri);
  }

  private async loadOpenNotebooks(): Promise<void> {
    if (!this.localNotebooks) {
      return;
    }
    const restored = [...this.openNotebooks];
    for (const item of restored) {
      if (this.notebooks.get(item.uri)?.loaded) {
        continue;
      }
      void this.openNotebook(item.requestedUri || item.uri, {
        name: item.name,
      });
    }
  }

  private ensureRestored(): void {
    if (this.restored) {
      return;
    }
    this.restored = true;
    this.openNotebooks = getNotebookSessionPersistence().loadOpenNotebooks();
    this.rebuildSnapshot();
  }

  private emit(): void {
    this.rebuildSnapshot();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        appLogger.error("NotebookDataController listener failed", {
          attrs: { scope: "notebook-session", error },
        });
      }
    }
  }

  private persist(): void {
    getNotebookSessionPersistence().saveOpenNotebooks(this.openNotebooks);
  }

  private rebuildSnapshot(): void {
    this.snapshot = {
      openNotebooks: this.openNotebooks.map((item) => ({ ...item })),
    };
  }

  private dispose(): void {
    for (const lease of this.leases.values()) {
      lease.release();
    }
    this.leases.clear();
    for (const handle of this.notebooks.values()) {
      handle.unsubscribe();
    }
    this.notebooks.clear();
    this.openNotebooks = [];
    this.listeners.clear();
    this.snapshot = { openNotebooks: [] };
    this.restored = false;
    this.localNotebooks = null;
  }

  private createOwnedNotebookStore(uri: string) {
    if (!this.localNotebooks) {
      return null;
    }
    return {
      save: async (saveUri: string, notebook: parser_pb.Notebook) => {
        const lease = this.leases.get(uri);
        if (!lease || !(await lease.isCurrentOwner())) {
          throw new Error(`Notebook ${uri} is not owned by this browser tab.`);
        }
        return this.localNotebooks?.save(saveUri, notebook);
      },
    };
  }
}

export function getNotebookDataController(): NotebookDataController {
  return NotebookDataController.getInstance();
}

export function __resetNotebookDataControllerForTests(): void {
  NotebookDataController.resetForTests();
}
