// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { createGoogleDrivePickerViews } from "./googleDrivePickerViews";

describe("Google Drive picker views", () => {
  it.each([
    ["folder", "FOLDERS", true],
    ["file", "DOCS", false],
  ] as const)(
    "adds separate My Drive and Shared drives views for %s selection",
    (kind, expectedViewId, configuresFolders) => {
      const createdViews: Array<{
        viewId: unknown;
        setEnableDrives: ReturnType<typeof vi.fn>;
        setIncludeFolders: ReturnType<typeof vi.fn>;
        setSelectFolderEnabled: ReturnType<typeof vi.fn>;
      }> = [];
      const picker = {
        ViewId: { DOCS: "DOCS", FOLDERS: "FOLDERS" },
        DocsView: class {
          setEnableDrives = vi.fn(() => this);
          setIncludeFolders = vi.fn(() => this);
          setSelectFolderEnabled = vi.fn(() => this);

          constructor(readonly viewId: unknown) {
            createdViews.push(this);
          }
        },
      };

      const views = createGoogleDrivePickerViews(picker, kind);

      expect(views).toHaveLength(2);
      expect(createdViews.map((view) => view.viewId)).toEqual([
        expectedViewId,
        expectedViewId,
      ]);
      expect(createdViews[0].setEnableDrives).not.toHaveBeenCalled();
      expect(createdViews[1].setEnableDrives).toHaveBeenCalledWith(true);
      for (const view of createdViews) {
        expect(view.setIncludeFolders).toHaveBeenCalledTimes(
          configuresFolders ? 1 : 0,
        );
        expect(view.setSelectFolderEnabled).toHaveBeenCalledTimes(
          configuresFolders ? 1 : 0,
        );
      }
    },
  );
});
