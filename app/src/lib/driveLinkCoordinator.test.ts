// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NotebookStoreItemType } from "../storage/notebook";
import {
  isDriveAuthError,
  isDriveMissingOrAccessDeniedError,
} from "./driveLinkCoordinator";

const STORAGE_KEY = "runme/drive-link-intents";

function createPreflight(ownerEmail = "owner@acme.example") {
  const remoteUri = "https://drive.google.com/file/d/file123/view";
  return {
    item: {
      uri: remoteUri,
      name: "design.ipynb",
      mimeType: "application/x-ipynb+json",
    },
    parents: [
      {
        uri: "https://drive.google.com/drive/folders/parent123",
        name: "Shared Notebooks",
        type: NotebookStoreItemType.Folder,
      },
    ],
    preflight: {
      fileId: "file123",
      uri: remoteUri,
      name: "design.ipynb",
      mimeType: "application/x-ipynb+json",
      parents: [],
      owners: [
        {
          emailAddress: ownerEmail,
          permissionId: `owner-${ownerEmail}`,
        },
      ],
      canDownload: true,
      version: "7",
      headRevisionId: "revision-1",
      md5Checksum: "checksum-1",
    },
  };
}

function createCoordinatorDeps(ownerEmail = "owner@acme.example") {
  return {
    ensureAccessToken: vi.fn(async () => "token"),
    getEffectivePrincipal: vi.fn(() => "viewer@acme.example"),
    fetchPreflight: vi.fn(async () => createPreflight(ownerEmail)),
    updateFolder: vi.fn(async () => "local://folder/parent123"),
    importFile: vi.fn(async () => "local://file/file123"),
    addWorkspaceItem: vi.fn(),
    removeWorkspaceItem: vi.fn(),
    getWorkspaceItems: vi.fn(() => [] as string[]),
    openNotebook: vi.fn(async () => undefined),
  };
}

function createStoredIntent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "drive-intent-test",
    remoteUri: "https://drive.google.com/file/d/file123/view",
    action: "open_shared_file",
    source: "url",
    focus: true,
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    retryCount: 0,
    ...overrides,
  };
}

describe("isDriveAuthError", () => {
  it("treats popup blocked auth failures as auth errors", () => {
    expect(
      isDriveAuthError(
        new Error("Popup blocked while requesting Google OAuth token"),
      ),
    ).toBe(true);
  });

  it("does not treat generic Drive API failures as auth errors", () => {
    expect(
      isDriveAuthError(
        new Error("Drive request failed (404 Not Found): file missing"),
      ),
    ).toBe(false);
  });

  it("treats explicit authorization-required failures as auth errors", () => {
    expect(
      isDriveAuthError(new Error("Google Drive authorization is required.")),
    ).toBe(true);
  });
});

describe("isDriveMissingOrAccessDeniedError", () => {
  it("treats 404 drive API failures as terminal", () => {
    expect(
      isDriveMissingOrAccessDeniedError(
        new Error("Drive request failed (404 Not Found): file missing"),
      ),
    ).toBe(true);
  });

  it("treats 403 drive API failures as terminal", () => {
    expect(
      isDriveMissingOrAccessDeniedError(
        new Error(
          "Drive request failed (403 Forbidden): insufficientFilePermissions",
        ),
      ),
    ).toBe(true);
  });

  it("does not treat auth redirect handoff as terminal", () => {
    expect(
      isDriveMissingOrAccessDeniedError(
        new Error("Redirecting to Google OAuth for Drive authorization."),
      ),
    ).toBe(false);
  });
});

