import { clone, create } from "@bufbuild/protobuf";

import {
  parser_pb,
  RunmeMetadataKey,
  MimeType,
} from "../contexts/CellContext";

/**
 * Minimal store interface used by NotebookData for auto-saving.
 * Both LocalNotebooks and ContentsNotebookStore satisfy this contract.
 */
export interface NotebookSaveStore {
  save(uri: string, notebook: parser_pb.Notebook): Promise<unknown>;
}
import {
  IOPUB_INCOMPLETE_METADATA_KEY,
  IOPUB_MIME_TYPE,
  maybeParseIPykernelMessage,
} from "./ipykernel";
import {
  DEFAULT_RUNNER_PLACEHOLDER,
  getRunnersManager,
} from "./runtime/runnersManager";
import {
  buildJupyterChannelsWebSocketURL,
} from "./runtime/jupyterManager";
import { createAppJsGlobals } from "./runtime/appJsGlobals";
import {
  createRunmeConsoleApi,
  type NotebookDataLike,
  type RunmeConsoleApi,
} from "./runtime/runmeConsole";
import {
  type NotebooksApiBridgeServer,
  createHostNotebooksApi,
  createNotebooksApiBridgeServer,
} from "./runtime/notebooksApiBridge";
import { JSKernel } from "./runtime/jsKernel";
import { SandboxJSKernel } from "./runtime/sandboxJsKernel";
import {
  type AppKernelRunnerMode,
  isAppKernelRunnerName,
  resolveAppKernelRunnerMode,
} from "./runtime/appKernel";
import {
  Streams,
  Heartbeat,
  genRunID,
  type StreamsLike,
} from "@runmedev/renderers";
import { buildExecuteRequest } from "./runme";
import type { Runner } from "./runner";
import { showToast } from "./toast";
import { appLogger } from "./logging/runtime";
import { getBrowserAdapter } from "../browserAdapter.client";

export type NotebookSnapshot = {
  readonly uri: string;
  readonly name: string;
  readonly notebook: parser_pb.Notebook;
  readonly loaded: boolean;
};

const localTextEncoder = new TextEncoder();

function encodeCellOutputBytes(text: string): Uint8Array {
  const encoded = localTextEncoder.encode(text);
  return encoded instanceof Uint8Array
    ? encoded
    : Uint8Array.from(encoded as ArrayLike<number>);
}

function createStdTextOutputs(
  stdout: string,
  stderr: string,
): parser_pb.CellOutput[] {
  return [
    create(parser_pb.CellOutputSchema, {
      items: [
        create(parser_pb.CellOutputItemSchema, {
          mime: MimeType.VSCodeNotebookStdOut,
          type: "Buffer",
          data: encodeCellOutputBytes(stdout),
        }),
        create(parser_pb.CellOutputItemSchema, {
          mime: MimeType.VSCodeNotebookStdErr,
          type: "Buffer",
          data: encodeCellOutputBytes(stderr),
        }),
      ],
    }),
  ];
}

function createTextOutputItem(
  mime: string,
  text: string,
): parser_pb.CellOutputItem {
  return create(parser_pb.CellOutputItemSchema, {
    mime,
    type: "Buffer",
    data: encodeCellOutputBytes(text),
  });
}

const JUPYTER_LIMITS = {
  textBytesPerExecution: 16 * 1024 * 1024,
  richBytesPerItem: 10 * 1024 * 1024,
  totalBytesPerExecution: 32 * 1024 * 1024,
} as const;

function decodeBase64ToBytes(value: string): Uint8Array {
  try {
    const binary = globalThis.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return new Uint8Array();
  }
}

type Listener = () => void;

export type StreamBinder = (args: {
  refId: string;
  streams: StreamsLike;
  getCell: (refId: string) => parser_pb.Cell | null;
  updateCell: (
    cell: parser_pb.Cell,
    options?: { transient?: boolean },
  ) => void;
}) => { dispose(): void };

/**
 * bindStreamsToCell wires a StreamsLike instance to a cell's outputs/metadata.
 *
 * It listens for stdout/stderr and appends data to existing output items (or
 * creates them if missing), updates pid/exit metadata, and closes/cleans up on
 * exit or error. The caller supplies `getCell` and `updateCell` so this helper
 * stays framework-agnostic and is easy to unit test with fake streams.
 */
