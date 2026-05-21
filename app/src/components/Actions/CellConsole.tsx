import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
} from "react";

import { create } from "@bufbuild/protobuf";
import {
  ExecuteRequestSchema,
  WinsizeSchema,
} from "@buf/stateful_runme.bufbuild_es/runme/runner/v2/runner_pb";
import { ClientMessages } from "@runmedev/renderers";

import { MimeType, RunmeMetadataKey, parser_pb } from "../../runme/client";
import { CellData } from "../../lib/notebookData";

export const fontSettings = {
  fontSize: 12.6,
  fontFamily: "Fira Mono, monospace",
};

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const stdinHelpText =
  "Send one line of standard input to the running process. This control is available while the process is active, even if it is not currently waiting for input.";

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
  const [stdinValue, setStdinValue] = useState("");
  const [showStdinHelp, setShowStdinHelp] = useState(false);

  const cell =
    useSyncExternalStore(
      (listener) => cellData.subscribe(listener),
      () => cellData.snapshot,
    ) || undefined;

  const runID = cellData.getRunID();
  const stream = cellData.getStreams() as any;

  if (!cell || cell.kind !== parser_pb.CellKind.CODE) {
    return null;
  }

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    const initialContent = decodeOutputs(cell?.outputs ?? []);

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

    if (stream) {
      const stdoutSub = stream.stdout.subscribe((data: Uint8Array) => {
        writeToTerminal(data);
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
        onExitCode(code);
      });
      disposers.push(() => exitSub.unsubscribe());
    }
    
    return () => {
      disposers.forEach((fn) => fn());
    };
    // Only recreate subscriptions/console when the run changes; callbacks are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellData, onExitCode, onPid, runID, stream]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const activeStream = cellData.getStreams() as any;
    if (!activeStream) {
      return;
    }
    const input = stdinValue.endsWith("\n") ? stdinValue : `${stdinValue}\n`;
    const req = create(ExecuteRequestSchema, {
      inputData: textEncoder.encode(input),
    });
    activeStream.sendExecuteRequest(req);
    setStdinValue("");
  };

  return (
    <div className="space-y-3">
      <div
        className="w-full"
        data-runkey={`console-${cell.refId}-${runID ?? "idle"}`}
        data-testid="cell-console"
        ref={containerRef}
      />
      {stream ? (
        <form
          className="rounded-nb-sm border border-nb-border bg-[#fff8ef] p-3"
          data-testid="cell-stdin-form"
          onSubmit={handleSubmit}
        >
          <div className="relative mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-[#8a5a2b]">
            <span>Provide input</span>
            <button
              type="button"
              aria-controls={`stdin-help-${cell.refId}`}
              aria-expanded={showStdinHelp}
              aria-label="Explain standard input"
              className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-[#c9b08f] bg-white text-[10px] leading-none text-[#8a5a2b]"
              onClick={() => setShowStdinHelp((visible) => !visible)}
            >
              ?
            </button>
            {showStdinHelp ? (
              <div
                className="absolute left-0 top-6 z-10 max-w-sm rounded-nb-xs border border-[#c9b08f] bg-white p-2 text-[11px] font-normal normal-case leading-relaxed tracking-normal text-nb-text shadow-nb-sm"
                data-testid="cell-stdin-help"
                id={`stdin-help-${cell.refId}`}
                role="tooltip"
              >
                {stdinHelpText}
              </div>
            ) : null}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              aria-label="Cell stdin input"
              className="min-w-0 flex-1 rounded-nb-xs border border-[#c9b08f] bg-white px-3 py-2 font-mono text-xs text-nb-text focus:outline-none focus:ring-1 focus:ring-nb-accent"
              data-testid="cell-stdin-input"
              onChange={(event) => setStdinValue(event.currentTarget.value)}
              placeholder="Type one response and press Enter"
              type="text"
              value={stdinValue}
            />
            <button
              className="rounded-nb-xs bg-[#9f4d2f] px-3 py-2 font-mono text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              data-testid="cell-stdin-submit"
              disabled={stdinValue.length === 0}
              type="submit"
            >
              Send
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
};

export default CellConsole;
