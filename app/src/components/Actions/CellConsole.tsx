import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type MutableRefObject,
} from "react";

import { create } from "@bufbuild/protobuf";
import {
  ExecuteRequestSchema,
  WinsizeSchema,
} from "@buf/stateful_runme.bufbuild_es/runme/runner/v2/runner_pb";
import { ClientMessages, setContext } from "@runmedev/renderers";

import { MimeType, RunmeMetadataKey, parser_pb } from "../../runme/client";
import { CellData } from "../../lib/notebookData";
import { maybeParseIPykernelMessage, type IPykernelMessage } from "../../lib/ipykernel";

export const fontSettings = {
  fontSize: 12.6,
  fontFamily: "Fira Mono, monospace",
};

/**
 * Extract displayable text from an IPykernel message.
 * - "stream" messages contain print() output in content.text
 * - "error" messages contain exception info in content.ename/evalue/traceback
 * Returns the text to write to the terminal, or null if the message
 * is a control message that should be silently ignored.
 */
function extractIopubText(msg: IPykernelMessage): string | null {
  const msgType = msg.header?.msg_type ?? (msg as any).msg_type;

  if (msgType === "stream") {
    const text = typeof msg.content?.text === "string" ? msg.content.text : "";
    return text || null;
  }

  if (msgType === "error") {
    const ename = (msg.content as any)?.ename ?? "";
    const evalue = (msg.content as any)?.evalue ?? "";
    const traceback: string[] = Array.isArray((msg.content as any)?.traceback)
      ? (msg.content as any).traceback
      : [];
    const text = [ename, evalue, ...traceback].filter(Boolean).join("\n");
    return text ? text + "\n" : null;
  }

  return null;
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function decodeOutputs(outputs: parser_pb.CellOutput[]): string {
  const parts: string[] = [];
  outputs.forEach((output) => {
    output.items.forEach((item) => {
      if (
        item.mime === MimeType.VSCodeNotebookStdOut ||
        item.mime === MimeType.VSCodeNotebookStdErr
      ) {
        parts.push(textDecoder.decode(item.data));
      }
    });
  });
  return parts.join("");
}

function buildMessagingBridge(
  cellData: CellData,
  winsizeRef: MutableRefObject<{ cols: number; rows: number }>,
) {
  return {
    postMessage: (msg: any) => {
      const stream = cellData.getStreams();
      if (!stream) {
        return;
      }
      if (
        msg.type === ClientMessages.terminalOpen ||
        msg.type === ClientMessages.terminalResize
      ) {
        const cols = Number(msg.output?.terminalDimensions?.columns);
        const rows = Number(msg.output?.terminalDimensions?.rows);
        if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
          return;
        }
        if (winsizeRef.current.cols === cols && winsizeRef.current.rows === rows) {
          return;
        }
        winsizeRef.current = { cols, rows };
        const req = create(ExecuteRequestSchema, {
          winsize: create(WinsizeSchema, { cols, rows }),
        });
        stream.sendExecuteRequest(req);
        return;
      }

      if (msg.type === ClientMessages.terminalStdin) {
        const input = typeof msg.output?.input === "string" ? msg.output.input : "";
        const req = create(ExecuteRequestSchema, {
          inputData: textEncoder.encode(input),
        });
        stream.sendExecuteRequest(req);
      }
    },
    onDidReceiveMessage: (cb: (message: unknown) => void) => {
      const stream = cellData.getStreams();
      if (stream?.setCallback) {
        stream.setCallback(cb);
      }
      return { dispose: () => {} };
    },
  };
}

type CellConsoleProps = {
  cellData: CellData;
  onExitCode: (code: number) => void;
  onPid: (pid: number) => void;
};

