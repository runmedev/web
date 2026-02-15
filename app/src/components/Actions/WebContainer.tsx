import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as d3 from "d3";
import { create } from "@bufbuild/protobuf";

import {
  RunmeMetadataKey,
  createCellOutputs,
  parser_pb,
} from "../../contexts/CellContext";
import { useNotebookContext } from "../../contexts/NotebookContext";
import { useCurrentDoc } from "../../contexts/CurrentDocContext";

import * as datadog from "../../lib/runtime/datadog";
import { useBaseUrl } from "../../lib/useAisreClient";
// TODO(jskernel): Refactor this component to delegate execution to JSKernel
// so notebook JS/Observable cells share the same runtime as AppConsole.

type ObservableOutputProps = {
  cell: parser_pb.Cell;
  onExitCode: (code: number | null) => void;
  onPid: (pid: number | null) => void;
};

const toPrintable = (value: unknown) => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const WebContainer = ({ cell, onExitCode, onPid }: ObservableOutputProps) => {
  const baseUrl = useBaseUrl();
  const { getNotebookData } = useNotebookContext();
  const { getCurrentDoc } = useCurrentDoc();
  const currentDocUri = getCurrentDoc();
  const notebookData = useMemo(
    () => (currentDocUri ? getNotebookData(currentDocUri) : undefined),
    [currentDocUri, getNotebookData],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const [stdout, setStdout] = useState<string>("");
  const [stderr, setStderr] = useState<string>("");
  const [lastRunId, setLastRunId] = useState<number>(0);
  const [hasRenderableOutput, setHasRenderableOutput] = useState<boolean>(false);
  const activeRunIdRef = useRef<number | null>(null);

  const runCode = useCallback(async () => {
    const container = containerRef.current;
    if (!container) {
      console.warn("ObservableOutput: container not mounted");
      return;
    }

    const runId = Date.now();
    activeRunIdRef.current = runId;
    setLastRunId(runId);
    setStdout("");
    setStderr("");
    setHasRenderableOutput(false);
    container.innerHTML = "";
    onPid(null);

    const logBuffer: string[] = [];
    const errorBuffer: string[] = [];

    const append = (buffer: string[], args: unknown[]) => {
      buffer.push(args.map(toPrintable).join(" "));
    };

    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };

    const mockedConsole = {
      log: (...args: unknown[]) => {
        originalConsole.log(...args);
        append(logBuffer, args);
      },
      info: (...args: unknown[]) => {
        originalConsole.info(...args);
        append(logBuffer, args);
      },
      warn: (...args: unknown[]) => {
        originalConsole.warn(...args);
        append(errorBuffer, args);
      },
      error: (...args: unknown[]) => {
        originalConsole.error(...args);
        append(errorBuffer, args);
      },
    };

    const aisre = {
      clear: () => {
        if (activeRunIdRef.current === runId) {
          container.innerHTML = "";
        }
      },
      container,
      render: (
        renderFn: (
          selection: d3.Selection<HTMLDivElement, unknown, null, undefined>,
        ) => void | Promise<void>,
      ) => {
        if (activeRunIdRef.current !== runId) {
          return;
        }
        container.innerHTML = "";
        const selection = d3.select(container);
        return renderFn(selection);
      },
    };

    let exitCode = 0;

    try {
      const runner = new Function(
        // Inject the libraries/objects we want to expose to the cell code
        "d3",
        "datadog",
        "aisre",
        "console",
        `"use strict"; return (async () => {\n${cell.value}\n})();`,
      );
      await runner(d3, datadog, aisre, mockedConsole);
    } catch (err) {
      exitCode = 1;
      console.error(`Error during cell execution: ${err}`);
      append(errorBuffer, [err]);
    } finally {
      activeRunIdRef.current = null;
    }

    const stdoutText = logBuffer.join("\n");
    const stderrText = errorBuffer.join("\n");
    const renderedText = container.textContent?.trim() ?? "";
    const renderedElements = container.querySelectorAll("*").length;
    const hasRenderedContent = renderedElements > 0 || renderedText.length > 0;
    const hasTerminalOutput =
      stdoutText.trim().length > 0 || stderrText.trim().length > 0;

    const updatedCell = create(parser_pb.CellSchema, cell);
    updatedCell.outputs = createCellOutputs(
      { pid: null, exitCode },
      stdoutText,
      stderrText,
      null,
    );

    if (exitCode !== null) {
      if (exitCode === 0) {
        delete updatedCell.metadata[RunmeMetadataKey.ExitCode];
      } else {
        updatedCell.metadata[RunmeMetadataKey.ExitCode] = exitCode.toString();
      }
    }

    notebookData?.updateCell(updatedCell);

    setStdout(stdoutText);
    setStderr(stderrText);
    setHasRenderableOutput(hasRenderedContent || hasTerminalOutput);
    onExitCode(exitCode);
  }, [cell, notebookData, onExitCode, onPid]);

  useEffect(() => {
    datadog.configureDatadogRuntime({ baseUrl });
  }, [baseUrl]);

  useEffect(() => {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<{ cellId: string }>;
      if (customEvent.detail.cellId === cell.refId) {
        void runCode();
      }
    };
    window.addEventListener("runCodeCell", handler as EventListener);
    return () => {
      window.removeEventListener("runCodeCell", handler as EventListener);
    };
  }, [cell.refId, runCode]);

  const hasStdIO = useMemo(() => {
    return stdout.trim().length > 0 || stderr.trim().length > 0;
  }, [stderr, stdout]);

  return (
    <div
      id={`webcontainer-output-shell-${cell.refId}`}
      className={hasRenderableOutput ? "mt-2 rounded-md border border-nb-cell-border bg-white p-2 text-xs text-nb-text" : "hidden"}
      aria-hidden={!hasRenderableOutput}
    >
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-nb-text-faint">
        Observable Output{" "}
        {lastRunId
          ? `(last run: ${new Date(lastRunId).toLocaleTimeString()})`
          : ""}
      </div>
      <div
        id={`webcontainer-output-content-${cell.refId}`}
        ref={containerRef}
        className="mb-2 min-h-[240px] w-full overflow-auto rounded border border-dashed border-nb-cell-border bg-nb-surface-2"
      />

      {hasStdIO && (
        <div className="space-y-2 font-mono">
          {stdout.trim().length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase text-emerald-600">
                stdout
              </div>
              <pre className="whitespace-pre-wrap break-words text-[11px] text-emerald-900">
                {stdout}
              </pre>
            </div>
          )}
          {stderr.trim().length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase text-rose-600">
                stderr
              </div>
              <pre className="whitespace-pre-wrap break-words text-[11px] text-rose-900">
                {stderr}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default WebContainer;
