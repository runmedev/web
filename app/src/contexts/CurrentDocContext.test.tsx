// @vitest-environment jsdom
import { useEffect } from "react";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CurrentDocProvider, useCurrentDoc } from "./CurrentDocContext";

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
    window.history.replaceState(
      null,
      "",
      "/?doc=https%3A%2F%2Fdrive.google.com%2Fdrive%2Ffolders%2Ffolder123",
    );
  });

  it("does not clear pending URL doc intents when selecting a current doc", async () => {
    render(
      <CurrentDocProvider>
        <SetCurrentDocOnMount uri="local://file/restored" />
      </CurrentDocProvider>,
    );

    await waitFor(() => {
      expect(window.localStorage.getItem("runme/currentDoc")).toBe(
        "local://file/restored",
      );
    });
    expect(window.location.search).toContain("doc=");
  });
});
