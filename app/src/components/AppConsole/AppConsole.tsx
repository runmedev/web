import { create } from "@bufbuild/protobuf";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/20/solid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentDoc } from "../../contexts/CurrentDocContext";
import { useFilesystemStore } from "../../contexts/FilesystemStoreContext";
import { useNotebookContext } from "../../contexts/NotebookContext";
import { useNotebookStore } from "../../contexts/NotebookStoreContext";
import { useRunners } from "../../contexts/RunnersContext";
import { useWorkspace } from "../../contexts/WorkspaceContext";
import { appState } from "../../lib/runtime/AppState";
import { createAppJsGlobals } from "../../lib/runtime/appJsGlobals";
import { JSKernel } from "../../lib/runtime/jsKernel";
import {
  createRunmeConsoleApi,
  type NotebookDataLike,
} from "../../lib/runtime/runmeConsole";
import { Runner } from "../../lib/runner";
import {
  FilesystemNotebookStore,
  isFileSystemAccessSupported,
} from "../../storage/fs";
import { parser_pb } from "../../runme/client";
import { ActionOutputItems } from "../Actions/Actions";
import Editor from "../Actions/Editor";
import {
  coerceRestoredCells,
  createDraftCell,
  createResultOutput,
  createStdTextOutputs,
  type ConsoleCell,
} from "./model";
import { appConsoleStorage } from "./storage";

const STORAGE_KEY = "runme.appConsoleCollapsed";
const LEGACY_STORAGE_KEY = "aisre.appConsoleCollapsed";
const PERSIST_DEBOUNCE_MS = 150;
const textDecoder = new TextDecoder();

type OutputKind = "stdout" | "stderr" | "result";

function buildOutputGroups(outputs: parser_pb.CellOutput[]): Array<{
  key: string;
  kind: OutputKind;
  outputs: parser_pb.CellOutput[];
}> {
  const groups: Array<{
    key: string;
    kind: OutputKind;
    outputs: parser_pb.CellOutput[];
  }> = [];

  outputs.forEach((output, outputIndex) => {
    (output.items ?? []).forEach((item, itemIndex) => {
      if (!item) {
        return;
      }

      const mime = item.mime || "";
      const decoded = textDecoder.decode(item.data ?? new Uint8Array());
      if (
        (mime === "application/vnd.code.notebook.stdout" ||
          mime === "application/vnd.code.notebook.stderr") &&
        decoded.length === 0
      ) {
        return;
      }

      let kind: OutputKind = "result";
      if (mime === "application/vnd.code.notebook.stdout") {
        kind = "stdout";
      } else if (mime === "application/vnd.code.notebook.stderr") {
        kind = "stderr";
      }

      groups.push({
        key: `${outputIndex}-${itemIndex}-${kind}`,
        kind,
        outputs: [
          create(parser_pb.CellOutputSchema, {
            items: [item],
          }),
        ],
      });
    });
  });

  return groups;
}

