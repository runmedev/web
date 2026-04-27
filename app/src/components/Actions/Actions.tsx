import {
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { create } from "@bufbuild/protobuf";
import { Button, ScrollArea, Tabs, Text } from "@radix-ui/themes";
import { useParams } from "react-router-dom";

import { XMarkIcon } from "@heroicons/react/20/solid";
import {
  MimeType,
  RunmeMetadataKey,
  parser_pb,
} from "../../runme/client";;
import { CellData } from "../../lib/notebookData";
import { useNotebookContext } from "../../contexts/NotebookContext";
import { useNotebookStore } from "../../contexts/NotebookStoreContext";
import { useOutput } from "../../contexts/OutputContext";
import CellConsole, { fontSettings } from "./CellConsole";
import Editor from "./Editor";
import MarkdownCell from "./MarkdownCell";
import { IOPUB_INCOMPLETE_METADATA_KEY } from "../../lib/ipykernel";
import { appLogger } from "../../lib/logging/runtime";
import { copyNotebookShareUrl } from "../../lib/shareLinks";
import {
  PlayIcon,
  PlusIcon,
  SpinnerIcon,
  TrashIcon,
} from "./icons";
//import { useRun } from "../../lib/useRun.js";
import { useCurrentDoc } from "../../contexts/CurrentDocContext";
import { useRunners } from "../../contexts/RunnersContext";
import { DEFAULT_RUNNER_PLACEHOLDER } from "../../lib/runtime/runnersManager";
import {
  APPKERNEL_RUNNER_NAME,
  APPKERNEL_SANDBOX_RUNNER_NAME,
  isAppKernelRunnerName,
} from "../../lib/runtime/appKernel";
import { getJupyterManager } from "../../lib/runtime/jupyterManager";
import {
  driveLinkCoordinator,
  DRIVE_LINK_STATUS_TAB_URI,
  useDriveLinkCoordinatorSnapshot,
} from "../../lib/driveLinkCoordinator";
import { parseDriveItem } from "../../storage/drive";
import type { NotebookSyncState } from "../../storage/local";
import { NotebookStoreItemType } from "../../storage/notebook";
import DriveLinkStatusTab from "../DriveLinkStatusTab";
import React from "react";

type TabPanelProps = React.HTMLAttributes<HTMLDivElement> & {
  "data-state"?: "active" | "inactive";
  hidden?: boolean;
};

const TabPanel = React.forwardRef<HTMLDivElement, TabPanelProps>(
  ({ hidden: _hiddenProp, "data-state": state, style, ...rest }, ref) => {
    const inactive = state !== "active";
    return (
      <div
        ref={ref}
        data-state={state}
        style={{
          ...style,
          visibility: inactive ? "hidden" : "visible",
          position: inactive ? "absolute" : "relative",
          inset: inactive ? 0 : undefined,
          height: "100%",
          pointerEvents: inactive ? "none" : "auto",
          zIndex: inactive ? 0 : 1,
          transition: "none",
        }}
        {...rest}
      />
    );
  },
);
TabPanel.displayName = "TabPanel";
// TabPanel is used with Tabs.Content + forceMount to keep every tab's DOM alive
// (preserving scroll/Monaco layout) while hiding inactive tabs without stacking
// them. Inactive tabs are taken out of flow via absolute positioning and hidden
// visibility so they don't visually overlap yet retain their state.

function syncIndicatorPresentation(state: NotebookSyncState | null): {
  label: string;
  className: string;
  clickable: boolean;
} {
  switch (state?.status) {
    case "synced":
      return {
        label: "Notebook is synced",
        className: "bg-emerald-500",
        clickable: false,
      };
    case "pending":
      return {
        label: "Notebook has local changes pending upstream sync. Click to sync now.",
        className: "bg-red-500",
        clickable: true,
      };
    case "pending-upstream-create":
      return {
        label: "Notebook is waiting for its upstream file to be created. Click to sync now.",
        className: "bg-amber-500",
        clickable: true,
      };
    case "syncing":
      return {
        label: "Notebook is syncing",
        className: "bg-sky-500 animate-pulse",
        clickable: false,
      };
    case "error":
      return {
        label: state.lastError
          ? `Notebook sync failed: ${state.lastError}. Click to retry.`
          : "Notebook sync failed. Click to retry.",
        className: "bg-red-700",
        clickable: true,
      };
    case "local-only":
      return {
        label: "Notebook is stored only in this browser",
        className: "border border-nb-text-faint bg-transparent",
        clickable: false,
      };
    default:
      return {
        label: "Notebook sync state is loading",
        className: "border border-nb-text-faint bg-transparent",
        clickable: false,
      };
  }
}

function NotebookSyncIndicator({ docUri }: { docUri: string }) {
  const { store } = useNotebookStore();
  const [syncState, setSyncState] = useState<NotebookSyncState | null>(null);

  useEffect(() => {
    if (!store || !docUri.startsWith("local://file/")) {
      setSyncState(null);
      return;
    }

    let cancelled = false;
    const refresh = () => {
      void (async () => {
        try {
          const next = await store.getSyncState(docUri);
          if (!cancelled) {
            setSyncState(next);
          }
        } catch (error) {
          if (!cancelled) {
            setSyncState({
              status: "error",
              localUri: docUri,
              remoteId: "",
              lastError: String(error),
            });
          }
        }
      })();
    };

    refresh();
    const unsubscribe = store.subscribeSync(docUri, refresh);
    const onSyncUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ uri?: string }>).detail;
      if (detail?.uri === docUri) {
        refresh();
      }
    };
    window.addEventListener("local-notebook-sync-updated", onSyncUpdated);
    window.addEventListener("local-notebook-updated", onSyncUpdated);
    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener("local-notebook-sync-updated", onSyncUpdated);
      window.removeEventListener("local-notebook-updated", onSyncUpdated);
    };
  }, [docUri, store]);

  const presentation = syncIndicatorPresentation(syncState);
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!store || !presentation.clickable) {
        return;
      }
      void store.sync(docUri).catch((error) => {
        appLogger.warn("Notebook tab immediate sync failed", {
          attrs: {
            scope: "storage.local.sync",
            localUri: docUri,
            error: String(error),
          },
        });
      });
    },
    [docUri, presentation.clickable, store],
  );

  if (!store || !docUri.startsWith("local://file/")) {
    return null;
  }

  return (
    <button
      type="button"
      aria-label={presentation.label}
      title={presentation.label}
      className="inline-flex h-5 w-5 items-center justify-center rounded-full"
      onClick={handleClick}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <span
        className={`block h-2.5 w-2.5 rounded-full ${presentation.className}`}
      />
    </button>
  );
}

/** Compact icon-only run button that sits in the cell toolbar.
 *  Shows a spinner while running, otherwise always shows the play icon. */
