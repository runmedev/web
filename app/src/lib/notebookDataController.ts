import { create } from "@bufbuild/protobuf";

import { parser_pb } from "../contexts/CellContext";
import { NotebookData, type NotebookSnapshot } from "./notebookData";
import type { NotebookDataLike } from "./runtime/runmeConsole";
import type { LocalNotebooks } from "../storage/local";
import {
  NotebookStoreItem,
  NotebookStoreItemType,
} from "../storage/notebook";

const OPEN_NOTEBOOKS_STORAGE_KEY = "runme/openNotebooks";
const LEGACY_OPEN_NOTEBOOKS_STORAGE_KEY = "aisre/openNotebooks";

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

function normalizeStoredOpenNotebook(item: unknown): OpenNotebookEntry | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const candidate = item as Partial<NotebookStoreItem & OpenNotebookEntry>;
  if (typeof candidate.uri !== "string" || candidate.uri.trim() === "") {
    return null;
  }
  if (
    "type" in candidate &&
    candidate.type !== undefined &&
    candidate.type !== NotebookStoreItemType.File
  ) {
    return null;
  }
  return {
    uri: candidate.uri,
    requestedUri: candidate.requestedUri ?? candidate.uri,
    name: candidate.name ?? candidate.uri,
    state: candidate.state ?? "loading",
    errorMessage: candidate.errorMessage,
  };
}

function loadStoredOpenNotebooks(): OpenNotebookEntry[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw =
      window.localStorage.getItem(OPEN_NOTEBOOKS_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_OPEN_NOTEBOOKS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map(normalizeStoredOpenNotebook)
      .filter((item): item is OpenNotebookEntry => Boolean(item));
  } catch (error) {
    console.error("Failed to load open notebooks from storage", error);
    return [];
  }
}

function persistOpenNotebooks(list: OpenNotebookEntry[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const legacyShape: NotebookStoreItem[] = list
      .filter((item) => item.uri.trim() !== "")
      .map((item) => ({
        uri: item.uri,
        name: item.name,
        type: NotebookStoreItemType.File,
        children: [],
        parents: [],
      }));
    window.localStorage.setItem(
      OPEN_NOTEBOOKS_STORAGE_KEY,
      JSON.stringify(legacyShape),
    );
    window.localStorage.removeItem(LEGACY_OPEN_NOTEBOOKS_STORAGE_KEY);
  } catch (error) {
    console.error("Failed to persist open notebooks", error);
  }
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.toLowerCase().includes("not found");
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
  private readonly notebooks = new Map<string, NotebookDataHandle>();
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
      handle.data.setNotebookStore(options.localNotebooks);
    }
    if (this.localNotebooks) {
      void this.loadOpenNotebooks();
    }
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
    });

    const handle = this.ensureNotebookData({
      uri: localUri,
      name,
      loaded: false,
    });

    if (this.localNotebooks) {
      try {
        const notebook = await this.localNotebooks.load(localUri);
        handle.data.setNotebookStore(this.localNotebooks);
        handle.data.loadNotebook(notebook, { persist: false });
        handle.loaded = true;
        entry = this.upsertOpenEntry({
          ...entry,
          name: await this.resolveNotebookName(localUri, name),
          state: "loaded",
          errorMessage: undefined,
        });
      } catch (error) {
        if (isNotFoundError(error)) {
          entry = this.upsertOpenEntry({
            ...entry,
            state: "error",
            errorMessage: String(error),
          });
        } else {
          entry = this.upsertOpenEntry({
            ...entry,
            state: "error",
            errorMessage: String(error),
          });
        }
      }
    }

    return { localUri, entry };
  }

  closeNotebook(localUri: string): string | null {
    this.ensureRestored();
    const index = this.openNotebooks.findIndex((item) => item.uri === localUri);
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
      existing.data.setNotebookStore(this.localNotebooks);
      return existing;
    }

    const data = new NotebookData({
      uri,
      name,
      notebook: notebook ?? createEmptyNotebook(),
      notebookStore: this.localNotebooks,
      loaded,
      resolveNotebookForAppKernel: (target?: unknown) => {
        const targetUri = this.resolveTargetUri(target);
        if (!targetUri) {
          return this.notebooks.get(uri)?.data ?? null;
        }
        return this.notebooks.get(targetUri)?.data ?? null;
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
      notebooksByUri.set(handle.data.getUri(), handle.data);
    }
    for (const item of this.openNotebooks) {
      if (!item.uri || notebooksByUri.has(item.uri)) {
        continue;
      }
      const emptyNotebook = createEmptyNotebook();
      notebooksByUri.set(item.uri, {
        getUri: () => item.uri,
        getName: () => item.name ?? item.uri,
        getNotebook: () => emptyNotebook,
        updateCell: () => {},
        getCell: () => null,
      });
    }
    const current = this.notebooks.get(currentUri)?.data;
    if (current && !notebooksByUri.has(current.getUri())) {
      notebooksByUri.set(current.getUri(), current);
    }
    return Array.from(notebooksByUri.values());
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
    const handle = this.notebooks.get(uri);
    if (handle) {
      handle.unsubscribe();
    }
    this.notebooks.delete(uri);
    this.openNotebooks = this.openNotebooks.filter((item) => item.uri !== uri);
    this.emit();
    this.persist();
  }

  private async loadOpenNotebooks(): Promise<void> {
    if (!this.localNotebooks) {
      return;
    }
    for (const item of this.openNotebooks) {
      const handle = this.ensureNotebookData({
        uri: item.uri,
        name: item.name,
        loaded: false,
      });
      if (handle.loaded) {
        continue;
      }
      try {
        const notebook = await this.localNotebooks.load(item.uri);
        handle.data.setNotebookStore(this.localNotebooks);
        handle.data.loadNotebook(notebook, { persist: false });
        handle.loaded = true;
        this.upsertOpenEntry({
          ...item,
          name: await this.resolveNotebookName(item.uri, item.name),
          state: "loaded",
          errorMessage: undefined,
        });
      } catch (error) {
        this.upsertOpenEntry({
          ...item,
          state: "error",
          errorMessage: String(error),
        });
      }
    }
  }

  private ensureRestored(): void {
    if (this.restored) {
      return;
    }
    this.restored = true;
    this.openNotebooks = loadStoredOpenNotebooks();
    for (const item of this.openNotebooks) {
      this.ensureNotebookData({
        uri: item.uri,
        name: item.name,
        loaded: false,
      });
    }
    this.rebuildSnapshot();
  }

  private emit(): void {
    this.rebuildSnapshot();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("NotebookDataController listener failed", error);
      }
    }
  }

  private persist(): void {
    persistOpenNotebooks(this.openNotebooks);
  }

  private rebuildSnapshot(): void {
    this.snapshot = {
      openNotebooks: this.openNotebooks.map((item) => ({ ...item })),
    };
  }

  private dispose(): void {
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
}

export function getNotebookDataController(): NotebookDataController {
  return NotebookDataController.getInstance();
}

export function __resetNotebookDataControllerForTests(): void {
  NotebookDataController.resetForTests();
}
