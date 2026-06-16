import { describe, expect, it } from "vitest";

import {
  EXCALIDRAW_MIME_TYPE,
  createInitialExcalidrawDocumentJson,
  isExcalidrawDocumentMetadata,
  isExcalidrawFileName,
  isExcalidrawMimeType,
} from "./excalidraw";

describe("excalidraw storage helpers", () => {
  it("recognizes Excalidraw file names", () => {
    expect(isExcalidrawFileName("diagram.excalidraw")).toBe(true);
    expect(isExcalidrawFileName("diagram.excalidraw.json")).toBe(true);
    expect(isExcalidrawFileName("notebook.json")).toBe(false);
  });

  it("recognizes Excalidraw MIME metadata", () => {
    expect(isExcalidrawMimeType(EXCALIDRAW_MIME_TYPE)).toBe(true);
    expect(isExcalidrawMimeType("application/json")).toBe(false);
    expect(
      isExcalidrawDocumentMetadata({
        name: "diagram.json",
        mimeType: EXCALIDRAW_MIME_TYPE,
      }),
    ).toBe(true);
  });

  it("creates an empty Excalidraw JSON document", () => {
    expect(JSON.parse(createInitialExcalidrawDocumentJson())).toMatchObject({
      type: "excalidraw",
      version: 2,
      elements: [],
      files: {},
    });
  });
});
