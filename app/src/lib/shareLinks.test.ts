import { describe, expect, it } from "vitest";

import { buildNotebookShareUrl } from "./shareLinks";

describe("buildNotebookShareUrl", () => {
  it("builds a share URL from the current app location", () => {
    window.history.replaceState(
      null,
      "",
      "/workspace?foo=bar#ignore-this-fragment",
    );

    expect(
      buildNotebookShareUrl(
        "https://drive.google.com/file/d/shared-file-123/view",
      ),
    ).toBe(
      "http://localhost:3000/workspace?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2Fshared-file-123%2Fview",
    );
  });

  it("throws when the remote URI is empty", () => {
    expect(() => buildNotebookShareUrl("   ")).toThrow(
      "A remote notebook URI is required to build a share link",
    );
  });
});