const CellConsole = ({ cellData, onExitCode, onPid }: CellConsoleProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const consoleRef = useRef<any>(null);
  const pendingWrites = useRef<Uint8Array[]>([]);
  const winsizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const wroteInitialForRun = useRef<string | null>(null);
  const stdoutBufferRef = useRef("");

  const cell =
    useSyncExternalStore(
      (listener) => cellData.subscribe(listener),
      () => cellData.snapshot,
    ) || undefined;

  const initialContent = useMemo(
    () => decodeOutputs(cell?.outputs ?? []),
    [cell?.outputs],
  );
  const runID = cellData.getRunID();

  if (!cell || cell.kind !== parser_pb.CellKind.CODE) {
    return null;
  }

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    void customElements.whenDefined("console-view");

    let consoleEl = consoleRef.current as any;
    if (!consoleEl) {
      consoleEl = document.createElement("console-view") as any;

      const messaging = buildMessagingBridge(cellData, winsizeRef);
      // Bridge console-view <-> stream messages the same way RunmeConsole does.      
      // This is what allows us to run interactive shells e.g. by typing "bash" in a code cell.
      // because it wires up the stdin/stdout handling.
      consoleEl.context = messaging;

      // Mirror AppConsole defaults to avoid invalid sizing.
      consoleEl.setAttribute("buttons", "false");
      consoleEl.setAttribute("theme", "light");
      consoleEl.setAttribute("fontFamily", fontSettings.fontFamily);
      consoleEl.setAttribute("fontSize", String(fontSettings.fontSize));
      consoleEl.setAttribute("cursorStyle", "block");
      consoleEl.setAttribute("cursorBlink", "true");
      consoleEl.setAttribute("cursorWidth", "1");
      consoleEl.setAttribute("smoothScrollDuration", "0");
      consoleEl.setAttribute("scrollback", "4000");
      consoleEl.setAttribute("initialRows", "20");
      consoleEl.initialContent = "";
      if (!runID) {
        // TODO(jlewi): I'm not sure this is really the right thing to do.
        // Maybe we shouldn't be rendering CellConsole if the cell has no runID?
        // If there is no runID that arguably means the cell hasn't been run.
        console.log("No runID for cell; generating a new ID");
        consoleEl.id = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      } else {
        consoleEl.id = runID;
      }

      consoleRef.current = consoleEl;
      containerRef.current.innerHTML = "";
      containerRef.current.appendChild(consoleEl);
    }
    
    // Write any recovered output into the terminal once it is ready.
    consoleEl.initialContent = "";

    const stream = cellData.getStreams() as any;
    const disposers: Array<() => void> = [];

    const flushPending = () => {
      const term = (consoleRef.current as any)?.terminal;
      if (term?.write && pendingWrites.current.length > 0) {
        pendingWrites.current.forEach((buf) => term.write(buf));
        pendingWrites.current = [];
      }
    };

    if (consoleEl.updateComplete) {
      consoleEl.updateComplete
        .then(() => {
          if (initialContent && wroteInitialForRun.current !== runID) {
            const term = (consoleRef.current as any)?.terminal;
            const buf = new TextEncoder().encode(initialContent);
            if (term?.write) {
              term.write(buf);
            } else {
              pendingWrites.current.push(buf);
            }
            wroteInitialForRun.current = runID ?? null;
          }
          flushPending();
        })
        .catch(() => {});
    }


    const writeToTerminal = (data: Uint8Array) => {
      const term = (consoleRef.current as any)?.terminal;
      if (term?.write) {
        term.write(data);
      } else {
        pendingWrites.current.push(data);
      }
    };

    const flushStdoutBuffer = () => {
      const pending = stdoutBufferRef.current;
      if (!pending) {
        return;
      }
      stdoutBufferRef.current = "";
      const parsed = maybeParseIPykernelMessage(pending);
      if (parsed) {
        const text = extractIopubText(parsed);
        if (text) {
          writeToTerminal(textEncoder.encode(text));
        }
      } else {
        writeToTerminal(textEncoder.encode(pending));
      }
    };

    if (stream) { 
      const stdoutSub = stream.stdout.subscribe((data: Uint8Array) => {
        const chunkText = textDecoder.decode(data);
        stdoutBufferRef.current += chunkText;

        const lines = stdoutBufferRef.current.split("\n");
        stdoutBufferRef.current = lines.pop() ?? "";

        lines.forEach((line) => {
          const parsed = maybeParseIPykernelMessage(line);
          if (parsed) {
            const text = extractIopubText(parsed);
            if (text) {
              writeToTerminal(textEncoder.encode(text));
            }
            return;
          }
          writeToTerminal(textEncoder.encode(`${line}\n`));
        });
      });
      disposers.push(() => stdoutSub.unsubscribe());

      const stderrSub = stream.stderr.subscribe((data: Uint8Array) => {
        writeToTerminal(data);
      });
      disposers.push(() => stderrSub.unsubscribe());

      const pidSub = stream.pid.subscribe((pid: number) => {
        onPid(pid);
      });
      disposers.push(() => pidSub.unsubscribe());

      const exitSub = stream.exitCode.subscribe((code: number) => {
        flushStdoutBuffer();
        onExitCode(code);
      });
      disposers.push(() => exitSub.unsubscribe());
    }
    
    return () => {
      disposers.forEach((fn) => fn());
    };
    // Only recreate subscriptions/console when the run changes; callbacks are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runID]);

  console.log("CellConsole render", { cellRefId: cell.refId, runID: runID });
  return (
    <div
      className="w-full"
      data-runkey={`console-${cell.refId}-${runID ?? "idle"}`}
      data-testid="cell-console"
      ref={containerRef}
    />
  );
};

export default CellConsole;
