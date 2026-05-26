import type { NotebookTabState } from "../notebookDataController";
import type { NotebookOwnershipRecord } from "../tabCoordination/notebookOwnership";

export const DRIVE_LINK_STATUS_DOCUMENT_URI = "status://drive-link";

export interface WorkspaceDocument {
  uri: string;
  title: string;
  requestedUri?: string;
  state?: NotebookTabState;
  errorMessage?: string;
  owner?: NotebookOwnershipRecord | null;
}

export function getWorkspaceDocumentScheme(uri: string): string {
  const index = uri.indexOf(":");
  return index > 0 ? uri.slice(0, index) : "";
}

export function isNotebookDocumentUri(uri: string | null | undefined): uri is string {
  return typeof uri === "string" && uri.startsWith("local://file/");
}

export function isNotebookDiffUri(uri: string | null | undefined): boolean {
  return typeof uri === "string" && uri.startsWith("diff://notebook/");
}

export function isDriveLinkStatusUri(uri: string | null | undefined): boolean {
  return uri === DRIVE_LINK_STATUS_DOCUMENT_URI;
}

export function isRestorableWorkspaceDocument(uri: string): boolean {
  return isNotebookDocumentUri(uri);
}

export function deriveWorkspaceDocumentTitle(uri: string): string {
  const documentUri = uri;
  if (isDriveLinkStatusUri(documentUri)) {
    return "Drive Link Status";
  }
  if (isNotebookDiffUri(documentUri)) {
    return "Notebook diff";
  }
  try {
    const url = new URL(documentUri);
    const tail = url.pathname.split("/").filter(Boolean).pop();
    if (tail) {
      return decodeURIComponent(tail);
    }
  } catch {
    // Fall through to the URI segment heuristic.
  }
  return documentUri.split("/").filter(Boolean).pop() ?? documentUri;
}
