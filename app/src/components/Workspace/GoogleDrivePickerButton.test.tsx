// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tourUiController } from "../../lib/tourUiController";
import { GoogleDrivePickerButton } from "./GoogleDrivePickerButton";

const mocks = vi.hoisted(() => ({
  addItem: vi.fn(),
  ensureAccessToken: vi.fn(),
  getItems: vi.fn(),
  getDrivePickerConfig: vi.fn(),
  listSharedDrives: vi.fn(),
  openPicker: vi.fn(),
  startGoogleDriveOAuth: vi.fn(),
  updateFolder: vi.fn(),
}));

vi.mock("../../contexts/GoogleAuthContext", async () => {
  const actual = await vi.importActual<
    typeof import("../../contexts/GoogleAuthContext")
  >("../../contexts/GoogleAuthContext");
  return {
    ...actual,
    useGoogleAuth: () => ({
      ensureAccessToken: mocks.ensureAccessToken,
      startGoogleDriveOAuth: mocks.startGoogleDriveOAuth,
    }),
  };
});

vi.mock("../../contexts/WorkspaceContext", () => ({
  useWorkspace: () => ({
    addItem: mocks.addItem,
    getItems: mocks.getItems,
  }),
}));

vi.mock("../../contexts/NotebookStoreContext", () => ({
  useNotebookStore: () => ({
    store: { updateFolder: mocks.updateFolder },
  }),
}));

vi.mock("../../lib/googleClientManager", () => ({
  googleClientManager: {
    getDrivePickerConfig: mocks.getDrivePickerConfig,
  },
}));

vi.mock("../../lib/onboarding", () => ({
  markOnboardingTaskComplete: vi.fn(),
}));

vi.mock("./googleDrivePickerViews", () => ({
  openGoogleDrivePicker: mocks.openPicker,
}));

vi.mock("./googleSharedDrives", () => ({
  listGoogleSharedDrives: mocks.listSharedDrives,
}));

describe("GoogleDrivePickerButton", () => {
  beforeEach(() => {
    tourUiController.resetForTests();
    mocks.addItem.mockReset();
    mocks.ensureAccessToken.mockReset();
    mocks.ensureAccessToken.mockResolvedValue("cached-access-token");
    mocks.getItems.mockReset();
    mocks.getItems.mockReturnValue([]);
    mocks.getDrivePickerConfig.mockReset();
    mocks.getDrivePickerConfig.mockReturnValue({
      appId: "drive-app-id",
      clientId: "drive-client-id",
      developerKey: "drive-developer-key",
    });
    mocks.listSharedDrives.mockReset();
    mocks.listSharedDrives.mockResolvedValue([]);
    mocks.openPicker.mockReset();
    mocks.startGoogleDriveOAuth.mockReset();
    mocks.updateFolder.mockReset();
  });

  afterEach(() => {
    tourUiController.resetForTests();
  });

  it("reuses an access token before opening the Drive picker", async () => {
    render(<GoogleDrivePickerButton />);

    fireEvent.click(screen.getByRole("button", { name: "Choose Folder" }));

    await waitFor(() => {
      expect(mocks.openPicker).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: "drive-app-id",
          developerKey: "drive-developer-key",
          token: "cached-access-token",
          kind: "folder",
          callback: expect.any(Function),
        }),
      );
    });
    expect(mocks.ensureAccessToken).toHaveBeenCalledWith({
      interactive: true,
    });
    expect(mocks.startGoogleDriveOAuth).not.toHaveBeenCalled();
  });

  it("registers a semantic target and completes only after a folder is added", async () => {
    mocks.ensureAccessToken.mockResolvedValue("token");
    mocks.getItems.mockReturnValue([]);
    mocks.updateFolder.mockResolvedValue("local://folder/selected");
    const initialCount =
      tourUiController.getSnapshot().googleDriveFolderAddedCount;

    render(<GoogleDrivePickerButton label="Add Google Drive folder" />);
    const button = screen.getByRole("button", {
      name: "Add Google Drive folder",
    });
    expect(button.getAttribute("data-tour-id")).toBe(
      "explorer.add-google-drive-folder",
    );

    fireEvent.click(button);
    await waitFor(() => expect(mocks.openPicker).toHaveBeenCalledTimes(1));
    expect(tourUiController.getSnapshot().googleDriveFolderAddedCount).toBe(
      initialCount,
    );

    const pickerConfig = mocks.openPicker.mock.calls[0]?.[0];
    pickerConfig.callback({
      action: "picked",
      docs: [
        {
          id: "folder-id",
          name: "Selected",
          mimeType: "application/vnd.google-apps.folder",
        },
      ],
    });

    await waitFor(() =>
      expect(tourUiController.getSnapshot().googleDriveFolderAddedCount).toBe(
        initialCount + 1,
      ),
    );
    expect(mocks.addItem).toHaveBeenCalledWith("local://folder/selected");
  });

  it("mounts a Shared Drive root without relying on Picker selection", async () => {
    mocks.listSharedDrives.mockResolvedValue([
      { id: "shared-drive-id", name: "notebooks" },
    ]);
    mocks.updateFolder.mockResolvedValue("local://folder/shared-drive");

    render(<GoogleDrivePickerButton />);
    fireEvent.click(screen.getByRole("button", { name: "Choose Folder" }));

    const sharedDriveButton = await screen.findByRole("button", {
      name: "Select notebooks Shared Drive root",
    });
    expect(mocks.openPicker).not.toHaveBeenCalled();

    fireEvent.click(sharedDriveButton);

    await waitFor(() =>
      expect(mocks.updateFolder).toHaveBeenCalledWith(
        "https://drive.google.com/drive/folders/shared-drive-id",
        "notebooks",
      ),
    );
    expect(mocks.addItem).toHaveBeenCalledWith(
      "local://folder/shared-drive",
    );
  });

  it("opens Picker from the Shared Drive root chooser for nested folders", async () => {
    mocks.listSharedDrives.mockResolvedValue([
      { id: "shared-drive-id", name: "notebooks" },
    ]);

    render(<GoogleDrivePickerButton />);
    fireEvent.click(screen.getByRole("button", { name: "Choose Folder" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Browse folders…" }),
    );

    await waitFor(() =>
      expect(mocks.openPicker).toHaveBeenCalledWith(
        expect.objectContaining({ token: "cached-access-token" }),
      ),
    );
    expect(
      screen.queryByRole("dialog", { name: "Choose a Google Drive folder" }),
    ).toBeNull();
  });

  it("shows actionable guidance when Shared Drives cannot be listed", async () => {
    mocks.listSharedDrives.mockRejectedValue(new Error("Drive API disabled"));

    render(<GoogleDrivePickerButton />);
    fireEvent.click(screen.getByRole("button", { name: "Choose Folder" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Verify that the Google Drive API is enabled for this credential's project",
    );
    expect(mocks.openPicker).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Browse folders…" }));
    await waitFor(() => expect(mocks.openPicker).toHaveBeenCalledTimes(1));
  });
});
