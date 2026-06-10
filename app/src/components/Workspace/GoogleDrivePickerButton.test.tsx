// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleDrivePickerButton } from "./GoogleDrivePickerButton";

const mocks = vi.hoisted(() => ({
  addItem: vi.fn(),
  ensureAccessToken: vi.fn(),
  getItems: vi.fn(),
  getDrivePickerConfig: vi.fn(),
  openPicker: vi.fn(),
  startGoogleDriveOAuth: vi.fn(),
  updateFolder: vi.fn(),
}));

vi.mock("react-google-drive-picker", () => ({
  default: () => [mocks.openPicker],
}));

vi.mock("../../contexts/GoogleAuthContext", async () => {
  const actual =
    await vi.importActual<typeof import("../../contexts/GoogleAuthContext")>(
      "../../contexts/GoogleAuthContext",
    );
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
    store: {
      updateFolder: mocks.updateFolder,
    },
  }),
}));

vi.mock("../../lib/googleClientManager", () => ({
  googleClientManager: {
    getDrivePickerConfig: mocks.getDrivePickerConfig,
  },
}));

describe("GoogleDrivePickerButton", () => {
  beforeEach(() => {
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
        }),
      );
    });
    expect(mocks.ensureAccessToken).toHaveBeenCalledWith({
      interactive: true,
    });
    expect(mocks.startGoogleDriveOAuth).not.toHaveBeenCalled();
  });
});