export const bindStreamsToCell: StreamBinder = ({
  refId,
  streams,
  getCell,
  updateCell,
}) => {
  // Track the most recent error toast so we don't spam the user during
  // repeated reconnect attempts for the same cell run.
  let lastToastAt = 0;
  const toastThrottleMs = 3_000;
  /**
   * stdoutBuffer tracks partial lines across chunks so we can parse line-based
   * IOPub messages without losing bytes. We only attempt IOPub detection at
   * the start of the stream or when a newline boundary is reached.
   */
  let stdoutBuffer = "";
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();

  const appendBuffer = (mime: MimeType, chunk: Uint8Array) => {
    const updated = getCell(refId);
    if (!updated) return;

    const { output, item } = ensureOutputItem(updated, mime);
    const prev = item.data ?? new Uint8Array();
    const next = new Uint8Array(prev.length + chunk.length);
    next.set(prev);
    next.set(chunk, prev.length);
    item.data = next;

    if (!updated.outputs.includes(output)) {
      updated.outputs = [...updated.outputs, output];
    }

    updateCell(updated, { transient: true });
  };

  /**
   * ensureOutputItem ensures a cell output item exists for the given mime type.
   * It returns the owning output and item so callers can update data/metadata.
   */
  const ensureOutputItem = (cell: parser_pb.Cell, mime: string) => {
    const existingOutput =
      cell.outputs.find((o) => o.items.some((i) => i.mime === mime)) ??
      create(parser_pb.CellOutputSchema, {
        items: [
          create(parser_pb.CellOutputItemSchema, {
            mime,
            type: "Buffer",
            data: new Uint8Array(),
          }),
        ],
      });

    const item =
      existingOutput.items.find((i) => i.mime === mime) ??
      create(parser_pb.CellOutputItemSchema, {
        mime,
        type: "Buffer",
        data: new Uint8Array(),
      });

    if (!existingOutput.items.includes(item)) {
      existingOutput.items = [...existingOutput.items, item];
    }

    if (!cell.outputs.includes(existingOutput)) {
      cell.outputs = [...cell.outputs, existingOutput];
    }

    return { output: existingOutput, item };
  };

  /**
   * appendIopubLine converts IOPub messages into output items per mime bundle.
   * Each output item is marked as incomplete until the stream finishes.
   */
  const appendIopubLine = (
    line: string,
    message: ReturnType<typeof maybeParseIPykernelMessage>,
  ) => {
    if (!message) return;

    const updated = getCell(refId);
    if (!updated) return;

    const dataBundle = message.content?.data;
    const items =
      dataBundle && typeof dataBundle === "object"
        ? Object.entries(dataBundle).map(([mime, value]) =>
            create(parser_pb.CellOutputItemSchema, {
              mime,
              type: "Buffer",
              data: textEncoder.encode(
                typeof value === "string"
                  ? value
                  : (JSON.stringify(value) ?? ""),
              ),
              metadata: {
                [IOPUB_INCOMPLETE_METADATA_KEY]: "true",
              },
            }),
          )
        : [
            create(parser_pb.CellOutputItemSchema, {
              mime: IOPUB_MIME_TYPE,
              type: "Buffer",
              data: textEncoder.encode(line),
              metadata: {
                [IOPUB_INCOMPLETE_METADATA_KEY]: "true",
              },
            }),
          ];

    const output = create(parser_pb.CellOutputSchema, {
      items,
    });

    updated.outputs = [...updated.outputs, output];
    updateCell(updated, { transient: true });
  };

  /**
   * flushStdoutBuffer writes any remaining partial stdout line into the proper
   * output item, routing IOPub lines to the IOPub buffer if detected.
   */
  const flushStdoutBuffer = () => {
    if (!stdoutBuffer) {
      return;
    }

    const pendingLine = stdoutBuffer;
    stdoutBuffer = "";
    const message = maybeParseIPykernelMessage(pendingLine);
    if (message) {
      appendIopubLine(pendingLine, message);
    } else {
      appendBuffer(
        MimeType.VSCodeNotebookStdOut,
        textEncoder.encode(pendingLine),
      );
    }
  };

  /**
   * appendStdoutChunk parses stdout chunks into lines, detects IOPub messages,
   * and routes them into an IOPub buffer while preserving normal stdout.
   */
  const appendStdoutChunk = (chunk: Uint8Array) => {
    const chunkText = textDecoder.decode(chunk);
    const hadBuffer = stdoutBuffer.length > 0;
    stdoutBuffer += chunkText;

    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";

    if (!hadBuffer && lines.length === 0 && stdoutBuffer) {
      // Stream just started with a partial line; we'll classify it once a newline arrives.
      return;
    }

    lines.forEach((line) => {
      const message = maybeParseIPykernelMessage(line);
      if (message) {
        appendIopubLine(line, message);
        return;
      }

      appendBuffer(
        MimeType.VSCodeNotebookStdOut,
        textEncoder.encode(`${line}\n`),
      );
    });
  };

  /**
   * finalizeIopubStream marks buffered IOPub output items as complete once the stream ends.
   */
  const finalizeIopubStream = () => {
    const updated = getCell(refId);
    if (!updated) return;

    let didUpdate = false;
    updated.outputs.forEach((output) => {
      output.items.forEach((item) => {
        if (item.metadata?.[IOPUB_INCOMPLETE_METADATA_KEY] === "true") {
          item.metadata = {
            ...(item.metadata ?? {}),
            [IOPUB_INCOMPLETE_METADATA_KEY]: "false",
          };
          didUpdate = true;
        }
      });
    });

    if (didUpdate) {
      updateCell(updated);
    }
  };

  const subs = [
    streams.stdout.subscribe((data) => appendStdoutChunk(data)),
    streams.stderr.subscribe((data) =>
      appendBuffer(MimeType.VSCodeNotebookStdErr, data),
    ),
    streams.pid.subscribe((pid) => {
      const updated = getCell(refId);
      if (!updated || !updated.metadata) return;
      updated.metadata[RunmeMetadataKey.Pid] = pid.toString();
      updateCell(updated, { transient: true });
    }),
    streams.exitCode.subscribe((code) => {
      const updated = getCell(refId);
      if (!updated || !updated.metadata) return;
      updated.metadata[RunmeMetadataKey.ExitCode] = code.toString();
      delete updated.metadata[RunmeMetadataKey.Pid];
      updateCell(updated);
      flushStdoutBuffer();
      finalizeIopubStream();
      streams.close();
      subs.forEach((s) => s.unsubscribe());
    }),
    streams.mimeType.subscribe(() => {
      // no-op for now
    }),
    streams.errors.subscribe((err) => {
      console.error("Stream error", err);
      const now = Date.now();
      if (now - lastToastAt >= toastThrottleMs) {
        lastToastAt = now;
        showToast({
          message:
            "Runme backend server is not running. Please start it and try again.",
          tone: "error",
        });
      }
      flushStdoutBuffer();
      finalizeIopubStream();
      streams.close();
      subs.forEach((s) => s.unsubscribe());
    }),
  ];

  streams.connect(Heartbeat.INITIAL).subscribe();

  return {
    dispose() {
      subs.forEach((s) => s.unsubscribe());
      streams.close();
    },
  };
};

/**
 * NotebookData keeps an in-memory Notebook proto and provides a tiny subscribe /
 * snapshot API for React. Mutations update the proto in place and notify
 * listeners so views can re-render.
 */
// NotebookData is the in-memory model for a notebook. It follows a simple
// model/view pattern:
// - NotebookData owns all state for a single notebook (cells, metadata, name, uri).
// - React views subscribe via `subscribe` / `getSnapshot` and rerender whenever
//   the model emits (emit is called on any mutation, including async loads).
// - NotebookData should exist as soon as a notebook URI is opened; async loads
//   populate it later by calling `loadNotebook`, which rebuilds the snapshot and emits.
// This separation keeps the model framework-agnostic and makes it easy to test
// without React.
//
//TODO(jlewi): Rename this to NotebookModel as in model-view.
export class NotebookData {
  private uri: string;
  private name: string;
  private notebook: parser_pb.Notebook;
  private refToIndex: Map<string, number> = new Map();
  private listeners: Set<Listener> = new Set();
  private notebookStore: NotebookSaveStore | null;
  private sequence = 0;
  private snapshotCache: NotebookSnapshot;
  private loaded: boolean;
  private activeStreams: Map<string, StreamsLike> = new Map();
  private activeJupyterSockets: Map<string, WebSocket> = new Map();

