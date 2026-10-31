import {
  type ConsoleCell,
  coerceRestoredCells,
  createDraftCell,
  createResultOutput,
  createStdTextOutputs,
} from "../../components/AppConsole/model";
import {
  type AppConsoleStorageLike,
  appConsoleStorage,
} from "../../components/AppConsole/storage";
import { boundedStorage } from "../boundedStorage";
import { appLogger } from "../logging/runtime";

type Listener = () => void;

type OutputBuffers = {
  stdout: string;
  stderr: string;
};

export type AppConsoleSnapshot = {
  sessionId: string | null;
  hydrated: boolean;
  loadError: string | null;
  cells: ConsoleCell[];
};

export type AppConsoleExecutionHandle = {
  cellId: string;
  source: string;
};

const DEFAULT_PERSIST_DELAY_MS = 150;

function withTrailingNewline(message: string): string {
  if (!message) {
    return "";
  }
  return message.endsWith("\n") ? message : `${message}\n`;
}

export class AppConsoleData {
  private readonly listeners = new Set<Listener>();
  private readonly outputBuffers = new Map<string, OutputBuffers>();
  private readonly storage: AppConsoleStorageLike;
  private readonly persistDelayMs: number;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private hydratePromise: Promise<void> | null = null;
  private persistenceEnabled = true;
  private hydrationController: AbortController | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private releaseFrozen = false;
  private snapshotCache: AppConsoleSnapshot = {
    sessionId: null,
    hydrated: false,
    loadError: null,
    cells: [createDraftCell(1)],
  };

  constructor(options?: {
    storage?: AppConsoleStorageLike;
    persistDelayMs?: number;
  }) {
    this.storage = options?.storage ?? appConsoleStorage;
    this.persistDelayMs = options?.persistDelayMs ?? DEFAULT_PERSIST_DELAY_MS;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): AppConsoleSnapshot {
    return this.snapshotCache;
  }

  async hydrate(): Promise<void> {
    if (this.snapshotCache.hydrated) {
      return;
    }
    if (this.hydratePromise) {
      return this.hydratePromise;
    }

    this.hydratePromise = this.doHydrate().finally(() => {
      this.hydratePromise = null;
    });
    return this.hydratePromise;
  }

  setDraftSource(source: string): void {
    if (
      !this.snapshotCache.hydrated &&
      source !== this.getCurrentDraftCell()?.source
    )
      this.prepareForExecution();
    if (this.releaseFrozen)
      throw new Error("App Console is frozen for an upgrade");
    this.updateCells((cells) => {
      const draftIndex = this.findDraftIndex(cells);
      if (draftIndex < 0) {
        return [...cells, createDraftCell(cells.length + 1, source)];
      }

      const draft = cells[draftIndex];
      if (draft.source === source) {
        return cells;
      }

      const next = [...cells];
      next[draftIndex] = {
        ...draft,
        source,
      };
      return next;
    });
  }

  copyCellSourceToDraft(cellId: string): void {
    const source =
      this.snapshotCache.cells.find((cell) => cell.id === cellId)?.source ??
      null;
    if (source === null) {
      return;
    }
    this.setDraftSource(source);
  }

  startDraftExecution(): AppConsoleExecutionHandle | null {
    this.prepareForExecution();
    if (this.releaseFrozen)
      throw new Error("App Console is frozen for an upgrade");
    const draft = this.getCurrentDraftCell();
    if (!draft || draft.source.trim() === "") {
      return null;
    }

    const startedAt = new Date().toISOString();
    this.outputBuffers.set(draft.id, {
      stdout: "",
      stderr: "",
    });
    this.updateCells((cells) =>
      cells.map((cell) =>
        cell.id === draft.id
          ? {
              ...cell,
              status: "running",
              startedAt,
              completedAt: undefined,
              exitCode: undefined,
              outputs: [],
            }
          : cell
      )
    );

    return {
      cellId: draft.id,
      source: draft.source,
    };
  }

  startExternalExecution(source: string): AppConsoleExecutionHandle | null {
    this.prepareForExecution();
    if (this.releaseFrozen)
      throw new Error("App Console is frozen for an upgrade");
    if (source.trim() === "") {
      return null;
    }

    const startedAt = new Date().toISOString();
    const runningCell: ConsoleCell = {
      ...createDraftCell(0, source),
      status: "running",
      startedAt,
      outputs: [],
    };
    this.outputBuffers.set(runningCell.id, {
      stdout: "",
      stderr: "",
    });

    this.updateCells((cells) => {
      const draftIndex = this.findDraftIndex(cells);
      if (draftIndex < 0) {
        return this.reindexCells([
          ...cells,
          runningCell,
          createDraftCell(cells.length + 2),
        ]);
      }

      const next = [...cells];
      next.splice(draftIndex, 0, runningCell);
      return this.reindexCells(next);
    });

    return {
      cellId: runningCell.id,
      source,
    };
  }

