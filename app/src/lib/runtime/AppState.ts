import { ContentsNotebookStore } from "../../storage/contents";
import { DriveNotebookStore } from "../../storage/drive";
import { FilesystemNotebookStore } from "../../storage/fs";
import LocalNotebooks from "../../storage/local";

/**
 * AppState exposes a global singleton for cross-cutting application state that
 * is not naturally scoped to React contexts.
 */
export class AppState {
  private static singleton: AppState | null = null;

  contentsStore: ContentsNotebookStore | null = null;
  driveNotebookStore: DriveNotebookStore | null = null;
  filesystemStore: FilesystemNotebookStore | null = null;
  localNotebooks: LocalNotebooks | null = null;
  private openNotebookHandler: ((uri: string) => void | Promise<void>) | null =
    null;

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

  setContentsStore(store: ContentsNotebookStore | null): void {
    this.contentsStore = store;
  }

  setOpenNotebookHandler(
    handler: ((uri: string) => void | Promise<void>) | null,
  ): void {
    this.openNotebookHandler = handler;
  }

  async openNotebook(uri: string): Promise<void> {
    if (!this.openNotebookHandler) {
      throw new Error("Notebook navigation is not initialized");
    }
    await this.openNotebookHandler(uri);
  }
}

export const appState = AppState.instance();
