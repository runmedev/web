// @vitest-environment jsdom
import { useEffect } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CurrentDocProvider, useCurrentDoc } from "./CurrentDocContext";

function CurrentDocProbe() {
  const { getCurrentDoc, setCurrentDoc } = useCurrentDoc();
  return (
    <div>
      <div data-testid="current-doc">{getCurrentDoc() ?? "none"}</div>
      <button
        type="button"
        onClick={() => setCurrentDoc("local://file/selected")}
      >
        Select
      </button>
    </div>
  );
}

function SetCurrentDocOnMount({ uri }: { uri: string }) {
  const { setCurrentDoc } = useCurrentDoc();

  useEffect(() => {
    setCurrentDoc(uri);
  }, [setCurrentDoc, uri]);

  return null;
}

describe("CurrentDocProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(
      null,
      "",
      "/?doc=https%3A%2F%2Fdrive.google.com%2Fdrive%2Ffolders%2Ffolder123",
    );
  });

  it("restores current doc from per-tab sessionStorage", async () => {
    window.localStorage.setItem("runme/currentDoc", "local://file/legacy");
    window.sessionStorage.setItem("runme/currentDoc", "local://file/session");

    render(
      <CurrentDocProvider>
        <CurrentDocProbe />
      </CurrentDocProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("current-doc").textContent).toBe(
        "local://file/session",
      );
    });
  });

  it("persists selection changes to sessionStorage without clearing URL doc intents", async () => {
    render(
      <CurrentDocProvider>
        <CurrentDocProbe />
      </CurrentDocProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select" }));

    expect(window.sessionStorage.getItem("runme/currentDoc")).toBe(
      "local://file/selected",
    );
    expect(window.localStorage.getItem("runme/currentDoc")).toBeNull();
    expect(window.location.search).toContain("doc=");
    await waitFor(() => {
      expect(screen.getByTestId("current-doc").textContent).toBe(
        "local://file/selected",
      );
    });
  });

  it("does not clear pending URL doc intents when selecting a current doc on mount", async () => {
    render(
      <CurrentDocProvider>
        <SetCurrentDocOnMount uri="local://file/restored" />
      </CurrentDocProvider>,
    );

    await waitFor(() => {
      expect(window.sessionStorage.getItem("runme/currentDoc")).toBe(
        "local://file/restored",
      );
    });
    expect(window.location.search).toContain("doc=");
  });
});