  appendStdout(cellId: string, chunk: string): void {
    this.appendOutput(cellId, "stdout", chunk);
  }

  appendStderr(cellId: string, chunk: string): void {
    this.appendOutput(cellId, "stderr", chunk);
  }

  completeExecution(
    cellId: string,
    result: { exitCode: number; result?: unknown }
  ): void {
    const buffers = this.outputBuffers.get(cellId) ?? {
      stdout: "",
      stderr: "",
    };
    this.outputBuffers.delete(cellId);
    const completedAt = new Date().toISOString();
    const nextStatus: ConsoleCell["status"] =
      result.exitCode === 0 ? "success" : "error";

    this.updateCells((cells) => {
      const next = cells.map((cell) =>
        cell.id === cellId
          ? {
              ...cell,
              status: nextStatus,
              completedAt,
              exitCode: result.exitCode,
              outputs: [
                ...createStdTextOutputs(buffers.stdout, buffers.stderr),
                ...createResultOutput(result.result),
              ],
            }
          : cell
      );

      return this.ensureTrailingDraft(next);
    });
  }

  failExecution(
    cellId: string,
    error: { exitCode?: number; message?: string }
  ): void {
    const current = this.outputBuffers.get(cellId) ?? {
      stdout: "",
      stderr: "",
    };
    const stderr = `${current.stderr}${withTrailingNewline(error.message ?? "")}`;
    this.outputBuffers.delete(cellId);
    const completedAt = new Date().toISOString();

    this.updateCells((cells) => {
      const next = cells.map((cell) =>
        cell.id === cellId
          ? {
              ...cell,
              status: "error" as const,
              completedAt,
              exitCode: error.exitCode ?? 1,
              outputs: createStdTextOutputs(current.stdout, stderr),
            }
          : cell
      );

      return this.ensureTrailingDraft(next);
    });
  }

  dispose(): void {
    this.hydrationController?.abort();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.listeners.clear();
    this.outputBuffers.clear();
  }

  /** History must never gate execution. Preserve the live draft and detach from
   * unread history; late reads cannot replace these cells or enable persistence. */
  private prepareForExecution(): void {
    if (!this.snapshotCache.hydrated) this.useTemporaryHistory();
  }

  private useTemporaryHistory(): void {
    this.hydrationController?.abort();
    this.persistenceEnabled = false;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.replaceSnapshot({
      ...this.snapshotCache,
      hydrated: true,
      loadError:
        "Console history is unavailable. New commands and drafts are kept only in this tab; saved history has not been changed.",
    });
  }

  private async doHydrate(): Promise<void> {
    const controller = new AbortController();
    this.hydrationController = controller;
    try {
      await boundedStorage(
        "console.hydrate",
        (signal) => this.restoreHistory(signal),
        controller.signal,
        5000
      );
    } catch (error) {
      appLogger.warn("Console history unavailable; retaining in-memory cells", {
        attrs: {
          scope: "app_console.history",
          errorName: error instanceof Error ? error.name : "unknown",
        },
      });
      if (!this.snapshotCache.hydrated) this.useTemporaryHistory();
    } finally {
      this.hydrationController = null;
    }
  }

  private async restoreHistory(signal: AbortSignal): Promise<void> {
    const now = new Date().toISOString();
    const restored = await this.storage.loadLatestSession(signal);
    signal.throwIfAborted();
    if (!restored) {
      const session = await this.storage.createSession(now, signal);
      signal.throwIfAborted();
      const nextCells = this.ensureTrailingDraft(this.snapshotCache.cells);
      await this.persistRows(nextCells, session.id, now, signal);
      signal.throwIfAborted();
      this.replaceSnapshot({
        sessionId: session.id,
        hydrated: true,
        loadError: null,
        cells: nextCells,
      });
      return;
    }

    const recovered = coerceRestoredCells(restored.cells, now);
    // Recovery is an in-memory projection. Save it with the next user edit,
    // rather than making opening history depend on a repair write.

    signal.throwIfAborted();
    this.replaceSnapshot({
      sessionId: restored.session.id,
      hydrated: true,
      loadError: null,
      cells: this.reindexCells(recovered.cells),
    });
  }

