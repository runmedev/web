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
import { Box, Button, Card, ScrollArea, Tabs, Text } from "@radix-ui/themes";
import { useParams } from "react-router-dom";

import { Cross2Icon } from "@radix-ui/react-icons";
import {
  MimeType,
  RunmeMetadataKey,
  parser_pb,
} from "../../runme/client";;
import { CellData } from "../../lib/notebookData";
import { useNotebookContext } from "../../contexts/NotebookContext";
import { useOutput } from "../../contexts/OutputContext";
import CellConsole, { fontSettings } from "./CellConsole";
import WebContainerConsole from "./WebContainer";
import Editor from "./Editor";
import MarkdownCell from "./MarkdownCell";
import { IOPUB_INCOMPLETE_METADATA_KEY } from "../../lib/ipykernel";
import {
  ErrorIcon,
  PlayIcon,
  PlusIcon,
  SpinnerIcon,
  SuccessIcon,
} from "./icons";
//import { useRun } from "../../lib/useRun.js";
import { useCurrentDoc } from "../../contexts/CurrentDocContext";
import { useRunners } from "../../contexts/RunnersContext";
import { DEFAULT_RUNNER_PLACEHOLDER } from "../../lib/runtime/runnersManager";
import React from "react";

type TabPanelProps = React.HTMLAttributes<HTMLDivElement> & {
  "data-state"?: "active" | "inactive";
  hidden?: boolean;
};

