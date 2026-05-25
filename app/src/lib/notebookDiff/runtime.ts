import type { NotebookTarget, NotebooksApi } from "../runtime/runmeConsole";
import type { DriveNotebookStore, DriveRevision } from "../../storage/drive";
import type LocalNotebooks from "../../storage/local";
import { isDriveItemUri } from "../../storage/drive";
import { computeNotebookDiff } from "./diff";
import {
  openNotebookDiffDocument,
  registerNotebookDiffDocument,
} from "./registry";
import type { NotebookDiffDocument } from "./model";

export type DriveNotebookRevision = DriveRevision & { id: string };

export type NotebookDiffRuntimeApi = {
  listDriveRevisions: (target?: NotebookTarget) => Promise<DriveNotebookRevision[]>;
  diffDriveRevision: (args: {
    target?: NotebookTarget;
    revisionId: string;
    includeOutputs?: boolean;
    includeMetadata?: boolean;
  }) => Promise<NotebookDiffDocument>;
  openDiffTab: (diff: NotebookDiffDocument | { id: string }) => Promise<void>;
  help: () => string;
};

export function createNotebookDiffRuntimeApi({
  notebooksApi,
  resolveLocalNotebooks,
  resolveDriveNotebookStore,
}: {
  notebooksApi: NotebooksApi;
  resolveLocalNotebooks: () => LocalNotebooks | null;
  resolveDriveNotebookStore: () => DriveNotebookStore | null;
}): NotebookDiffRuntimeApi {
  const resolveDriveRemoteUri = async (target?: NotebookTarget) => {
    const doc = await notebooksApi.get(target);
    const localStore = resolveLocalNotebooks();
    if (!localStore) {
      throw new Error("Local notebook mirror store is not initialized yet.");
    }
    const metadata = await localStore.getMetadata(doc.handle.uri);
    const remoteUri = metadata?.remoteUri;
    if (!remoteUri || !isDriveItemUri(remoteUri)) {
      throw new Error(
        `Notebook ${doc.handle.uri} is not backed by a Google Drive file.`,
      );
    }
    return { doc, remoteUri };
  };

  const requireDriveStore = () => {
    const driveStore = resolveDriveNotebookStore();
    if (!driveStore) {
      throw new Error("Google Drive notebook store is not initialized yet.");
    }
    return driveStore;
  };

  return {
    listDriveRevisions: async (target?: NotebookTarget) => {
      const { remoteUri } = await resolveDriveRemoteUri(target);
      const revisions = await requireDriveStore().listRevisions(remoteUri);
      return revisions.filter((revision): revision is DriveNotebookRevision =>
        Boolean(revision.id),
      );
    },
    diffDriveRevision: async (args) => {
      if (!args?.revisionId?.trim()) {
        throw new Error("notebookDiff.diffDriveRevision requires revisionId.");
      }
      const { doc, remoteUri } = await resolveDriveRemoteUri(args.target);
      const driveStore = requireDriveStore();
      const baseNotebook = await driveStore.loadRevision(
        remoteUri,
        args.revisionId,
      );
      const diff = computeNotebookDiff(baseNotebook, doc.notebook, {
        includeOutputs: args.includeOutputs ?? true,
        includeMetadata: args.includeMetadata ?? true,
      });
      diff.baseLabel = `Drive revision ${args.revisionId}`;
      diff.compareLabel = "Local copy";
      return registerNotebookDiffDocument({
        base: {
          label: diff.baseLabel,
          revisionId: args.revisionId,
        },
        compare: {
          label: diff.compareLabel,
          revisionId: doc.handle.revision,
        },
        diff,
      });
    },
    openDiffTab: async (diff) => {
      openNotebookDiffDocument(diff);
    },
    help: () =>
      [
        "notebookDiff.listDriveRevisions(target?)",
        "notebookDiff.diffDriveRevision({ target?, revisionId, includeOutputs?, includeMetadata? })",
        "notebookDiff.openDiffTab(diffOrId)",
        "Example:",
        "  const revisions = await notebookDiff.listDriveRevisions();",
        "  const diff = await notebookDiff.diffDriveRevision({ revisionId: revisions.at(-2).id });",
        "  await notebookDiff.openDiffTab(diff);",
      ].join("\n"),
  };
}

