// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGoogleDrivePickerViews,
  getGoogleDrivePickerViews,
  openGoogleDrivePicker,
} from "./googleDrivePickerViews";

describe("Google Drive picker views", () => {
  afterEach(() => {
    Object.defineProperty(window, "gapi", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, "google", {
      configurable: true,
      value: undefined,
    });
  });

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

  it("loads the Picker module before constructing custom views", async () => {
    const picker = {
      ViewId: { DOCS: "DOCS", FOLDERS: "FOLDERS" },
      DocsView: class {
        setEnableDrives = vi.fn(() => this);
        setIncludeFolders = vi.fn(() => this);
        setSelectFolderEnabled = vi.fn(() => this);
      },
    };
    const load = vi.fn(
      (
        apiName: string,
        options: {
          callback: () => void;
        },
      ) => {
        expect(apiName).toBe("picker");
        Object.defineProperty(window, "google", {
          configurable: true,
          value: { picker },
        });
        options.callback();
      },
    );
    Object.defineProperty(window, "gapi", {
      configurable: true,
      value: { load },
    });

    const views = await getGoogleDrivePickerViews("folder", 100);

    expect(load).toHaveBeenCalledTimes(1);
    expect(views).toHaveLength(2);
  });

  it("opens Picker directly with both My Drive and Shared drives views", async () => {
    const addedViews: unknown[] = [];
    const setVisible = vi.fn();
    const setAppId = vi.fn();
    const setOAuthToken = vi.fn();
    const setDeveloperKey = vi.fn();
    const setCallback = vi.fn();
    const picker = {
      ViewId: { DOCS: "DOCS", FOLDERS: "FOLDERS" },
      DocsView: class {
        setEnableDrives = vi.fn(() => this);
        setIncludeFolders = vi.fn(() => this);
        setSelectFolderEnabled = vi.fn(() => this);
      },
      PickerBuilder: class {
        addView(view: unknown) {
          addedViews.push(view);
          return this;
        }
        build() {
          return { setVisible };
        }
        setAppId(appId: string) {
          setAppId(appId);
          return this;
        }
        setCallback(callback: (data: unknown) => void) {
          setCallback(callback);
          return this;
        }
        setDeveloperKey(developerKey: string) {
          setDeveloperKey(developerKey);
          return this;
        }
        setOAuthToken(token: string) {
          setOAuthToken(token);
          return this;
        }
      },
    };
    Object.defineProperty(window, "google", {
      configurable: true,
      value: { picker },
    });
    const callback = vi.fn();

    await openGoogleDrivePicker({
      appId: "app-id",
      callback,
      developerKey: "developer-key",
      kind: "folder",
      token: "access-token",
    });

    expect(addedViews).toHaveLength(2);
    expect(setAppId).toHaveBeenCalledWith("app-id");
    expect(setOAuthToken).toHaveBeenCalledWith("access-token");
    expect(setDeveloperKey).toHaveBeenCalledWith("developer-key");
    expect(setCallback).toHaveBeenCalledWith(callback);
    expect(setVisible).toHaveBeenCalledWith(true);
  });
});
