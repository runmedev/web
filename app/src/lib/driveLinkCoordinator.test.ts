// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isDriveAuthError,
  isDriveMissingOrAccessDeniedError,
} from "./driveLinkCoordinator";

const STORAGE_KEY = "runme/drive-link-intents";

function createStoredIntent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "drive-intent-test",
    remoteUri: "https://drive.google.com/file/d/file123/view",
    action: "open_shared_file",
    source: "url",
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
      isDriveAuthError(
        new Error("Google Drive authorization is required."),
      ),
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
        new Error("Drive request failed (403 Forbidden): insufficientFilePermissions"),
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
      updateFolder: vi.fn(),
      addFile: vi.fn(),
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
});