describe("driveLinkCoordinator intent storage", () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("does not restore legacy localStorage intents and clears them", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([createStoredIntent()]),
    );

    const { driveLinkCoordinator } = await import("./driveLinkCoordinator");

    expect(driveLinkCoordinator.getSnapshot().intents).toEqual([]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("restores pending intents from sessionStorage for the current tab", async () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([createStoredIntent({ status: "processing" })]),
    );

    const { driveLinkCoordinator } = await import("./driveLinkCoordinator");

    expect(driveLinkCoordinator.getSnapshot().intents).toEqual([
      expect.objectContaining({
        id: "drive-intent-test",
        remoteUri: "https://drive.google.com/file/d/file123/view",
        status: "pending",
      }),
    ]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("persists auth-blocked intents in sessionStorage only", async () => {
    const remoteUri = "https://drive.google.com/file/d/file123/view";
    const { driveLinkCoordinator } = await import("./driveLinkCoordinator");

    driveLinkCoordinator.configure({
      ensureAccessToken: vi.fn(async () => {
        throw new Error("Google Drive authorization is required.");
      }),
      getEffectivePrincipal: vi.fn(() => null),
      fetchPreflight: vi.fn(),
      updateFolder: vi.fn(),
      importFile: vi.fn(),
      addWorkspaceItem: vi.fn(),
      removeWorkspaceItem: vi.fn(),
      getWorkspaceItems: vi.fn(() => []),
      openNotebook: vi.fn(),
    });

    await driveLinkCoordinator.enqueue(remoteUri, "manual");

    const stored = JSON.parse(
      window.sessionStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    expect(stored).toEqual([
      expect.objectContaining({
        remoteUri,
        action: "open_shared_file",
        status: "waiting_for_auth",
        retryCount: 1,
      }),
    ]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("automatically opens a notebook owned by the same Workspace domain", async () => {
    const remoteUri = "https://drive.google.com/file/d/file123/view";
    const { driveLinkCoordinator } = await import("./driveLinkCoordinator");
    const deps = createCoordinatorDeps();
    driveLinkCoordinator.configure(deps);

    await driveLinkCoordinator.enqueue(remoteUri, "manual");

    expect(deps.fetchPreflight).toHaveBeenCalledWith(remoteUri);
    expect(deps.importFile).toHaveBeenCalledWith(
      remoteUri,
      "design.ipynb",
      expect.objectContaining({
        expected: {
          checksum: "checksum-1",
          revisionId: "revision-1",
          version: "7",
        },
      }),
    );
    expect(deps.openNotebook).toHaveBeenCalledWith("local://file/file123", {
      focus: true,
    });
    expect(driveLinkCoordinator.getSnapshot().intents).toEqual([]);

    const { loadSharedNotebookTrustRecords } = await import(
      "./sharedNotebookTrust"
    );
    expect(loadSharedNotebookTrustRecords()).toEqual([
      expect.objectContaining({
        fileId: "file123",
        effectivePrincipal: "viewer@acme.example",
        basis: "same_domain",
      }),
    ]);
  });

  it("imports a Drive notebook in the background when focus is disabled", async () => {
    const remoteUri = "https://drive.google.com/file/d/file123/view";
    const { driveLinkCoordinator } = await import("./driveLinkCoordinator");
    const deps = createCoordinatorDeps();
    driveLinkCoordinator.configure(deps);

    await driveLinkCoordinator.enqueue(remoteUri, "manual", { focus: false });

    expect(deps.openNotebook).toHaveBeenCalledWith("local://file/file123", {
      focus: false,
    });
  });

  it("does not download an external notebook before review", async () => {
    const remoteUri = "https://drive.google.com/file/d/file123/view";
    const { driveLinkCoordinator } = await import("./driveLinkCoordinator");
    const deps = createCoordinatorDeps("attacker@external.example");
    driveLinkCoordinator.configure(deps);

    await driveLinkCoordinator.enqueue(remoteUri, "manual");

    expect(deps.importFile).not.toHaveBeenCalled();
    expect(deps.openNotebook).not.toHaveBeenCalled();
    expect(driveLinkCoordinator.getSnapshot().intents).toEqual([
      expect.objectContaining({
        remoteUri,
        status: "awaiting_review",
        preflight: expect.objectContaining({ name: "design.ipynb" }),
        trustDecision: expect.objectContaining({ trusted: false }),
      }),
    ]);
  });

  it("persists explicit document trust before opening a reviewed notebook", async () => {
    const remoteUri = "https://drive.google.com/file/d/file123/view";
    const { driveLinkCoordinator } = await import("./driveLinkCoordinator");
    const deps = createCoordinatorDeps("partner@external.example");
    driveLinkCoordinator.configure(deps);

    await driveLinkCoordinator.enqueue(remoteUri, "manual");
    const intent = driveLinkCoordinator.getSnapshot().intents[0];
    expect(intent?.status).toBe("awaiting_review");

    await driveLinkCoordinator.trustAndOpen(intent.id);

    expect(deps.importFile).toHaveBeenCalledTimes(1);
    expect(deps.openNotebook).toHaveBeenCalledWith("local://file/file123", {
      focus: true,
    });
    expect(driveLinkCoordinator.getSnapshot().intents).toEqual([]);
    const { loadSharedNotebookTrustRecords } = await import(
      "./sharedNotebookTrust"
    );
    expect(loadSharedNotebookTrustRecords()).toEqual([
      expect.objectContaining({
        fileId: "file123",
        basis: "explicit_document",
      }),
    ]);
  });

  it("re-evaluates a metadata-only review when authorization identifies the principal", async () => {
    const remoteUri = "https://drive.google.com/file/d/file123/view";
    const { driveLinkCoordinator } = await import("./driveLinkCoordinator");
    let principal: string | null = null;
    const deps = {
      ...createCoordinatorDeps(),
      getEffectivePrincipal: vi.fn(() => principal),
    };
    driveLinkCoordinator.configure(deps);

    await driveLinkCoordinator.enqueue(remoteUri, "manual");
    expect(driveLinkCoordinator.getSnapshot().intents[0]?.status).toBe(
      "awaiting_review",
    );
    expect(deps.importFile).not.toHaveBeenCalled();

    principal = "viewer@acme.example";
    driveLinkCoordinator.configure(deps);
    await driveLinkCoordinator.processPending();

    expect(deps.importFile).toHaveBeenCalledTimes(1);
    expect(deps.openNotebook).toHaveBeenCalledTimes(1);
    expect(driveLinkCoordinator.getSnapshot().intents).toEqual([]);
  });
});
