export type GoogleDrivePickerResourceKind = "file" | "folder";

type GoogleDrivePickerView = {
  setEnableDrives(enabled: boolean): GoogleDrivePickerView;
  setIncludeFolders(included: boolean): GoogleDrivePickerView;
  setSelectFolderEnabled(enabled: boolean): GoogleDrivePickerView;
};

type GoogleDrivePicker = {
  setVisible(visible: boolean): void;
};

type GoogleDrivePickerBuilder = {
  addView(view: GoogleDrivePickerView): GoogleDrivePickerBuilder;
  build(): GoogleDrivePicker;
  setAppId(appId: string): GoogleDrivePickerBuilder;
  setCallback(
    callback: (data: GoogleDrivePickerCallbackData) => void,
  ): GoogleDrivePickerBuilder;
  setDeveloperKey(developerKey: string): GoogleDrivePickerBuilder;
  setOAuthToken(token: string): GoogleDrivePickerBuilder;
};

type GoogleDrivePickerApi = {
  DocsView: new (viewId: unknown) => GoogleDrivePickerView;
  PickerBuilder: new () => GoogleDrivePickerBuilder;
  ViewId: {
    DOCS: unknown;
    FOLDERS: unknown;
  };
};

type GooglePickerWindow = Window & {
  gapi?: {
    load(
      apiName: string,
      options: {
        callback: () => void;
        onerror: () => void;
        timeout: number;
        ontimeout: () => void;
      },
    ): void;
  };
  google?: {
    picker?: GoogleDrivePickerApi;
  };
};

const GOOGLE_PICKER_LOAD_TIMEOUT_MS = 5_000;
const GOOGLE_PICKER_POLL_INTERVAL_MS = 25;

export type GoogleDrivePickerDocument = {
  id: string;
  name?: string;
  mimeType?: string;
  url?: string;
  [key: string]: unknown;
};

export type GoogleDrivePickerCallbackData = {
  action: string;
  docs?: GoogleDrivePickerDocument[];
};

export type OpenGoogleDrivePickerOptions = {
  appId: string;
  callback: (data: GoogleDrivePickerCallbackData) => void;
  developerKey: string;
  kind: GoogleDrivePickerResourceKind;
  token: string;
};

function getGoogleDrivePickerApi(): GoogleDrivePickerApi | undefined {
  return (window as GooglePickerWindow).google?.picker;
}

function configureView(
  view: GoogleDrivePickerView,
  kind: GoogleDrivePickerResourceKind,
): GoogleDrivePickerView {
  if (kind === "folder") {
    view.setIncludeFolders(true);
    view.setSelectFolderEnabled(true);
  }
  return view;
}

export function createGoogleDrivePickerViews(
  picker: Pick<GoogleDrivePickerApi, "DocsView" | "ViewId">,
  kind: GoogleDrivePickerResourceKind,
): GoogleDrivePickerView[] {
  const viewId =
    kind === "folder" ? picker.ViewId.FOLDERS : picker.ViewId.DOCS;
  const myDriveView = configureView(new picker.DocsView(viewId), kind);
  const sharedDriveView = configureView(new picker.DocsView(viewId), kind);
  sharedDriveView.setEnableDrives(true);
  return [myDriveView, sharedDriveView];
}

/**
 * Loads the Picker module before constructing custom views. Loading api.js only
 * exposes gapi; the google.picker constructors arrive asynchronously after
 * gapi.load("picker") completes.
 */
export async function getGoogleDrivePickerViews(
  kind: GoogleDrivePickerResourceKind,
  timeoutMs = GOOGLE_PICKER_LOAD_TIMEOUT_MS,
): Promise<GoogleDrivePickerView[]> {
  const existingPicker = getGoogleDrivePickerApi();
  if (existingPicker) {
    return createGoogleDrivePickerViews(existingPicker, kind);
  }

  const deadline = Date.now() + timeoutMs;
  let gapi: GooglePickerWindow["gapi"];
  do {
    gapi = (window as GooglePickerWindow).gapi;
    if (gapi?.load) {
      break;
    }
    await new Promise((resolve) =>
      window.setTimeout(resolve, GOOGLE_PICKER_POLL_INTERVAL_MS),
    );
  } while (Date.now() < deadline);

  if (!gapi?.load) {
    throw new Error("Google API loader did not finish loading.");
  }

  const remainingMs = Math.max(1, deadline - Date.now());
  const picker = await new Promise<GoogleDrivePickerApi>((resolve, reject) => {
    const resolveLoadedPicker = () => {
      const loadedPicker = getGoogleDrivePickerApi();
      if (loadedPicker) {
        resolve(loadedPicker);
        return;
      }
      reject(new Error("Google Drive picker module loaded without its API."));
    };
    gapi.load("picker", {
      callback: resolveLoadedPicker,
      onerror: () => reject(new Error("Google Drive picker failed to load.")),
      timeout: remainingMs,
      ontimeout: () =>
        reject(new Error("Google Drive picker did not finish loading.")),
    });
  });

  return createGoogleDrivePickerViews(picker, kind);
}

/**
 * Opens Picker directly after its API is ready. This avoids coupling custom
 * view construction to a React hook's asynchronous internal load state.
 */
export async function openGoogleDrivePicker(
  options: OpenGoogleDrivePickerOptions,
): Promise<void> {
  const views = await getGoogleDrivePickerViews(options.kind);
  const pickerApi = getGoogleDrivePickerApi();
  if (!pickerApi) {
    throw new Error("Google Drive picker API is unavailable.");
  }

  const builder = new pickerApi.PickerBuilder()
    .setAppId(options.appId)
    .setOAuthToken(options.token)
    .setDeveloperKey(options.developerKey)
    .setCallback(options.callback);
  for (const view of views) {
    builder.addView(view);
  }
  builder.build().setVisible(true);
}
