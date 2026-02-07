import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { Tree, type NodeApi, type TreeApi } from "react-arborist";
import { Box, Flex, Text } from "@radix-ui/themes";
import { PlusIcon, MinusIcon, FileTextIcon } from "@radix-ui/react-icons";
import useResizeObserver from "use-resize-observer";

import { GoogleDrivePickerButton } from "./GoogleDrivePickerButton";
import { FolderPlusIcon } from "../icons/FolderPlusIcon";
import { CloudFolderIcon } from "../icons/CloudFolderIcon";
import { useWorkspace } from "../../contexts/WorkspaceContext";
import { useNotebookStore } from "../../contexts/NotebookStoreContext";
import { useFilesystemStore } from "../../contexts/FilesystemStoreContext";
import { useContentsStore } from "../../contexts/ContentsStoreContext";
import {
  NotebookStore,
  NotebookStoreItem,
  NotebookStoreItemType,
} from "../../storage/notebook";
import { isFileSystemAccessSupported } from "../../storage/fs";
import { fetchDriveItemWithParents, parseDriveItem } from "../../storage/drive";
import { LOCAL_FOLDER_URI } from "../../storage/local";
import { useGoogleAuth } from "../../contexts/GoogleAuthContext";
import { useCurrentDoc } from "../../contexts/CurrentDocContext";

interface ContextMenuState {
  uri: string;
  name: string;
  type: TreeNodeType;
  remoteUri?: string;
  parentUri?: string;
  position: { x: number; y: number };
}

type TreeNodeType = NotebookStoreItemType | "placeholder";

type TreeNode = {
  id: string;
  uri: string;
  name: string;
  type: TreeNodeType;
  remoteUri?: string;
  parentUri?: string;
  children?: TreeNode[];
};

function createPlaceholderNode(uri: string, label: string): TreeNode {
  return {
    id: `${uri}::placeholder::${label}`,
    uri,
    name: label,
    type: "placeholder",
  };
}

function createFolderNode(
  uri: string,
  name: string,
  options?: { remoteUri?: string; parentUri?: string },
): TreeNode {
  return {
    id: uri,
    uri,
    name,
    type: NotebookStoreItemType.Folder,
    remoteUri: options?.remoteUri,
    parentUri: options?.parentUri,
    // Loading file contents is a place holder that shouldn't really show up.
    // If the tree is created with openByDefault false then expandable items are collapsed.
    // However, I think we need at least one child in order to get the expand/collapse icon.
    // When the folder is expanded we will fetch the actual children.
    children: [createPlaceholderNode(uri, "Loading file contents...")],
  };
}

function createFileNode(
  item: NotebookStoreItem,
  options?: { parentUri?: string },
): TreeNode {
  return {
    id: item.uri,
    uri: item.uri,
    name: item.name,
    type: NotebookStoreItemType.File,
    remoteUri: item.remoteUri,
    parentUri: options?.parentUri,
  };
}

function setChildrenForFolder(
  nodes: TreeNode[],
  folderUri: string,
  children: TreeNode[],
): TreeNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.uri === folderUri) {
      changed = true;
      return {
        ...node,
        children,
      };
    }
    if (node.children?.length) {
      const updated = setChildrenForFolder(node.children, folderUri, children);
      if (updated !== node.children) {
        changed = true;
        return {
          ...node,
          children: updated,
        };
      }
    }
    return node;
  });
  return changed ? next : nodes;
}

function updateNodeMetadata(
  nodes: TreeNode[],
  targetUri: string,
  updates: Partial<Pick<TreeNode, "name" | "remoteUri">>,
): TreeNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    let current = node;
    if (node.uri === targetUri) {
      changed = true;
      current = { ...node, ...updates };
    }
    if (node.children?.length) {
      const updatedChildren = updateNodeMetadata(
        node.children,
        targetUri,
        updates,
      );
      if (updatedChildren !== node.children) {
        changed = true;
        current = { ...current, children: updatedChildren };
      }
    }
    return current;
  });
  return changed ? next : nodes;
}