function RunActionButton({
  pid,
  onClick,
}: {
  pid: number | null;
  onClick: () => void;
}) {
  const isRunning = pid !== null;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={isRunning ? "Running..." : "Run code"}
      className="icon-btn h-7 w-7"
    >
      {isRunning ? (
        <div className="animate-spin">
          <SpinnerIcon />
        </div>
      ) : (
        <PlayIcon />
      )}
    </button>
  );
}

// Action is an editor and an optional Runme console
const LANGUAGE_OPTIONS = [
  { label: "Markdown", value: "markdown" },
  { label: "Bash", value: "bash" },
  { label: "Jupyter", value: "jupyter" },
  { label: "Python", value: "python" },
  { label: "JS", value: "javascript" },
] as const;

const JAVASCRIPT_RUNNER_OPTIONS = [
  { label: "browser", value: APPKERNEL_RUNNER_NAME },
  { label: "sandbox", value: APPKERNEL_SANDBOX_RUNNER_NAME },
] as const;

type SupportedLanguage =
  | "bash"
  | "jupyter"
  | "javascript"
  | "markdown"
  | "python";

const outputTextDecoder = new TextDecoder();
const ALWAYS_SKIP_MIMES = new Set<string>([MimeType.StatefulRunmeTerminal]);

function isGoogleDriveFileUri(uri: string | null | undefined): uri is string {
  if (!uri) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (!/(^|\.)drive\.google\.com$/i.test(url.hostname)) {
    return false;
  }
  try {
    return parseDriveItem(uri).type === NotebookStoreItemType.File;
  } catch {
    return false;
  }
}

function normalizeLanguageId(
  kind: parser_pb.CellKind,
  languageId?: string | null,
): SupportedLanguage {
  switch (kind) {
    case parser_pb.CellKind.CODE:
      const normalized = (languageId ?? "").toLowerCase();
      if (normalized === "markdown") {
        return "markdown";
      }
      if (normalized === "python" || normalized === "py") {
        return "python";
      }
      if (normalized === "jupyter" || normalized === "ipython") {
        return "jupyter";
      }
      if (
        normalized === "javascript" ||
        normalized === "typescript" ||
        normalized === "js" ||
        normalized === "ts" ||
        normalized === "observable" ||
        normalized === "d3"
      ) {
        return "javascript";
      }
      return "bash";
    case parser_pb.CellKind.MARKUP:
      return "markdown";
    default:
      return "bash";
  }
}

function decodeOutputText(data: Uint8Array): string {
  if (!(data instanceof Uint8Array) || data.length === 0) {
    return "";
  }
  try {
    return outputTextDecoder.decode(data);
  } catch {
    return "";
  }
}

function uint8ArrayToBase64(data: Uint8Array): string {
  if (!(data instanceof Uint8Array) || data.length === 0) {
    return "";
  }

  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  if (typeof globalThis.btoa === "function") {
    return globalThis.btoa(binary);
  }
  return "";
}

function ActionOutputItemView({
  item,
  outputIndex,
  itemIndex,
}: {
  item: parser_pb.CellOutputItem;
  outputIndex: number;
  itemIndex: number;
}) {
  const mime = item.mime || "";
  const text = decodeOutputText(item.data ?? new Uint8Array());
  const isStreaming = item.metadata?.[IOPUB_INCOMPLETE_METADATA_KEY] === "true";
  const hasIopubMetadata =
    item.metadata?.[IOPUB_INCOMPLETE_METADATA_KEY] === "true" ||
    item.metadata?.[IOPUB_INCOMPLETE_METADATA_KEY] === "false";

  let content: React.ReactNode = null;

  if (mime === "text/html") {
    content = (
      <iframe
        title={`cell-output-${outputIndex}-${itemIndex}`}
        sandbox="allow-scripts"
        srcDoc={text}
        className="h-[420px] w-full rounded-md border border-nb-cell-border bg-white"
      />
    );
  } else if (
    mime === "image/png" ||
    mime === "image/jpeg" ||
    mime === "image/svg+xml"
  ) {
    const base64 = uint8ArrayToBase64(item.data ?? new Uint8Array());
    const src = `data:${mime};base64,${base64}`;
    content = (
      <img
        alt={`Cell output ${outputIndex}-${itemIndex}`}
        src={src}
        className="max-h-[480px] w-full rounded-md border border-nb-cell-border bg-white object-contain"
      />
    );
  } else {
    content = (
      <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-nb-text">
        {text}
      </pre>
    );
  }

  return (
    <div
      className="rounded-nb-sm border border-nb-border bg-nb-surface-2 p-3"
      data-testid="cell-output-item"
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-nb-text-faint">
        Output {outputIndex} / Item {itemIndex} - mime={mime}
        {hasIopubMetadata ? (isStreaming ? " (streaming)" : " (complete)") : ""}
      </div>
      <div className="mt-2">{content}</div>
    </div>
  );
}

function ActionOutputItems({ outputs }: { outputs: parser_pb.CellOutput[] }) {
  const hasTerminalOutput = outputs.some((output) =>
    (output.items ?? []).some((item) => item?.mime === MimeType.StatefulRunmeTerminal),
  );

  const displayableItems = outputs.flatMap((output, outputIndex) =>
    (output.items ?? [])
      .map((item, itemIndex) => {
        if (!item) {
          return null;
        }
        const mime = item.mime || "";
        if (ALWAYS_SKIP_MIMES.has(mime)) {
          return null;
        }
        if (
          hasTerminalOutput &&
          (mime === MimeType.VSCodeNotebookStdOut || mime === MimeType.VSCodeNotebookStdErr)
        ) {
          return null;
        }
        if (!(item.data instanceof Uint8Array)) {
          return null;
        }
        return (
          <ActionOutputItemView
            key={`${outputIndex}-${itemIndex}-${item.mime}`}
            item={item}
            outputIndex={outputIndex}
            itemIndex={itemIndex}
          />
        );
      })
      .filter(Boolean),
  );

  if (displayableItems.length === 0) {
    return null;
  }

  return <div className="mt-2 space-y-2">{displayableItems}</div>;
}

