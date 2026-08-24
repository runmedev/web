import { NotebookStoreItemType } from "../../storage/notebook";

export interface WorkspaceFolderCandidate {
  uri: string;
  name: string;
  remoteUri?: string;
}

export type WorkspaceTreeChild = {
  uri: string;
  type: NotebookStoreItemType | "placeholder";
};

/**
 * Explicitly mounted folders remain visible as roots. Remove their duplicate
 * child edge from an ancestor so react-arborist still receives unique ids and
 * the workspace remains a tree rather than a DAG.
 */
export function filterMountedWorkspaceFolderChildren<
  T extends WorkspaceTreeChild,
>(children: T[], mountedUris: ReadonlySet<string>): T[] {
  return children.filter(
    (child) =>
      child.type !== NotebookStoreItemType.Folder || !mountedUris.has(child.uri)
  );
}
