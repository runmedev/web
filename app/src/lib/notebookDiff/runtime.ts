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
type NotebookDiffTarget =
  | NotebookTarget
  | { getUri: () => string }
  | null
  | undefined;

export type NotebookDiffRuntimeApi = {
  listDriveRevisions: (
    target?: NotebookDiffTarget,
  ) => Promise<DriveNotebookRevision[]>;
  diffDriveRevision: (args: {
    target?: NotebookDiffTarget;
    revisionId: string;
    includeOutputs?: boolean;
    includeMetadata?: boolean;
  }) => Promise<NotebookDiffDocument>;
  openDiffTab: (diff: NotebookDiffDocument | { id: string }) => Promise<void>;
  help: () => string;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toDriveNotebookRevision(
  revision: DriveRevision,
): DriveNotebookRevision | null {
  const id = optionalString(revision.id);
  if (!id) {
    return null;
  }
  const lastModifyingUser =
    revision.lastModifyingUser && typeof revision.lastModifyingUser === "object"
      ? {
          displayName: optionalString(revision.lastModifyingUser.displayName),
          emailAddress: optionalString(revision.lastModifyingUser.emailAddress),
        }
      : undefined;

  return {
    id,
    mimeType: optionalString(revision.mimeType),
    modifiedTime: optionalString(revision.modifiedTime),
    md5Checksum: optionalString(revision.md5Checksum),
    size: optionalString(revision.size),
    keepForever:
      typeof revision.keepForever === "boolean"
        ? revision.keepForever
        : undefined,
    lastModifyingUser,
  };
}

function normalizeTarget(target?: NotebookDiffTarget): NotebookTarget | undefined {
  if (!target) {
    return undefined;
  }
  if (hasGetUri(target)) {
    return { uri: target.getUri() };
  }
  return target;
}

function hasGetUri(
  target: NotebookDiffTarget,
): target is { getUri: () => string } {
  return (
    !!target &&
    typeof (target as { getUri?: unknown }).getUri === "function"
  );
}

export function createNotebookDiffRuntimeApi({
  notebooksApi,
  resolveLocalNotebooks,
  resolveDriveNotebookStore,
}: {
  notebooksApi: NotebooksApi;
  resolveLocalNotebooks: () => LocalNotebooks | null;
  resolveDriveNotebookStore: () => DriveNotebookStore | null;
}): NotebookDiffRuntimeApi {
  const resolveDriveRemoteUri = async (target?: NotebookDiffTarget) => {
    const doc = await notebooksApi.get(normalizeTarget(target));
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
    listDriveRevisions: async (target?: NotebookDiffTarget) => {
      const { remoteUri } = await resolveDriveRemoteUri(target);
      const revisions = await requireDriveStore().listRevisions(remoteUri);
      return revisions.flatMap((revision) => {
        const normalized = toDriveNotebookRevision(revision);
        return normalized ? [normalized] : [];
      });
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
        "  const doc = await notebooks.get();",
        "  const revisions = await notebookDiff.listDriveRevisions({ handle: doc.handle });",
        "  const diff = await notebookDiff.diffDriveRevision({ target: { handle: doc.handle }, revisionId: revisions.at(-2).id });",
        "  await notebookDiff.openDiffTab(diff);",
      ].join("\n"),
  };
}