export function Action({
  cellData,
  docUri,
  isFirst,
}: {
  cellData: CellData;
  docUri: string;
  isFirst: boolean;
}) {
  const { store } = useNotebookStore();
  const { listRunners, defaultRunnerName } = useRunners();
  const jupyterManager = useMemo(() => getJupyterManager(), []);
  const jupyterVersion = useSyncExternalStore(
    useCallback((listener) => jupyterManager.subscribe(listener), [jupyterManager]),
    useCallback(() => jupyterManager.getVersion(), [jupyterManager]),
    useCallback(() => jupyterManager.getVersion(), [jupyterManager]),
  );
  const cell = useSyncExternalStore(
    useCallback(
      (listener) => cellData.subscribeToContentChange(listener),
      [cellData],
    ),
    useCallback(() => cellData.snapshot, [cellData]),
    useCallback(() => cellData.snapshot, [cellData]),
  );
  // Derive runID from the current cell snapshot so clear/reset operations
  // immediately repaint output visibility without requiring a separate listener.
  const runID = cellData.getRunID();

  const handleAddCodeCellBefore = useCallback(() => {
    cellData.addBefore(cell?.languageId);
  }, [cell?.languageId, cellData]);

  const handleAddCodeCellAfter = useCallback(() => {
    cellData.addAfter(cell?.languageId);
  }, [cell?.languageId, cellData]);

  const updateCellLocal = useCallback(
    (nextCell: parser_pb.Cell) => {
      cellData.update(nextCell);
    },
    [cellData],
  );

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [shareRemoteUri, setShareRemoteUri] = useState<string | null>(null);
  const [markdownEditRequest, setMarkdownEditRequest] = useState(0);
  const [pid, setPid] = useState<number | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);

  useEffect(() => {
    if (!store || !docUri.startsWith("local://")) {
      setShareRemoteUri(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const metadata = await store.getMetadata(docUri);
        if (!cancelled) {
          setShareRemoteUri(metadata?.remoteUri ?? null);
        }
      } catch {
        if (!cancelled) {
          setShareRemoteUri(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [docUri, store]);

  // When an exit code arrives, clear the pid so the spinner stops.
  const handleExitCode = useCallback((code: number | null) => {
    setExitCode(code);
    if (code !== null) {
      setPid(null);
    }
  }, []);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handleClick = () => setContextMenu(null);
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("click", handleClick);
    window.addEventListener("keydown", handleKey);

    return () => {
      window.removeEventListener("click", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [contextMenu]);

  const adjustedContextMenu = useMemo(() => {
    if (!contextMenu) {
      return null;
    }

    if (typeof window === "undefined") {
      return contextMenu;
    }

    const menuWidth = 200;
    const menuHeight = shareRemoteUri ? 88 : 48;
    const left = Math.max(
      0,
      Math.min(contextMenu.x, window.innerWidth - menuWidth),
    );
    const top = Math.max(
      0,
      Math.min(contextMenu.y, window.innerHeight - menuHeight),
    );
    return { x: left, y: top };
  }, [contextMenu, shareRemoteUri]);

  const runCode = useCallback(() => {
    cellData.run();
  }, [cellData]);

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({ x: event.clientX, y: event.clientY });
    },
    [],
  );

  const handleRemoveCell = useCallback(() => {
    cellData.remove();
    setContextMenu(null);
  }, [cellData]);

  const handleCopyShareLink = useCallback(async () => {
    if (!shareRemoteUri) {
      setContextMenu(null);
      return;
    }

    try {
      await copyNotebookShareUrl(shareRemoteUri);
    } catch (error) {
      appLogger.error("Failed to copy notebook share link from document menu", {
        attrs: {
          scope: "storage.drive.share",
          code: "DRIVE_SHARE_LINK_COPY_FAILED",
          remoteUri: shareRemoteUri,
          error: String(error),
        },
      });
    } finally {
      setContextMenu(null);
    }
  }, [shareRemoteUri]);

  const sequenceLabel = useMemo(() => {
    if (!cell) {
      return " ";
    }
    const seq = Number(cell.metadata[RunmeMetadataKey.Sequence]);
    if (!seq) {
      return " ";
    }
    return seq.toString();
  }, [cell, pid, exitCode]);

  const selectedLanguage = useMemo(() => {
    if (!cell) {
      return "bash";
    }
    return normalizeLanguageId(cell.kind, cell.languageId);
  }, [cell]);

  const editorLanguage = useMemo(() => {
    switch (selectedLanguage) {
      case "markdown":
        return "markdown";
      case "javascript":
        return "javascript";
      case "jupyter":
        return "python";
      case "python":
        return "python";
      default:
        return "shellscript";
    }
  }, [selectedLanguage]);

  const languageSelectId = useMemo(
    () => `language-select-${cell?.refId ?? "unknown"}`,
    [cell?.refId],
  );
  const runnerSelectId = useMemo(
    () => `runner-select-${cell?.refId ?? "unknown"}`,
    [cell?.refId],
  );
  const kernelSelectId = useMemo(
    () => `kernel-select-${cell?.refId ?? "unknown"}`,
    [cell?.refId],
  );

  var initialRunnerName = cellData.getRunnerName();
  if (!initialRunnerName) {
    initialRunnerName = DEFAULT_RUNNER_PLACEHOLDER;
  }
  const isJavascriptLanguage = selectedLanguage === "javascript";
  const runnerSelectionName =
    selectedLanguage === "jupyter" && isAppKernelRunnerName(initialRunnerName)
      ? DEFAULT_RUNNER_PLACEHOLDER
      : initialRunnerName;
  const resolvedRunnerName =
    runnerSelectionName === DEFAULT_RUNNER_PLACEHOLDER
      ? (defaultRunnerName ?? "")
      : runnerSelectionName;
  const showRunnerSelector =
    selectedLanguage === "bash" ||
    selectedLanguage === "python" ||
    isJavascriptLanguage;
  const showKernelSelector = selectedLanguage === "jupyter";
  const runnerSelectValue =
    isJavascriptLanguage
      ? initialRunnerName === APPKERNEL_SANDBOX_RUNNER_NAME
        ? APPKERNEL_SANDBOX_RUNNER_NAME
        : APPKERNEL_RUNNER_NAME
      : isAppKernelRunnerName(initialRunnerName)
        ? DEFAULT_RUNNER_PLACEHOLDER
        : initialRunnerName;
  const hasJupyterSelection =
    Boolean(cell?.metadata?.[RunmeMetadataKey.JupyterServerName]) ||
    Boolean(cell?.metadata?.[RunmeMetadataKey.JupyterKernelID]) ||
    Boolean(cell?.metadata?.[RunmeMetadataKey.JupyterKernelName]);
  const availableRunnerNames = useMemo(
    () => listRunners().map((runner) => runner.name).filter((name) => !isAppKernelRunnerName(name)),
    [listRunners],
  );
  const jupyterRunnerNames = useMemo(() => {
    const names = new Set<string>();
    if (resolvedRunnerName) {
      names.add(resolvedRunnerName);
    }
    availableRunnerNames.forEach((name) => names.add(name));
    return [...names];
  }, [availableRunnerNames, resolvedRunnerName]);

  useEffect(() => {
    if (selectedLanguage !== "jupyter") {
      return;
    }
    if (jupyterRunnerNames.length === 0) {
      return;
    }
    void Promise.all(
      jupyterRunnerNames.map((runnerName) =>
        jupyterManager.ensureRunnerData(runnerName).catch((error) => {
          console.error("Failed to load Jupyter kernels for runner", {
            runner: runnerName,
            error,
          });
        }),
      ),
    );
  }, [jupyterManager, jupyterRunnerNames, resolvedRunnerName, selectedLanguage]);

  useEffect(() => {
    if (selectedLanguage === "javascript" && !isAppKernelRunnerName(initialRunnerName)) {
      cellData.setRunner(APPKERNEL_RUNNER_NAME);
      if (hasJupyterSelection) {
        cellData.clearJupyterKernel();
      }
      return;
    }
    if (selectedLanguage === "markdown") {
      if (initialRunnerName !== DEFAULT_RUNNER_PLACEHOLDER) {
        cellData.setRunner(DEFAULT_RUNNER_PLACEHOLDER);
      }
      if (hasJupyterSelection) {
        cellData.clearJupyterKernel();
      }
      return;
    }
    if (selectedLanguage === "jupyter" && isAppKernelRunnerName(initialRunnerName)) {
      cellData.setRunner(DEFAULT_RUNNER_PLACEHOLDER);
      if (hasJupyterSelection) {
        cellData.clearJupyterKernel();
      }
    }
  }, [cellData, hasJupyterSelection, initialRunnerName, selectedLanguage]);

  const kernelOptions = useMemo(() => {
    if (!showKernelSelector || jupyterRunnerNames.length === 0) {
      return [];
    }
    const deduped = new Map<string, ReturnType<typeof jupyterManager.getKernelOptionsForRunner>[number]>();
    jupyterRunnerNames.forEach((runnerName) => {
      try {
        const options = jupyterManager.getKernelOptionsForRunner(runnerName);
        options.forEach((option) => {
          deduped.set(option.key, option);
        });
      } catch (error) {
        console.error("Failed to build Jupyter kernel options for runner", {
          runner: runnerName,
          error,
        });
      }
    });
    return [...deduped.values()].sort(
      (a, b) =>
        a.label.localeCompare(b.label) ||
        a.runnerName.localeCompare(b.runnerName),
    );
  }, [jupyterManager, jupyterRunnerNames, jupyterVersion, showKernelSelector]);
  const selectedKernelKey = useMemo(() => {
    const serverName =
      (cell?.metadata?.[RunmeMetadataKey.JupyterServerName] as string | undefined) ?? "";
    const kernelID =
      (cell?.metadata?.[RunmeMetadataKey.JupyterKernelID] as string | undefined) ?? "";
    if (!serverName || !kernelID) {
      return "";
    }
    const runnerName =
      (cell?.metadata?.[RunmeMetadataKey.RunnerName] as string | undefined) ?? "";
    if (runnerName && !isAppKernelRunnerName(runnerName)) {
      return jupyterManager.getKernelOptionKey(serverName, kernelID, runnerName);
    }
    if (resolvedRunnerName) {
      return jupyterManager.getKernelOptionKey(serverName, kernelID, resolvedRunnerName);
    }
    return jupyterManager.getKernelOptionKey(serverName, kernelID);
  }, [cell, jupyterManager, resolvedRunnerName]);

  useEffect(() => {
    if (selectedLanguage !== "jupyter") {
      return;
    }
    if (selectedKernelKey) {
      return;
    }
    if (kernelOptions.length !== 1) {
      return;
    }
    const option = kernelOptions[0];
    const parsed = jupyterManager.parseKernelOptionKey(option.key);
    if (!parsed) {
      return;
    }
    cellData.setJupyterKernel({
      runnerName: option.runnerName,
      serverName: parsed.serverName,
      kernelId: parsed.kernelId,
      kernelName: option.label,
    });
  }, [
    cellData,
    jupyterManager,
    kernelOptions,
    selectedKernelKey,
    selectedLanguage,
  ]);

  const renderedOutputs = useMemo(() => {
    const hasTerminalOutput = (cell?.outputs ?? []).some((output) =>
      (output.items ?? []).some((item) => item.mime === MimeType.StatefulRunmeTerminal),
    );
    const hasActiveStream = Boolean(cellData.getStreams());
    if (!hasTerminalOutput && !hasActiveStream) {
      return null;
    }

    return (
      <CellConsole
        key={`console-${cell?.refId ?? "cell"}-${runID}`}
        cellData={cellData}
        onPid={setPid}
        onExitCode={handleExitCode}
      />
    );
  }, [cell, cellData, handleExitCode, runID]);

  const renderedOutputItems = useMemo(() => {
    if (!cell?.outputs || cell.outputs.length === 0) {
      return null;
    }
    return <ActionOutputItems outputs={cell.outputs} />;
  }, [cell?.outputs]);

  const handleLanguageChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      if (!cell) {
        return;
      }
      const nextValue = event.target
        .value as (typeof LANGUAGE_OPTIONS)[number]["value"];
      if (nextValue === selectedLanguage) {
        return;
      }

      const updatedCell = create(parser_pb.CellSchema, cell);
      updatedCell.metadata ??= {};
      if (nextValue === "markdown") {
        setMarkdownEditRequest((request) => request + 1);
        updatedCell.kind = parser_pb.CellKind.MARKUP;
        updatedCell.languageId = "markdown";
        delete updatedCell.metadata[RunmeMetadataKey.RunnerName];
        delete updatedCell.metadata[RunmeMetadataKey.JupyterServerName];
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelID];
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelName];
      } else if (nextValue === "jupyter") {
        updatedCell.kind = parser_pb.CellKind.CODE;
        updatedCell.languageId = "jupyter";
        delete updatedCell.metadata[RunmeMetadataKey.RunnerName];
        delete updatedCell.metadata[RunmeMetadataKey.JupyterServerName];
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelID];
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelName];
      } else if (nextValue === "javascript") {
        updatedCell.kind = parser_pb.CellKind.CODE;
        updatedCell.languageId = "javascript";
        updatedCell.metadata[RunmeMetadataKey.RunnerName] = APPKERNEL_RUNNER_NAME;
        delete updatedCell.metadata[RunmeMetadataKey.JupyterServerName];
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelID];
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelName];
      } else if (nextValue === "python") {
        updatedCell.kind = parser_pb.CellKind.CODE;
        updatedCell.languageId = "python";
        if (isAppKernelRunnerName(updatedCell.metadata[RunmeMetadataKey.RunnerName])) {
          delete updatedCell.metadata[RunmeMetadataKey.RunnerName];
        }
        delete updatedCell.metadata[RunmeMetadataKey.JupyterServerName];
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelID];
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelName];
      } else {
        updatedCell.kind = parser_pb.CellKind.CODE;
        updatedCell.languageId = "bash";
        if (isAppKernelRunnerName(updatedCell.metadata[RunmeMetadataKey.RunnerName])) {
          delete updatedCell.metadata[RunmeMetadataKey.RunnerName];
        }
        delete updatedCell.metadata[RunmeMetadataKey.JupyterServerName];
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelID];
        delete updatedCell.metadata[RunmeMetadataKey.JupyterKernelName];
      }

      updateCellLocal(updatedCell);
      setPid(null);
      setExitCode(null);
    },
    [cell, selectedLanguage, updateCellLocal],
  );

  // Determine if this cell is a markdown cell (either MARKUP kind or CODE with markdown language)
  const isMarkdownCell = useMemo(() => {
    if (!cell) return false;
    // Check if cell kind is MARKUP
    if (cell.kind === parser_pb.CellKind.MARKUP) return true;
    // Check if cell is CODE but with markdown language
    const lang = (cell.languageId ?? "").toLowerCase();
    return lang === "markdown" || lang === "md";
  }, [cell]);

  if (!cell) {
    return null;
  }

  // Render markdown cells with in-place rendering (Jupyter-style)
  // No run button, no output area - just the markdown rendered in-place
  if (isMarkdownCell) {
    return (
      <div
        id={`markdown-action-${cell.refId}`}
        className="group/cell relative flex min-w-0"
        onContextMenu={handleContextMenu}
        data-testid="markdown-action"
      >
        {/* Left gutter: top + bottom add-cell buttons */}
        <div id={`markdown-gutter-${cell.refId}`} className="flex w-7 shrink-0 flex-col items-center justify-between py-1">
          <button
            type="button"
            aria-label="Add cell above"
            className="cell-add-btn h-5 w-5"
            onClick={handleAddCodeCellBefore}
          >
            <PlusIcon width={10} height={10} />
          </button>
          <button
            type="button"
            aria-label="Add cell below"
            className="cell-add-btn h-5 w-5"
            onClick={handleAddCodeCellAfter}
          >
            <PlusIcon width={10} height={10} />
          </button>
        </div>
        {/* Cell content */}
        <div className="min-w-0 flex-1">
          <div className="relative w-full min-w-0 max-w-full overflow-hidden">
            <MarkdownCell
              cellData={cellData}
              selectedLanguage={selectedLanguage}
              languageSelectId={languageSelectId}
              languageOptions={LANGUAGE_OPTIONS}
              onLanguageChange={handleLanguageChange}
              forceEditRequest={markdownEditRequest}
            />
            {/* Trash icon on the right, visible on hover */}
            <button
              type="button"
              aria-label="Delete cell"
              className="icon-btn absolute right-2 top-2 h-6 w-6 opacity-0 transition-opacity duration-150 group-hover/cell:opacity-100"
              onClick={handleRemoveCell}
            >
              <TrashIcon />
            </button>
          </div>
        </div>
        {adjustedContextMenu && (
          <div
            className="ctx-menu"
            style={{
              top: adjustedContextMenu.y,
              left: adjustedContextMenu.x,
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            {shareRemoteUri && (
              <button
                type="button"
                className="ctx-menu-item"
                onClick={(event) => {
                  event.stopPropagation();
                  void handleCopyShareLink();
                }}
              >
                Copy Share Link
              </button>
            )}
            <button
              type="button"
              className="ctx-menu-item text-red-600"
              onClick={(event) => {
                event.stopPropagation();
                handleRemoveCell();
              }}
            >
              Remove Cell
            </button>
          </div>
        )}
      </div>
    );
  }

  // Render code cells as a unified Marimo-style card: editor + toolbar + output
  // are all inside one bordered container with a distinctive "paper" shadow.
  // The outer wrapper is a flex row: left gutter (add-cell buttons) + cell card.
  return (
    <div
      id={`code-action-${cell.refId}`}
      className="group/cell relative flex"
      onContextMenu={handleContextMenu}
      data-testid="code-action"
    >
      {/* Left gutter: top + bottom add-cell buttons */}
      <div id={`code-gutter-${cell.refId}`} className="flex w-7 shrink-0 flex-col items-center justify-between py-1">
        <button
          type="button"
          aria-label="Add cell above"
          className="cell-add-btn h-5 w-5"
          onClick={handleAddCodeCellBefore}
        >
          <PlusIcon width={10} height={10} />
        </button>
        <button
          type="button"
          aria-label="Add cell below"
          className="cell-add-btn h-5 w-5"
          onClick={handleAddCodeCellAfter}
        >
          <PlusIcon width={10} height={10} />
        </button>
      </div>

      {/* Cell card: editor + toolbar + output */}
      <div className="min-w-0 flex-1">
        <div
          id={`cell-card-${cell.refId}`}
          className="cell-card"
        >
          {/* Code editor section — overflow-hidden keeps border-radius clipping on the editor */}
          <div className="overflow-hidden rounded-t-nb-md">
            <Editor
              key={`editor-${cell.refId}-${selectedLanguage}`}
              id={cell.refId}
              value={cell.value}
              language={editorLanguage}
              fontSize={fontSettings.fontSize}
              fontFamily={fontSettings.fontFamily}
              onChange={(v) => {
                const updated = create(parser_pb.CellSchema, cell);
                updated.value = v;
                updateCellLocal(updated);
              }}
              onEnter={runCode}
            />
          </div>

          {/* Minimal toolbar: language + runner selectors + run/trash buttons */}
          <div
            id={`cell-toolbar-${cell.refId}`}
            className="cell-toolbar"
          >
            <div className="flex items-center gap-3">
              <select
                id={languageSelectId}
                value={selectedLanguage}
                onChange={handleLanguageChange}
                className="toolbar-select"
              >
                {LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {showRunnerSelector && (
                <select
                  id={runnerSelectId}
                  value={runnerSelectValue}
                  onChange={(event) => {
                    const nextName = event.target.value;
                    if (isJavascriptLanguage) {
                      const validJsRunner = JAVASCRIPT_RUNNER_OPTIONS.some(
                        (option) => option.value === nextName,
                      );
                      if (!validJsRunner) {
                        return;
                      }
                      cellData.setRunner(nextName);
                      return;
                    }
                    const names = new Set(listRunners().map((r) => r.name));
                    if (
                      !names.has(nextName) &&
                      nextName !== DEFAULT_RUNNER_PLACEHOLDER
                    ) {
                      return;
                    }
                    cellData.setRunner(nextName);
                  }}
                  className="toolbar-select"
                >
                  {isJavascriptLanguage ? (
                    JAVASCRIPT_RUNNER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value={DEFAULT_RUNNER_PLACEHOLDER}>
                        {defaultRunnerName ? `${defaultRunnerName}` : "default"}
                      </option>
                      {listRunners()
                        .filter((runner) => !isAppKernelRunnerName(runner.name))
                        .map((runner) => (
                          <option key={runner.name} value={runner.name}>
                            {runner.name}
                          </option>
                        ))}
                    </>
                  )}
                </select>
              )}
              {showKernelSelector && (
                <select
                  id={kernelSelectId}
                  value={selectedKernelKey}
                  onChange={(event) => {
                    const nextKey = event.target.value;
                    if (!nextKey) {
                      cellData.clearJupyterKernel();
                      return;
                    }
                    const parsed = jupyterManager.parseKernelOptionKey(nextKey);
                    if (!parsed) {
                      return;
                    }
                    const option = kernelOptions.find((item) => item.key === nextKey);
                    if (!option) {
                      return;
                    }
                    cellData.setJupyterKernel({
                      runnerName: option.runnerName,
                      serverName: parsed.serverName,
                      kernelId: parsed.kernelId,
                      kernelName: option.label,
                    });
                  }}
                  className="toolbar-select"
                >
                  <option value="">Select kernel</option>
                  {kernelOptions.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
              {sequenceLabel.trim() && (
                <span className="text-[11px] font-mono text-nb-text-faint">
                  [{sequenceLabel}]
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <RunActionButton pid={pid} onClick={runCode} />
              <button
                type="button"
                aria-label="Delete cell"
                className="icon-btn h-7 w-7 opacity-0 transition-opacity duration-150 group-hover/cell:opacity-100"
                onClick={handleRemoveCell}
              >
                <TrashIcon />
              </button>
            </div>
          </div>

          {/* Output section: separated by a thin divider, inside the same card.
              max-h + overflow-auto gives a vertical scrollbar when output is tall. */}
          {(renderedOutputs || renderedOutputItems) && (
            <div id={`cell-output-${cell.refId}`}>
              <div className="border-t border-nb-tray-border" />
              <div className="overflow-auto p-[14.4px]" style={{ maxHeight: 'var(--nb-cell-output-max-h)' }}>
                {renderedOutputs}
                {renderedOutputItems}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Context menu */}
      {adjustedContextMenu && (
        <div
          className="ctx-menu"
          style={{
            top: adjustedContextMenu.y,
            left: adjustedContextMenu.x,
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {shareRemoteUri && (
            <button
              type="button"
              className="ctx-menu-item"
              onClick={(event) => {
                event.stopPropagation();
                void handleCopyShareLink();
              }}
            >
              Copy Share Link
            </button>
          )}
          <button
            type="button"
            className="ctx-menu-item text-red-600"
            onClick={(event) => {
              event.stopPropagation();
              handleRemoveCell();
            }}
          >
            Remove Cell
          </button>
        </div>
      )}
    </div>
  );
}

function NotebookTabContent({ docUri }: { docUri: string }) {
  const { getNotebookData, useNotebookSnapshot } = useNotebookContext();
  const notebookSnapshot = useNotebookSnapshot(docUri);
  const cellDatas = useMemo(() => {
    if (!notebookSnapshot) {
      return [];
    }
    const data = getNotebookData(notebookSnapshot.uri);
    if (!data) {
      return [];
    }
    return (notebookSnapshot.notebook.cells ?? [])
      .map((c) => (c?.refId ? data.getCell(c.refId) : null))
      .filter((c): c is CellData => Boolean(c));
  }, [getNotebookData, notebookSnapshot]);

  if (!notebookSnapshot || !notebookSnapshot.loaded) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-nb-text-muted">
        <span>Loading…</span>
      </div>
    );
  }

  const data = getNotebookData(notebookSnapshot.uri);

  return (
    <ScrollArea
      key={`scroll-${docUri}`}
      type="auto"
      scrollbars="vertical"
      className="flex-1 h-full min-w-0 max-w-full overflow-x-hidden"
      data-document-id={docUri}
    >
      {/* Full-width notebook column with horizontal padding for breathing room.
          Cells expand to fill the available width of the tab content area. */}
      <div id="notebook-column" className="w-full py-2 px-8">
        {cellDatas.length === 0 ? (
          <div id="empty-notebook-prompt" className="flex flex-col items-center justify-center gap-3 py-16 text-sm text-nb-text-muted">
            <p>This notebook has no cells yet.</p>
            <button
              type="button"
              className="cell-add-btn h-8 w-8"
              aria-label="Add first cell"
              onClick={() => data?.appendMarkupCell()}
            >
              <PlusIcon className="h-5 w-5" />
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {cellDatas.map((cellData, index) => {
              const refId = cellData.snapshot?.refId ?? `cell-${index}`;
              return (
                <Action
                  key={`action-${refId}`}
                  cellData={cellData}
                  docUri={docUri}
                  isFirst={index === 0}
                />
              );
            })}
            {/* Add cell button at the bottom of the notebook */}
            <div className="flex justify-center py-3">
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-full border border-nb-border-strong bg-white px-3 py-1 text-xs text-nb-text-muted transition-colors duration-150 hover:border-nb-accent hover:text-nb-accent hover:bg-nb-accent-muted"
                aria-label="Add cell at end"
                onClick={() => data?.appendCodeCell()}
              >
                <PlusIcon width={10} height={10} />
                <span>Add cell</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

export default function Actions() {
  const { useNotebookList, removeNotebook } = useNotebookContext();
  const { store } = useNotebookStore();
  const openNotebooks = useNotebookList();
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc();
  const currentDocUri = getCurrentDoc();
  const driveLinkSnapshot = useDriveLinkCoordinatorSnapshot();
  const statusTabVisible =
    driveLinkSnapshot.intents.length > 0 ||
    Boolean(driveLinkSnapshot.lastErrorMessage);
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(() => new Set());
  const [selectedTabUri, setSelectedTabUri] = useState<string | null>(null);
  // Empty-state hint visibility is stored locally so the hint panel can be
  // revealed on demand without cluttering the default view.
  const [showConsoleHints, setShowConsoleHints] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<{
    x: number;
    y: number;
    docUri: string;
    shareableUri: string;
    googleDriveUri: string | null;
  } | null>(null);
  const { runName } = useParams<{ runName?: string }>();
  //const { data: run } = useRun(runName);
  const [cellsInitialized, setCellsInitialized] = useState(false);

  // useEffect(() => {
  //   if (cellsInitialized) {
  //     return;
  //   }
  //   if (run) {
  //     const fallbackName = run?.name ?? runName ?? "Run Notebook";
  //     const targetUri =
  //       currentDocUri ??
  //       (runName ? `run:${runName}` : "run-notebook");
  //     const notebook = create(parser_pb.NotebookSchema, {
  //       cells: run.notebook?.cells ?? [],
  //       metadata: run.notebook?.metadata ?? {},
  //     });
  //     const data = ensureNotebook({
  //       uri: targetUri,
  //       name: fallbackName,
  //       notebook,
  //     });
  //     data.loadNotebook(notebook);
  //     data.setName(fallbackName);
  //     console.log("useEffect is calling setCurrentDoc because run is true", targetUri);
  //     setCurrentDoc(targetUri);
  //     setCellsInitialized(true);
  //   }
  // }, [cellsInitialized, currentDocUri, ensureNotebook, run, runName, setCurrentDoc]);

  const { registerRenderer, unregisterRenderer } = useOutput();

  // Ensure the active tab is tracked as mounted on first render/whenever it changes.
  useEffect(() => {
    if (!currentDocUri) {
      return;
    }
    setMountedTabs((prev) => {
      if (prev.has(currentDocUri)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(currentDocUri);
      return next;
    });
    setSelectedTabUri((prev) =>
      prev === DRIVE_LINK_STATUS_TAB_URI ? prev : currentDocUri,
    );
  }, [currentDocUri]);

  useEffect(() => {
    if (statusTabVisible && !currentDocUri) {
      setSelectedTabUri((prev) => prev ?? DRIVE_LINK_STATUS_TAB_URI);
      return;
    }

    if (!statusTabVisible && selectedTabUri === DRIVE_LINK_STATUS_TAB_URI) {
      setSelectedTabUri(currentDocUri ?? openNotebooks[0]?.uri ?? null);
    }
  }, [currentDocUri, openNotebooks, selectedTabUri, statusTabVisible]);

  // TODO(jlewi): Does it still make sense to have a registration pattern for renderers? What does that buy us over
  // just hardcoding an "if" statement when rendering the outputs. Is that a legacy of the vscode extension where
  // renderers could be registered via extensions for different mimetypes?
  // Register renderers for code cells
  useEffect(() => {
    registerRenderer(MimeType.StatefulRunmeTerminal, {
      onCellUpdate: () => {},
      component: ({
        cell,
        cellData,
        onPid,
        onExitCode,
      }: {
        cell: parser_pb.Cell;
        cellData: CellData;
        onPid: (pid: number | null) => void;
        onExitCode: (exitCode: number | null) => void;
      }) => {
        return (
          // TODO(jlewi): Why do we pass cell which is parser_pb.Cell? Rather than CellData?
          <CellConsole
            key={`console-${cell.refId}`}
            cellData={cellData}
            onPid={onPid}
            onExitCode={onExitCode}
          />
        );
      },
    });

    return () => {
      unregisterRenderer(MimeType.StatefulRunmeTerminal);
    };
  }, [registerRenderer, unregisterRenderer]);

  const handleCloseTab = useCallback(
    (uri: string) => {
      const next = removeNotebook(uri);
      if (uri === currentDocUri) {
        console.log("handleCloseTab Switching current doc to", next);
        setCurrentDoc(next ?? null);
      }
    },
    [currentDocUri, removeNotebook, setCurrentDoc],
  );

  useEffect(() => {
    if (!tabContextMenu) {
      return;
    }
    const handleClick = () => setTabContextMenu(null);
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTabContextMenu(null);
      }
    };
    window.addEventListener("click", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("click", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [tabContextMenu]);

  const adjustedTabContextMenu = useMemo(() => {
    if (!tabContextMenu) {
      return null;
    }
    if (typeof window === "undefined") {
      return tabContextMenu;
    }
    const itemCount = tabContextMenu.googleDriveUri ? 3 : 2;
    const menuWidth = 220;
    const menuHeight = itemCount * 36 + 8;
    return {
      ...tabContextMenu,
      x: Math.max(0, Math.min(tabContextMenu.x, window.innerWidth - menuWidth)),
      y: Math.max(
        0,
        Math.min(tabContextMenu.y, window.innerHeight - menuHeight),
      ),
    };
  }, [tabContextMenu]);

  const handleTabContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, docUri: string) => {
      event.preventDefault();
      event.stopPropagation();
      setTabContextMenu({
        x: event.clientX,
        y: event.clientY,
        docUri,
        shareableUri: docUri,
        googleDriveUri: isGoogleDriveFileUri(docUri) ? docUri : null,
      });

      if (!store || !docUri.startsWith("local://")) {
        return;
      }

      void (async () => {
        try {
          const metadata = await store.getMetadata(docUri);
          const remoteUri = metadata?.remoteUri?.trim() || null;
          setTabContextMenu((current) => {
            if (!current || current.docUri !== docUri) {
              return current;
            }
            return {
              ...current,
              shareableUri: remoteUri ?? docUri,
              googleDriveUri: isGoogleDriveFileUri(remoteUri) ? remoteUri : current.googleDriveUri,
            };
          });
        } catch (error) {
          appLogger.error("Failed to resolve tab metadata for context menu", {
            attrs: {
              scope: "storage.metadata",
              code: "TAB_CONTEXT_METADATA_LOOKUP_FAILED",
              docUri,
              error: String(error),
            },
          });
        }
      })();
    },
    [store],
  );

  const handleCopyTabShareableLink = useCallback(async () => {
    if (!tabContextMenu) {
      return;
    }
    try {
      await copyNotebookShareUrl(tabContextMenu.shareableUri);
    } catch (error) {
      appLogger.error("Failed to copy shareable link from tab context menu", {
        attrs: {
          scope: "storage.share",
          code: "TAB_COPY_SHAREABLE_LINK_FAILED",
          uri: tabContextMenu.shareableUri,
          error: String(error),
        },
      });
    } finally {
      setTabContextMenu(null);
    }
  }, [tabContextMenu]);

  const handleCopyTabLocalUri = useCallback(async () => {
    if (!tabContextMenu) {
      return;
    }
    try {
      if (typeof window === "undefined" || !window.navigator?.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable in this browser");
      }
      await window.navigator.clipboard.writeText(tabContextMenu.docUri);
    } catch (error) {
      appLogger.error("Failed to copy local URI from tab context menu", {
        attrs: {
          scope: "storage.local",
          code: "TAB_COPY_LOCAL_URI_FAILED",
          uri: tabContextMenu.docUri,
          error: String(error),
        },
      });
    } finally {
      setTabContextMenu(null);
    }
  }, [tabContextMenu]);

  const handleCopyTabGoogleDriveLink = useCallback(async () => {
    if (!tabContextMenu?.googleDriveUri) {
      setTabContextMenu(null);
      return;
    }
    try {
      if (typeof window === "undefined" || !window.navigator?.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable in this browser");
      }
      await window.navigator.clipboard.writeText(tabContextMenu.googleDriveUri);
    } catch (error) {
      appLogger.error("Failed to copy Google Drive link from tab context menu", {
        attrs: {
          scope: "storage.drive",
          code: "TAB_COPY_GOOGLE_DRIVE_LINK_FAILED",
          uri: tabContextMenu.googleDriveUri,
          error: String(error),
        },
      });
    } finally {
      setTabContextMenu(null);
    }
  }, [tabContextMenu]);

  // Each document gets its own scroll container keyed by URI so the browser
  // does not reuse the previous document's scroll position.

  return (
    <div id="documents" className="flex flex-col h-full">
      {openNotebooks.length === 0 && !statusTabVisible ? (
        <ScrollArea
          type="auto"
          scrollbars="vertical"
          className="flex-1 p-4"
          data-testid="actions-empty-scroll"
        >
          <div
            id="actions-empty-state"
            className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-6 text-center text-sm text-nb-text-muted"
          >
            <div id="actions-empty-header" className="space-y-2">
              <Text size="5" weight="bold" as="p" className="text-nb-text">
                No open notebooks yet
              </Text>
              <Text size="2" as="p" className="text-nb-text-muted">
                Use the button below to reveal console commands for mounting
                folders or attaching files programmatically.
              </Text>
            </div>

            <div id="actions-empty-hints" className="flex flex-col items-center">
              <Button
                id="actions-empty-hints-toggle"
                variant="soft"
                onClick={() => setShowConsoleHints((prev) => !prev)}
              >
                {showConsoleHints
                  ? "Hide Console Commands"
                  : "Show Console Commands"}
              </Button>
            </div>

            {showConsoleHints && (
              <div
                id="actions-empty-quickstart"
                className="w-full rounded-lg border border-nb-border bg-nb-surface-2 p-4 text-left"
              >
                <Text size="3" weight="bold" as="p" className="text-nb-text">
                  Quick Start Console Commands
                </Text>
                <Text size="2" as="p" className="mt-1 text-nb-text-muted">
                  These commands are available in the app console and map to the
                  Explorer helpers. The File System Access API requires a picker
                  gesture, so addFolder/openPicker always prompt for a folder.
                </Text>
                {/* Console snippets mirror AppConsole helpers so users can copy/paste. */}
                <pre
                  id="actions-empty-quickstart-code"
                  className="quickstart-console-code mt-3 whitespace-pre-wrap rounded-md bg-gray-900 p-3 text-xs text-gray-100 select-text cursor-text"
                  style={{
                    userSelect: "text",
                    WebkitUserSelect: "text",
                  }}
                >
                  explorer.addFolder(){"\n"}
                  explorer.mountDrive(driveUrl){"\n"}
                  explorer.openPicker(){"\n"}
                  explorer.listFolders(){"\n"}
                  runme.getCurrentNotebook(){"\n"}
                  runme.clear(){"\n"}
                  runme.runAll(){"\n"}
                  runme.rerun(){"\n"}
                  help(){"\n\n"}
                  To attach test notebooks: use the Explorer + button to pick the fixtures folder
                  {"\n"}
                  To mount a local file: use the Explorer + button or explorer.openPicker()
                </pre>
              </div>
            )}
          </div>
        </ScrollArea>
      ) : (
        <Tabs.Root
          value={
            selectedTabUri ??
            currentDocUri ??
            (statusTabVisible
              ? DRIVE_LINK_STATUS_TAB_URI
              : openNotebooks[0]?.uri ?? "")
          }
          onValueChange={(nextUri) => {
            setSelectedTabUri(nextUri);
            if (nextUri === DRIVE_LINK_STATUS_TAB_URI) {
              return;
            }
            if (nextUri !== currentDocUri) {
              setMountedTabs((prev) => {
                if (prev.has(nextUri)) {
                  return prev;
                }
                const next = new Set(prev);
                next.add(nextUri);
                return next;
              });
              setCurrentDoc(nextUri);
            }
          }}
          className="flex flex-col flex-1 min-h-0 overflow-hidden bg-white"
        >
          <Tabs.List className="flex items-center gap-0.5 border-b border-nb-border bg-nb-surface-2 px-2 py-1">
          {statusTabVisible && (
            <div
              key={`tab-${DRIVE_LINK_STATUS_TAB_URI}`}
              className="flex items-center gap-1"
            >
              <Tabs.Trigger
                value={DRIVE_LINK_STATUS_TAB_URI}
                title="Drive Link Status"
                className="group flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-nb-sm transition-all duration-150 text-nb-text-muted border border-transparent data-[state=active]:bg-nb-surface data-[state=active]:text-nb-text data-[state=active]:border-nb-border data-[state=active]:shadow-nb-xs data-[state=inactive]:hover:bg-nb-surface/60 data-[state=inactive]:hover:text-nb-text focus:outline-none"
              >
                <span className="truncate max-w-[180px]">Drive Link Status</span>
              </Tabs.Trigger>
            </div>
          )}
          {openNotebooks.map((doc) => {
            const displayName =
              doc.name ||
              doc.uri.split("/").filter(Boolean).pop() ||
              "This is a bug; this should not happen";
            return (
              <div key={`tab-${doc.uri}`} className="flex items-center gap-1">
                <Tabs.Trigger
                  value={doc.uri}
                  title={doc.name}
                  onContextMenu={(event) => handleTabContextMenu(event, doc.uri)}
                  className="group flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-nb-sm transition-all duration-150 text-nb-text-muted border border-transparent data-[state=active]:bg-nb-surface data-[state=active]:text-nb-text data-[state=active]:border-nb-border data-[state=active]:shadow-nb-xs data-[state=inactive]:hover:bg-nb-surface/60 data-[state=inactive]:hover:text-nb-text focus:outline-none"
                >
                  <span className="truncate max-w-[140px]">{displayName}</span>
                </Tabs.Trigger>
                <NotebookSyncIndicator docUri={doc.uri} />
                <button
                  type="button"
                  className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-nb-xs text-nb-text-faint transition-all duration-150 hover:text-nb-text hover:bg-nb-surface-2"
                  aria-label={`Close ${displayName}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleCloseTab(doc.uri);
                  }}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <XMarkIcon className="h-3 w-3" />
                </button>
              </div>
              );
            })}
          </Tabs.List>
          {adjustedTabContextMenu && (
            <div
              className="ctx-menu"
              style={{
                top: adjustedTabContextMenu.y,
                left: adjustedTabContextMenu.x,
              }}
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                type="button"
                className="ctx-menu-item"
                onClick={(event) => {
                  event.stopPropagation();
                  void handleCopyTabShareableLink();
                }}
              >
                Copy Shareable Link
              </button>
              <button
                type="button"
                className="ctx-menu-item"
                onClick={(event) => {
                  event.stopPropagation();
                  void handleCopyTabLocalUri();
                }}
              >
                Copy local URI
              </button>
              {adjustedTabContextMenu.googleDriveUri && (
                <button
                  type="button"
                  className="ctx-menu-item"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleCopyTabGoogleDriveLink();
                  }}
                >
                  Copy Google Drive Link
                </button>
              )}
            </div>
          )}
          <div className="relative flex-1 min-h-0 overflow-hidden">
          {statusTabVisible && (
            <Tabs.Content
              key={`content-${DRIVE_LINK_STATUS_TAB_URI}`}
              value={DRIVE_LINK_STATUS_TAB_URI}
              forceMount
              asChild
            >
              <TabPanel className="flex-1 min-h-0">
                <DriveLinkStatusTab
                  onLogin={() => driveLinkCoordinator.loginToDriveAndProcess()}
                  onRetry={() => driveLinkCoordinator.retryAuthAndProcess()}
                />
              </TabPanel>
            </Tabs.Content>
          )}
          {openNotebooks.map((doc) => (
            <Tabs.Content
              key={`content-${doc.uri}`}
              value={doc.uri}
              forceMount
              asChild
            >
              <TabPanel className="flex-1 min-h-0" data-document-id={doc.uri}>
                <NotebookTabContent docUri={doc.uri} />
              </TabPanel>
            </Tabs.Content>
          ))}
          </div>
        </Tabs.Root>
      )}
    </div>
  );
}
