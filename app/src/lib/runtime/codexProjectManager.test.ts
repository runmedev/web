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
    expect(active.personality).toBe("pragmatic");
  });

  it("supports project create and default selection", () => {
    const mgr = getCodexProjectManager();
    const created = mgr.create(
      "Runme Repo",
      "/Users/jlewi/code/runmecodex/web",
      "gpt-5",
      "workspace-write",
      "never",
      "pragmatic",
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
      "pragmatic",
    );

    const updated = mgr.update(created.id, {
      model: "gpt-5-mini",
      personality: "friendly",
      writableRoots: ["/Users/jlewi/code/runmecodex/web/app"],
    });

    expect(updated.model).toBe("gpt-5-mini");
    expect(updated.personality).toBe("friendly");
    expect(updated.writableRoots).toEqual([
      "/Users/jlewi/code/runmecodex/web/app",
    ]);
  });

  it("normalizes legacy and invalid personalities to pragmatic", () => {
    const mgr = getCodexProjectManager();
    const created = mgr.create(
      "Runme Repo",
      "/Users/jlewi/code/runmecodex/web",
      "gpt-5",
      "workspace-write",
      "never",
      "default",
    );

    expect(created.personality).toBe("pragmatic");

    const updated = mgr.update(created.id, {
      personality: "code-review",
    });

    expect(updated.personality).toBe("pragmatic");
  });

  it("persists projects and default selection in local storage", () => {
    const mgr = getCodexProjectManager();
    const created = mgr.create(
      "Runme Repo",
      "/Users/jlewi/code/runmecodex/web",
      "gpt-5",
      "workspace-write",
      "never",
      "pragmatic",
    );
    mgr.setDefault(created.id);

    __resetCodexProjectManagerForTests();

    const reloaded = getCodexProjectManager();
    const active = reloaded.getDefault();
    expect(active.id).toBe(created.id);
    expect(active.name).toBe("Runme Repo");
    expect(reloaded.list().some((project) => project.id === created.id)).toBe(true);
  });

  it("syncs project updates from storage events", () => {
    const mgr = getCodexProjectManager();

    localStorage.setItem(
      CODEX_PROJECT_STORAGE_KEY,
      JSON.stringify({
        projects: [
          {
            id: "project-external",
            name: "External Project",
            cwd: "/tmp/project",
            model: "gpt-5",
            approvalPolicy: "never",
            sandboxPolicy: "workspace-write",
            personality: "default",
          },
        ],
        defaultProjectId: "project-external",
      }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: CODEX_PROJECT_STORAGE_KEY,
        newValue: localStorage.getItem(CODEX_PROJECT_STORAGE_KEY),
      }),
    );

    const active = mgr.getDefault();
    expect(active.id).toBe("project-external");
    expect(active.name).toBe("External Project");
    expect(active.cwd).toBe("/tmp/project");
    expect(active.personality).toBe("pragmatic");
  });

  it("syncs project updates from same-window change events", () => {
    const mgr = getCodexProjectManager();

    localStorage.setItem(
      CODEX_PROJECT_STORAGE_KEY,
      JSON.stringify({
        projects: [
          {
            id: "project-same-window",
            name: "Same Window Project",
            cwd: "/tmp/same-window",
            model: "gpt-5",
            approvalPolicy: "never",
            sandboxPolicy: "workspace-write",
            personality: "default",
          },
        ],
        defaultProjectId: "project-same-window",
      }),
    );
    window.dispatchEvent(new CustomEvent("runme:codex-projects-changed"));

    const active = mgr.getDefault();
    expect(active.id).toBe("project-same-window");
    expect(active.name).toBe("Same Window Project");
    expect(active.cwd).toBe("/tmp/same-window");
    expect(active.personality).toBe("pragmatic");
  });
});
