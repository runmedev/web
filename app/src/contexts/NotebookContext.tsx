import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { create } from "@bufbuild/protobuf";
import { NotebookData, type NotebookSnapshot } from "../lib/notebookData";
import { parser_pb } from "./CellContext";
import { type NotebookDataLike } from "../lib/runtime/runmeConsole";
import { useNotebookStore } from "./NotebookStoreContext";
import { useFilesystemStore } from "./FilesystemStoreContext";
import { useCurrentDoc } from "./CurrentDocContext";
import {
  NotebookStoreItem,
  NotebookStoreItemType,
} from "../storage/notebook";

type NotebookContextValue = {
  getNotebookData: (uri: string) => NotebookData | undefined;
  useNotebookSnapshot: (uri: string) => NotebookSnapshot | null;
  useNotebookList: () => { uri: string; name: string }[];
  removeNotebook: (uri: string) => string | null;
};

const NotebookContext = createContext<NotebookContextValue | undefined>(undefined);

export function useNotebookContext() {
  const ctx = useContext(NotebookContext);
  if (!ctx) {
    throw new Error("useNotebookContext must be used within a NotebookProvider");
  }
  return ctx;
}

type StoreEntry = {
  data: NotebookData;
  unsubscribe: () => void;
  loaded: boolean;
};

type NotebookLoadResult = {
  uri: string;
  name: string;
  notebook: parser_pb.Notebook;
};

type EnsureNotebookArgs = {
  /** Canonical URI that keys the NotebookData instance. */
  uri: string;
  /** Human-readable name for display; may be derived from the URI. */
  name?: string;
  /** Notebook payload to seed the model with (optional if not yet loaded). */
  notebook?: parser_pb.Notebook;
  /** Whether the payload represents a fully loaded notebook. Defaults false. */
  loaded?: boolean;
};

const OPEN_NOTEBOOKS_STORAGE_KEY = "runme/openNotebooks";
const LEGACY_OPEN_NOTEBOOKS_STORAGE_KEY = "aisre/openNotebooks";

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("not found");
}

function isWaitingForUpstreamStore(
  uri: string,
  fsStore: unknown,
): boolean {
  return uri.startsWith("fs://") && !fsStore;
}

function loadStoredOpenNotebooks(): NotebookStoreItem[] {
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
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }
        const candidate = item as Partial<NotebookStoreItem>;
        if (typeof candidate.uri !== "string" || candidate.uri.trim() === "") {
          return null;
        }
        if (
          candidate.type !== NotebookStoreItemType.File &&
          candidate.type !== NotebookStoreItemType.Folder
        ) {
          return null;
        }
        return {
          uri: candidate.uri,
          name: candidate.name ?? candidate.uri,
          type: candidate.type,
          children: Array.isArray(candidate.children)
            ? (candidate.children as string[])
            : [],
          remoteUri: candidate.remoteUri,
          parents: Array.isArray(candidate.parents)
            ? (candidate.parents as string[])
            : [],
        } satisfies NotebookStoreItem;
      })
      .filter((item): item is NotebookStoreItem => Boolean(item));
  } catch (error) {
    console.error("Failed to load open notebooks from storage", error);
    return [];
  }
}

function persistOpenNotebooks(list: NotebookStoreItem[]): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const filtered = list.filter(
      (item) => typeof item.uri === "string" && item.uri.trim() !== "",
    );
    window.localStorage.setItem(
      OPEN_NOTEBOOKS_STORAGE_KEY,
      JSON.stringify(filtered),
    );
    window.localStorage.removeItem(LEGACY_OPEN_NOTEBOOKS_STORAGE_KEY);
  } catch (error) {
    console.error("Failed to persist open notebooks", error);
  }
}