function EditableTreeNode({
  node,
  style,
}: {
  node: NodeApi<TreeNode, unknown>;
  style: CSSProperties;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      style={style}
      className="flex items-center gap-2 px-2 py-1 text-sm"
      onContextMenu={(event) => event.preventDefault()}
    >
      <input
        ref={inputRef}
        defaultValue={node.data.name}
        className="w-full rounded border border-gray-300 px-2 py-1 text-sm outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400"
        onBlur={() => node.reset()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            node.reset();
          }
          if (event.key === "Enter") {
            const value = inputRef.current?.value ?? "";
            node.submit(value);
          }
        }}
      />
    </div>
  );
}

// WorkspaceExplorer provides an explorer panel that shows all the open folders/files
// in the workspace.
// In addition to viewing Google Drive folders it also supports "local://" URIs
// which are stored in the browser's IndexedDB.
/**
 * Return the appropriate NotebookStore for a given URI.
 * - `contents://` URIs route to the ContentsNotebookStore.
 * - `fs://` URIs route to the FilesystemNotebookStore.
 * - Everything else routes to the LocalNotebooks (Drive-backed) store.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function storeForUri(
  uri: string,
  localStore: any,
  fsStoreInstance: NotebookStore | null,
  contentsStoreInstance?: NotebookStore | null,
): NotebookStore | null {
  if (uri.startsWith("contents://")) {
    return contentsStoreInstance ?? null;
  }
  if (uri.startsWith("fs://")) {
    return fsStoreInstance;
  }
  return localStore as NotebookStore | null;
}

export function WorkspaceExplorer() {
  const { getItems, addItem, removeItem } = useWorkspace();
  const { store } = useNotebookStore();
  const { fsStore } = useFilesystemStore();
  const { contentsStore } = useContentsStore();
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc();
  const currentDoc = getCurrentDoc();
  const { ensureAccessToken } = useGoogleAuth();
  const handledDocRef = useRef<string | null>(null);

  const treeRef = useRef<TreeApi<TreeNode> | undefined>(undefined);
  const { ref: containerRef, width = 0, height = 0 } = useResizeObserver<HTMLDivElement>();

  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingEditId, setPendingEditId] = useState<string | null>(null);

  const workspaceUris = useMemo(() => getItems(), [getItems]);

  useEffect(() => {
    if (!workspaceUris.includes(LOCAL_FOLDER_URI)) {
      addItem(LOCAL_FOLDER_URI);
    }
  }, [workspaceUris, addItem]);

  useEffect(() => {
    if (!store) {
      setTreeNodes([
        createFolderNode(LOCAL_FOLDER_URI, "Local Notebooks"),
      ]);
      return;
    }

    let cancelled = false;
    (async () => {
      const folderNodes: TreeNode[] = [];
      for (const uri of workspaceUris) {
        if (cancelled) {
          return;
        }

        // fs:// workspace roots are handled by the filesystem store.
        if (uri.startsWith("fs://")) {
          if (!fsStore) {
            continue;
          }
          try {
            const metadata = await fsStore.getMetadata(uri);
            const name = metadata?.name ?? uri;
            const type = metadata?.type ?? NotebookStoreItemType.Folder;
            if (type !== NotebookStoreItemType.Folder) {
              continue;
            }
            folderNodes.push(createFolderNode(uri, name));
          } catch (error) {
            console.error("Failed to load fs workspace metadata", uri, error);
          }
          continue;
        }

        // contents:// workspace roots are handled by the contents store.
        if (uri.startsWith("contents://")) {
          if (!contentsStore) {
            continue;
          }
          try {
            const metadata = await contentsStore.getMetadata(uri);
            const name = metadata?.name ?? "Server Files";
            const type = metadata?.type ?? NotebookStoreItemType.Folder;
            if (type !== NotebookStoreItemType.Folder) {
              continue;
            }
            folderNodes.push(createFolderNode(uri, name));
          } catch (error) {
            console.error("Failed to load contents workspace metadata", uri, error);
          }
          continue;
        }

        let localUri = uri;
        if (!uri.startsWith("local://")) {
          try {
            const parsed = parseDriveItem(uri);
            if (parsed.type === NotebookStoreItemType.Folder) {
              localUri = await store.updateFolder(uri);
            } else {
              localUri = await store.addFile(uri);
            }
            removeItem(uri);
            addItem(localUri);
          } catch (error) {
            console.error("Failed to normalize workspace entry", uri, error);
            continue;
          }
        }

        const metadata = await store.getMetadata(localUri);
        const name = metadata?.name ?? localUri;
        const type = metadata?.type ?? NotebookStoreItemType.Folder;
        if (type !== NotebookStoreItemType.Folder) {
          continue;
        }
        folderNodes.push(
          createFolderNode(localUri, name, {
            remoteUri: metadata?.remoteUri,
          }),
        );
      }

      if (!folderNodes.some((node) => node.uri === LOCAL_FOLDER_URI)) {
        folderNodes.push(
          createFolderNode(LOCAL_FOLDER_URI, "Local Notebooks"),
        );
      }

      if (cancelled) {
        return;
      }

      setTreeNodes(folderNodes);
    })().catch((error) => {
      console.error("Failed to load workspace metadata", error);
    });

    return () => {
      cancelled = true;
    };
  }, [addItem, contentsStore, fsStore, removeItem, store, workspaceUris]);

  useEffect(() => {
    // Coordinate with the global current-doc context. Whenever a Drive-backed
    // document becomes active, ensure the required folder hierarchy is present
    // in the workspace before loading the notebook contents.
    if (!currentDoc || currentDoc === handledDocRef.current) {
      return;
    }

    if (currentDoc.startsWith("local://")) {
      handledDocRef.current = currentDoc;
      return;
    }

    if (currentDoc.startsWith("fs://") || currentDoc.startsWith("contents://")) {
      handledDocRef.current = currentDoc;
      return;
    }

    if (!store) {
      return;
    }

    let parsed = null;
    try {
      parsed = parseDriveItem(currentDoc);
    } catch (error) {
      console.error("Invalid Google Drive URI", error);
    }

    if (!parsed || parsed.type !== NotebookStoreItemType.File) {
      handledDocRef.current = currentDoc;
      return;
    }

    void (async () => {
      try {
        let workspaceItems = [...workspaceUris];
        let targetItemUri = workspaceItems.find((entry) => entry === currentDoc);
        let targetItem: NotebookStoreItem | null = null;

        if (!targetItemUri) {
          const { item, parents } = await fetchDriveItemWithParents(
            currentDoc,
            ensureAccessToken,
          );

          for (const parent of parents) {
            if (parent.type !== NotebookStoreItemType.Folder) {
              continue;
            }
            const localParentUri = await store.updateFolder(
              parent.uri,
              parent.name,
            );
            if (!workspaceItems.includes(localParentUri)) {
              addItem(localParentUri);
              workspaceItems = [...workspaceItems, localParentUri];
            }
          }

          const localFileUri = await store.addFile(item.uri, item.name);
          if (!workspaceItems.includes(localFileUri)) {
            addItem(localFileUri);
            workspaceItems = [...workspaceItems, localFileUri];
          }

          targetItemUri = localFileUri;
        }

        if (!targetItemUri) {
          throw new Error("Unable to resolve notebook workspace item");
        }

        targetItem =
          (await store.getMetadata(targetItemUri)) ??
          ({
            uri: targetItemUri,
            name: targetItemUri,
            type: NotebookStoreItemType.File,
            children: [],
            remoteUri: undefined,
          } as NotebookStoreItem);

        setCurrentDoc(targetItem.uri);
        handledDocRef.current = targetItem.uri;
      } catch (error) {
        console.error("Failed to load notebook from URL", error);
        setCurrentDoc(null);
        handledDocRef.current = currentDoc;
      }
    })();
  }, [
    addItem,
    currentDoc,
    ensureAccessToken,
    setCurrentDoc,
    store,
    workspaceUris,
  ]);

  useEffect(() => {
    if (!pendingEditId) {
      return;
    }
    const tree = treeRef.current;
    if (!tree) {
      return;
    }
    const node = tree.get(pendingEditId);
    if (!node) {
      return;
    }
    node.openParents();
    node.parent?.open();
    void tree.edit(pendingEditId).finally(() => {
      setPendingEditId(null);
    });
  }, [pendingEditId, treeNodes]);

  useEffect(() => {
    if (!store || typeof window === "undefined") {
      return;
    }

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ uri?: string }>).detail;
      if (!detail?.uri) {
        return;
      }

      void (async () => {
        try {
          const metadata = await store.getMetadata(detail.uri);
          if (!metadata) {
            return;
          }
          setTreeNodes((prev) =>
            updateNodeMetadata(prev, detail.uri, {
              name: metadata.name,
              remoteUri: metadata.remoteUri,
            }),
          );
        } catch (error) {
          console.error("Failed to refresh notebook metadata", error);
        }
      })();
    };

    window.addEventListener("local-notebook-updated", handler as EventListener);
    return () => {
      window.removeEventListener(
        "local-notebook-updated",
        handler as EventListener,
      );
    };
  }, [store]);

  const fetchChildren = useCallback(
    async (uri: string) => {
      const targetStore = storeForUri(uri, store, fsStore, contentsStore);
      if (!targetStore) {
        return;
      }

      setTreeNodes((prev) =>
        setChildrenForFolder(prev, uri, [
          createPlaceholderNode(uri, "Loading…"),
        ]),
      );

      try {
        let childNodes: TreeNode[];

        if (uri.startsWith("fs://") || uri.startsWith("contents://")) {
          // Filesystem / Contents store: use list() which returns items directly.
          const items = await targetStore.list(uri);
          childNodes = items.map((item) => {
            if (item.type === NotebookStoreItemType.Folder) {
              return createFolderNode(item.uri, item.name, {
                parentUri: uri,
              });
            }
            return createFileNode(item, { parentUri: uri });
          });
        } else {
          // Local/Drive store: use getMetadata() + children array.
          const folderMetadata = await (store as any).getMetadata(uri);
          if (!folderMetadata || folderMetadata.type !== NotebookStoreItemType.Folder) {
            throw new Error(`URI ${uri} is not a folder or metadata is missing.`);
          }

          childNodes = [];
          for (const childUri of folderMetadata.children) {
            const childMetadata = await (store as any).getMetadata(childUri);
            if (childMetadata?.type === NotebookStoreItemType.Folder) {
              childNodes.push(
                createFolderNode(childMetadata.uri, childMetadata.name, {
                  remoteUri: childMetadata.remoteUri,
                  parentUri: folderMetadata.uri,
                }),
              );
            } else if (childMetadata?.type === NotebookStoreItemType.File) {
              childNodes.push(
                createFileNode(childMetadata, { parentUri: folderMetadata.uri }),
              );
            } else {
              childNodes.push(createPlaceholderNode(childUri, "Unknown item"));
            }
          }
        }

        const nodes =
          childNodes.length > 0
            ? childNodes
            : [createPlaceholderNode(uri, "Folder is empty")];

        setTreeNodes((prev) => setChildrenForFolder(prev, uri, nodes));
      } catch (error) {
        console.error("Failed to list notebook store items", error);
        setTreeNodes((prev) =>
          setChildrenForFolder(prev, uri, [
            createPlaceholderNode(uri, "Unable to load items"),
          ]),
        );
      }
    },
    [contentsStore, fsStore, store],
  );

  const handleFileOpen = useCallback(
    async (nodeData: TreeNode) => {
      const targetStore = storeForUri(nodeData.uri, store, fsStore, contentsStore);
      if (!targetStore) {
        return;
      }
      try {
        const uri = nodeData.uri;
        const item = await targetStore.getMetadata(uri);
        if (!item) {
          console.error("Notebook metadata missing for", uri);
          return;
        }
        setCurrentDoc(item.uri);
        setErrorMessage(null);
      } catch (error) {
        console.error("Failed to load notebook", error);
        setErrorMessage(
          "Failed to load notebook. Please ensure you have access.",
        );
      }
    },
    [contentsStore, fsStore, setCurrentDoc, store],
  );

  const handleCreateDocument = useCallback(
    async (folderUri: string) => {
      const targetStore = storeForUri(folderUri, store, fsStore, contentsStore);
      if (!targetStore) {
        return;
      }
      try {
        treeRef.current?.open(folderUri);
        const timestamp = formatShortTimestamp(new Date());
        const name = `untitled-${timestamp}.json`;
        const newItem = await targetStore.create(folderUri, name);
        await fetchChildren(folderUri);
        setPendingEditId(newItem.uri);
        setErrorMessage(null);
      } catch (error) {
        console.error("Failed to create notebook", error);
        setErrorMessage("Unable to create a new document. Please try again.");
      }
    },
    [contentsStore, fetchChildren, fsStore, store],
  );

function formatShortTimestamp(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${year}${month}${day}-${hours}${minutes}`;
}

  const renderNode = useCallback(
    ({
      node,
      style,
    }: {
      node: NodeApi<TreeNode, unknown>;
      style: CSSProperties;
    }) => {
      if (node.isEditing) {
        return <EditableTreeNode node={node} style={style} />;
      }

      const data = node.data;
      const isPlaceholder = data.type === "placeholder";
      const isFolder = data.type === NotebookStoreItemType.Folder;
      const handleContextMenu = (event: MouseEvent) => {
        event.preventDefault();
        node.handleClick(event);
        if (data.type === "placeholder") {
          return;
        }
        setContextMenu({
          uri: data.uri,
          name: data.name,
          type: data.type,
          remoteUri: data.remoteUri,
          parentUri: data.parentUri ?? node.parent?.data.uri,
          position: { x: event.clientX, y: event.clientY },
        });
      };
      return (
        <div
          style={style}
          className="flex items-center gap-2 px-2 py-1 text-sm"
          onContextMenu={handleContextMenu}
        >
          {isFolder && (
            <button
              type="button"
              aria-label={node.isOpen ? "Collapse folder" : "Expand folder"}
              className="flex h-5 w-5 items-center justify-center rounded hover:bg-gray-100 focus:outline-none"
              onClick={(event) => {
                event.stopPropagation();
                node.toggle();
              }}
            >
              {node.isOpen ? (
                <MinusIcon width={12} height={12} />
              ) : (
                <PlusIcon width={12} height={12} />
              )}
            </button>
          )}
          {isFolder ? null : data.type === NotebookStoreItemType.File ? (
            <FileTextIcon width={16} height={16} />
          ) : (
            <FileTextIcon width={16} height={16} />
          )}
          {data.type === NotebookStoreItemType.File ? (
            <button
              type="button"
              className="block w-full bg-transparent p-0 text-left text-amber-600 leading-4 hover:bg-transparent hover:text-amber-700 hover:underline focus:outline-none border-0"
              onClick={(event) => {
                event.stopPropagation();
                void handleFileOpen(data);
              }}
              style={{ backgroundColor: "transparent" }}
            >
              {data.name}
            </button>
          ) : (
            <span
              className={`leading-4${isPlaceholder ? " text-gray-500" : ""}`}
            >
              {data.name}
            </span>
          )}
        </div>
      );
    },
    [handleFileOpen],
  );

  const handleToggle = useCallback(
    (id: string) => {
      const tree = treeRef.current;
      if (!tree) {
        return;
      }

      const node = tree.get(id);
      if (!node || node.data.type !== NotebookStoreItemType.Folder) {
        return;
      }

      const folderUri = node.data.uri;
      const scheduleFetch = () => {
        const current = tree.get(id);
        if (!current?.isOpen) {
          return;
        }
        fetchChildren(folderUri);
      };

      if (
        typeof window !== "undefined" &&
        typeof window.requestAnimationFrame === "function"
      ) {
        window.requestAnimationFrame(scheduleFetch);
      } else {
        setTimeout(scheduleFetch, 0);
      }
    },
    [fetchChildren],
  );

  const handleRename = useCallback(
    async ({
      id,
      name,
      node,
    }: {
      id: string;
      name: string;
      node: NodeApi<TreeNode, unknown>;
    }) => {
      void id;
      const target = node.data;
      const targetStore = storeForUri(target.uri, store, fsStore, contentsStore);
      if (!targetStore) {
        node.reset();
        return;
      }
      if (target.type !== NotebookStoreItemType.File) {
        node.reset();
        return;
      }
      const trimmed = name.trim();
      const nextName = trimmed === "" ? "untitled.json" : trimmed;
      try {
        await targetStore.rename(target.uri, nextName);
        const parentUri = node.parent?.data.uri;
        if (parentUri) {
          await fetchChildren(parentUri);
        } else {
          setTreeNodes((prev) =>
            updateNodeMetadata(prev, target.uri, { name: nextName }),
          );
        }
        setErrorMessage(null);
        setPendingEditId(null);
      } catch (error) {
        console.error("Failed to rename notebook", error);
        setErrorMessage("Unable to rename document. Please try again.");
        node.reset();
      }
    },
    [contentsStore, fetchChildren, fsStore, store],
  );

  const handleOpenLocalFolder = useCallback(async () => {
    if (!fsStore) {
      return;
    }
    try {
      const workspaceRootUri = await fsStore.openWorkspace();
      if (!getItems().includes(workspaceRootUri)) {
        addItem(workspaceRootUri);
      }
      setErrorMessage(null);
    } catch (error) {
      // User cancelled the picker or API error.
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      console.error("Failed to open local folder", error);
      setErrorMessage("Unable to open folder. Please try again.");
    }
  }, [addItem, fsStore, getItems]);

  if (!store) {
    return (
      <Box className="flex h-full min-h-0 flex-col gap-3">
        <Text size="4" weight="bold">
          Google Drive
        </Text>
        <Text size="2" color="gray">
          Notebook storage is not initialized.
        </Text>
      </Box>
    );
  }

  return (
    <Box id="workspace-explorer-box" className="flex h-full min-h-0 w-full flex-col gap-3" onClick={() => setContextMenu(null)}>
      <div id="workspace-explorer-toolbar-row" className="flex items-center justify-between w-full">
        <Text size="4" weight="bold">
          Explorer
        </Text>
        <div className="flex items-center gap-1">
          {isFileSystemAccessSupported() && fsStore && (
            <button
              type="button"
              className="btn btn-soft h-8 w-8 justify-center rounded-full p-0"
              onClick={handleOpenLocalFolder}
              aria-label="Open local folder"
              title="Open local folder"
            >
              <FolderPlusIcon width={20} height={20} />
            </button>
          )}
          <GoogleDrivePickerButton
            label="Add Google Drive folder"
            className="btn btn-soft h-8 w-8 justify-center rounded-full p-0"
          >
            <CloudFolderIcon width={20} height={20} />
          </GoogleDrivePickerButton>
        </div>
      </div>

      {errorMessage && (
        <Text size="2" color="red">
          {errorMessage}
        </Text>
      )}

      {treeNodes.length === 0 ? (
        <Text size="2" color="gray">
          No notebook locations have been configured yet.
        </Text>
      ) : (
        // We set height to 95% because if we set it to 100% the dive extends beyond the bottom of the page
        // It doesn't seem to be accounting for the height of the toolbar and error message above
        // This isn't great; it leaves a gap between the bottom of the tree and the bottom of the page but
        // its the best I could come up with.
        <div
          id="workspace-explorer-tree-row"
          className="flex-1 min-h-0 w-full overflow-hidden rounded-md border border-gray-200"
          style={{ height: "95%" }}
          ref={containerRef}
        >
          <Tree
            ref={treeRef}
            data={treeNodes}
            openByDefault={false}
            width={Math.max(0, width)}
            height={height}
            indent={20}
            children={renderNode}
            onToggle={handleToggle}
            onClick={() => setContextMenu(null)}
            disableEdit={(data) => data.type !== NotebookStoreItemType.File}
            onRename={handleRename}
          />
        </div>
      )}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[180px] rounded-md border border-gray-200 bg-white py-2 shadow-lg"
          style={{
            top: contextMenu.position.y,
            left: contextMenu.position.x,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenu.type === NotebookStoreItemType.File ? (
            <>
              {!contextMenu.uri.startsWith("fs://") &&
                !contextMenu.uri.startsWith("contents://") && (
                <button
                  type="button"
                  className="block w-full px-4 py-2 text-left text-sm hover:bg-gray-100"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setContextMenu(null);
                    void (async () => {
                      try {
                        await store?.sync(contextMenu.uri);
                      } catch (error) {
                        console.error("Failed to sync file", error);
                      }
                    })();
                  }}
                >
                  Sync
                </button>
              )}
              <button
                type="button"
                className="block w-full px-4 py-2 text-left text-sm hover:bg-gray-100"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setContextMenu(null);
                  if (contextMenu.parentUri) {
                    void handleCreateDocument(contextMenu.parentUri);
                  } else {
                    console.warn(
                      "Cannot create document: no parent folder for",
                      contextMenu.uri,
                    );
                  }
                }}
              >
                New Document
              </button>
              {contextMenu.remoteUri && (
                <a
                  className="block w-full px-4 py-2 text-sm text-left hover:bg-gray-100"
                  href={contextMenu.remoteUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    event.stopPropagation();
                    setContextMenu(null);
                  }}
                >
                  Open in Google Drive
                </a>
              )}
            </>
          ) : contextMenu.type === NotebookStoreItemType.Folder ? (
            <>
              {!contextMenu.uri.startsWith("fs://") &&
                !contextMenu.uri.startsWith("contents://") && (
              <button
                type="button"
                className="block w-full px-4 py-2 text-left text-sm hover:bg-gray-100"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setContextMenu(null);

                  void (async () => {
                    try {
                      if (store) {
                        await store.sync(contextMenu.uri);
                      }
                    } catch (error) {
                      console.error("Failed to sync folder", error);
                    } finally {
                      await fetchChildren(contextMenu.uri);
                    }
                  })();
                }}
              >
                Sync
              </button>
              )}
              <button
                type="button"
                className="block w-full px-4 py-2 text-left text-sm hover:bg-gray-100"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setContextMenu(null);
                  void handleCreateDocument(contextMenu.uri);
                }}
              >
                New Document
              </button>
          {contextMenu.uri !== LOCAL_FOLDER_URI && (
                <button
                  type="button"
                  className="block w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-gray-100"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeItem(contextMenu.uri);
                    setContextMenu(null);
                  }}
                >
                  Remove "{contextMenu.name}"
                </button>
              )}
              {contextMenu.remoteUri && (
                <a
                  className="block w-full px-4 py-2 text-sm text-left hover:bg-gray-100"
                  href={contextMenu.remoteUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    event.stopPropagation();
                    setContextMenu(null);
                  }}
                >
                  Open in Google Drive
                </a>
              )}
            </>
          ) : null}
        </div>
      )}
    </Box>
  );
}

export default WorkspaceExplorer;