function StatusPill({ status }: { status: ConsoleCell["status"] }) {
  const className =
    status === "success"
      ? "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/30"
      : status === "error"
        ? "bg-rose-500/15 text-rose-200 ring-1 ring-rose-400/30"
        : status === "running"
          ? "bg-amber-500/15 text-amber-100 ring-1 ring-amber-300/30"
          : "bg-sky-500/15 text-sky-100 ring-1 ring-sky-300/30";

  return (
    <span
      data-testid="app-console-cell-status"
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ${className}`}
    >
      {status}
    </span>
  );
}

function OutputGroups({ outputs }: { outputs: parser_pb.CellOutput[] }) {
  const groups = useMemo(() => buildOutputGroups(outputs), [outputs]);
  if (groups.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="app-console-cell-outputs"
      className="space-y-2"
    >
      {groups.map((group) => (
        <div
          key={group.key}
          data-testid="app-console-cell-output"
          data-output-kind={group.kind}
          className="rounded-nb-sm border border-white/10 bg-black/15 p-3"
        >
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-slate-400">
            {group.kind}
          </div>
          <ActionOutputItems outputs={group.outputs} />
        </div>
      ))}
    </div>
  );
}

export default function AppConsole({ showHeader = true }: { showHeader?: boolean }) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      const stored =
        localStorage.getItem(STORAGE_KEY) ??
        localStorage.getItem(LEGACY_STORAGE_KEY);
      return stored === "true";
    } catch (error) {
      console.error("Failed to read console collapse state", error);
      return false;
    }
  });
  const [cells, setCells] = useState<ConsoleCell[]>(() => [createDraftCell(1)]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const draftEditorRef = useRef<any>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const historyBrowseRef = useRef<{ index: number | null; draftBuffer: string }>({
    index: null,
    draftBuffer: "",
  });
  const pendingFocusCellIdRef = useRef<string | null>(null);
  const persistenceEnabledRef = useRef(true);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? "true" : "false");
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch (error) {
      console.error("Failed to persist console collapse state", error);
    }
  }, [collapsed]);

  const { updateRunner, deleteRunner, setDefaultRunner } = useRunners();
  const { getItems, addItem, removeItem } = useWorkspace();
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc();
  const { getNotebookData, useNotebookList } = useNotebookContext();
  const openNotebooks = useNotebookList();
  const { fsStore, setFsStore } = useFilesystemStore();
  const { store: notebookStore } = useNotebookStore();

  const resolveNotebookStore = useCallback(() => {
    return notebookStore ?? appState.localNotebooks;
  }, [notebookStore]);

  const ensureFilesystemStore = useCallback(() => {
    if (fsStore) {
      return fsStore;
    }
    if (!isFileSystemAccessSupported()) {
      return null;
    }
    const store = new FilesystemNotebookStore();
    appState.setFilesystemStore(store);
    setFsStore(store);
    return store;
  }, [fsStore, setFsStore]);

  const getVisibleNotebookUri = useCallback((): string | null => {
    const activePanel = document.querySelector<HTMLElement>(
      '[data-document-id][data-state="active"]',
    );
    const uri = activePanel?.dataset.documentId;
    if (!uri || uri.trim() === "") {
      return null;
    }
    return uri;
  }, []);

  const resolveNotebookData = useCallback(
    (target?: unknown): NotebookDataLike | null => {
      if (target && typeof target === "object") {
        const candidate = target as Partial<NotebookDataLike>;
        if (
          typeof candidate.getUri === "function" &&
          typeof candidate.getName === "function" &&
          typeof candidate.getNotebook === "function" &&
          typeof candidate.updateCell === "function" &&
          typeof candidate.getCell === "function"
        ) {
          return candidate as NotebookDataLike;
        }
      }

      if (typeof target === "string" && target.trim() !== "") {
        return getNotebookData(target) ?? null;
      }

      const currentUri = getCurrentDoc();
      if (currentUri) {
        const currentNotebook = getNotebookData(currentUri);
        if (currentNotebook) {
          return currentNotebook;
        }
      }

      const visibleUri = openNotebooks[0]?.uri;
      const activeUri = getVisibleNotebookUri() ?? visibleUri;
      if (!activeUri) {
        return null;
      }
      return getNotebookData(activeUri) ?? null;
    },
    [getCurrentDoc, getNotebookData, getVisibleNotebookUri, openNotebooks],
  );

  const runme = useMemo(
    () =>
      createRunmeConsoleApi({
        resolveNotebook: resolveNotebookData,
      }),
    [resolveNotebookData],
  );

  const currentCell = cells[cells.length - 1] ?? null;

  const persistCells = useCallback(
    async (rows: ConsoleCell[]) => {
      if (!sessionId || !persistenceEnabledRef.current) {
        return;
      }
      const updatedAt = new Date().toISOString();
      await appConsoleStorage.saveCells(
        rows.map((row) => ({
          ...row,
          sessionId,
          updatedAt,
        })),
      );
      await appConsoleStorage.touchSession(sessionId, updatedAt);
    },
    [sessionId],
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const now = new Date().toISOString();
      try {
        const restored = await appConsoleStorage.loadLatestSession();
        if (cancelled) {
          return;
        }

        if (!restored) {
          const session = await appConsoleStorage.createSession(now);
          if (cancelled) {
            return;
          }
          const nextCells = [createDraftCell(1)];
          await appConsoleStorage.saveCells(
            nextCells.map((cell) => ({
              ...cell,
              sessionId: session.id,
              updatedAt: now,
            })),
          );
          setSessionId(session.id);
          setCells(nextCells);
          pendingFocusCellIdRef.current = nextCells[0].id;
          setHydrated(true);
          return;
        }

        const recovered = coerceRestoredCells(restored.cells, now);
        if (recovered.mutated) {
          await appConsoleStorage.saveCells(
            recovered.cells.map((cell) => ({
              ...cell,
              sessionId: restored.session.id,
              updatedAt: now,
            })),
          );
          await appConsoleStorage.touchSession(restored.session.id, now);
        }

        if (cancelled) {
          return;
        }

        setSessionId(restored.session.id);
        setCells(recovered.cells);
        pendingFocusCellIdRef.current =
          recovered.cells[recovered.cells.length - 1]?.id ?? null;
        setHydrated(true);
      } catch (error) {
        console.error("Failed to restore App Console session", error);
        persistenceEnabledRef.current = false;
        const fallbackSessionId =
          globalThis.crypto?.randomUUID?.() ?? `app-console-fallback-${Date.now()}`;
        const fallbackCells = [createDraftCell(1)];
        if (!cancelled) {
          setLoadError("Console history is unavailable for this session.");
          setSessionId(fallbackSessionId);
          setCells(fallbackCells);
          pendingFocusCellIdRef.current = fallbackCells[0].id;
          setHydrated(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated || !sessionId || !persistenceEnabledRef.current) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void persistCells(cells).catch((error) => {
        console.error("Failed to persist App Console state", error);
      });
    }, PERSIST_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [cells, hydrated, persistCells, sessionId]);

  useEffect(() => {
    if (!currentCell || currentCell.status !== "draft") {
      return;
    }
    if (pendingFocusCellIdRef.current !== currentCell.id) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      draftEditorRef.current?.focus?.();
      pendingFocusCellIdRef.current = null;
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [currentCell]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof body.scrollTo !== "function") {
      return;
    }
    body.scrollTo({
      top: body.scrollHeight,
      behavior: "smooth",
    });
  }, [cells]);

  const setCurrentSource = useCallback(
    (source: string, clearHistoryBrowse = true) => {
      setCells((prev) => {
        if (prev.length === 0) {
          return prev;
        }
        const lastIndex = prev.length - 1;
        const target = prev[lastIndex];
        if (target.source === source) {
          return prev;
        }
        const next = [...prev];
        next[lastIndex] = {
          ...target,
          source,
        };
        return next;
      });

      if (clearHistoryBrowse) {
        historyBrowseRef.current = {
          index: null,
          draftBuffer: "",
        };
      }
    },
    [],
  );

  const browseHistory = useCallback(
    (direction: "previous" | "next") => {
      setCells((prev) => {
        if (prev.length === 0) {
          return prev;
        }
        const draft = prev[prev.length - 1];
        if (draft.status !== "draft") {
          return prev;
        }

        const history = prev
          .filter((cell) => cell.status !== "draft")
          .map((cell) => cell.source)
          .filter((source) => source.trim() !== "");

        if (history.length === 0) {
          return prev;
        }

        const state = historyBrowseRef.current;
        if (direction === "previous") {
          const nextIndex =
            state.index === null ? 0 : Math.min(state.index + 1, history.length - 1);
          const draftBuffer = state.index === null ? draft.source : state.draftBuffer;
          const nextSource = history[history.length - 1 - nextIndex] ?? draft.source;
          historyBrowseRef.current = {
            index: nextIndex,
            draftBuffer,
          };
          if (nextSource === draft.source) {
            return prev;
          }
          const next = [...prev];
          next[next.length - 1] = {
            ...draft,
            source: nextSource,
          };
          return next;
        }

        if (state.index === null) {
          return prev;
        }

        const nextIndex = state.index - 1;
        const nextSource =
          nextIndex >= 0
            ? history[history.length - 1 - nextIndex] ?? draft.source
            : state.draftBuffer;

        historyBrowseRef.current =
          nextIndex >= 0
            ? {
                index: nextIndex,
                draftBuffer: state.draftBuffer,
              }
            : {
                index: null,
                draftBuffer: "",
              };

        if (nextSource === draft.source) {
          return prev;
        }

        const next = [...prev];
        next[next.length - 1] = {
          ...draft,
          source: nextSource,
        };
        return next;
      });
    },
    [],
  );

  const executeCurrentCell = useCallback(async () => {
    if (!currentCell || currentCell.status !== "draft") {
      return;
    }
    if (currentCell.source.trim() === "") {
      return;
    }

    historyBrowseRef.current = {
      index: null,
      draftBuffer: "",
    };

    const startedAt = new Date().toISOString();
    const runningId = currentCell.id;
    let stdout = "";
    let stderr = "";

    const updateStreamingOutputs = (kind: "stdout" | "stderr", chunk: string) => {
      if (kind === "stdout") {
        stdout += chunk;
      } else {
        stderr += chunk;
      }

      setCells((prev) =>
        prev.map((cell) =>
          cell.id === runningId
            ? {
                ...cell,
                outputs: createStdTextOutputs(stdout, stderr),
              }
            : cell,
        ),
      );
    };

    setCells((prev) =>
      prev.map((cell) =>
        cell.id === runningId
          ? {
              ...cell,
              status: "running",
              startedAt,
              completedAt: undefined,
              exitCode: undefined,
              outputs: [],
            }
          : cell,
      ),
    );

    const globals = createAppJsGlobals({
      runme,
      sendOutput: (data) => updateStreamingOutputs("stdout", data),
      resolveNotebookStore,
      ensureFilesystemStore,
      workspace: {
        getItems,
        addItem,
        removeItem,
      },
      openNotebook: (uri) => {
        setCurrentDoc(uri);
      },
      resolveNotebook: resolveNotebookData,
      listNotebooks: () =>
      openNotebooks
          .reduce<NotebookDataLike[]>((items, notebook) => {
            const resolved = getNotebookData(notebook.uri);
            if (resolved) {
              items.push(resolved);
            }
            return items;
          }, []),
      runnerSync: {
        onUpdated: (runner) => {
          updateRunner(
            new Runner({
              name: runner.name,
              endpoint: runner.endpoint,
              reconnect: runner.reconnect,
              interceptors: [],
            }),
          );
        },
        onDeleted: deleteRunner,
        onDefaultSet: setDefaultRunner,
      },
    });

    const kernel = new JSKernel({
      globals,
      hooks: {
        onStdout: (data) => updateStreamingOutputs("stdout", data),
        onStderr: (data) => updateStreamingOutputs("stderr", data),
      },
    });

    const { exitCode, result } = await kernel.run(currentCell.source);
    const completedAt = new Date().toISOString();
    const nextDraft = createDraftCell(currentCell.index + 1);
    const nextStatus: ConsoleCell["status"] = exitCode === 0 ? "success" : "error";

    pendingFocusCellIdRef.current = nextDraft.id;
    setCells((prev) => {
      const next = prev.map((cell) => {
        if (cell.id !== runningId) {
          return cell;
        }
        return {
          ...cell,
          status: nextStatus,
          completedAt,
          exitCode,
          outputs: [
            ...createStdTextOutputs(stdout, stderr),
            ...createResultOutput(result),
          ],
        };
      });
      next.push(nextDraft);
      return next;
    });
  }, [
    addItem,
    currentCell,
    deleteRunner,
    ensureFilesystemStore,
    getItems,
    getNotebookData,
    openNotebooks,
    removeItem,
    resolveNotebookData,
    resolveNotebookStore,
    runme,
    setCurrentDoc,
    setDefaultRunner,
    updateRunner,
  ]);

  const registerDraftEditor = useCallback(
    (editor: any, monaco: any) => {
      draftEditorRef.current = editor;
      if (!monaco?.KeyMod || !monaco?.KeyCode) {
        return;
      }

      editor.addCommand(
        monaco.KeyMod.Shift | monaco.KeyCode.Enter,
        () => {
          void executeCurrentCell();
        },
      );
      editor.addCommand(
        monaco.KeyMod.Shift | monaco.KeyCode.UpArrow,
        () => {
          browseHistory("previous");
        },
      );
      editor.addCommand(
        monaco.KeyMod.Shift | monaco.KeyCode.DownArrow,
        () => {
          browseHistory("next");
        },
      );
    },
    [browseHistory, executeCurrentCell],
  );

  const isBodyHidden = showHeader && collapsed;

  return (
    <div
      id="app-console"
      className="flex flex-col overflow-hidden rounded-nb-md border border-nb-cell-border bg-[#0f1014] text-white shadow-nb-sm"
    >
      {showHeader && (
        <div
          id="app-console-header"
          className="flex items-center justify-between border-b border-nb-tray-border bg-[#1a1a2e] px-3"
        >
          <span className="text-[12.6px] font-mono font-medium">App Console</span>
          <button
            type="button"
            aria-label={collapsed ? "Expand app console" : "Collapse app console"}
            className="inline-flex h-8 w-8 items-center justify-center rounded bg-black/0 text-[12.6px] font-mono font-medium text-white hover:bg-black/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black/80"
            style={{ backgroundColor: "transparent" }}
            onClick={() => setCollapsed((prev) => !prev)}
          >
            {collapsed ? (
              <ChevronUpIcon className="h-4 w-4" />
            ) : (
              <ChevronDownIcon className="h-4 w-4" />
            )}
          </button>
        </div>
      )}
      <div
        id="app-console-body"
        className={`${isBodyHidden ? "hidden" : "flex"} min-h-[220px] flex-1 flex-col bg-[#0f1014]`}
      >
        <div
          ref={bodyRef}
          data-testid="app-console-cells"
          className="flex min-h-[220px] flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
        >
          {loadError ? (
            <div className="rounded-nb-sm border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              {loadError}
            </div>
          ) : null}
          {cells.map((cell) => {
            const isCurrent = currentCell?.id === cell.id;
            const isEditable = isCurrent && cell.status === "draft";
            const isFrozen = cell.status === "success" || cell.status === "error";

            return (
              <article
                key={cell.id}
                data-testid="app-console-cell"
                data-console-cell-id={cell.id}
                data-console-cell-index={`${cell.index}`}
                data-status={cell.status}
                data-current={isCurrent ? "true" : "false"}
                className={`rounded-nb-md border p-3 shadow-sm ${
                  isCurrent
                    ? "border-sky-400/40 bg-[#151a27]"
                    : "border-white/10 bg-[#12151e]"
                }`}
              >
                <div
                  data-testid="app-console-cell-header"
                  className="mb-3 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-2">
                    <span
                      data-testid="app-console-cell-index"
                      className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-300"
                    >
                      Cell {cell.index}
                    </span>
                    <StatusPill status={cell.status} />
                  </div>
                  <div className="flex items-center gap-2">
                    {isFrozen ? (
                      <button
                        type="button"
                        data-testid="app-console-cell-copy-to-draft"
                        disabled={currentCell?.status !== "draft"}
                        className="rounded border border-white/15 px-2 py-1 text-[11px] font-medium text-slate-200 transition hover:border-sky-300/50 hover:bg-sky-400/10 disabled:cursor-not-allowed disabled:opacity-40"
                        onClick={() => {
                          setCurrentSource(cell.source);
                          draftEditorRef.current?.focus?.();
                        }}
                      >
                        Copy to draft
                      </button>
                    ) : null}
                    {isEditable ? (
                      <button
                        type="button"
                        data-testid="app-console-cell-run"
                        className="rounded border border-sky-300/40 bg-sky-400/10 px-2 py-1 text-[11px] font-medium text-sky-100 transition hover:bg-sky-400/20"
                        onClick={() => {
                          void executeCurrentCell();
                        }}
                      >
                        Run
                      </button>
                    ) : null}
                  </div>
                </div>

                <div
                  data-testid="app-console-cell-input"
                  className="rounded-nb-sm border border-white/10 bg-[#0e1320] p-2"
                >
                  {isEditable || cell.status === "running" ? (
                    <Editor
                      id={`app-console-cell-${cell.id}`}
                      value={cell.source}
                      language="javascript"
                      ariaLabel={
                        isEditable
                          ? "App Console input"
                          : `App Console cell ${cell.index} source`
                      }
                      autoFocusWhenEmpty={isEditable}
                      readOnly={!isEditable}
                      onChange={(value) => {
                        if (!isEditable) {
                          return;
                        }
                        setCurrentSource(value);
                      }}
                      onEnter={() => {
                        void executeCurrentCell();
                      }}
                      onMount={isEditable ? registerDraftEditor : undefined}
                    />
                  ) : (
                    <pre
                      data-testid="app-console-cell-source"
                      className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-[#141b2b] px-3 py-3 text-xs leading-relaxed text-slate-100"
                    >
                      {cell.source}
                    </pre>
                  )}
                </div>

                <OutputGroups outputs={cell.outputs} />

                {isCurrent && cell.status === "draft" ? (
                  <div className="mt-3 text-[11px] text-slate-400">
                    <span className="font-semibold text-slate-300">Shortcuts:</span>{" "}
                    <span>Shift+Enter to run, Shift+Up/Shift+Down to browse history.</span>
                  </div>
                ) : null}
              </article>
            );
          })}
          {!hydrated ? (
            <div className="text-xs text-slate-400">Loading console history…</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
