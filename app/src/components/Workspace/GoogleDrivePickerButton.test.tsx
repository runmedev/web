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
  openPicker: vi.fn(),
  pickerViews: [{ scope: "my-drive" }, { scope: "shared-drives" }],
  startGoogleDriveOAuth: vi.fn(),
  updateFolder: vi.fn(),
}));

vi.mock("react-google-drive-picker", () => ({
  default: () => [mocks.openPicker],
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
  getGoogleDrivePickerViews: vi.fn(async () => mocks.pickerViews),
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
          clientId: "drive-client-id",
          developerKey: "drive-developer-key",
          token: "cached-access-token",
          viewId: "FOLDERS",
          disableDefaultView: true,
          customViews: mocks.pickerViews,
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
    pickerConfig.callbackFunction({
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
});