const TabPanel = React.forwardRef<HTMLDivElement, TabPanelProps>(
  ({ hidden: _hiddenProp, "data-state": state, style, ...rest }, ref) => {
    const inactive = state === "inactive";
    return (
      <div
        ref={ref}
        data-state={state}
        style={{
          ...style,
          visibility: inactive ? "hidden" : "visible",
          position: inactive ? "absolute" : "relative",
          inset: inactive ? 0 : undefined,
          pointerEvents: inactive ? "none" : "auto",
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

function RunActionButton({
  pid,
  exitCode,
  onClick,
}: {
  pid: number | null;
  exitCode: number | null;
  onClick: () => void;
}) {
  const getButtonLabel = () => {
    if (exitCode === null && pid === null) {
      return "Run code";
    }
    if (exitCode === null && pid !== null) {
      return "Running...";
    }
    if (exitCode !== null && exitCode === 0) {
      return "Execution successful";
    }
    if (exitCode !== null && exitCode > 0) {
      return `Execution failed with exit code ${exitCode}`;
    }
    return "Run code";
  };

  return (
    <Button variant="soft" onClick={onClick} aria-label={getButtonLabel()}>
      {exitCode === null && pid === null && <PlayIcon />}
      {exitCode === null && pid !== null && (
        <div className="animate-spin">
          <SpinnerIcon />
        </div>
      )}
      {exitCode !== null && exitCode === 0 && <SuccessIcon />}
      {exitCode !== null && exitCode > 0 && <ErrorIcon exitCode={exitCode} />}
    </Button>
  );
}

// Action is an editor and an optional Runme console
const LANGUAGE_OPTIONS = [
  { label: "Markdown", value: "markdown" },
  { label: "Bash", value: "bash" },
  { label: "Python", value: "python" },
  { label: "JS", value: "javascript" },
] as const;

type SupportedLanguage = "bash" | "javascript" | "markdown" | "python";

const outputTextDecoder = new TextDecoder();
const OUTPUT_SKIP_MIMES = new Set<string>([
  MimeType.StatefulRunmeTerminal,
  MimeType.VSCodeNotebookStdOut,
  MimeType.VSCodeNotebookStdErr,
]);

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
        className="h-[420px] w-full rounded-md border border-gray-200 bg-white"
      />
    );
  } else if (mime === "image/png") {
    const base64 = uint8ArrayToBase64(item.data ?? new Uint8Array());
    const src = `data:${mime};base64,${base64}`;
    content = (
      <img
        alt={`Cell output ${outputIndex}-${itemIndex}`}
        src={src}
        className="max-h-[480px] w-full rounded-md border border-gray-200 bg-white object-contain"
      />
    );
  } else {
    content = (
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-gray-900">
        {text}
      </pre>
    );
  }

  return (
    <div
      className="rounded-md border border-gray-200 bg-gray-50 p-2"
      data-testid="cell-output-item"
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-600">
        Output {outputIndex} / Item {itemIndex} - mime={mime}
        {hasIopubMetadata ? (isStreaming ? " (streaming)" : " (complete)") : ""}
      </div>
      <div className="mt-2">{content}</div>
    </div>
  );
}

function ActionOutputItems({ outputs }: { outputs: parser_pb.CellOutput[] }) {
  const displayableItems = outputs.flatMap((output, outputIndex) =>
    (output.items ?? [])
      .map((item, itemIndex) => {
        if (!item || OUTPUT_SKIP_MIMES.has(item.mime || "")) {
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

export function Action({ cellData, isFirst }: { cellData: CellData; isFirst: boolean }) {
  const { getAllRenderers } = useOutput();
  const { listRunners, defaultRunnerName } = useRunners();
  const cell = useSyncExternalStore(
    useCallback(
      (listener) => cellData.subscribeToContentChange(listener),
      [cellData],
    ),
    useCallback(() => cellData.snapshot, [cellData]),
    useCallback(() => cellData.snapshot, [cellData]),
  );
  const [runID, setRunID] = useState(cellData.getRunID());

  useEffect(() => {
    const unsubscribe = cellData.subscribeToRunIDChange((next) => {
      console.log("Action detected runID change", { next });
      setRunID(next);
    });
    return () => unsubscribe();
  }, [cellData]);

  const handleAddCodeCellBefore = useCallback(() => {
    cellData.addBefore(cell?.languageId);
  }, [cell?.languageId, cellData]);

  const handleAddCodeCellAfter = useCallback(() => {
    cellData.addAfter(cell?.languageId);
  }, [cell?.languageId, cellData]);

  const updateCellLocal = useCallback(
    (nextCell: parser_pb.Cell) => {
      // Ensure any renderer-specific initialization (e.g., seeding terminal output) runs.
      const renderers = getAllRenderers();
      for (const renderer of renderers.values()) {
        renderer.onCellUpdate(nextCell);
      }
      cellData.update(nextCell);
    },
    [cellData, getAllRenderers],
  );

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [pid, setPid] = useState<number | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);

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
    const menuHeight = 48;
    const left = Math.max(
      0,
      Math.min(contextMenu.x, window.innerWidth - menuWidth),
    );
    const top = Math.max(
      0,
      Math.min(contextMenu.y, window.innerHeight - menuHeight),
    );
    return { x: left, y: top };
  }, [contextMenu]);

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

  var initialRunnerName = cellData.getRunnerName();
  if (!initialRunnerName) {
    initialRunnerName = DEFAULT_RUNNER_PLACEHOLDER;
  }

  const renderedOutputs = useMemo(() => {
    const languageId = cell?.languageId?.toLowerCase();
    const isObservable = languageId === "observable" || languageId === "d3";
    const isJavaScript =
      languageId === "javascript" ||
      languageId === "typescript" ||
      languageId === "js" ||
      languageId === "ts";
    const isPython = languageId === "python" || languageId === "py";

    if (!isPython && (isObservable || isJavaScript)) {
      return (
        <WebContainerConsole
          key={`webcontainer-${cell.refId}`}
          cell={cell}
          onPid={setPid}
          onExitCode={setExitCode}
        />
      );
    }

    // For non-JS/Observable cells, prefer renderer-backed outputs. If none
    // exist (fresh cell), fall back to the terminal console so the user sees
    // an output area immediately.
    // const rendered = cellData.snapshot?.outputs
    //   .flatMap((o) =>
    //     (o.items ?? []).map((oi) => {
    //       const renderer = getRenderer(oi.mime);
    //       if (!renderer) {
    //         return null;
    //       }
    //       const Component = renderer.component;
    //       return (
    //         <Component
    //           key={`${oi.mime}-${cell.refId}`}
    //           cell={cell}
    //           cellData={cellData}
    //           onPid={setPid}
    //           onExitCode={setExitCode}
    //           {...renderer.props}
    //         />
    //       );
    //     }),
    //   )
    //   .filter(Boolean);

    // if (rendered && rendered.length > 0) {
    //   return rendered;
    // }

    if (!runID && (cell?.outputs?.length ?? 0) === 0) {
      return null;
    }

    console.log("Rendering CellConsole", { runID });

    return (
      <CellConsole
        key={`console-${cell?.refId ?? "cell"}-${runID}`}
        cellData={cellData}
        onPid={setPid}
        onExitCode={setExitCode}
      />
    );
  }, [cell, cellData, runID]);

  const renderedOutputItems = useMemo(() => {
    if (!cell?.outputs || cell.outputs.length === 0) {
      return null;
    }
    return <ActionOutputItems outputs={cell.outputs} />;
  }, [cell?.outputs]);

  const handleLanguageChange = useCallback(    
    (event: ChangeEvent<HTMLSelectElement>) => {
      console.log("handleLanguageChange", { value: event.target.value });      
      if (!cell) {
        return;
      }
      const nextValue = event.target
        .value as (typeof LANGUAGE_OPTIONS)[number]["value"];
      if (nextValue === selectedLanguage) {
        return;
      }

      const updatedCell = create(parser_pb.CellSchema, cell);
      if (nextValue === "markdown") {
        updatedCell.languageId = "markdown";
      } else if (nextValue === "javascript") {
        updatedCell.languageId = "javascript";
      } else if (nextValue === "python") {
        updatedCell.languageId = "python";
      } else {
        updatedCell.languageId = "bash";
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
        className="relative py-2 flex flex-col gap-2 min-w-0"
        onContextMenu={handleContextMenu}
        data-testid="markdown-action"
      >
        {!isFirst && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center">
            <div className="pointer-events-auto flex h-8 w-8 -translate-y-1/2 items-center justify-center">
              <button
                type="button"
                aria-label="Add cell above"
                className="flex h-6 w-6 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-600 shadow-sm transition-colors hover:border-gray-400 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                onClick={handleAddCodeCellBefore}
              >
                <PlusIcon width={12} height={12} />
              </button>
            </div>
          </div>
        )}
        <Box className="relative w-full min-w-0 max-w-full px-2 py-1 overflow-hidden">
          <MarkdownCell cellData={cellData} />
        </Box>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center">
          <div className="pointer-events-auto flex h-8 w-8 translate-y-1/2 items-center justify-center">
            <button
              type="button"
              aria-label="Add cell below"
              className="flex h-6 w-6 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-600 shadow-sm transition-colors hover:border-gray-400 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
              onClick={handleAddCodeCellAfter}
            >
              <PlusIcon width={12} height={12} />
            </button>
          </div>
        </div>
        {adjustedContextMenu && (
          <div
            className="fixed z-50 min-w-[160px] rounded-md border border-gray-200 bg-white py-1 shadow-lg"
            style={{
              top: adjustedContextMenu.y,
              left: adjustedContextMenu.x,
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              type="button"
              className="block w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-gray-100"
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

  // Render code cells with the full editor, toolbar, and output area
  return (
    <div
      className="relative py-2 flex flex-col gap-2"
      onContextMenu={handleContextMenu}
    >
      {!isFirst && (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center">
          <div className="pointer-events-auto flex h-8 w-8 -translate-y-1/2 items-center justify-center">
            <button
              type="button"
              aria-label="Add cell above"
              className="flex h-6 w-6 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-600 shadow-sm transition-colors hover:border-gray-400 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
              onClick={handleAddCodeCellBefore}
            >
              <PlusIcon width={12} height={12} />
            </button>
          </div>
        </div>
      )}
      <Box className="relative w-full px-2 py-1">
        <div className="flex justify-between items-top">
          <div className="flex flex-col items-center">
            <RunActionButton pid={pid} exitCode={exitCode} onClick={runCode} />
            <Text
              size="2"
              className="mt-1 p-2 font-bold text-gray-400 font-mono"
              data-testid="sequence-label"
            >
              [{sequenceLabel}]
            </Text>
          </div>
      <Card className="flex flex-col flex-1 ml-2 overflow-hidden">
        <div id="editor-toolbar" className="relative flex flex-col gap-0">
              <Editor
                key={`editor-${cell.refId}-${selectedLanguage}`}
                id={cell.refId}
                value={cell.value}
                language={editorLanguage}
                fontSize={fontSettings.fontSize}
                fontFamily={fontSettings.fontFamily}
                onChange={(v) => {
                  console.log("Editor onChange", { v });
                  const updated = create(parser_pb.CellSchema, cell);
                  updated.value = v;
                  updateCellLocal(updated);
                }}
                onEnter={runCode}
              />
              <div
                id="toolbar"
                className="-mt-px flex items-center justify-start gap-4 border border-sky-200/70 bg-[#111111] px-3 py-0.5 text-[10px] leading-tight text-gray-200 rounded-b-md"
              >
                <div className="flex items-center gap-2">
                  <Text
                    size="1"
                    as="span"
                    className="text-[9px] uppercase tracking-wide text-gray-300"
                  >
                    Language
                  </Text>
                  <select
                    id={languageSelectId}
                    value={selectedLanguage}
                    onChange={handleLanguageChange}
                    className="cursor-pointer rounded border border-sky-200/70 bg-[#111111] px-2 py-0.5 text-[10px] font-mono text-gray-100 focus:outline-none focus:ring-2 focus:ring-sky-200/50"
                  >
                    {LANGUAGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <Text
                    size="1"
                    as="span"
                    className="text-[9px] uppercase tracking-wide text-gray-300"
                  >
                    Runner
                  </Text>
                  <select
                    id={runnerSelectId}
                    value={initialRunnerName}
                    onChange={(event) => {                      
                      const nextName = event.target.value;
                      const names = new Set(listRunners().map((r) => r.name));
                      if (!names.has(nextName) && nextName !== DEFAULT_RUNNER_PLACEHOLDER) {
                        return;
                      }
                      cellData.setRunner(nextName);           
                    }}
                    className="cursor-pointer rounded border border-sky-200/70 bg-[#111111] px-2 py-0.5 text-[10px] font-mono text-gray-100 focus:outline-none focus:ring-2 focus:ring-sky-200/50"
                  >
                    <option value="<default>">
                      {defaultRunnerName ? `<default: ${defaultRunnerName}>` : "<default>"}
                    </option>
                    {listRunners().map((runner) => (
                      <option key={runner.name} value={runner.name}>
                        {runner.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
          </div>
            {renderedOutputs}
            {renderedOutputItems}
          </Card>
        </div> 
      </Box>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center">
        <div className="pointer-events-auto flex h-8 w-8 translate-y-1/2 items-center justify-center">
          <button
            type="button"
            aria-label="Add cell below"
            className="flex h-6 w-6 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-600 shadow-sm transition-colors hover:border-gray-400 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
            onClick={handleAddCodeCellAfter}
          >
            <PlusIcon width={12} height={12} />
          </button>
        </div>
      </div>
      {adjustedContextMenu && (
        <div
          className="fixed z-50 min-w-[160px] rounded-md border border-gray-200 bg-white py-1 shadow-lg"
          style={{
            top: adjustedContextMenu.y,
            left: adjustedContextMenu.x,
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            className="block w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-gray-100"
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
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-gray-500">
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
      className="flex-1 h-full p-1 min-w-0 max-w-full overflow-x-hidden"
      data-document-id={docUri}
    >
      <div className="mb-2 flex justify-center">
        <button
          type="button"
          aria-label="Add cell"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-600 shadow-sm transition-colors hover:border-gray-400 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
          onClick={() => {
            if (!data) {
              return;
            }
            // Default to inserting a code cell when notebook is empty.
            const firstCell = cellDatas[0]?.snapshot;
            if (firstCell) {
              data.addCodeCellBefore(firstCell.refId);
            } else {
              const newCell = data.addCodeCellAfter("");
              if (!newCell) {
                // Fallback: create and persist a new code cell at the end.
                const cell = create(parser_pb.CellSchema, {
                  metadata: {},
                  refId: `code_${crypto.randomUUID().replace(/-/g, "")}`,
                  languageId: "bash",
                  role: parser_pb.CellRole.USER,
                  kind: parser_pb.CellKind.CODE,
                  value: "",
                });
                data.updateCell(cell);
              }
            }
          }}
        >
          <PlusIcon width={16} height={16} />
        </button>
      </div>
      {cellDatas.map((cellData, index) => {
        const refId = cellData.snapshot?.refId ?? `cell-${index}`;
        return (
          <Action
            key={`action-${refId}`}
            cellData={cellData}
            isFirst={index === 0}
          />
        );
      })}
    </ScrollArea>
  );
}

export default function Actions() {
  const { useNotebookList, removeNotebook } = useNotebookContext();
  const openNotebooks = useNotebookList();
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc();
  const currentDocUri = getCurrentDoc();
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(() => new Set());
  // Empty-state hint visibility is stored locally so the hint panel can be
  // revealed on demand without cluttering the default view.
  const [showConsoleHints, setShowConsoleHints] = useState(false);
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
  }, [currentDocUri]);

  // TODO(jlewi): Does it still make sense to have a registration pattern for renderers? What does that buy us over
  // just hardcoding an "if" statement when rendering the outputs. Is that a legacy of the vscode extension where
  // renderers could be registered via extensions for different mimetypes?
  // Register renderers for code cells
  useEffect(() => {
    registerRenderer(MimeType.StatefulRunmeTerminal, {
      onCellUpdate: (cell: parser_pb.Cell) => {
        if (cell.kind !== parser_pb.CellKind.CODE || cell.outputs.length > 0) {
          return;
        }

        // it's basically shell, be prepared to render a terminal
        cell.outputs = [
          create(parser_pb.CellOutputSchema, {
            items: [
              create(parser_pb.CellOutputItemSchema, {
                mime: MimeType.StatefulRunmeTerminal,
                type: "Buffer",
                data: new Uint8Array(), // todo(sebastian): pass terminal settings
              }),
            ],
          }),
        ];
      },
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
        const languageId = cell.languageId?.toLowerCase();
        const isJavaScript =
          languageId === "javascript" ||
          languageId === "typescript" ||
          languageId === "js" ||
          languageId === "ts";
        const isObservable = languageId === "observable" || languageId === "d3";
        const isPython = languageId === "python" || languageId === "py";

        if (!isPython && (isObservable || isJavaScript)) {
          return (
            <WebContainerConsole
              key={`webcontainer-${cell.refId}`}
              cell={cell}
              onPid={onPid}
              onExitCode={onExitCode}
            />
          );
        }

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

  // Each document gets its own scroll container keyed by URI so the browser
  // does not reuse the previous document's scroll position.

  return (
    <div id="documents" className="flex flex-col h-full">
      {openNotebooks.length === 0 ? (
        <ScrollArea
          type="auto"
          scrollbars="vertical"
          className="flex-1 p-4"
          data-testid="actions-empty-scroll"
        >
          <div
            id="actions-empty-state"
            className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-6 text-center text-sm text-gray-600"
          >
            <div id="actions-empty-header" className="space-y-2">
              <Text size="5" weight="bold" as="p" className="text-gray-900">
                No open notebooks yet
              </Text>
              <Text size="2" as="p" className="text-gray-500">
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
                className="w-full rounded-lg border border-gray-200 bg-gray-50 p-4 text-left"
              >
                <Text size="3" weight="bold" as="p" className="text-gray-900">
                  Quick Start Console Commands
                </Text>
                <Text size="2" as="p" className="mt-1 text-gray-500">
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
          value={currentDocUri ?? openNotebooks[0]?.uri ?? ""}
          className="flex flex-col flex-1 min-h-0 border border-gray-200 rounded-md overflow-hidden bg-white"
        >
          <Tabs.List className="flex items-center gap-0 border-b border-gray-300 bg-gray-100 px-1">
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
                  className="group flex items-center gap-2 px-3 py-1 text-sm font-medium text-gray-600 border border-gray-300 border-b-0 border-t-transparent data-[state=active]:border-t-2 data-[state=active]:border-t-sky-400 data-[state=active]:border-l-gray-400 data-[state=active]:border-r-gray-400 data-[state=active]:bg-white data-[state=active]:text-gray-900 data-[state=inactive]:bg-gray-100 focus:outline-none"
                  onClick={() => {
                    if (doc.uri !== currentDocUri) {
                      setMountedTabs((prev) => {
                        if (prev.has(doc.uri)) {
                          return prev;
                        }
                        const next = new Set(prev);
                        next.add(doc.uri);
                        return next;
                      });
                      setCurrentDoc(doc.uri);
                    }
                  }}
                >
                  <span className="truncate max-w-[140px]">{displayName}</span>
                </Tabs.Trigger>
                  <button
                    type="button"
                    className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-gray-400 transition-colors hover:text-gray-700"
                    aria-label={`Close ${displayName}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleCloseTab(doc.uri);
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    <Cross2Icon width={12} height={12} />
                  </button>
                </div>
              );
            })}
          </Tabs.List>
          {openNotebooks.map((doc) => (
            <Tabs.Content
              key={`content-${doc.uri}`}
              value={doc.uri}
              forceMount
              asChild
            >
              <TabPanel className="flex-1 min-h-0" data-document-id={doc.uri}>
                {/* Keep every tab mounted (forceMount) so scroll position is preserved when switching. */}
                <NotebookTabContent docUri={doc.uri} />
              </TabPanel>
            </Tabs.Content>
          ))}
        </Tabs.Root>
      )}
    </div>
  );
}
