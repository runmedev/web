import { appState } from "./runtime/AppState";
import { driveFileUrl, parseDriveItem } from "../storage/drive";

function ensureDriveStore() {
  const store = appState.driveNotebookStore;
  if (!store) {
    throw new Error("Google Drive store is not initialized");
  }
  return store;
}

export async function createDriveFile(
  folder: string,
  name: string,
): Promise<string> {
  if (!folder?.trim()) {
    throw new Error("drive.create requires a Drive folder URI or folder id");
  }
  if (!name?.trim()) {
    throw new Error("drive.create requires a non-empty file name");
  }

  const folderRef = folder.includes("://") ? folder : `https://drive.google.com/drive/folders/${folder}`;
  const created = await ensureDriveStore().create(folderRef, name);
  const { id } = parseDriveItem(created.uri);
  return id;
}

export async function updateDriveFileBytes(
  idOrUri: string,
  bytes: Uint8Array | ArrayBuffer | ArrayLike<number>,
  mimeType: string = "text/markdown",
): Promise<string> {
  if (!idOrUri?.trim()) {
    throw new Error("drive.update requires a Drive file id or URI");
  }
  const normalizedBytes =
    bytes instanceof Uint8Array
      ? bytes
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array(bytes);

  const uri = idOrUri.includes("://") ? idOrUri : driveFileUrl(idOrUri);
  const content = new TextDecoder().decode(normalizedBytes);
  await ensureDriveStore().saveContent(uri, content, mimeType);
  const { id } = parseDriveItem(uri);
  return id;
}
