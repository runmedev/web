import { clone, create } from "@bufbuild/protobuf";

import { parser_pb, RunmeMetadataKey, MimeType } from "../contexts/CellContext";
import LocalNotebooks from "../storage/local";
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
  Streams,
  Heartbeat,
  genRunID,
  type StreamsLike,
} from "@runmedev/renderers";
import { buildExecuteRequest } from "./runme";
import type { Runner } from "./runner";

export type NotebookSnapshot = {
  readonly uri: string;
  readonly name: string;
  readonly notebook: parser_pb.Notebook;
  readonly loaded: boolean;
};

type Listener = () => void;

export type StreamBinder = (args: {
  refId: string;
  streams: StreamsLike;
  getCell: (refId: string) => parser_pb.Cell | null;
  updateCell: (cell: parser_pb.Cell) => void;
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
    const prev = textDecoder.decode(item.data ?? new Uint8Array());
    const next = prev + textDecoder.decode(chunk);
    item.data = textEncoder.encode(next);

    if (!updated.outputs.includes(output)) {
      updated.outputs = [...updated.outputs, output];
    }

    updateCell(updated);
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
    updateCell(updated);
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
      updateCell(updated);
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
  private notebookStore: LocalNotebooks | null;
  private sequence = 0;
  private snapshotCache: NotebookSnapshot;
  private loaded: boolean;
  private activeStreams: Map<string, StreamsLike> = new Map();

  private refToCellData: Map<string, CellData> = new Map();

  constructor({
    notebook,
    uri,
    name,
    notebookStore,
    loaded = false,
  }: {
    notebook: parser_pb.Notebook;
    uri: string;
    name: string;
    notebookStore: LocalNotebooks | null;
    loaded?: boolean;
  }) {
    this.uri = uri;
    this.name = name;
    this.notebook = clone(parser_pb.NotebookSchema, notebook);
    this.notebookStore = notebookStore;
    this.loaded = loaded;
    this.sequence = this.computeHighestSequence();
    this.rebuildIndex();
    this.snapshotCache = this.buildSnapshot();
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

  /** Replace the in-memory notebook. */
  loadNotebook(notebook: parser_pb.Notebook): void {
    this.notebook = clone(parser_pb.NotebookSchema, notebook);
    this.rebuildIndex();
    this.validateCells();
    this.sequence = this.computeHighestSequence();
    this.loaded = true;
    this.snapshotCache = this.buildSnapshot();
    this.emit();
    void this.persist();
  }

  updateCell(cell: parser_pb.Cell): void {
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

    this.snapshotCache = this.buildSnapshot();
    this.emit();
    void this.persist();
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
    void this.persist();
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
    void this.persist();
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
    void this.persist();
  }

  setName(name: string): void {
    this.name = name;
    this.snapshotCache = this.buildSnapshot();
    this.emit();
    void this.persist();
  }

  setUri(uri: string): void {
    this.uri = uri;
    this.snapshotCache = this.buildSnapshot();
    this.emit();
    void this.persist();
  }

  // Returns the runID if the cell was started successfully.
  // empty string otherwise
  runCodeCell(cell: parser_pb.Cell): string {
    if (cell.kind !== parser_pb.CellKind.CODE) {
      console.warn("Cannot run non-code cell", cell.refId);
      return "";
    }

    const runner = this.getRunner(cell);
    if (!runner || !runner.endpoint) {
      console.error("No runner available for cell", cell.refId);
      return "";
    }

    // If there is an existing active stream for this cell, close it before
    // starting a new run to avoid leaking sockets.
    const existing = this.activeStreams.get(cell.refId);
    existing?.close();

    // Bump sequence and attach to metadata.
    this.sequence += 1;
    cell.metadata ??= {};
    delete cell.metadata[RunmeMetadataKey.ExitCode];
    delete cell.metadata[RunmeMetadataKey.Pid];
    cell.metadata[RunmeMetadataKey.Sequence] = this.sequence.toString();

    // Strip outputs except terminal to avoid stale output accumulation.
    cell.outputs = cell.outputs.filter((o) =>
      o.items.some((oi) => oi.mime === MimeType.StatefulRunmeTerminal),
    );

    const runID = genRunID();
    cell.metadata[RunmeMetadataKey.LastRunID] = runID;
    this.updateCell(cell);

    const streams = this.createAndBindStreams({
      cell,
      runID,
      sequence: this.sequence,
      runner,
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
      normalizedLanguage && normalizedLanguage.length > 0 ? normalizedLanguage : "js";
    return create(parser_pb.CellSchema, {
      metadata: {},
      refId: refID,
      languageId: resolvedLanguage,
      role: parser_pb.CellRole.USER,
      kind: parser_pb.CellKind.CODE,
      value: "",
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
      updateCell: (next) => this.updateCell(next),
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
}

export class CellData {
  private listeners: Set<Listener> = new Set();
  private lastSnapshotKey: string | null = null;
  private unsubscribeNotebook: (() => void) | null = null;
  private cachedSnapshot: parser_pb.Cell | null = null;
  private runIdListeners: Set<(runID: string) => void> = new Set();

  // Assign a unique ID to each CellData to help with debugging.
  private cellDataID: string = crypto.randomUUID();

  constructor(private readonly notebook: NotebookData, private readonly refId: string) {    
    // TODO(jlewi): Need to rationalize the design and management of snapshots
    this.cachedSnapshot = notebook.getCellSnapshot(refId); 

    // Check if there are active streams for this cell.
    const streams = this.getStreams()
    if (streams) {
      console.log(`CellData ${this.cellDataID} found active streams for cell ${refId} runID ${this.getRunID()} `);
    }
    console.log(`Created CellData ${this.cellDataID}`);
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
    console.log(`Running CellData ${this.cellDataID}`);
    const cell = this.snapshot;
    if (!cell) return;
    const runID = this.notebook.runCodeCell(cell);
    console.log("Started run for cell", { refId: this.refId, runID });
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