  private refToCellData: Map<string, CellData> = new Map();
  // Debounce auto-save writes so keystrokes don't trigger a full disk write
  // (and in dev, a Vite page reload) on every change.
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly persistDelayMs = 750;
  private readonly resolveNotebookForAppKernel: (
    target?: unknown,
  ) => NotebookDataLike | null;
  private readonly listNotebooksForAppKernel: () => NotebookDataLike[];

  constructor({
    notebook,
    uri,
    name,
    notebookStore,
    loaded = false,
    resolveNotebookForAppKernel,
    listNotebooksForAppKernel,
  }: {
    notebook: parser_pb.Notebook;
    uri: string;
    name: string;
    notebookStore: NotebookSaveStore | null;
    loaded?: boolean;
    resolveNotebookForAppKernel?: (target?: unknown) => NotebookDataLike | null;
    listNotebooksForAppKernel?: () => NotebookDataLike[];
  }) {
    this.uri = uri;
    this.name = name;
    this.notebook = clone(parser_pb.NotebookSchema, notebook);
    this.notebookStore = notebookStore;
    this.loaded = loaded;
    this.sequence = this.computeHighestSequence();
    this.rebuildIndex();
    this.snapshotCache = this.buildSnapshot();
    this.resolveNotebookForAppKernel =
      resolveNotebookForAppKernel ??
      ((target?: unknown) => {
        if (!target || this.matchesNotebookTarget(target)) {
          return this;
        }
        return null;
      });
    this.listNotebooksForAppKernel =
      listNotebooksForAppKernel ??
      (() => {
        return [this];
      });
  }

