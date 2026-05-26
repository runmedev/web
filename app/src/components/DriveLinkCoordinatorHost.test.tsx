// @vitest-environment jsdom
import { useEffect } from "react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DriveLinkCoordinatorHost from "./DriveLinkCoordinatorHost";

const mocks = vi.hoisted(() => ({
  addItem: vi.fn(),
  configure: vi.fn(),
  consumeUrlIntentFromLocation: vi.fn(),
  ensureAccessToken: vi.fn(),
  getItems: vi.fn(() => [] as string[]),
  openNotebook: vi.fn(),
  processPending: vi.fn(),
  removeItem: vi.fn(),
  setCurrentDoc: vi.fn(),
  showDocument: vi.fn(),
  store: {
    addFile: vi.fn(),
    updateFolder: vi.fn(),
  },
}));

vi.mock("../contexts/GoogleAuthContext", () => ({
  useGoogleAuth: () => ({
    ensureAccessToken: mocks.ensureAccessToken,
  }),
}));

vi.mock("../contexts/NotebookStoreContext", () => ({
  useNotebookStore: () => ({
    store: mocks.store,
  }),
}));

vi.mock("../contexts/WorkspaceContext", () => ({
  useWorkspace: () => ({
    addItem: mocks.addItem,
    getItems: mocks.getItems,
    removeItem: mocks.removeItem,
  }),
}));

vi.mock("../contexts/CurrentDocContext", () => ({
  useCurrentDoc: () => ({
    setCurrentDoc: mocks.setCurrentDoc,
  }),
}));

vi.mock("../contexts/NotebookContext", () => ({
  useNotebookContext: () => ({
    openNotebook: mocks.openNotebook,
  }),
}));

vi.mock("../contexts/WorkspaceDocumentContext", () => ({
  useWorkspaceDocumentContext: () => ({
    showDocument: mocks.showDocument,
  }),
}));

vi.mock("../lib/driveLinkCoordinator", () => ({
  driveLinkCoordinator: {
    configure: mocks.configure,
    consumeUrlIntentFromLocation: mocks.consumeUrlIntentFromLocation,
    processPending: mocks.processPending,
  },
}));

function NavigateTo({ to }: { to: string }) {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(to);
  }, [navigate, to]);

  return <DriveLinkCoordinatorHost />;
}

describe("DriveLinkCoordinatorHost", () => {
  beforeEach(() => {
    mocks.addItem.mockReset();
    mocks.configure.mockReset();
    mocks.consumeUrlIntentFromLocation.mockReset();
    mocks.ensureAccessToken.mockReset();
    mocks.getItems.mockReset();
    mocks.getItems.mockReturnValue([]);
    mocks.openNotebook.mockReset();
    mocks.processPending.mockReset();
    mocks.processPending.mockResolvedValue(undefined);
    mocks.removeItem.mockReset();
    mocks.setCurrentDoc.mockReset();
    mocks.showDocument.mockReset();
    mocks.store.addFile.mockReset();
    mocks.store.updateFolder.mockReset();
  });

  it("rechecks URL drive-link intents when the router location changes", async () => {
    const firstUrl =
      "/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2Ffile123%2Fview";
    const secondUrl =
      "/?doc=https%3A%2F%2Fdrive.google.com%2Fdrive%2Ffolders%2Ffolder123";
    const rendered = render(
      <MemoryRouter initialEntries={["/"]}>
        <NavigateTo to={firstUrl} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mocks.consumeUrlIntentFromLocation).toHaveBeenCalledTimes(2);
    });
    const callsAfterFirstUrl = mocks.consumeUrlIntentFromLocation.mock.calls.length;

    rendered.rerender(
      <MemoryRouter initialEntries={[firstUrl]}>
        <NavigateTo to={secondUrl} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mocks.consumeUrlIntentFromLocation.mock.calls.length).toBeGreaterThan(
        callsAfterFirstUrl,
      );
    });
  });
});
