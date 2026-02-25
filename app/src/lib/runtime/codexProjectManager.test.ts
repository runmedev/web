// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetCodexProjectManagerForTests,
  getCodexProjectManager,
} from "./codexProjectManager";

const CODEX_PROJECT_STORAGE_KEY = "runme/codex/projects";

describe("codexProjectManager", () => {
  beforeEach(() => {
    localStorage.removeItem(CODEX_PROJECT_STORAGE_KEY);
    __resetCodexProjectManagerForTests();
  });

  it("bootstraps a default local project", () => {
    const mgr = getCodexProjectManager();
    const active = mgr.getDefault();

    expect(active.id).toBe("local-default");
    expect(active.name).toBe("Local Project");
    expect(active.cwd).toBe(".");
    expect(active.model).toBe("gpt-5");
    expect(active.approvalPolicy).toBe("never");
    expect(active.sandboxPolicy).toBe("workspace-write");
  });

  it("supports project create and default selection", () => {
    const mgr = getCodexProjectManager();
    const created = mgr.create(
      "Runme Repo",
      "/Users/jlewi/code/runmecodex/web",
      "gpt-5",
      "workspace-write",
      "never",
      "default",
    );

    mgr.setDefault(created.id);

    const active = mgr.getDefault();
    expect(active.id).toBe(created.id);
    expect(active.name).toBe("Runme Repo");
    expect(active.cwd).toBe("/Users/jlewi/code/runmecodex/web");
  });

  it("supports partial project updates", () => {
    const mgr = getCodexProjectManager();
    const created = mgr.create(
      "Runme Repo",
      "/Users/jlewi/code/runmecodex/web",
      "gpt-5",
      "workspace-write",
      "never",
      "default",
    );

    const updated = mgr.update(created.id, {
      model: "gpt-5-mini",
      personality: "code-review",
      writableRoots: ["/Users/jlewi/code/runmecodex/web/app"],
    });

    expect(updated.model).toBe("gpt-5-mini");
    expect(updated.personality).toBe("code-review");
    expect(updated.writableRoots).toEqual([
      "/Users/jlewi/code/runmecodex/web/app",
    ]);
  });

  it("persists projects and default selection in local storage", () => {
    const mgr = getCodexProjectManager();
    const created = mgr.create(
      "Runme Repo",
      "/Users/jlewi/code/runmecodex/web",
      "gpt-5",
      "workspace-write",
      "never",
      "default",
    );
    mgr.setDefault(created.id);

    __resetCodexProjectManagerForTests();

    const reloaded = getCodexProjectManager();
    const active = reloaded.getDefault();
    expect(active.id).toBe(created.id);
    expect(active.name).toBe("Runme Repo");
    expect(reloaded.list().some((project) => project.id === created.id)).toBe(true);
  });
});