  private matchesNotebookTarget(target: unknown): boolean {
    if (typeof target === "string") {
      return target === this.getUri();
    }
    if (
      typeof target === "object" &&
      target &&
      "uri" in target &&
      (target as { uri?: string }).uri === this.getUri()
    ) {
      return true;
    }
    if (
      typeof target === "object" &&
      target &&
      "handle" in target &&
      (target as { handle?: { uri?: string } }).handle?.uri === this.getUri()
    ) {
      return true;
    }
    return false;
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Current immutable snapshot for rendering. */
  getSnapshot(): NotebookSnapshot {
    return this.snapshotCache;
  }

  /**
   * Validate notebook cells and log warnings for suspicious data.
   * Called during loadNotebook to surface format issues early.
   */
  private validateCells(): void {
    for (const cell of this.notebook.cells) {
      if (!cell.refId) {
        console.warn("[NotebookData] Cell missing refId", cell);
      }
      const hasOutput = cell.outputs.length > 0;
      const hasValue = (cell.value ?? "").trim().length > 0;
      if (hasOutput && !hasValue) {
        console.warn(
          `[NotebookData] Cell ${cell.refId} has ${cell.outputs.length} output(s) but no input value. ` +
          `This may indicate a corrupt notebook format.`,
          { kind: cell.kind, languageId: cell.languageId },
        );
      }
    }
  }

  /**
   * Replace the in-memory notebook.
   *
   * `persist` defaults to true so interactive edits still auto-save, but
   * callers that are just loading from disk can disable it to avoid writing
   * the same content back (which triggers Vite reloads in dev).
   */
  loadNotebook(
    notebook: parser_pb.Notebook,
    { persist = true }: { persist?: boolean } = {},
  ): void {
    this.notebook = clone(parser_pb.NotebookSchema, notebook);
    this.rebuildIndex();
    this.validateCells();
    this.sequence = this.computeHighestSequence();
    this.loaded = true;
    this.snapshotCache = this.buildSnapshot();
    this.emit();
    if (persist) {
      this.schedulePersist();
    }
  }

  updateCell(
    cell: parser_pb.Cell,
    { transient = false }: { transient?: boolean } = {},
  ): void {
    const idx = this.refToIndex.get(cell.refId);
    const cloned = clone(parser_pb.CellSchema, cell);
    if (idx === undefined) {
      this.notebook.cells.push(cloned);
      this.refToIndex.set(cloned.refId, this.notebook.cells.length - 1);
    } else {
      this.notebook.cells[idx] = cloned;
    }

    const existingCellData = this.refToCellData.get(cloned.refId);
    if (existingCellData) {
      existingCellData.updateCachedSnapshotFromNotebook(cloned);
      // Emit from NotebookData to avoid double-notifying when CellData.update()
      // also routes through here.
      existingCellData.emitContentChange();
    }

    if (!transient) {
      this.snapshotCache = this.buildSnapshot();
      this.emit();
      this.schedulePersist();
    }
  }

  /** Append a new code cell to the end of the notebook. */
  appendCodeCell(languageId?: string | null): parser_pb.Cell {
    const cell = this.createCodeCell(languageId);
    this.notebook.cells.push(cell);
    this.rebuildIndex();
    this.snapshotCache = this.buildSnapshot();
    this.emit();
    this.schedulePersist();
    return cell;
  }

  /** Append a new markup (markdown) cell to the end of the notebook. */
  appendMarkupCell(): parser_pb.Cell {
    const cell = this.createMarkupCell();
    this.notebook.cells.push(cell);
    this.rebuildIndex();
    this.snapshotCache = this.buildSnapshot();
    this.emit();
    this.schedulePersist();
    return cell;
  }

  addCodeCellAfter(targetRefId: string, languageId?: string | null): parser_pb.Cell | null {
    const idx = this.refToIndex.get(targetRefId);
    if (idx === undefined) {
      return null;
    }
    const cell = this.createCodeCell(languageId);
    this.notebook.cells.splice(idx + 1, 0, cell);
    this.rebuildIndex();
    this.snapshotCache = this.buildSnapshot();
    this.emit();
    this.schedulePersist();
    return cell;
  }

  addCodeCellBefore(targetRefId: string, languageId?: string | null): parser_pb.Cell | null {
    const idx = this.refToIndex.get(targetRefId);
    if (idx === undefined) {
      return null;
    }
    const cell = this.createCodeCell(languageId);
    this.notebook.cells.splice(idx, 0, cell);
    this.rebuildIndex();
    this.snapshotCache = this.buildSnapshot();
    this.emit();
    this.schedulePersist();
    return cell;
  }

  removeCell(refId: string): void {
    const idx = this.refToIndex.get(refId);
    if (idx === undefined) {
      return;
    }
    this.notebook.cells.splice(idx, 1);
    this.rebuildIndex();
    this.snapshotCache = this.buildSnapshot();
    this.emit();
    this.schedulePersist();
  }

  setName(name: string): void {
    this.name = name;
    this.snapshotCache = this.buildSnapshot();
    this.emit();
    this.schedulePersist();
  }

  setUri(uri: string): void {
    this.uri = uri;
    this.snapshotCache = this.buildSnapshot();
    this.emit();
    this.schedulePersist();
  }

  // Returns the runID if the cell was started successfully.
  // empty string otherwise
  runCodeCell(cell: parser_pb.Cell): string {
    if (cell.kind !== parser_pb.CellKind.CODE) {
      console.warn("Cannot run non-code cell", cell.refId);
      return "";
    }

    const normalizedLanguage = (cell.languageId ?? "").trim().toLowerCase();
    const requestedRunnerName =
      (cell.metadata?.[RunmeMetadataKey.RunnerName] as string | undefined) ?? "";
    const appKernelMode = resolveAppKernelRunnerMode(requestedRunnerName);
    const useAppKernel =
      normalizedLanguage === "javascript" || isAppKernelRunnerName(requestedRunnerName);
    const useJupyterKernel = normalizedLanguage === "jupyter" || normalizedLanguage === "ipython";
    const runner = useAppKernel ? undefined : this.getRunner(cell);
    if (!useAppKernel && (!runner || !runner.endpoint)) {
      console.error("No runner available for cell", cell.refId);
      showToast({
        message: "Runme backend server is not running. Please start it and try again.",
        tone: "error",
      });
      return "";
    }

    // If there is an existing active stream for this cell, close it before
    // starting a new run to avoid leaking sockets.
    const existing = this.activeStreams.get(cell.refId);
    existing?.close();
    this.activeStreams.delete(cell.refId);
    const existingJupyterSocket = this.activeJupyterSockets.get(cell.refId);
    existingJupyterSocket?.close();
    this.activeJupyterSockets.delete(cell.refId);

    // Bump sequence and attach to metadata.
    this.sequence += 1;
    cell.metadata ??= {};
    delete cell.metadata[RunmeMetadataKey.ExitCode];
    delete cell.metadata[RunmeMetadataKey.Pid];
    cell.metadata[RunmeMetadataKey.Sequence] = this.sequence.toString();

    // Clear outputs on each execution start for Jupyter/IPython; for other
    // runners keep terminal output only so reruns don't show stale non-terminal data.
    if (useJupyterKernel) {
      cell.outputs = [];
    } else {
      cell.outputs = cell.outputs.filter((o) =>
        o.items.some((oi) => oi.mime === MimeType.StatefulRunmeTerminal),
      );
    }

    const runID = genRunID();
    cell.metadata[RunmeMetadataKey.LastRunID] = runID;
    this.updateCell(cell);

    if (useAppKernel) {
      this.runCodeCellWithAppKernel(cell, runID, appKernelMode);
      return runID;
    }

    if (useJupyterKernel) {
      this.runCodeCellWithJupyterKernel(cell, runID, runner!);
      return runID;
    }

    const streams = this.createAndBindStreams({
      cell,
      runID,
      sequence: this.sequence,
      runner: runner!,
    });
    if (!streams) {
      return "";
    }

    const commands = cell.value ? cell.value.split("\n") : [];
    const execReq = buildExecuteRequest({
      languageId: cell.languageId ?? undefined,
      commands,
      knownID: streams["knownID"] ?? `cell_${cell.refId}`,
      runID,
      winsize: undefined,
    });
    streams.sendExecuteRequest(execReq as any);
    return runID;
  }

  getUri(): string {
    return this.uri;
  }

  getName(): string {
    return this.name;
  }

  getNotebook(): parser_pb.Notebook {
    return this.notebook;
  }

  getCellSnapshot(refId: string): parser_pb.Cell | null {
    const idx = this.refToIndex.get(refId);
    if (idx === undefined || !this.notebook.cells[idx]) {
      return null;
    }
    return clone(parser_pb.CellSchema, this.notebook.cells[idx]);
  }

  private getCellProto(refId: string): parser_pb.Cell | null {
    const idx = this.refToIndex.get(refId);
    if (idx === undefined || !this.notebook.cells[idx]) {
      return null;
    }
    return this.notebook.cells[idx];
  }

  getCell(refId: string): CellData | null {
    if (!this.refToIndex.has(refId)) {
      return null;
    }
    // We need getCell to refer to the same CellData instance for a given refId
    // otherwise subscriptions and other changes won't be reflected across the application.
    if (!this.refToCellData.has(refId)) {
      this.refToCellData.set(refId, new CellData(this, refId));
    }

    return this.refToCellData.get(refId)!;
  }

  getActiveStream(refId: string): StreamsLike | undefined {
    const existing = this.activeStreams.get(refId);
    if (existing) {
      return existing;
    }

    // Check if the cell has metadata indicating an active run we can recover.
    // If there is a PID and lastRunID is set but no exit code we interpret that
    // as an active run.

    const cell = this.getCellProto(refId);
    const metadata = cell?.metadata ?? {};
    const hasPid =
      typeof metadata[RunmeMetadataKey.Pid] === "string" &&
      metadata[RunmeMetadataKey.Pid].length > 0;
    const hasExitCode =
      typeof metadata[RunmeMetadataKey.ExitCode] === "string" &&
      metadata[RunmeMetadataKey.ExitCode].length > 0;
    const runID =
      typeof metadata[RunmeMetadataKey.LastRunID] === "string"
        ? metadata[RunmeMetadataKey.LastRunID]
        : "";

    if (!cell || !hasPid || hasExitCode || !runID) {
      return undefined;
    }

    const runner = this.getRunner(cell);
    if (!runner || !runner.endpoint) {
      console.warn("Cannot recover stream; no runner available", {
        refId,
      });
      return undefined;
    }
    console.log("Trying to resume streams for cell", { refId, runID });
    const seqValue = metadata[RunmeMetadataKey.Sequence];
    const parsedSeq =
      typeof seqValue === "string" ? Number.parseInt(seqValue, 10) : Number.NaN;
    const sequence = Number.isNaN(parsedSeq) ? this.sequence : parsedSeq;

    return this.createAndBindStreams({ cell, runID, sequence, runner });
  }

  private createCodeCell(languageId?: string | null): parser_pb.Cell {
    const refID = `code_${crypto.randomUUID().replace(/-/g, "")}`;
    const normalizedLanguage = languageId?.trim().toLowerCase();
    const resolvedLanguage =
      normalizedLanguage && normalizedLanguage.length > 0
        ? normalizedLanguage
        : "markdown";
    return create(parser_pb.CellSchema, {
      metadata: {},
      refId: refID,
      languageId: resolvedLanguage,
      role: parser_pb.CellRole.USER,
      kind: parser_pb.CellKind.CODE,
      value: "",
    });
  }

  private createMarkupCell(): parser_pb.Cell {
    const refID = `markup_${crypto.randomUUID().replace(/-/g, "")}`;
    return create(parser_pb.CellSchema, {
      metadata: {},
      refId: refID,
      languageId: "markdown",
      role: parser_pb.CellRole.USER,
      kind: parser_pb.CellKind.MARKUP,
      value: "",
    });
  }

  private runCodeCellWithAppKernel(
    cell: parser_pb.Cell,
    runID: string,
    mode: AppKernelRunnerMode,
  ): void {
    const refId = cell.refId;
    const languageId = (cell.languageId ?? "").trim().toLowerCase();
    const source = cell.value ?? "";
    const runmeApi = createRunmeConsoleApi({
      resolveNotebook: () => this,
    });
    const notebooksApiBridgeServer = createNotebooksApiBridgeServer({
      notebooksApi: createHostNotebooksApi({
        resolveNotebook: this.resolveNotebookForAppKernel,
        listNotebooks: this.listNotebooksForAppKernel,
      }),
    });

    let stdout = "";
    let stderr = "";
    let finalExitCode = 0;

    appLogger.info("Starting AppKernel cell execution", {
      attrs: {
        scope: "appkernel.runner",
        refId,
        runID,
        languageId,
        mode,
      },
    });

    const hooks = {
      onStdout: (data: string) => {
        stdout += data;
      },
      onStderr: (data: string) => {
        stderr += data;
      },
      onExit: (code: number) => {
        finalExitCode = code;
      },
    };

    const runPromise =
      languageId === "javascript"
        ? mode === "sandbox"
          ? new SandboxJSKernel({
              bridge: {
                call: async (method, args) =>
                  this.handleSandboxAppKernelCall(
                    method,
                    args,
                    runmeApi,
                    notebooksApiBridgeServer,
                  ),
              },
              hooks,
            }).run(source)
          : new JSKernel({
              globals: createAppJsGlobals({
                runme: runmeApi,
                resolveNotebook: this.resolveNotebookForAppKernel,
                listNotebooks: this.listNotebooksForAppKernel,
              }),
              hooks,
            }).run(source)
        : Promise.resolve().then(() => {
            appLogger.error("Unsupported AppKernel language", {
              attrs: {
                scope: "appkernel.runner",
                refId,
                runID,
                languageId,
                mode,
              },
            });
            stderr += "AppKernel only supports javascript cells in v0.\n";
            finalExitCode = 1;
          });

    void runPromise
      .catch((error) => {
        finalExitCode = 1;
        appLogger.error("AppKernel cell execution failed", {
          attrs: {
            scope: "appkernel.runner",
            refId,
            runID,
            languageId,
            mode,
            error: String(error),
          },
        });
        stderr += `${String(error)}\n`;
      })
      .finally(() => {
        const updated = this.getCellProto(refId);
        if (!updated) {
          return;
        }
        const currentRunID =
          typeof updated.metadata?.[RunmeMetadataKey.LastRunID] === "string"
            ? updated.metadata[RunmeMetadataKey.LastRunID]
            : "";
        if (currentRunID !== runID) {
          return;
        }

        updated.metadata ??= {};
        updated.metadata[RunmeMetadataKey.ExitCode] = `${finalExitCode}`;
        delete updated.metadata[RunmeMetadataKey.Pid];

        // AppKernel runs are not terminal-stream based. Drop stale terminal MIME
        // outputs from prior remote runs so stdout/stderr are visible in the
        // notebook output renderer.
        updated.outputs = createStdTextOutputs(stdout, stderr);
        this.updateCell(updated);
        appLogger.info("Finished AppKernel cell execution", {
          attrs: {
            scope: "appkernel.runner",
            refId,
            runID,
            languageId,
            mode,
            exitCode: finalExitCode,
            stdoutBytes: stdout.length,
            stderrBytes: stderr.length,
          },
        });
      });
  }

  private async handleSandboxAppKernelCall(
    method: string,
    args: unknown[],
    runmeApi: RunmeConsoleApi,
    notebooksApiBridgeServer: NotebooksApiBridgeServer,
  ): Promise<unknown> {
    const target = args[0];
    switch (method) {
      case "runme.clear":
        return runmeApi.clear(target);
      case "runme.clearOutputs":
        return runmeApi.clearOutputs(target);
      case "runme.runAll":
        return runmeApi.runAll(target);
      case "runme.rerun":
        return runmeApi.rerun(target);
      case "runme.help":
        return runmeApi.help();
      case "runme.getCurrentNotebook": {
        const notebook = runmeApi.getCurrentNotebook();
        if (!notebook) {
          return null;
        }
        return {
          uri: notebook.getUri(),
          name: notebook.getName(),
          cellCount: notebook.getNotebook().cells.length,
        };
      }
      default:
        if (method.startsWith("notebooks.")) {
          return notebooksApiBridgeServer.handleMessage({
            method,
            args,
          });
        }
        throw new Error(`Unsupported sandbox AppKernel method: ${method}`);
    }
  }

  private runCodeCellWithJupyterKernel(
    cell: parser_pb.Cell,
    runID: string,
    runner: Runner,
  ): void {
    const refId = cell.refId;
    const source = cell.value ?? "";
    const serverName =
      (cell.metadata?.[RunmeMetadataKey.JupyterServerName] as string | undefined) ??
      "";
    const selectedKernelID =
      (cell.metadata?.[RunmeMetadataKey.JupyterKernelID] as string | undefined) ?? "";
    const selectedKernelName =
      (cell.metadata?.[RunmeMetadataKey.JupyterKernelName] as string | undefined) ?? "";

    if (!serverName || !selectedKernelID) {
      showToast({
        message: "Select a Jupyter kernel before running a Jupyter cell.",
        tone: "error",
      });
      const updated = this.getCellProto(refId);
      if (updated) {
        updated.metadata ??= {};
        updated.metadata[RunmeMetadataKey.ExitCode] = "1";
        delete updated.metadata[RunmeMetadataKey.Pid];
        updated.outputs = createStdTextOutputs(
          "",
          "Jupyter kernel is not selected for this cell.\n",
        );
        this.updateCell(updated);
      }
      return;
    }

    let channelsURL: string;
    try {
      const idToken = getBrowserAdapter().simpleAuth?.idToken?.trim() ?? "";
      channelsURL = buildJupyterChannelsWebSocketURL({
        runnerEndpoint: runner.endpoint,
        serverName,
        kernelId: selectedKernelID,
        authorization: idToken ? `Bearer ${idToken}` : "",
      });
    } catch (error) {
      showToast({
        message: "Failed to create Jupyter channels URL from runner endpoint.",
        tone: "error",
      });
      const updated = this.getCellProto(refId);
      if (updated) {
        updated.metadata ??= {};
        updated.metadata[RunmeMetadataKey.ExitCode] = "1";
        delete updated.metadata[RunmeMetadataKey.Pid];
        updated.outputs = createStdTextOutputs(
          "",
          `Invalid runner endpoint for Jupyter: ${runner.endpoint}\n`,
        );
        this.updateCell(updated);
      }
      return;
    }

    const socket = new WebSocket(channelsURL);
    this.activeJupyterSockets.set(refId, socket);

    const executeMsgID = crypto.randomUUID().replace(/-/g, "");
    const sessionID = crypto.randomUUID().replace(/-/g, "");
    const textDecoder = new TextDecoder();
    const richOutputs: parser_pb.CellOutput[] = [];
    let stdoutText = "";
    let stderrText = "";
    let textBytes = 0;
    let totalBytes = 0;
    let didTruncate = false;
    let completed = false;
    let sawExecuteReply = false;
    let sawIdle = false;
    let exitCode = 0;

    const appendTruncationNotice = () => {
      if (didTruncate) {
        return;
      }
      didTruncate = true;
      const notice = "[runme] Jupyter output truncated due to v0 output limits.\n";
      const noticeBytes = encodeCellOutputBytes(notice);
      const allowed = Math.max(
        0,
        Math.min(
          noticeBytes.length,
          JUPYTER_LIMITS.textBytesPerExecution - textBytes,
          JUPYTER_LIMITS.totalBytesPerExecution - totalBytes,
        ),
      );
      if (allowed <= 0) {
        return;
      }
      stderrText += textDecoder.decode(noticeBytes.slice(0, allowed));
      textBytes += allowed;
      totalBytes += allowed;
    };

    const appendText = (target: "stdout" | "stderr", value: string) => {
      if (!value) {
        return;
      }
      const encoded = encodeCellOutputBytes(value);
      const allowed = Math.max(
        0,
        Math.min(
          encoded.length,
          JUPYTER_LIMITS.textBytesPerExecution - textBytes,
          JUPYTER_LIMITS.totalBytesPerExecution - totalBytes,
        ),
      );
      if (allowed <= 0) {
        appendTruncationNotice();
        return;
      }
      const chunk = textDecoder.decode(encoded.slice(0, allowed));
      if (target === "stdout") {
        stdoutText += chunk;
      } else {
        stderrText += chunk;
      }
      textBytes += allowed;
      totalBytes += allowed;
      if (allowed < encoded.length) {
        appendTruncationNotice();
      }
    };

    const appendRichItem = (mime: string, data: Uint8Array) => {
      let payload = data;
      if (payload.length > JUPYTER_LIMITS.richBytesPerItem) {
        payload = payload.slice(0, JUPYTER_LIMITS.richBytesPerItem);
        appendTruncationNotice();
      }
      const allowed = Math.max(
        0,
        Math.min(payload.length, JUPYTER_LIMITS.totalBytesPerExecution - totalBytes),
      );
      if (allowed <= 0) {
        appendTruncationNotice();
        return;
      }
      const trimmed = payload.slice(0, allowed);
      totalBytes += trimmed.length;
      if (trimmed.length < payload.length) {
        appendTruncationNotice();
      }
      richOutputs.push(
        create(parser_pb.CellOutputSchema, {
          items: [
            create(parser_pb.CellOutputItemSchema, {
              mime,
              type: "Buffer",
              data: trimmed,
            }),
          ],
        }),
      );
    };

    const pushDisplayBundle = (bundle: Record<string, unknown> | undefined) => {
      if (!bundle || typeof bundle !== "object") {
        return;
      }
      if (typeof bundle["text/html"] === "string") {
        appendRichItem("text/html", encodeCellOutputBytes(bundle["text/html"] as string));
        return;
      }
      if (typeof bundle["image/png"] === "string") {
        appendRichItem("image/png", decodeBase64ToBytes(bundle["image/png"] as string));
        return;
      }
      if (typeof bundle["image/jpeg"] === "string") {
        appendRichItem("image/jpeg", decodeBase64ToBytes(bundle["image/jpeg"] as string));
        return;
      }
      if (typeof bundle["image/svg+xml"] === "string") {
        appendRichItem("image/svg+xml", encodeCellOutputBytes(bundle["image/svg+xml"] as string));
        return;
      }
      if (typeof bundle["text/plain"] === "string") {
        appendRichItem("text/plain", encodeCellOutputBytes(bundle["text/plain"] as string));
      }
    };

    const updateCellOutputs = (transient: boolean) => {
      const updated = this.getCellProto(refId);
      if (!updated) {
        return false;
      }
      const currentRunID =
        typeof updated.metadata?.[RunmeMetadataKey.LastRunID] === "string"
          ? updated.metadata[RunmeMetadataKey.LastRunID]
          : "";
      if (currentRunID !== runID) {
        return false;
      }

      const nextOutputs: parser_pb.CellOutput[] = [];
      if (stdoutText.length > 0 || stderrText.length > 0) {
        nextOutputs.push(
          create(parser_pb.CellOutputSchema, {
            items: [
              createTextOutputItem(MimeType.VSCodeNotebookStdOut, stdoutText),
              createTextOutputItem(MimeType.VSCodeNotebookStdErr, stderrText),
            ],
          }),
        );
      }
      nextOutputs.push(...richOutputs);
      updated.outputs = nextOutputs;
      this.updateCell(updated, { transient });
      return true;
    };

    const markCompleted = (code: number) => {
      if (completed) {
        return;
      }
      completed = true;
      const updated = this.getCellProto(refId);
      if (updated) {
        const currentRunID =
          typeof updated.metadata?.[RunmeMetadataKey.LastRunID] === "string"
            ? updated.metadata[RunmeMetadataKey.LastRunID]
            : "";
        if (currentRunID === runID) {
          updated.metadata ??= {};
          updated.metadata[RunmeMetadataKey.ExitCode] = `${code}`;
          delete updated.metadata[RunmeMetadataKey.Pid];
          this.updateCell(updated);
        }
      }
      this.activeJupyterSockets.delete(refId);
      try {
        socket.close();
      } catch {
        // no-op
      }
    };

    socket.onopen = () => {
      const executeRequest = {
        channel: "shell",
        header: {
          msg_id: executeMsgID,
          username: "runme",
          session: sessionID,
          date: new Date().toISOString(),
          msg_type: "execute_request",
          version: "5.3",
        },
        parent_header: {},
        metadata: {},
        content: {
          code: source,
          silent: false,
          store_history: true,
          user_expressions: {},
          allow_stdin: false,
          stop_on_error: true,
        },
      };
      socket.send(JSON.stringify(executeRequest));
    };

    socket.onmessage = (event) => {
      if (completed) {
        return;
      }
      if (typeof event.data !== "string") {
        return;
      }
      let message: Record<string, any>;
      try {
        message = JSON.parse(event.data) as Record<string, any>;
      } catch {
        return;
      }
      const msgType =
        (message.msg_type as string | undefined) ??
        (message.header?.msg_type as string | undefined) ??
        "";
      const parentMsgID = (message.parent_header?.msg_id as string | undefined) ?? "";
      if (parentMsgID && parentMsgID !== executeMsgID) {
        return;
      }

      switch (msgType) {
        case "stream": {
          const streamName = (message.content?.name as string | undefined) ?? "stdout";
          const text = (message.content?.text as string | undefined) ?? "";
          appendText(streamName === "stderr" ? "stderr" : "stdout", text);
          updateCellOutputs(true);
          break;
        }
        case "error": {
          const traceback = Array.isArray(message.content?.traceback)
            ? (message.content.traceback as string[]).join("\n")
            : "";
          const ename = (message.content?.ename as string | undefined) ?? "Error";
          const evalue = (message.content?.evalue as string | undefined) ?? "";
          appendText("stderr", `${ename}: ${evalue}\n${traceback}\n`);
          exitCode = 1;
          updateCellOutputs(true);
          break;
        }
        case "display_data":
        case "execute_result":
        case "update_display_data": {
          const dataBundle = message.content?.data as Record<string, unknown> | undefined;
          pushDisplayBundle(dataBundle);
          updateCellOutputs(true);
          break;
        }
        case "input_request": {
          appendText(
            "stderr",
            "Jupyter input_request is not supported in v0. Re-run with non-interactive code.\n",
          );
          exitCode = 1;
          updateCellOutputs(true);
          break;
        }
        case "execute_reply": {
          sawExecuteReply = true;
          if (message.content?.status && message.content.status !== "ok") {
            exitCode = 1;
          }
          if (sawIdle) {
            updateCellOutputs(false);
            markCompleted(exitCode);
          }
          break;
        }
        case "status": {
          if (message.content?.execution_state === "idle") {
            sawIdle = true;
            if (sawExecuteReply) {
              updateCellOutputs(false);
              markCompleted(exitCode);
            }
          }
          break;
        }
        case "clear_output": {
          // v0 behavior: ignore in-band clear_output; we clear at execution start.
          break;
        }
        default:
          break;
      }
    };

    socket.onerror = () => {
      if (completed) {
        return;
      }
      appendText(
        "stderr",
        "Connection lost; output may be incomplete. Re-run the cell.\n",
      );
      updateCellOutputs(false);
      markCompleted(1);
    };

    socket.onclose = () => {
      if (completed) {
        return;
      }
      // Long-running Jupyter executions can be quiet; completion is gated on
      // protocol signals, not "no message for N seconds".
      if (!sawExecuteReply || !sawIdle) {
        appendText(
          "stderr",
          "Connection lost; output may be incomplete. Re-run the cell.\n",
        );
        updateCellOutputs(false);
        markCompleted(1);
      }
    };

    appLogger.info("Started Jupyter kernel cell execution", {
      attrs: {
        scope: "jupyter.runner",
        refId,
        runID,
        serverName,
        kernelID: selectedKernelID,
        kernelName: selectedKernelName,
      },
    });
  }

  private getRunner(cell: parser_pb.Cell): Runner | undefined {
    const runnerMgr = getRunnersManager();
    const runnerName =
      (cell.metadata?.[RunmeMetadataKey.RunnerName] as string | undefined) ||
      "";
    return runnerMgr.getWithFallback(runnerName);
  }

  private createAndBindStreams({
    cell,
    runID,
    sequence,
    runner,
  }: {
    cell: parser_pb.Cell;
    runID: string;
    sequence: number;
    runner: Runner;
  }): StreamsLike | undefined {
    const streams = new Streams({
      knownID: `cell_${cell.refId}`,
      runID,
      sequence,
      options: {
        runnerEndpoint: runner.endpoint,
        interceptors: runner.interceptors ?? [],
        autoReconnect: runner.reconnect ?? true,
      },
    });
    this.activeStreams.set(cell.refId, streams);

    bindStreamsToCell({
      refId: cell.refId,
      streams,
      getCell: (ref) => this.getCellProto(ref),
      updateCell: (next, options) => this.updateCell(next, options),
    });

    return streams;
  }

  private rebuildIndex(): void {
    this.refToIndex.clear();
    this.notebook.cells.forEach((cell, index) => {
      if (cell?.refId) {
        this.refToIndex.set(cell.refId, index);
      }
    });
  }

  private computeHighestSequence(): number {
    return (this.notebook.cells ?? []).reduce((max, cell) => {
      const value = cell.metadata?.[RunmeMetadataKey.Sequence];
      const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
      if (Number.isNaN(parsed)) {
        return max;
      }
      return Math.max(max, parsed);
    }, 0);
  }

  private buildSnapshot(): NotebookSnapshot {
    return {
      uri: this.uri,
      name: this.name,
      loaded: this.loaded,
      notebook: clone(parser_pb.NotebookSchema, this.notebook),
    };
  }

  private emit(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error("NotebookData listener failed", error);
      }
    });
  }

  private async persist(): Promise<void> {
    if (!this.notebookStore) {
      return;
    }
    try {
      await this.notebookStore.save(this.uri, this.notebook);
    } catch (error) {
      console.error("NotebookData failed to persist notebook", {
        uri: this.uri,
        error,
      });
    }
  }

  private schedulePersist(): void {
    if (!this.notebookStore) {
      return;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, this.persistDelayMs);
  }
}