  private appendOutput(
    cellId: string,
    kind: keyof OutputBuffers,
    chunk: string
  ): void {
    if (!chunk) {
      return;
    }

    const current = this.outputBuffers.get(cellId) ?? {
      stdout: "",
      stderr: "",
    };
    const nextBuffers: OutputBuffers =
      kind === "stdout"
        ? {
            stdout: `${current.stdout}${chunk}`,
            stderr: current.stderr,
          }
        : {
            stdout: current.stdout,
            stderr: `${current.stderr}${chunk}`,
          };

    this.outputBuffers.set(cellId, nextBuffers);
    this.updateCells((cells) =>
      cells.map((cell) =>
        cell.id === cellId
          ? {
              ...cell,
              outputs: createStdTextOutputs(
                nextBuffers.stdout,
                nextBuffers.stderr
              ),
            }
          : cell
      )
    );
  }

  private getCurrentDraftCell(): ConsoleCell | null {
    const cells = this.snapshotCache.cells;
    const draft = cells[cells.length - 1];
    return draft?.status === "draft" ? draft : null;
  }

  private findDraftIndex(cells: ConsoleCell[]): number {
    return cells.findIndex((cell) => cell.status === "draft");
  }

  private reindexCells(cells: ConsoleCell[]): ConsoleCell[] {
    return cells.map((cell, index) => ({
      ...cell,
      index: index + 1,
    }));
  }

  private ensureTrailingDraft(cells: ConsoleCell[]): ConsoleCell[] {
    const draftIndex = this.findDraftIndex(cells);
    if (draftIndex >= 0) {
      const ordered = this.reindexCells(cells);
      const draft = ordered[draftIndex];
      if (draftIndex === ordered.length - 1) {
        return ordered;
      }

      const next = [...ordered];
      next.splice(draftIndex, 1);
      next.push(draft);
      return this.reindexCells(next);
    }

    return this.reindexCells([...cells, createDraftCell(cells.length + 1)]);
  }

  private updateCells(
    updater: (cells: ConsoleCell[]) => ConsoleCell[],
    options?: { persist?: boolean }
  ): void {
    const nextCells = updater(this.snapshotCache.cells);
    if (nextCells === this.snapshotCache.cells) {
      return;
    }

    this.replaceSnapshot({
      ...this.snapshotCache,
      cells: nextCells,
    });

    if (options?.persist !== false) {
      this.schedulePersist();
    }
  }

  private replaceSnapshot(next: AppConsoleSnapshot): void {
    this.snapshotCache = next;
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error("AppConsoleData listener failed", error);
      }
    });
  }

  private schedulePersist(): void {
    if (!this.persistenceEnabled || !this.snapshotCache.sessionId) {
      return;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist().catch((error) => {
        console.error("Failed to persist App Console state", error);
      });
    }, this.persistDelayMs);
  }

  /** Flush the latest draft after earlier writes; failure is an upgrade blocker. */
  async flushForRelease(signal?: AbortSignal): Promise<void> {
    if (this.hydratePromise) await this.hydratePromise;
    // A timed-out reload must not freeze the console when hydration resolves late.
    signal?.throwIfAborted();
    if (!this.snapshotCache.hydrated) return;
    if (!this.persistenceEnabled)
      throw new Error("App Console drafts cannot be saved");
    if (this.snapshotCache.cells.some((cell) => cell.status === "running"))
      throw new Error("App Console is running");
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.releaseFrozen = true;
    try {
      await this.persist();
    } catch (error) {
      this.releaseFrozen = false;
      throw error;
    }
  }

  /** A failed preparation leaves this tab editable; no reload was authorized. */
  resumeAfterFailedPreparation(): void {
    this.releaseFrozen = false;
  }

  private persist(): Promise<void> {
    const sessionId = this.snapshotCache.sessionId;
    if (!this.persistenceEnabled || !sessionId) {
      return Promise.resolve();
    }
    const cells = this.snapshotCache.cells;
    this.persistChain = this.persistChain
      .catch(() => {})
      .then(() => this.persistRows(cells, sessionId, new Date().toISOString()));
    return this.persistChain;
  }

  private async persistRows(
    cells: ConsoleCell[],
    sessionId: string,
    updatedAt: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.storage.saveCells(
      cells.map((cell) => ({
        ...cell,
        sessionId,
        updatedAt,
      })),
      signal
    );
    signal?.throwIfAborted();
    await this.storage.touchSession(sessionId, updatedAt, signal);
  }
}
