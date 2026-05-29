export interface WorkspaceFolderCandidate {
  uri: string;
  name: string;
  remoteUri?: string;
  parentUris: string[];
}

type ParentLoader = (uri: string) => Promise<string[]>;

async function hasMountedAncestor(
  uri: string,
  parentUris: string[],
  mountedUris: Set<string>,
  loadParents: ParentLoader,
  seen: Set<string>,
): Promise<boolean> {
  for (const parentUri of parentUris) {
    if (!parentUri || parentUri === uri || seen.has(parentUri)) {
      continue;
    }
    if (mountedUris.has(parentUri)) {
      return true;
    }
    seen.add(parentUri);

    const nextParents = await loadParents(parentUri);
    if (
      await hasMountedAncestor(uri, nextParents, mountedUris, loadParents, seen)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Keep the workspace tree a tree, not a DAG. react-arborist requires stable
 * unique ids for every rendered node; if a nested folder is rendered both as a
 * root and as a child, the virtualized row geometry can become inconsistent.
 */
export async function filterNestedWorkspaceFolders(
  candidates: WorkspaceFolderCandidate[],
  loadParents: ParentLoader,
): Promise<WorkspaceFolderCandidate[]> {
  const mountedUris = new Set(candidates.map((candidate) => candidate.uri));
  const visible: WorkspaceFolderCandidate[] = [];

  for (const candidate of candidates) {
    const nested = await hasMountedAncestor(
      candidate.uri,
      candidate.parentUris,
      mountedUris,
      loadParents,
      new Set<string>(),
    );
    if (!nested) {
      visible.push(candidate);
    }
  }

  return visible;
}
