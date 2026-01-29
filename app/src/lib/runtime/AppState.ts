import { DriveNotebookStore } from "../../storage/drive";
import LocalNotebooks from "../../storage/local";

/**
 * AppState exposes a global singleton for cross-cutting application state that
 * is not naturally scoped to React contexts.
 */
export class AppState {
  private static singleton: AppState | null = null;

  driveNotebookStore: DriveNotebookStore | null = null;
  localNotebooks: LocalNotebooks | null = null;

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

  setLocalNotebooks(store: LocalNotebooks | null): void {
    this.localNotebooks = store;
  }
}

export const appState = AppState.instance();
