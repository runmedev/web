import { AppConsoleData } from "./AppConsoleData";

let appConsoleDataSingleton: AppConsoleData | null = null;

export function getAppConsoleData(): AppConsoleData {
  if (!appConsoleDataSingleton) {
    appConsoleDataSingleton = new AppConsoleData();
  }
  return appConsoleDataSingleton;
}

export function __resetAppConsoleDataForTests(): void {
  appConsoleDataSingleton?.dispose();
  appConsoleDataSingleton = null;
}