export function NotebookProvider({ children }: { children: ReactNode }) {
  // NotebookContext is the owner of NotebookData instances. It keeps a map
  // keyed by notebook URI so multiple tabs/documents can stay mounted
  // simultaneously. Consumers (e.g., CellContext, Actions) should ask for a
  // NotebookData by URI and subscribe via useNotebookSnapshot to drive renders.
  // Note: storeRef is seeded from localStorage once so useNotebookSnapshot can
  // subscribe immediately; async loads later populate the existing models.
  //
  // Responsibilities:
  // - Construct/retrieve NotebookData for a given URI (ensureNotebook).
  // - Expose a subscription-friendly snapshot hook (useNotebookSnapshot) so
  //   React components can re-render when the underlying notebook changes.
  // - Leave persistence/loading orchestration to higher layers (CellContext
  //   will decide when to load/save); this context just owns in-memory data.
  const storeRef = useRef<Map<string, StoreEntry>>(new Map());
  const listenersRef = useRef<Set<() => void>>(new Set());
  const listCacheRef = useRef<{ uri: string; name: string }[]>([]);
  const [openNotebooks, setOpenNotebooks] = useState<NotebookStoreItem[]>([]);

  const emit = useCallback(() => {
    // emitter retained for future subscribers; currently unused by useNotebookList
    listenersRef.current.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error("NotebookContext listener failed", error);
      }
    });
  }, []);
  const { store: notebookStore } = useNotebookStore();
  const { fsStore } = useFilesystemStore();
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc();
  const hasRestoredNotebooks = useRef(false);

  const ensureNotebook = useCallback(
    ({ uri, name, notebook, loaded = false }: EnsureNotebookArgs) => {
      const existing = storeRef.current.get(uri);
      if (existing) {
        existing.data.setNotebookStore(notebookStore ?? null);
        return existing.data;
      }
      const resolvedName =
        name ?? uri.split("/").filter(Boolean).pop() ?? uri;
      console.log("[NotebookProvider] ensuring notebook", uri)
      const initialNotebook =
        notebook ??
        create(parser_pb.NotebookSchema, {
          cells: [],
          metadata: {},
        });
      const resolveTargetUri = (target?: unknown): string | null => {
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
          (
            target as { handle: { uri: string } }
          ).handle.uri.trim() !== ""
        ) {
          return (target as { handle: { uri: string } }).handle.uri.trim();
        }
        return null;
      };
      const data = new NotebookData({
        uri,
        name: resolvedName,
        notebook: initialNotebook,
        notebookStore: notebookStore ?? null,
        loaded,
        resolveNotebookForAppKernel: (target?: unknown) => {
          const targetUri = resolveTargetUri(target)
          if (!targetUri) {
            return storeRef.current.get(uri)?.data ?? null
          }
          return storeRef.current.get(targetUri)?.data ?? null
        },
        listNotebooksForAppKernel: () => {
          const notebooksByUri = new Map<string, NotebookDataLike>()
          for (const entry of storeRef.current.values()) {
            notebooksByUri.set(entry.data.getUri(), entry.data)
          }
          for (const item of listCacheRef.current) {
            if (!item?.uri || notebooksByUri.has(item.uri)) {
              continue
            }
            const emptyNotebook = create(parser_pb.NotebookSchema, {
              cells: [],
              metadata: {},
            })
            const placeholder = {
              getUri: () => item.uri,
              getName: () => item.name ?? item.uri,
              getNotebook: () => emptyNotebook,
              updateCell: () => {},
              getCell: () => null,
            } satisfies NotebookDataLike
            notebooksByUri.set(item.uri, placeholder)
          }
          const current = storeRef.current.get(uri)?.data
          if (current && !notebooksByUri.has(current.getUri())) {
            notebooksByUri.set(current.getUri(), current)
          }
          return Array.from(notebooksByUri.values())
        },
      });
      const unsubscribe = data.subscribe(() => emit());
      storeRef.current.set(uri, { data, unsubscribe, loaded });
      setOpenNotebooks((prev) => {
        const exists = prev.some((item) => item.uri === uri);
        if (exists) {
          return prev;
        }
        const item: NotebookStoreItem = {
          uri,
          name: resolvedName,
          type: NotebookStoreItemType.File,
          children: [],
          parents: [],
        };
        return [...prev, item];
      });
      emit();
      return data;
    },
    [emit, notebookStore],
  );

  const getNotebookData = useCallback((uri: string) => {
    return storeRef.current.get(uri)?.data;
  }, []);

  // Subscribe to an existing NotebookData model and return its immutable snapshot.
  // This hook assumes the provider has already created the model for the URI.
  const useNotebookSnapshot = useCallback((uri: string) => {
    const data = uri ? storeRef.current.get(uri)?.data : undefined;

    const subscribe = useCallback(
      (listener: () => void) => (data ? data.subscribe(listener) : () => {}),
      [data],
    );

    const getSnapshot = useCallback(
      () => (data ? data.getSnapshot() : null as NotebookSnapshot | null),
      [data],
    );

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }, []);

  // On first availability of notebookStore, restore placeholders for any
  // notebooks persisted in localStorage so subscribers can attach immediately.
  useEffect(() => {
    if (hasRestoredNotebooks.current) {
      return;
    }
    const stored = loadStoredOpenNotebooks();
    stored.forEach((item) => {
      if (storeRef.current.has(item.uri)) {
        return;
      }
      const empty = create(parser_pb.NotebookSchema, {
        cells: [],
        metadata: {},
      });
      ensureNotebook({
        uri: item.uri,
        name: item.name ?? item.uri,
        notebook: empty,
        loaded: false,
      });
    });
    //setOpenNotebooks(stored);
    hasRestoredNotebooks.current = true;
  }, [ensureNotebook, notebookStore, fsStore]);

  const useNotebookList = useCallback(() => {
    return openNotebooks;
  }, [openNotebooks]);

  const removeNotebook = useCallback(
    (uri: string): string | null => {
      const entries = Array.from(storeRef.current.keys());
      const index = entries.findIndex((value) => value === uri);
      let fallback: string | null = null;
      if (index !== -1) {
        if (index > 0) {
          fallback = entries[index - 1];
        } else if (index + 1 < entries.length) {
          fallback = entries[index + 1];
        }
      }
      const entry = storeRef.current.get(uri);
      if (entry) {
        entry.unsubscribe();
      }
      storeRef.current.delete(uri);
      setOpenNotebooks((prev) => prev.filter((item) => item.uri !== uri));
      emit();
      return fallback;
    },
    [emit],
  );

  const removeNotebookEntry = useCallback(
    (uri: string) => {
      const entry = storeRef.current.get(uri);
      if (entry) {
        entry.unsubscribe();
      }
      storeRef.current.delete(uri);
      setOpenNotebooks((prev) => prev.filter((item) => item.uri !== uri));
      emit();
    },
    [emit],
  );

  const dropStaleNotebook = useCallback(
    (uri: string) => {
      const fallback = removeNotebook(uri);
      if (getCurrentDoc() === uri) {
        setCurrentDoc(fallback);
      }
    },
    [getCurrentDoc, removeNotebook, setCurrentDoc],
  );

  const loadNotebookIntoLocalMirror = useCallback(
    async (
      uri: string,
      fallbackName?: string,
    ): Promise<NotebookLoadResult | null> => {
      if (!notebookStore) {
        return null;
      }

      if (uri.startsWith("local://file/")) {
        const metadata = await notebookStore.getMetadata(uri);
        if (!metadata || metadata.type !== NotebookStoreItemType.File) {
          return null;
        }
        const notebook = await notebookStore.load(uri);
        return {
          uri,
          name: metadata.name,
          notebook,
        };
      }

      const upstreamStore = uri.startsWith("fs://") ? fsStore : null;
      if (!upstreamStore) {
        return null;
      }

      const metadata = await upstreamStore.getMetadata(uri);
      if (!metadata || metadata.type !== NotebookStoreItemType.File) {
        return null;
      }
      const notebook = await upstreamStore.load(uri);
      const name = metadata.name ?? fallbackName ?? uri;
      const localUri = await notebookStore.addNotebook(uri, name, notebook);
      const localNotebook = await notebookStore.load(localUri);

      return {
        uri: localUri,
        name,
        notebook: localNotebook,
      };
    },
    [fsStore, notebookStore],
  );

  // Keep a cached list snapshot in sync for useSyncExternalStore consumers and persist to localStorage.
  useEffect(() => {
    // hasRestoredNotebooks.current guards against updating localStorage before we've restored from localStorage on window load
    if (!hasRestoredNotebooks.current) {
      return;
    }
    listCacheRef.current = openNotebooks.map((item) => ({
      uri: item.uri,
      name: item.name ?? item.uri,
    }));
    persistOpenNotebooks(openNotebooks);
  }, [openNotebooks]);

  // If notebooks are open but no current document is selected, promote the first
  // open notebook to be the active document so notebook helpers can resolve the
  // UI's visible notebook by default.
  useEffect(() => {
    if (getCurrentDoc() || openNotebooks.length === 0) {
      return;
    }
    const fallbackUri = openNotebooks[0]?.uri?.trim();
    if (!fallbackUri) {
      return;
    }
    setCurrentDoc(fallbackUri);
  }, [getCurrentDoc, openNotebooks, setCurrentDoc]);

  // Load any notebooks that were open last session once a store is available.
  useEffect(() => {
    if (!notebookStore) {
      return;
    }
    const loadExisting = async () => {
      for (const item of openNotebooks) {
        let entry = storeRef.current.get(item.uri);
        if (entry?.loaded) {
          continue;
        }
        if (!entry) {
          continue;
        }
        if (item.type !== NotebookStoreItemType.File) {
          dropStaleNotebook(item.uri);
          continue;
        }
        if (isWaitingForUpstreamStore(item.uri, fsStore)) {
          continue;
        }
        entry.data.setNotebookStore(notebookStore);
        try {
          const loaded = await loadNotebookIntoLocalMirror(item.uri, item.name);
          if (!loaded) {
            dropStaleNotebook(item.uri);
            continue;
          }
          if (loaded.uri !== item.uri) {
            removeNotebookEntry(item.uri);
            if (getCurrentDoc() === item.uri) {
              setCurrentDoc(loaded.uri);
            }
            entry = undefined;
          }
          const data = entry?.data ?? ensureNotebook({
            uri: loaded.uri,
            name: loaded.name,
            loaded: false,
          });
          data.setNotebookStore(notebookStore);
          data.loadNotebook(loaded.notebook, { persist: false });
          const loadedEntry = storeRef.current.get(loaded.uri);
          if (loadedEntry) {
            loadedEntry.loaded = true;
          }
        } catch (error) {
          if (isNotFoundError(error)) {
            dropStaleNotebook(item.uri);
            continue;
          }
          console.error("Failed to load open notebook", item.uri, error);
        }
      }
    };
    void loadExisting();
  }, [
    dropStaleNotebook,
    ensureNotebook,
    getCurrentDoc,
    fsStore,
    loadNotebookIntoLocalMirror,
    notebookStore,
    openNotebooks,
    removeNotebookEntry,
    setCurrentDoc,
  ]);

  // Ensure the current doc is loaded into NotebookData when it changes.
  useEffect(() => {
    const uri = getCurrentDoc();
    if (!uri) {
      return;
    }
    if (!notebookStore) {
      return;
    }
    if (isWaitingForUpstreamStore(uri, fsStore)) {
      return;
    }
    let entry = storeRef.current.get(uri);
    if (entry?.loaded) {
      return;
    }
    const load = async () => {
      try {
        const loaded = await loadNotebookIntoLocalMirror(uri);
        if (!loaded) {
          dropStaleNotebook(uri);
          return;
        }
        const targetUri = loaded.uri;
        if (targetUri !== uri) {
          removeNotebookEntry(uri);
          setCurrentDoc(targetUri);
          entry = storeRef.current.get(targetUri);
        }

        if (entry) {
          entry.data.setNotebookStore(notebookStore);
          entry.data.loadNotebook(loaded.notebook, { persist: false });
          entry.loaded = true;
        } else {
          ensureNotebook({
            uri: targetUri,
            name: loaded.name,
            notebook: loaded.notebook,
            loaded: true,
          });
        }
      } catch (error) {
        if (isNotFoundError(error)) {
          dropStaleNotebook(uri);
          return;
        }
        console.error("Failed to load current document notebook", uri, error);
        setCurrentDoc(null);
      }
    };
    void load();
  }, [
    dropStaleNotebook,
    ensureNotebook,
    getCurrentDoc,
    fsStore,
    loadNotebookIntoLocalMirror,
    notebookStore,
    removeNotebookEntry,
    setCurrentDoc,
  ]);

  const value = useMemo<NotebookContextValue>(
    () => ({
      getNotebookData,
      useNotebookSnapshot,
      useNotebookList,
      removeNotebook,
    }),
    [getNotebookData, removeNotebook, useNotebookList, useNotebookSnapshot],
  );

  // Persist the active notebook on change. Callers are responsible for passing
  // the right uri/notebook when saving; this provider simply exposes the store.
  // Saving/loading coordination will be handled by CellContext / callers.
  // We intentionally do not auto-save here to avoid hidden I/O.

  return <NotebookContext.Provider value={value}>{children}</NotebookContext.Provider>;
}
