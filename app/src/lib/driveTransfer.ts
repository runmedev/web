import { appState } from "./runtime/AppState";
import { driveFileUrl, parseDriveItem } from "../storage/drive";
import { appLogger } from "./logging/runtime";
import { parser_pb } from "../runme/client";
import { toJsonString } from "@bufbuild/protobuf";

function ensureDriveStore() {
  const store = appState.driveNotebookStore;
  if (!store) {
    appLogger.error("Google Drive store is not initialized", {
      attrs: {
        scope: "drive.transfer",
      },
    });
    throw new Error("Google Drive store is not initialized");
  }
  return store;
}

function ensureLocalStore() {
  const store = appState.localNotebooks;
  if (!store) {
    appLogger.error("Local notebook mirror store is not initialized", {
      attrs: {
        scope: "drive.transfer",
      },
    });
    throw new Error("Local notebook mirror store is not initialized");
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
  appLogger.info("Creating Google Drive file", {
    attrs: {
      scope: "drive.transfer",
      folderRef,
      name,
    },
  });
  try {
    const created = await ensureDriveStore().create(folderRef, name);
    const { id } = parseDriveItem(created.uri);
    appLogger.info("Created Google Drive file", {
      attrs: {
        scope: "drive.transfer",
        fileId: id,
        name,
      },
    });
    return id;
  } catch (error) {
    appLogger.error("Failed to create Google Drive file", {
      attrs: {
        scope: "drive.transfer",
        folderRef,
        name,
        error: String(error),
      },
    });
    throw error;
  }
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
  appLogger.info("Updating Google Drive file", {
    attrs: {
      scope: "drive.transfer",
      uri,
      bytes: normalizedBytes.byteLength,
      mimeType,
    },
  });
  try {
    await ensureDriveStore().saveContent(uri, content, mimeType);
    const { id } = parseDriveItem(uri);
    appLogger.info("Updated Google Drive file", {
      attrs: {
        scope: "drive.transfer",
        fileId: id,
        bytes: normalizedBytes.byteLength,
      },
    });
    return id;
  } catch (error) {
    appLogger.error("Failed to update Google Drive file", {
      attrs: {
        scope: "drive.transfer",
        uri,
        bytes: normalizedBytes.byteLength,
        mimeType,
        error: String(error),
      },
    });
    throw error;
  }
}

export async function saveNotebookAsDriveCopy(
  notebook: parser_pb.Notebook,
  folder: string,
  name: string,
): Promise<{ fileId: string; fileName: string; remoteUri: string; localUri: string }> {
  if (!notebook) {
    throw new Error("drive.saveAsCurrentNotebook requires a notebook");
  }
  if (!folder?.trim()) {
    throw new Error("drive.saveAsCurrentNotebook requires a Drive folder URI or folder id");
  }
  if (!name?.trim()) {
    throw new Error("drive.saveAsCurrentNotebook requires a non-empty file name");
  }

  const fileId = await createDriveFile(folder, name);
  const remoteUri = driveFileUrl(fileId);
  const notebookJson = toJsonString(parser_pb.NotebookSchema, notebook, {
    emitDefaultValues: true,
  });
  await updateDriveFileBytes(
    remoteUri,
    new TextEncoder().encode(notebookJson),
    "application/json",
  );

  const localStore = ensureLocalStore();
  const localUri = await localStore.addFile(remoteUri, name);
  await localStore.save(localUri, notebook);

  try {
    await appState.openNotebook(localUri);
  } catch (error) {
    appLogger.error("Saved Drive copy but failed to switch current notebook", {
      attrs: {
        scope: "drive.transfer",
        localUri,
        remoteUri,
        error: String(error),
      },
    });
    throw error;
  }

  appLogger.info("Saved notebook as Google Drive copy and switched current doc", {
    attrs: {
      scope: "drive.transfer",
      fileId,
      fileName: name,
      localUri,
      remoteUri,
    },
  });
  return {
    fileId,
    fileName: name,
    remoteUri,
    localUri,
  };
}
