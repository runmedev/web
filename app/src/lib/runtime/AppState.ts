import type {
  GetServiceAccountCredentialsOptions,
  ServiceAccountCredentialStatus,
} from "../../auth/googleServiceAccountImpersonation";
import type {
  StartGoogleDriveOAuthOptions,
  StartGoogleDriveOAuthResult,
} from "../../contexts/GoogleAuthContext";
import { DriveNotebookStore } from "../../storage/drive";
import { FilesystemNotebookStore } from "../../storage/fs";
import LocalNotebooks from "../../storage/local";
import LocalComments from "../../storage/localComments";
import type { Runner } from "../runner";

type WorkspaceHandlers = {
  getItems: () => string[];
  addItem: (uri: string) => void;
  removeItem: (uri: string) => void;
};

type RunnerHandlers = {
  updateRunner: (runner: Runner) => void;
  deleteRunner: (name: string) => void;
  setDefaultRunner: (name: string) => void;
};

/**
 * AppState exposes a global singleton for cross-cutting application state that
 * is not naturally scoped to React contexts.
 */
export class AppState {
  private static singleton: AppState | null = null;

  driveNotebookStore: DriveNotebookStore | null = null;
  filesystemStore: FilesystemNotebookStore | null = null;
  localNotebooks: LocalNotebooks | null = null;
  localComments: LocalComments | null = null;
  private openNotebookHandler: ((uri: string) => void | Promise<void>) | null =
    null;
  private loadNotebookHandler:
    | ((uri: string) => string | Promise<string>)
    | null = null;
  private focusNotebookHandler: ((uri: string) => void | Promise<void>) | null =
    null;
  private googleDriveOAuthHandler:
    | ((
        options?: StartGoogleDriveOAuthOptions,
      ) => Promise<StartGoogleDriveOAuthResult>)
    | null = null;
  private serviceAccountCredentialsHandler:
    | ((
        serviceAccount: string,
        options?: GetServiceAccountCredentialsOptions,
      ) => Promise<ServiceAccountCredentialStatus>)
    | null = null;
  private workspaceHandlers: WorkspaceHandlers | null = null;
  private workspaceRenameHandler: ((uri: string) => void) | null = null;
  private runnerHandlers: RunnerHandlers | null = null;

  private constructor() {}

  static instance(): AppState {
    if (!this.singleton) {
      this.singleton = new AppState();
    }
    return this.singleton;
  }

  setDriveNotebookStore(store: DriveNotebookStore | null): void {
    this.driveNotebookStore = store;
  }

  setFilesystemStore(store: FilesystemNotebookStore | null): void {
    this.filesystemStore = store;
  }

  setLocalNotebooks(store: LocalNotebooks | null): void {
    this.localNotebooks = store;
  }

  setLocalComments(store: LocalComments | null): void {
    this.localComments = store;
  }

  setOpenNotebookHandler(
    handler: ((uri: string) => void | Promise<void>) | null,
  ): void {
    this.openNotebookHandler = handler;
  }

  /** Registers notebook loading without changing the visible document. */
  setLoadNotebookHandler(
    handler: ((uri: string) => string | Promise<string>) | null,
  ): void {
    this.loadNotebookHandler = handler;
  }

  /** Registers selection of an already-open notebook. */
  setFocusNotebookHandler(
    handler: ((uri: string) => void | Promise<void>) | null,
  ): void {
    this.focusNotebookHandler = handler;
  }

  setGoogleDriveOAuthHandler(
    handler:
      | ((
          options?: StartGoogleDriveOAuthOptions,
        ) => Promise<StartGoogleDriveOAuthResult>)
      | null,
  ): void {
    this.googleDriveOAuthHandler = handler;
  }

  /** Registers the React-owned interactive service-account credential flow. */
  setServiceAccountCredentialsHandler(
    handler:
      | ((
          serviceAccount: string,
          options?: GetServiceAccountCredentialsOptions,
        ) => Promise<ServiceAccountCredentialStatus>)
      | null,
  ): void {
    this.serviceAccountCredentialsHandler = handler;
  }

  setWorkspaceHandlers(handlers: WorkspaceHandlers | null): void {
    this.workspaceHandlers = handlers;
  }

  getWorkspaceItems(): string[] {
    return this.workspaceHandlers?.getItems() ?? [];
  }

  addWorkspaceItem(uri: string): void {
    this.workspaceHandlers?.addItem(uri);
  }

  removeWorkspaceItem(uri: string): void {
    this.workspaceHandlers?.removeItem(uri);
  }

  setWorkspaceRenameHandler(handler: ((uri: string) => void) | null): void {
    this.workspaceRenameHandler = handler;
  }

  startWorkspaceItemRename(uri: string): void {
    if (!this.workspaceRenameHandler) {
      throw new Error("Workspace rename handler is not initialized");
    }
    this.workspaceRenameHandler(uri);
  }

  setRunnerHandlers(handlers: RunnerHandlers | null): void {
    this.runnerHandlers = handlers;
  }

  syncRunnerUpdate(runner: Runner): void {
    this.runnerHandlers?.updateRunner(runner);
  }

  syncRunnerDelete(name: string): void {
    this.runnerHandlers?.deleteRunner(name);
  }

  syncRunnerDefault(name: string): void {
    this.runnerHandlers?.setDefaultRunner(name);
  }

  async openNotebook(uri: string): Promise<void> {
    if (!this.openNotebookHandler) {
      throw new Error("Notebook navigation is not initialized");
    }
    await this.openNotebookHandler(uri);
  }

  async loadNotebook(uri: string): Promise<string> {
    if (!this.loadNotebookHandler) {
      throw new Error("Notebook loading is not initialized");
    }
    return await this.loadNotebookHandler(uri);
  }

  async focusNotebook(uri: string): Promise<void> {
    if (!this.focusNotebookHandler) {
      throw new Error("Notebook focus is not initialized");
    }
    await this.focusNotebookHandler(uri);
  }

  async startGoogleDriveOAuth(
    options?: StartGoogleDriveOAuthOptions,
  ): Promise<StartGoogleDriveOAuthResult> {
    if (!this.googleDriveOAuthHandler) {
      throw new Error("Google Drive OAuth is not initialized");
    }
    return this.googleDriveOAuthHandler(options);
  }

  /** Starts keyless service-account impersonation through the active UI. */
  async getServiceAccountCredentials(
    serviceAccount: string,
    options?: GetServiceAccountCredentialsOptions,
  ): Promise<ServiceAccountCredentialStatus> {
    if (!this.serviceAccountCredentialsHandler) {
      throw new Error(
        "Google service-account authorization is not initialized",
      );
    }
    return this.serviceAccountCredentialsHandler(serviceAccount, options);
  }
}

export const appState = AppState.instance();
