import { useEffect, useState } from "react";

import { appLogger } from "./logging/runtime";
import {
  fetchDriveItemWithParents,
  parseDriveItem,
} from "../storage/drive";
import { NotebookStoreItemType } from "../storage/notebook";

const STORAGE_KEY = "runme/drive-link-intents";
const STATUS_TAB_URI = "system://drive-link-status";
const PROCESS_INTENT_TIMEOUT_MS = 20_000;

export type DriveLinkIntentStatus =
  | "pending"
  | "processing"
  | "waiting_for_auth"
  | "failed";

export type DriveLinkIntentAction =
  | "open_shared_file"
  | "mount_shared_folder";

export interface DriveLinkIntent {
  id: string;
  remoteUri: string;
  action: DriveLinkIntentAction;
  source: "url" | "manual";
  status: DriveLinkIntentStatus;
  createdAt: string;
  updatedAt: string;
  retryCount: number;
  lastErrorMessage?: string;
}

export interface DriveLinkCoordinatorSnapshot {
  intents: DriveLinkIntent[];
  authBlocked: boolean;
  lastErrorMessage: string | null;
}

type DriveLinkCoordinatorDeps = {
  ensureAccessToken: (options?: { interactive?: boolean }) => Promise<string>;
  updateFolder: (remoteUri: string, name?: string) => Promise<string>;
  addFile: (remoteUri: string, name?: string) => Promise<string>;
  addWorkspaceItem: (localUri: string) => void;
  getWorkspaceItems: () => string[];
  openNotebook: (localUri: string) => Promise<void> | void;
};

