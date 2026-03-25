// @vitest-environment jsdom
import { useEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type PanelKey = "explorer" | "chatkit" | null;

let authData: {} | null = null;
let isDriveSyncing = false;
let activePanelState: PanelKey = "explorer";
let chatKitMountCount = 0;
let chatKitUnmountCount = 0;
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
    activePanel: activePanelState,
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
  default: () => {
    useEffect(() => {
      chatKitMountCount += 1;
      return () => {
        chatKitUnmountCount += 1;
      };
    }, []);
    return <div data-testid="chatkit-panel-mock" />;
  },
}));

vi.mock("../Workspace/WorkspaceExplorer", () => ({
  default: () => <div data-testid="workspace-explorer-mock" />,
}));

import { SidePanelContent, SidePanelToolbar } from "./SidePanel";

describe("SidePanelToolbar drive status button", () => {
  beforeEach(() => {
    authData = null;
    isDriveSyncing = false;
    activePanelState = "explorer";
    chatKitMountCount = 0;
    chatKitUnmountCount = 0;
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

describe("SidePanelContent ChatKit persistence", () => {
  beforeEach(() => {
    activePanelState = "explorer";
    chatKitMountCount = 0;
    chatKitUnmountCount = 0;
  });

  it("keeps ChatKit mounted when switching from ChatKit to Explorer and back", () => {
    activePanelState = "chatkit";
    const { rerender } = render(<SidePanelContent />);

    expect(screen.getByTestId("chatkit-panel-mock")).toBeTruthy();
    expect(chatKitMountCount).toBe(1);
    expect(chatKitUnmountCount).toBe(0);

    activePanelState = "explorer";
    rerender(<SidePanelContent />);

    expect(screen.getByTestId("chatkit-panel-mock")).toBeTruthy();
    expect(screen.getByTestId("workspace-explorer-mock")).toBeTruthy();
    expect(chatKitUnmountCount).toBe(0);

    activePanelState = "chatkit";
    rerender(<SidePanelContent />);

    expect(screen.getByTestId("chatkit-panel-mock")).toBeTruthy();
    expect(chatKitMountCount).toBe(1);
    expect(chatKitUnmountCount).toBe(0);
  });
});