export class CellData {
  private listeners: Set<Listener> = new Set();
  private lastSnapshotKey: string | null = null;
  private unsubscribeNotebook: (() => void) | null = null;
  private cachedSnapshot: parser_pb.Cell | null = null;
  private runIdListeners: Set<(runID: string) => void> = new Set();

  constructor(private readonly notebook: NotebookData, private readonly refId: string) {
    // TODO(jlewi): Need to rationalize the design and management of snapshots
    this.cachedSnapshot = notebook.getCellSnapshot(refId);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeToContentChange(listener: Listener): () => void {
    return this.subscribe(listener);
  }

  subscribeToRunIDChange(listener: (runID: string) => void): () => void {
    this.runIdListeners.add(listener);
    return () => {
      this.runIdListeners.delete(listener);
    };
  }

  private emitRunIDChange(runID: string): void {
    this.runIdListeners.forEach((listener) => {
      try {
        listener(runID);
      } catch (err) {
        console.error("CellData runID listener failed", err);
      }
    });
  }

  private emit(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (err) {
        console.error("CellData listener failed", err);
      }
    });
  }

  emitContentChange(): void {
    this.emit();
  }

  updateCachedSnapshotFromNotebook(cell: parser_pb.Cell | null): void {
    this.cachedSnapshot = cell ? clone(parser_pb.CellSchema, cell) : null;
  }

  /** Latest cloned snapshot of this cell. */
  get snapshot(): parser_pb.Cell | null {
    return this.cachedSnapshot;
  }

  setValue(value: string): void {
    const cell = this.cachedSnapshot;
    if (!cell) return;
    cell.value = value;
    this.notebook.updateCell(cell);
  }

  setLanguage(languageId: string): void {
    const cell = this.cachedSnapshot;
    if (!cell) return;
    cell.languageId = languageId;
    this.notebook.updateCell(cell);
  }

  addBefore(languageId?: string | null): parser_pb.Cell | null {
    return this.notebook.addCodeCellBefore(this.refId, languageId);
  }

  addAfter(languageId?: string | null): parser_pb.Cell | null {
    return this.notebook.addCodeCellAfter(this.refId, languageId);
  }

  remove(): void {
    this.notebook.removeCell(this.refId);
  }

  run(): void {
    const cell = this.snapshot;
    if (!cell) return;
    const runID = this.notebook.runCodeCell(cell);
    // Update the snapshot after running to pick up any metadata changes.
    this.cachedSnapshot = this.notebook.getCellSnapshot(this.refId);
    this.emitRunIDChange(runID ?? "");
  }

  getStreams(): StreamsLike | undefined {
    return this.notebook.getActiveStream(this.refId);
  }

  getRunID(): string {
    const snap = this.snapshot;
    const id = snap?.metadata?.[RunmeMetadataKey.LastRunID];
    return typeof id === "string" ? id : "";
  }

  setRunner(name: string): void {
    const snap = this.snapshot;
    if (!snap) return;
    snap.metadata ??= {};
    if (name === DEFAULT_RUNNER_PLACEHOLDER) {
      delete (snap.metadata as any)[RunmeMetadataKey.RunnerName];      
    } else {
      (snap.metadata as any)[RunmeMetadataKey.RunnerName] = name;      
    }
    this.notebook.updateCell(snap);
  }

  setJupyterKernel(selection: {
    runnerName?: string;
    serverName: string;
    kernelId: string;
    kernelName: string;
  }): void {
    const snap = this.snapshot;
    if (!snap) return;
    snap.metadata ??= {};
    (snap.metadata as any)[RunmeMetadataKey.JupyterServerName] =
      selection.serverName;
    (snap.metadata as any)[RunmeMetadataKey.JupyterKernelID] =
      selection.kernelId;
    (snap.metadata as any)[RunmeMetadataKey.JupyterKernelName] =
      selection.kernelName;
    if (selection.runnerName && selection.runnerName !== DEFAULT_RUNNER_PLACEHOLDER) {
      (snap.metadata as any)[RunmeMetadataKey.RunnerName] = selection.runnerName;
    }
    this.notebook.updateCell(snap);
  }

  clearJupyterKernel(): void {
    const snap = this.snapshot;
    if (!snap) return;
    snap.metadata ??= {};
    delete (snap.metadata as any)[RunmeMetadataKey.JupyterServerName];
    delete (snap.metadata as any)[RunmeMetadataKey.JupyterKernelID];
    delete (snap.metadata as any)[RunmeMetadataKey.JupyterKernelName];
    this.notebook.updateCell(snap);
  }

  getJupyterServerName(): string {
    const value = this.snapshot?.metadata?.[RunmeMetadataKey.JupyterServerName];
    return typeof value === "string" ? value : "";
  }

  getJupyterKernelID(): string {
    const value = this.snapshot?.metadata?.[RunmeMetadataKey.JupyterKernelID];
    return typeof value === "string" ? value : "";
  }

  getJupyterKernelName(): string {
    const value = this.snapshot?.metadata?.[RunmeMetadataKey.JupyterKernelName];
    return typeof value === "string" ? value : "";
  }

  update(cell: parser_pb.Cell): void {
    this.cachedSnapshot = clone(parser_pb.CellSchema, cell);
    this.notebook.updateCell(cell);
  }

  /** Runner name from metadata, validated against known runners; falls back to default placeholder. */
  getRunnerName(): string {
    const requested =
      this.snapshot?.metadata?.[RunmeMetadataKey.RunnerName] ??
      null;
    if (requested) {
      return requested;
    }
    return DEFAULT_RUNNER_PLACEHOLDER;
  }
}