function createIntentId(): string {
  try {
    const randomUUID = globalThis.crypto?.randomUUID;
    if (typeof randomUUID === "function") {
      return randomUUID.call(globalThis.crypto);
    }
  } catch {
    // Ignore UUID failures and fall back below.
  }
  return `drive-intent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isLocalUri(uri: string): boolean {
  return (
    uri.startsWith("local://") ||
    uri.startsWith("fs://") ||
    uri.startsWith("contents://")
  );
}

export function isDriveAuthError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return [
    "auth",
    "oauth",
    "token",
    "popup",
    "consent",
    "required",
    "access denied",
    "not configured",
  ].some((token) => message.includes(token));
}

export function isDriveMissingOrAccessDeniedError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes("drive request failed (404") ||
    message.includes("drive request failed (403") ||
    message.includes("not found") ||
    message.includes("insufficientfilepermissions") ||
    message.includes("insufficient permissions") ||
    message.includes("permission denied") ||
    message.includes("forbidden")
  );
}

function toDriveLinkAccessErrorMessage(remoteUri: string): string {
  return `Failed to load shared Drive link (${remoteUri}). The file may not exist or you may not have permission to access it.`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await new Promise<T>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      promise.then(resolve, reject);
    });
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

function loadIntents(): DriveLinkIntent[] {
  if (typeof window === "undefined" || !window.localStorage) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as DriveLinkIntent[] | null;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (intent): intent is DriveLinkIntent =>
          Boolean(intent?.id) &&
          Boolean(intent?.remoteUri) &&
          Boolean(intent?.action) &&
          Boolean(intent?.status),
      )
      .map((intent) => ({
        ...intent,
        // "processing" can be left behind in localStorage after reload/crash.
        // Treat it as pending so the coordinator can resume it.
        status: intent.status === "processing" ? "pending" : intent.status,
      }));
  } catch {
    return [];
  }
}

function persistIntents(intents: DriveLinkIntent[]): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  try {
    if (intents.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(intents));
  } catch {
    // Ignore persistence failures.
  }
}

class DriveLinkCoordinatorRuntime {
  private intents = loadIntents();
  private lastMessage: string | null = null;

  private listeners = new Set<() => void>();

  private deps: DriveLinkCoordinatorDeps | null = null;

  private processing = false;

  configure(deps: DriveLinkCoordinatorDeps | null): void {
    this.deps = deps;
  }

  getStatusTabUri(): string {
    return STATUS_TAB_URI;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): DriveLinkCoordinatorSnapshot {
    const authBlocked = this.intents.some(
      (intent) => intent.status === "waiting_for_auth",
    );
    const intentErrorMessage =
      [...this.intents]
        .reverse()
        .find((intent) => intent.lastErrorMessage)?.lastErrorMessage ?? null;
    return {
      intents: this.intents.map((intent) => ({ ...intent })),
      authBlocked,
      lastErrorMessage: this.lastMessage ?? intentErrorMessage,
    };
  }

  hasVisibleStatus(): boolean {
    return this.intents.length > 0;
  }

  async enqueue(
    remoteUri: string,
    source: "url" | "manual" = "manual",
  ): Promise<void> {
    const action = this.resolveAction(remoteUri);
    const existing = this.intents.find(
      (intent) =>
        intent.remoteUri === remoteUri && intent.action === action,
    );
    if (existing) {
      return;
    }

    this.lastMessage = null;
    this.intents = [
      ...this.intents,
      {
        id: createIntentId(),
        remoteUri,
        action,
        source,
        status: "pending",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        retryCount: 0,
      },
    ];
    this.persistAndEmit();
    await this.processPending();
  }

  consumeUrlIntentFromLocation(): boolean {
    if (typeof window === "undefined") {
      return false;
    }

    const url = new URL(window.location.href);
    const doc = url.searchParams.get("doc");
    if (!doc || isLocalUri(doc)) {
      return false;
    }

    try {
      this.resolveAction(doc);
    } catch {
      return false;
    }

    void this.enqueue(doc, "url");
    url.searchParams.delete("doc");
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    return true;
  }

  async retryAuthAndProcess(): Promise<void> {
    if (this.processing) {
      this.lastMessage =
        "Shared links are already being processed. Please wait for the current attempt to finish.";
      appLogger.info("Retry requested while shared links are still processing", {
        attrs: {
          scope: "storage.drive.share",
          code: "DRIVE_SHARED_LINK_RETRY_IGNORED_PROCESSING",
        },
      });
      this.persistAndEmit();
      return;
    }

    this.lastMessage = "Retrying shared links...";
    appLogger.info("Retry requested for shared Drive links", {
      attrs: {
        scope: "storage.drive.share",
        code: "DRIVE_SHARED_LINK_RETRY_REQUESTED",
      },
    });
    this.intents = this.intents.map((intent) => ({
      ...intent,
      status:
        intent.status === "waiting_for_auth" ||
        intent.status === "failed" ||
        intent.status === "processing"
          ? "pending"
          : intent.status,
      updatedAt: nowIso(),
    }));
    this.persistAndEmit();
    await this.processPending();
  }

  async loginToDriveAndProcess(): Promise<void> {
    const deps = this.deps;
    if (!deps) {
      return;
    }
    try {
      await deps.ensureAccessToken({ interactive: true });
    } catch (error) {
      if (isDriveAuthError(error)) {
        this.lastMessage = String(error);
        this.intents = this.intents.map((intent) =>
          intent.status === "waiting_for_auth" || intent.status === "failed"
            ? {
                ...intent,
                status: "waiting_for_auth",
                lastErrorMessage: String(error),
                updatedAt: nowIso(),
              }
            : intent,
        );
        this.persistAndEmit();
      }
      return;
    }

    await this.retryAuthAndProcess();
  }

  async processPending(): Promise<void> {
    if (this.processing || !this.deps) {
      return;
    }
    this.processing = true;
    try {
      for (const intent of [...this.intents]) {
        if (
          intent.status !== "pending" &&
          intent.status !== "waiting_for_auth" &&
          intent.status !== "failed" &&
          intent.status !== "processing"
        ) {
          continue;
        }
        await this.processIntent(intent.id);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processIntent(intentId: string): Promise<void> {
    const deps = this.deps;
    if (!deps) {
      return;
    }

    const intent = this.intents.find((item) => item.id === intentId);
    if (!intent) {
      return;
    }

    this.updateIntent(intentId, {
      status: "processing",
      retryCount: intent.retryCount + 1,
      lastErrorMessage: undefined,
    });

    try {
      await withTimeout(
        (async () => {
          await deps.ensureAccessToken({ interactive: false });

          if (intent.action === "mount_shared_folder") {
            const localFolderUri = await deps.updateFolder(intent.remoteUri);
            if (!deps.getWorkspaceItems().includes(localFolderUri)) {
              deps.addWorkspaceItem(localFolderUri);
            }
          } else {
            const { item, parents } = await fetchDriveItemWithParents(
              intent.remoteUri,
              deps.ensureAccessToken,
            );
            const parentFolder = parents.find(
              (parent) => parent.type === NotebookStoreItemType.Folder,
            );
            if (parentFolder) {
              const localFolderUri = await deps.updateFolder(
                parentFolder.uri,
                parentFolder.name,
              );
              if (!deps.getWorkspaceItems().includes(localFolderUri)) {
                deps.addWorkspaceItem(localFolderUri);
              }
            }

            const localFileUri = await deps.addFile(item.uri, item.name);
            await deps.openNotebook(localFileUri);
          }
        })(),
        PROCESS_INTENT_TIMEOUT_MS,
        "Timed out while loading the shared Drive link.",
      );

      this.lastMessage = null;
      this.intents = this.intents.filter((item) => item.id !== intentId);
      this.persistAndEmit();
    } catch (error) {
      const message = String(error);
      const waitingForAuth = isDriveAuthError(error);
      const terminalMissingOrAccessDenied =
        isDriveMissingOrAccessDeniedError(error);
      appLogger.error("Failed to process shared Drive link", {
        attrs: {
          scope: "storage.drive.share",
          code: "DRIVE_SHARED_LINK_PROCESS_FAILED",
          remoteUri: intent.remoteUri,
          action: intent.action,
          error: message,
        },
      });
      if (terminalMissingOrAccessDenied) {
        this.lastMessage = toDriveLinkAccessErrorMessage(intent.remoteUri);
        this.intents = this.intents.filter((item) => item.id !== intentId);
        this.persistAndEmit();
        return;
      }

      this.lastMessage = message;
      this.updateIntent(intentId, {
        status: waitingForAuth ? "waiting_for_auth" : "failed",
        lastErrorMessage: message,
      });
    }
  }

  private resolveAction(remoteUri: string): DriveLinkIntentAction {
    const parsed = parseDriveItem(remoteUri);
    return parsed.type === NotebookStoreItemType.Folder
      ? "mount_shared_folder"
      : "open_shared_file";
  }

  private updateIntent(
    intentId: string,
    updates: Partial<Omit<DriveLinkIntent, "id" | "remoteUri" | "action" | "source" | "createdAt">>,
  ): void {
    this.intents = this.intents.map((intent) =>
      intent.id === intentId
        ? {
            ...intent,
            ...updates,
            updatedAt: nowIso(),
          }
        : intent,
    );
    this.persistAndEmit();
  }

  private persistAndEmit(): void {
    persistIntents(this.intents);
    this.listeners.forEach((listener) => listener());
  }
}

export const driveLinkCoordinator = new DriveLinkCoordinatorRuntime();

export function useDriveLinkCoordinatorSnapshot(): DriveLinkCoordinatorSnapshot {
  const [snapshot, setSnapshot] = useState<DriveLinkCoordinatorSnapshot>(() =>
    driveLinkCoordinator.getSnapshot(),
  );

  useEffect(() => {
    setSnapshot(driveLinkCoordinator.getSnapshot());
    return driveLinkCoordinator.subscribe(() => {
      setSnapshot(driveLinkCoordinator.getSnapshot());
    });
  }, []);

  return snapshot;
}

export { STATUS_TAB_URI as DRIVE_LINK_STATUS_TAB_URI };
