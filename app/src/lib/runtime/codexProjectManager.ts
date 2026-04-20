import { useEffect, useMemo, useState } from "react";

export interface CodexProject {
  id: string;
  name: string;
  cwd: string;
  model: string;
  approvalPolicy: string;
  sandboxPolicy: string;
  personality: string;
  writableRoots?: string[];
  workspaceUri?: string;
  notebookUri?: string;
}

type CodexProjectStorage = {
  projects: CodexProject[];
  defaultProjectId: string | null;
};

export type CodexProjectSnapshot = {
  projects: CodexProject[];
  defaultProject: CodexProject;
  defaultProjectId: string;
};

const CODEX_PROJECT_STORAGE_KEY = "runme/codex/projects";
const DEFAULT_PROJECT_ID = "local-default";
const CODEX_PROJECTS_CHANGED_EVENT = "runme:codex-projects-changed";
const DEFAULT_CODEX_PERSONALITY = "pragmatic";
const ALLOWED_CODEX_PERSONALITIES = new Set([
  "none",
  "friendly",
  "pragmatic",
]);

function normalizeString(value: string): string {
  return value.trim();
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePersonality(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  if (ALLOWED_CODEX_PERSONALITIES.has(normalized)) {
    return normalized;
  }
  return DEFAULT_CODEX_PERSONALITY;
}

function normalizeWritableRoots(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function createDefaultProject(): CodexProject {
  return {
    id: DEFAULT_PROJECT_ID,
    name: "Local Project",
    cwd: ".",
    model: "gpt-5.4",
    approvalPolicy: "never",
    sandboxPolicy: "workspace-write",
    personality: DEFAULT_CODEX_PERSONALITY,
  };
}

function generateProjectId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `codex-project-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeProject(
  project: Partial<CodexProject>,
  options?: { fallbackId?: string },
): CodexProject | null {
  const id = normalizeOptionalString(project.id ?? options?.fallbackId);
  const name = normalizeOptionalString(project.name);
  const cwd = normalizeOptionalString(project.cwd);
  const model = normalizeOptionalString(project.model);
  const approvalPolicy = normalizeOptionalString(project.approvalPolicy);
  const sandboxPolicy = normalizeOptionalString(project.sandboxPolicy);
  const personality = normalizePersonality(project.personality);

  if (!id || !name || !cwd || !model || !approvalPolicy || !sandboxPolicy || !personality) {
    return null;
  }

  return {
    id,
    name,
    cwd,
    model,
    approvalPolicy,
    sandboxPolicy,
    personality,
    writableRoots: normalizeWritableRoots(project.writableRoots),
    workspaceUri: normalizeOptionalString(project.workspaceUri),
    notebookUri: normalizeOptionalString(project.notebookUri),
  };
}

class CodexProjectManager {
  private static instance: CodexProjectManager | null = null;
  private projects: Map<string, CodexProject>;
  private defaultProjectId: string;
  private listeners = new Set<() => void>();
  private readonly handleStorageBound: ((event: StorageEvent) => void) | null;
  private readonly handleProjectsChangedBound: (() => void) | null;

  private constructor() {
    const loaded = this.loadFromStorage();
    this.projects = loaded.projects;
    this.defaultProjectId = loaded.defaultProjectId;
    this.ensureDefaultProject();
    if (typeof window !== "undefined") {
      this.handleStorageBound = (event: StorageEvent) => this.handleStorage(event);
      window.addEventListener("storage", this.handleStorageBound);
      this.handleProjectsChangedBound = () => this.syncFromStorage();
      window.addEventListener(
        CODEX_PROJECTS_CHANGED_EVENT,
        this.handleProjectsChangedBound,
      );
    } else {
      this.handleStorageBound = null;
      this.handleProjectsChangedBound = null;
    }
  }

  static getInstance(): CodexProjectManager {
    if (!CodexProjectManager.instance) {
      CodexProjectManager.instance = new CodexProjectManager();
    }
    return CodexProjectManager.instance;
  }

  static resetForTests(): void {
    CodexProjectManager.instance?.dispose();
    CodexProjectManager.instance = null;
  }

  list(): CodexProject[] {
    return [...this.projects.values()];
  }

  get(id: string): CodexProject | undefined {
    return this.projects.get(id);
  }

  getDefaultId(): string {
    this.ensureDefaultProject();
    return this.defaultProjectId;
  }

  getDefault(): CodexProject {
    this.ensureDefaultProject();
    return this.projects.get(this.defaultProjectId) ?? createDefaultProject();
  }

  getSnapshot(): CodexProjectSnapshot {
    const defaultProject = this.getDefault();
    return {
      projects: this.list(),
      defaultProject,
      defaultProjectId: defaultProject.id,
    };
  }

  create(
    name: string,
    cwd: string,
    model: string,
    sandboxPolicy: string,
    approvalPolicy: string,
    personality: string,
    options?: {
      writableRoots?: string[];
      workspaceUri?: string;
      notebookUri?: string;
    },
  ): CodexProject {
    const next = normalizeProject({
      id: generateProjectId(),
      name: normalizeString(name),
      cwd: normalizeString(cwd),
      model: normalizeString(model),
      sandboxPolicy: normalizeString(sandboxPolicy),
      approvalPolicy: normalizeString(approvalPolicy),
      personality: normalizeString(personality),
      writableRoots: options?.writableRoots,
      workspaceUri: options?.workspaceUri,
      notebookUri: options?.notebookUri,
    });
    if (!next) {
      throw new Error("Project name, cwd, model, sandboxPolicy, approvalPolicy, and personality are required");
    }
    this.projects.set(next.id, next);
    if (!this.defaultProjectId) {
      this.defaultProjectId = next.id;
    }
    this.persistAndNotify();
    return next;
  }

  update(id: string, patch: Partial<CodexProject>): CodexProject {
    const current = this.projects.get(id);
    if (!current) {
      throw new Error(`Codex project ${id} not found`);
    }
    const next = normalizeProject(
      {
        ...current,
        ...patch,
        id,
      },
      { fallbackId: id },
    );
    if (!next) {
      throw new Error("Updated project is missing required fields");
    }
    this.projects.set(id, next);
    this.persistAndNotify();
    return next;
  }

  delete(id: string): void {
    if (!this.projects.has(id)) {
      return;
    }
    this.projects.delete(id);
    if (this.defaultProjectId === id) {
      const first = this.list()[0];
      this.defaultProjectId = first?.id ?? "";
    }
    this.ensureDefaultProject();
    this.persistAndNotify();
  }

  setDefault(id: string): void {
    if (!this.projects.has(id)) {
      throw new Error(`Codex project ${id} not found`);
    }
    this.defaultProjectId = id;
    this.persistAndNotify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  private ensureDefaultProject(): void {
    if (this.projects.size === 0) {
      const fallback = createDefaultProject();
      this.projects.set(fallback.id, fallback);
      this.defaultProjectId = fallback.id;
      this.persist();
      return;
    }
    if (!this.defaultProjectId || !this.projects.has(this.defaultProjectId)) {
      const first = this.list()[0];
      this.defaultProjectId = first?.id ?? createDefaultProject().id;
      this.persist();
    }
  }

  private loadFromStorage(): {
    projects: Map<string, CodexProject>;
    defaultProjectId: string;
  } {
    const fallback = createDefaultProject();
    if (typeof window === "undefined") {
      return {
        projects: new Map([[fallback.id, fallback]]),
        defaultProjectId: fallback.id,
      };
    }

    try {
      const raw = window.localStorage.getItem(CODEX_PROJECT_STORAGE_KEY);
      if (!raw) {
        return {
          projects: new Map([[fallback.id, fallback]]),
          defaultProjectId: fallback.id,
        };
      }

      const parsed = JSON.parse(raw) as Partial<CodexProjectStorage> | null;
      const entries = Array.isArray(parsed?.projects) ? parsed.projects : [];
      const projects = new Map<string, CodexProject>();

      for (const entry of entries) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const normalized = normalizeProject(entry as Partial<CodexProject>);
        if (!normalized) {
          continue;
        }
        projects.set(normalized.id, normalized);
      }

      if (projects.size === 0) {
        return {
          projects: new Map([[fallback.id, fallback]]),
          defaultProjectId: fallback.id,
        };
      }

      const requestedDefault =
        typeof parsed?.defaultProjectId === "string" ? parsed.defaultProjectId : "";
      const firstProjectId = projects.keys().next().value;
      const defaultProjectId =
        typeof requestedDefault === "string" && projects.has(requestedDefault)
          ? requestedDefault
          : typeof firstProjectId === "string" && firstProjectId.length > 0
            ? firstProjectId
            : fallback.id;

      return {
        projects,
        defaultProjectId,
      };
    } catch (error) {
      console.error("Failed to load codex projects from storage", error);
      return {
        projects: new Map([[fallback.id, fallback]]),
        defaultProjectId: fallback.id,
      };
    }
  }

  private persistAndNotify(): void {
    this.persist();
    this.notify();
  }

  private persist(): void {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const payload: CodexProjectStorage = {
        projects: this.list(),
        defaultProjectId: this.defaultProjectId || null,
      };
      window.localStorage.setItem(CODEX_PROJECT_STORAGE_KEY, JSON.stringify(payload));
      window.dispatchEvent(new CustomEvent(CODEX_PROJECTS_CHANGED_EVENT));
    } catch (error) {
      console.error("Failed to persist codex projects", error);
    }
  }

  private dispose(): void {
    if (typeof window !== "undefined" && this.handleStorageBound) {
      window.removeEventListener("storage", this.handleStorageBound);
    }
    if (typeof window !== "undefined" && this.handleProjectsChangedBound) {
      window.removeEventListener(
        CODEX_PROJECTS_CHANGED_EVENT,
        this.handleProjectsChangedBound,
      );
    }
  }

  private handleStorage(event: StorageEvent): void {
    if (event.key !== CODEX_PROJECT_STORAGE_KEY) {
      return;
    }
    this.syncFromStorage();
  }

  private syncFromStorage(): void {
    const loaded = this.loadFromStorage();
    const currentSerialized = JSON.stringify({
      projects: this.list(),
      defaultProjectId: this.defaultProjectId,
    });
    const nextSerialized = JSON.stringify({
      projects: [...loaded.projects.values()],
      defaultProjectId: loaded.defaultProjectId,
    });
    if (currentSerialized === nextSerialized) {
      return;
    }
    this.projects = loaded.projects;
    this.defaultProjectId = loaded.defaultProjectId;
    this.ensureDefaultProject();
    this.notify();
  }
}

export function getCodexProjectManager(): CodexProjectManager {
  return CodexProjectManager.getInstance();
}

export function useCodexProjects(): CodexProjectSnapshot {
  const manager = useMemo(() => getCodexProjectManager(), []);
  const [snapshot, setSnapshot] = useState<CodexProjectSnapshot>(() => manager.getSnapshot());

  useEffect(() => {
    return manager.subscribe(() => {
      setSnapshot(manager.getSnapshot());
    });
  }, [manager]);

  return snapshot;
}

export function __resetCodexProjectManagerForTests(): void {
  CodexProjectManager.resetForTests();
}
