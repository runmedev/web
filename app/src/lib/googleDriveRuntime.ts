const STORAGE_KEY = "runme/google-drive/runtime";
const LEGACY_STORAGE_KEY = "aisre/google-drive/runtime";

type GoogleDriveRuntimeState = {
  baseUrl: string;
};

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/\/+$/, "");
}

function readState(): GoogleDriveRuntimeState {
  if (typeof window === "undefined" || !window.localStorage) {
    return { baseUrl: "" };
  }

  try {
    const raw =
      window.localStorage.getItem(STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      return { baseUrl: "" };
    }
    const parsed = JSON.parse(raw) as Partial<GoogleDriveRuntimeState> | null;
    return {
      baseUrl: normalizeBaseUrl(parsed?.baseUrl),
    };
  } catch {
    return { baseUrl: "" };
  }
}

function writeState(state: GoogleDriveRuntimeState): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        baseUrl: normalizeBaseUrl(state.baseUrl),
      }),
    );
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Runtime config persistence should never break the app.
  }
}

let cachedState: GoogleDriveRuntimeState = readState();

export function getGoogleDriveBaseUrl(): string {
  if (typeof window !== "undefined" && window.localStorage) {
    cachedState = readState();
  }
  return cachedState.baseUrl;
}

export function setGoogleDriveBaseUrl(baseUrl: string): string {
  cachedState = {
    baseUrl: normalizeBaseUrl(baseUrl),
  };
  writeState(cachedState);
  return cachedState.baseUrl;
}

export function clearGoogleDriveRuntime(): void {
  cachedState = { baseUrl: "" };
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // Ignore localStorage cleanup failures.
    }
  }
}

export const GOOGLE_DRIVE_RUNTIME_STORAGE_KEY = STORAGE_KEY;
