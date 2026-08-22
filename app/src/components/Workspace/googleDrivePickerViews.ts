export type GoogleDrivePickerResourceKind = "file" | "folder";

type GoogleDrivePickerView = {
  setEnableDrives(enabled: boolean): GoogleDrivePickerView;
  setIncludeFolders(included: boolean): GoogleDrivePickerView;
  setSelectFolderEnabled(enabled: boolean): GoogleDrivePickerView;
};

type GoogleDrivePickerApi = {
  DocsView: new (viewId: unknown) => GoogleDrivePickerView;
  ViewId: {
    DOCS: unknown;
    FOLDERS: unknown;
  };
};

type GooglePickerWindow = Window & {
  google?: {
    picker?: GoogleDrivePickerApi;
  };
};

const GOOGLE_PICKER_LOAD_TIMEOUT_MS = 5_000;
const GOOGLE_PICKER_POLL_INTERVAL_MS = 25;

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
  picker: GoogleDrivePickerApi,
  kind: GoogleDrivePickerResourceKind,
): GoogleDrivePickerView[] {
  const viewId =
    kind === "folder" ? picker.ViewId.FOLDERS : picker.ViewId.DOCS;
  const myDriveView = configureView(new picker.DocsView(viewId), kind);
  const sharedDriveView = configureView(new picker.DocsView(viewId), kind);
  sharedDriveView.setEnableDrives(true);
  return [myDriveView, sharedDriveView];
}

export async function getGoogleDrivePickerViews(
  kind: GoogleDrivePickerResourceKind,
  timeoutMs = GOOGLE_PICKER_LOAD_TIMEOUT_MS,
): Promise<GoogleDrivePickerView[]> {
  const deadline = Date.now() + timeoutMs;
  do {
    const picker = getGoogleDrivePickerApi();
    if (picker) {
      return createGoogleDrivePickerViews(picker, kind);
    }
    await new Promise((resolve) =>
      window.setTimeout(resolve, GOOGLE_PICKER_POLL_INTERVAL_MS),
    );
  } while (Date.now() < deadline);

  throw new Error("Google Drive picker did not finish loading.");
}
