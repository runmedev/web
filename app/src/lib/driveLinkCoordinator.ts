import { useEffect, useState } from "react";

import { type SharedNotebookPreflight, parseDriveItem } from "../storage/drive";
import { NotebookStoreItemType } from "../storage/notebook";
import { appLogger } from "./logging/runtime";
import {
  type SharedNotebookTrustDecision,
  evaluateSharedNotebookTrust,
  rememberSharedNotebookTrust,
} from "./sharedNotebookTrust";

const STORAGE_KEY = "runme/drive-link-intents";
const STATUS_TAB_URI = "status://drive-link";

export type DriveLinkIntentStatus =
  | "pending"
  | "processing"
  | "fetching_metadata"
  | "awaiting_review"
  | "waiting_for_auth"
  | "failed";

export type DriveLinkIntentAction = "open_shared_file" | "mount_shared_folder";

export interface DriveLinkIntent {
  id: string;
  remoteUri: string;
  action: DriveLinkIntentAction;
  source: "url" | "manual";
  /** Whether the imported notebook should become the visible document. */
  focus: boolean;
  status: DriveLinkIntentStatus;
  createdAt: string;
  updatedAt: string;
  retryCount: number;
  lastErrorMessage?: string;
  preflight?: SharedNotebookPreflight;
  trustDecision?: SharedNotebookTrustDecision;
}

export interface DriveLinkCoordinatorSnapshot {
  intents: DriveLinkIntent[];
  authBlocked: boolean;
  lastErrorMessage: string | null;
}

type DriveLinkCoordinatorDeps = {
  ensureAccessToken: (options?: { interactive?: boolean }) => Promise<string>;
  getEffectivePrincipal: () => string | null;
  fetchPreflight: (remoteUri: string) => Promise<{
    item: {
      uri: string;
      name: string;
      mimeType?: string;
    };
    parents: Array<{
      uri: string;
      name: string;
      type: NotebookStoreItemType;
    }>;
    preflight: SharedNotebookPreflight;
  }>;
  updateFolder: (remoteUri: string, name?: string) => Promise<string>;
  importFile: (
    remoteUri: string,
    name: string,
    options: {
      mimeType?: string;
      expected?: { checksum?: string; revisionId?: string; version?: string };
    },
  ) => Promise<string>;
  addWorkspaceItem: (localUri: string) => void;
  removeWorkspaceItem: (uri: string) => void;
  getWorkspaceItems: () => string[];
  openNotebook: (
    localUri: string,
    options?: { focus?: boolean },
  ) => Promise<void> | void;
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
  return uri.startsWith("local://") || uri.startsWith("fs://");
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

function getIntentStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function clearLegacyLocalIntents(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore cleanup failures. Session-scoped intent storage remains primary.
  }
}

function loadIntents(): DriveLinkIntent[] {
  clearLegacyLocalIntents();

  const storage = getIntentStorage();
  if (!storage) {
    return [];
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);
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
        // Intents written by older builds always focused the imported file.
        focus: intent.focus !== false,
        // "processing" can be left behind in sessionStorage after reload/crash.
        // Treat it as pending so the coordinator can resume it.
        status:
          intent.status === "processing" ||
          intent.status === "fetching_metadata"
            ? "pending"
            : intent.status,
      }));
  } catch {
    return [];
  }
}

