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
import { useNotebookStore } from "./NotebookStoreContext";
import { useContentsStore } from "./ContentsStoreContext";
import { useCurrentDoc } from "./CurrentDocContext";
import {
  NotebookStoreItem,
  NotebookStoreItemType,
} from "../storage/notebook";
import { isContentsUri, resolveStore } from "../storage/storeResolver";

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

const OPEN_NOTEBOOKS_STORAGE_KEY = "aisre/openNotebooks";

function loadStoredOpenNotebooks(): NotebookStoreItem[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(OPEN_NOTEBOOKS_STORAGE_KEY);
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
  const { contentsStore } = useContentsStore();
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc();
  const hasRestoredNotebooks = useRef(false);

  const ensureNotebook = useCallback(
    ({ uri, name, notebook, loaded = false }: EnsureNotebookArgs) => {
      const existing = storeRef.current.get(uri);
      if (existing) {
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
      const effectiveStore = resolveStore(uri, notebookStore, contentsStore);
      const data = new NotebookData({
        uri,
        name: resolvedName,
        notebook: initialNotebook,
        notebookStore: effectiveStore ?? null,
        loaded,
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
          name,
          type: NotebookStoreItemType.File,
          children: [],
        };
        return [...prev, item];
      });
      emit();
      return data;
    },
    [emit, notebookStore, contentsStore],
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
    if (hasRestoredNotebooks.current || !notebookStore) {
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
  }, [ensureNotebook, notebookStore]);

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

  // Load any notebooks that were open last session once a store is available.
  useEffect(() => {
    if (!notebookStore && !contentsStore) {
      return;
    }
    const loadExisting = async () => {
      for (const item of openNotebooks) {
        const entry = storeRef.current.get(item.uri);
        if (entry?.loaded) {
          continue;
        }
        if (!entry) {
          continue;
        }
        const store = resolveStore(item.uri, notebookStore, contentsStore);
        if (!store) {
          continue;
        }
        try {
          const [metadata, notebook] = await Promise.all([
            store.getMetadata(item.uri),
            store.load(item.uri),
          ]);
          entry.data.loadNotebook(notebook);
          entry.loaded = true;
        } catch (error) {
          console.error("Failed to load open notebook", item.uri, error);
        }
      }
    };
    void loadExisting();
  }, [notebookStore, contentsStore, openNotebooks]);

  // Ensure the current doc is loaded into NotebookData when it changes.
  useEffect(() => {
    const uri = getCurrentDoc();
    if (!uri) {
      return;
    }
    const store = resolveStore(uri, notebookStore, contentsStore);
    if (!store) {
      return;
    }
    const entry = storeRef.current.get(uri);
    if (entry?.loaded) {
      return;
    }
    const load = async () => {
      try {
        const [metadata, notebook] = await Promise.all([
          store.getMetadata(uri),
          store.load(uri),
        ]);
        if (entry) {
          entry.data.loadNotebook(notebook);
          entry.loaded = true;
        } else {
          ensureNotebook({
            uri,
            name: metadata?.name ?? uri,
            notebook,
            loaded: true,
          });
        }
      } catch (error) {
        console.error("Failed to load current document notebook", uri, error);
        setCurrentDoc(null);
      }
    };
    void load();
  }, [ensureNotebook, getCurrentDoc, notebookStore, contentsStore, setCurrentDoc]);

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
