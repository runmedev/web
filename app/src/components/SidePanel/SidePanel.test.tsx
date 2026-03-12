// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let authData: {} | null = null;
let isDriveSyncing = false;
const ensureAccessTokenMock = vi.fn(async () => "token");
const loginWithRedirectMock = vi.fn();
const logoutMock = vi.fn();
const togglePanelMock = vi.fn();

vi.mock("../../browserAdapter.client", () => ({
  useBrowserAuthData: () => authData,
  getBrowserAdapter: () => ({
    loginWithRedirect: loginWithRedirectMock,
    logout: logoutMock,
  }),
}));

vi.mock("../../contexts/SidePanelContext", () => ({
  useSidePanel: () => ({
    activePanel: "explorer" as const,
    togglePanel: togglePanelMock,
  }),
}));

vi.mock("../../contexts/GoogleAuthContext", () => ({
  useGoogleAuth: () => ({
    ensureAccessToken: ensureAccessTokenMock,
    isDriveSyncing,
  }),
}));

vi.mock("../ChatKit/ChatKitPanel", () => ({
  default: () => null,
}));

vi.mock("../Workspace/WorkspaceExplorer", () => ({
  default: () => null,
}));

import { SidePanelToolbar } from "./SidePanel";

describe("SidePanelToolbar drive status button", () => {
  beforeEach(() => {
    authData = null;
    isDriveSyncing = false;
    ensureAccessTokenMock.mockClear();
    loginWithRedirectMock.mockClear();
    logoutMock.mockClear();
    togglePanelMock.mockClear();
  });

  it("renders the Drive status button above Login and starts auth when not syncing", async () => {
    render(<SidePanelToolbar />);

    const driveStatusButton = screen.getByRole("button", {
      name: "Google Drive status: Not syncing",
    });
    const loginButton = screen.getByRole("button", { name: "Login" });

    expect(
      driveStatusButton.compareDocumentPosition(loginButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(driveStatusButton);
      await Promise.resolve();
    });
    expect(ensureAccessTokenMock).toHaveBeenCalledWith({ interactive: true });
  });

  it("does not start auth when Drive is already syncing", () => {
    isDriveSyncing = true;
    render(<SidePanelToolbar />);

    const driveStatusButton = screen.getByRole("button", {
      name: "Google Drive status: Syncing",
    });
    fireEvent.click(driveStatusButton);

    expect(ensureAccessTokenMock).not.toHaveBeenCalled();
  });
});
