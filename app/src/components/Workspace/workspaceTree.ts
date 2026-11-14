export interface WorkspaceFolderCandidate {
  uri: string;
  name: string;
  remoteUri?: string;
}

type Item<T> = { uri: string; children?: T[] };

/** Arborist identifies appearances by path; the store identifies items by URI. */
export type WorkspaceRow<T> = Omit<T, "children"> & {
  id: string;
  children?: WorkspaceRow<T>[];
};

/** Append one URI to the JSON array identifying its parent row. */
export function workspaceRowId(parentId: string, uri: string): string {
  const segment = JSON.stringify(uri);
  return parentId ? `${parentId.slice(0, -1)},${segment}]` : `[${segment}]`;
}

/** Project the loaded hierarchy into independent rows for each mounted path. */
export function workspaceRows<T extends Item<T>>(
  items: T[],
  parentId = "",
): WorkspaceRow<T>[] {
  return items.map(({ children, ...item }) => {
    const id = workspaceRowId(parentId, item.uri);
    return { ...item, id, children: children && workspaceRows(children, id) };
  });
}
