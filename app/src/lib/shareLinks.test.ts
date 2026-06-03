import { describe, expect, it } from "vitest";

import { buildNotebookMarkdownLink, buildNotebookShareUrl } from "./shareLinks";

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

describe("buildNotebookMarkdownLink", () => {
  it("builds markdown with the notebook title and app share URL", () => {
    window.history.replaceState(null, "", "/");

    expect(
      buildNotebookMarkdownLink(
        "202602a_tb_aws_codex_136.json",
        "https://drive.google.com/file/d/1cDDvmvjrBKQDkZi6nojVC_CSAfTSj7EV/view",
      ),
    ).toBe(
      "[202602a_tb_aws_codex_136](http://localhost:3000/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2F1cDDvmvjrBKQDkZi6nojVC_CSAfTSj7EV%2Fview)",
    );
  });

  it("escapes markdown link text", () => {
    window.history.replaceState(null, "", "/");

    expect(
      buildNotebookMarkdownLink(
        String.raw`notebook \[draft].json`,
        "https://drive.google.com/file/d/file123/view",
      ),
    ).toBe(
      String.raw`[notebook \\[draft\]](http://localhost:3000/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2Ffile123%2Fview)`,
    );
  });
});
