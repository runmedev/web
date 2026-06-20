import type {
  StartGoogleDriveOAuthOptions,
  StartGoogleDriveOAuthResult,
} from "../../contexts/GoogleAuthContext";
import { DriveNotebookStore } from "../../storage/drive";
import { FilesystemNotebookStore } from "../../storage/fs";
import LocalNotebooks from "../../storage/local";
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
  private openNotebookHandler: ((uri: string) => void | Promise<void>) | null =
    null;
  private googleDriveOAuthHandler:
    | ((
        options?: StartGoogleDriveOAuthOptions,
      ) => Promise<StartGoogleDriveOAuthResult>)
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

  setOpenNotebookHandler(
    handler: ((uri: string) => void | Promise<void>) | null,
  ): void {
    this.openNotebookHandler = handler;
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

  async startGoogleDriveOAuth(
    options?: StartGoogleDriveOAuthOptions,
  ): Promise<StartGoogleDriveOAuthResult> {
    if (!this.googleDriveOAuthHandler) {
      throw new Error("Google Drive OAuth is not initialized");
    }
    return this.googleDriveOAuthHandler(options);
  }
}

export const appState = AppState.instance();