function persistIntents(intents: DriveLinkIntent[]): void {
  clearLegacyLocalIntents();

  const storage = getIntentStorage();
  if (!storage) {
    return;
  }

  try {
    if (intents.length === 0) {
      storage.removeItem(STORAGE_KEY);
      return;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(intents));
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

  private configuredPrincipal: string | null = null;

  configure(deps: DriveLinkCoordinatorDeps | null): void {
    this.deps = deps;
    const nextPrincipal =
      deps?.getEffectivePrincipal()?.trim().toLowerCase() ?? null;
    const principalChanged = nextPrincipal !== this.configuredPrincipal;
    this.configuredPrincipal = nextPrincipal;

    if (nextPrincipal && principalChanged) {
      let changed = false;
      this.intents = this.intents.map((intent) => {
        if (intent.status !== "awaiting_review") {
          return intent;
        }
        changed = true;
        return {
          ...intent,
          status: "pending",
          updatedAt: nowIso(),
        };
      });
      if (changed) {
        this.persistAndEmit();
      }
    }
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
      [...this.intents].reverse().find((intent) => intent.lastErrorMessage)
        ?.lastErrorMessage ?? null;
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
    options: { focus?: boolean } = {},
  ): Promise<void> {
    const action = this.resolveAction(remoteUri);
    const focus = options.focus !== false;
    const existing = this.intents.find(
      (intent) => intent.remoteUri === remoteUri && intent.action === action,
    );
    if (existing) {
      if (focus && !existing.focus) {
        this.updateIntent(existing.id, { focus: true });
      }
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
        focus,
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
      appLogger.info(
        "Retry requested while shared links are still processing",
        {
          attrs: {
            scope: "storage.drive.share",
            code: "DRIVE_SHARED_LINK_RETRY_IGNORED_PROCESSING",
          },
        },
      );
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

  async trustAndOpen(intentId: string): Promise<void> {
    const intent = this.intents.find((item) => item.id === intentId);
    const principal = this.deps?.getEffectivePrincipal();
    if (!intent?.preflight || intent.status !== "awaiting_review") {
      return;
    }
    if (!principal) {
      this.updateIntent(intentId, {
        lastErrorMessage:
          "Runme could not identify the active Google Drive account. Reconnect Drive and try again.",
      });
      return;
    }

    rememberSharedNotebookTrust(
      intent.preflight,
      principal,
      "explicit_document",
    );
    this.updateIntent(intentId, {
      status: "pending",
      // The user explicitly chose the "Trust This Document And Open" action.
      focus: true,
      lastErrorMessage: undefined,
    });
    await this.processPending();
  }

  cancelIntent(intentId: string): void {
    this.intents = this.intents.filter((intent) => intent.id !== intentId);
    this.lastMessage = null;
    this.persistAndEmit();
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
      await deps.ensureAccessToken({ interactive: false });

      if (intent.action === "mount_shared_folder") {
        const localFolderUri = await deps.updateFolder(intent.remoteUri);
        if (!deps.getWorkspaceItems().includes(localFolderUri)) {
          deps.addWorkspaceItem(localFolderUri);
        }
        deps.removeWorkspaceItem(intent.remoteUri);
      } else {
        this.updateIntent(intentId, { status: "fetching_metadata" });
        const { item, parents, preflight } = await deps.fetchPreflight(
          intent.remoteUri,
        );
        const trustDecision = evaluateSharedNotebookTrust({
          preflight,
          effectivePrincipal: deps.getEffectivePrincipal(),
        });
        this.updateIntent(intentId, { preflight, trustDecision });

        if (!preflight.canDownload) {
          throw new Error(
            "Google Drive does not allow this file to be downloaded.",
          );
        }
        if (
          !preflight.version &&
          !preflight.headRevisionId &&
          !preflight.md5Checksum
        ) {
          throw new Error(
            "Google Drive did not provide a content version, so Runme cannot safely import this notebook.",
          );
        }
        if (!trustDecision.trusted) {
          this.lastMessage = null;
          this.updateIntent(intentId, {
            status: "awaiting_review",
            lastErrorMessage: undefined,
          });
          return;
        }

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

        const localFileUri = await deps.importFile(item.uri, item.name, {
          mimeType: item.mimeType,
          expected: {
            checksum: preflight.md5Checksum,
            revisionId: preflight.headRevisionId,
            version: preflight.version,
          },
        });
        deps.removeWorkspaceItem(intent.remoteUri);
        await deps.openNotebook(localFileUri, { focus: intent.focus });

        if (trustDecision.basis && trustDecision.effectivePrincipal) {
          rememberSharedNotebookTrust(
            preflight,
            trustDecision.effectivePrincipal,
            trustDecision.basis,
          );
        }
      }

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
    updates: Partial<
      Omit<
        DriveLinkIntent,
        "id" | "remoteUri" | "action" | "source" | "createdAt"
      >
    >,
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
