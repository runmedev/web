import { useEffect, useMemo, useState } from "react";

export type HarnessAdapter = "responses-direct" | "codex";

export interface HarnessProfile {
  name: string;
  baseUrl: string;
  adapter: HarnessAdapter;
}

type HarnessStorage = {
  harnesses: HarnessProfile[];
  defaultHarnessName: string | null;
};

export type HarnessSnapshot = {
  harnesses: HarnessProfile[];
  defaultHarness: HarnessProfile;
  defaultHarnessName: string;
};

const HARNESS_STORAGE_KEY = "runme/harness";
const DEFAULT_HARNESS_NAME = "local-responses";
const HARNESS_CHANGED_EVENT = "runme:harness-changed";

const CHATKIT_ROUTE_BY_ADAPTER: Record<HarnessAdapter, string> = {
  "responses-direct": "/responses/direct/chatkit",
  codex: "/codex/chatkit",
};

function isHarnessAdapter(value: unknown): value is HarnessAdapter {
  return value === "responses-direct" || value === "codex";
}

function normalizeStoredHarnessAdapter(value: unknown): HarnessAdapter | null {
  if (value === "responses") {
    return "responses-direct";
  }
  return isHarnessAdapter(value) ? value : null;
}

function normalizeName(value: string): string {
  return value.trim();
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function buildChatkitUrl(baseUrl: string, adapter: HarnessAdapter): string {
  const route =
    CHATKIT_ROUTE_BY_ADAPTER[adapter] ?? CHATKIT_ROUTE_BY_ADAPTER["responses-direct"];
  if (!baseUrl.trim()) {
    return route;
  }
  try {
    const url = new URL(baseUrl);
    url.pathname = route;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return `${baseUrl.replace(/\/$/, "")}${route}`;
  }
}

export function buildCodexBridgeWsUrl(baseUrl: string, options?: {
  forceReplace?: boolean;
}): string {
  const forceReplace = options?.forceReplace === true;
  try {
    const url = new URL(baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/codex/ws";
    url.hash = "";
    if (forceReplace) {
      url.searchParams.set("force_replace", "true");
    } else {
      url.search = "";
    }
    return url.toString();
  } catch {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    const normalized = trimmed.replace(/^https?:\/\//, (prefix) =>
      prefix === "https://" ? "wss://" : "ws://"
    );
    const qs = forceReplace ? "?force_replace=true" : "";
    return `${normalized}/codex/ws${qs}`;
  }
}

export function buildCodexAppServerWsUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/codex/app-server/ws";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    const normalized = trimmed.replace(/^https?:\/\//, (prefix) =>
      prefix === "https://" ? "wss://" : "ws://"
    );
    return `${normalized}/codex/app-server/ws`;
  }
}

function createDefaultHarness(baseUrl = ""): HarnessProfile {
  return {
    name: DEFAULT_HARNESS_NAME,
    baseUrl,
    adapter: "responses-direct",
  };
}

class HarnessManager {
  private static instance: HarnessManager | null = null;
  private harnesses: Map<string, HarnessProfile>;
  private defaultHarnessName: string;
  private listeners = new Set<() => void>();
  private readonly handleStorageBound: ((event: StorageEvent) => void) | null;
  private readonly handleHarnessChangedBound: (() => void) | null;

  private constructor() {
    const loaded = this.loadFromStorage();
    this.harnesses = loaded.harnesses;
    this.defaultHarnessName = loaded.defaultHarnessName;
    this.ensureDefaultHarness();
    if (typeof window !== "undefined") {
      this.handleStorageBound = (event: StorageEvent) => this.handleStorage(event);
      window.addEventListener("storage", this.handleStorageBound);
      this.handleHarnessChangedBound = () => this.syncFromStorage();
      window.addEventListener(HARNESS_CHANGED_EVENT, this.handleHarnessChangedBound);
    } else {
      this.handleStorageBound = null;
      this.handleHarnessChangedBound = null;
    }
  }

  static getInstance(): HarnessManager {
    if (!HarnessManager.instance) {
      HarnessManager.instance = new HarnessManager();
    }
    return HarnessManager.instance;
  }

  static resetForTests(): void {
    HarnessManager.instance?.dispose();
    HarnessManager.instance = null;
  }

  list(): HarnessProfile[] {
    return [...this.harnesses.values()];
  }

  get(name: string): HarnessProfile | undefined {
    return this.harnesses.get(name);
  }

  getDefaultName(): string {
    this.ensureDefaultHarness();
    return this.defaultHarnessName;
  }

  getDefault(): HarnessProfile {
    this.ensureDefaultHarness();
    return this.harnesses.get(this.defaultHarnessName) ?? createDefaultHarness();
  }

  resolveChatkitUrl(profile = this.getDefault()): string {
    return buildChatkitUrl(profile.baseUrl, profile.adapter);
  }

  getSnapshot(): HarnessSnapshot {
    const defaultHarness = this.getDefault();
    return {
      harnesses: this.list(),
      defaultHarness,
      defaultHarnessName: defaultHarness.name,
    };
  }

  update(name: string, baseUrl: string, adapter: HarnessAdapter): HarnessProfile {
    const nextName = normalizeName(name);
    const nextBaseUrl = normalizeBaseUrl(baseUrl);
    if (!nextName) {
      throw new Error("Harness name is required");
    }
    if (!isHarnessAdapter(adapter)) {
      throw new Error(`Unsupported harness adapter: ${String(adapter)}`);
    }
    if (adapter === "codex" && !nextBaseUrl) {
      throw new Error("Harness baseUrl is required for codex adapter");
    }
    const next: HarnessProfile = {
      name: nextName,
      baseUrl: nextBaseUrl,
      adapter,
    };
    this.harnesses.set(nextName, next);
    if (!this.defaultHarnessName) {
      this.defaultHarnessName = nextName;
    }
    this.persistAndNotify();
    return next;
  }

  setDefault(name: string): void {
    if (!this.harnesses.has(name)) {
      throw new Error(`Harness ${name} not found`);
    }
    this.defaultHarnessName = name;
    this.persistAndNotify();
  }

  delete(name: string): void {
    if (!this.harnesses.has(name)) {
      return;
    }
    this.harnesses.delete(name);
    if (this.defaultHarnessName === name) {
      const first = this.list()[0];
      this.defaultHarnessName = first?.name ?? "";
    }
    this.ensureDefaultHarness();
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

  private ensureDefaultHarness(): void {
    if (this.harnesses.size === 0) {
      const fallback = createDefaultHarness();
      this.harnesses.set(fallback.name, fallback);
      this.defaultHarnessName = fallback.name;
      this.persist();
      return;
    }
    if (!this.defaultHarnessName || !this.harnesses.has(this.defaultHarnessName)) {
      const first = this.list()[0];
      this.defaultHarnessName = first?.name ?? createDefaultHarness().name;
      this.persist();
    }
  }

  private loadFromStorage(): {
    harnesses: Map<string, HarnessProfile>;
    defaultHarnessName: string;
  } {
    if (typeof window === "undefined") {
      const fallback = createDefaultHarness();
      return {
        harnesses: new Map([[fallback.name, fallback]]),
        defaultHarnessName: fallback.name,
      };
    }

    try {
      const raw = window.localStorage.getItem(HARNESS_STORAGE_KEY);
      if (!raw) {
        const fallback = createDefaultHarness();
        return {
          harnesses: new Map([[fallback.name, fallback]]),
          defaultHarnessName: fallback.name,
        };
      }

      const parsed = JSON.parse(raw) as Partial<HarnessStorage> | null;
      const entries = Array.isArray(parsed?.harnesses) ? parsed.harnesses : [];
      const harnesses = new Map<string, HarnessProfile>();

      for (const entry of entries) {
        const rawAdapter = entry?.adapter;
        const adapter = normalizeStoredHarnessAdapter(entry?.adapter);
        if (
          !entry ||
          typeof entry !== "object" ||
          typeof entry.name !== "string" ||
          !adapter
        ) {
          continue;
        }
        const name = normalizeName(entry.name);
        let baseUrl = normalizeBaseUrl(
          typeof entry.baseUrl === "string" ? entry.baseUrl : "",
        );
        // Legacy "responses" entries targeted runme /chatkit, not the upstream
        // Responses API. After migration to responses-direct, default to OpenAI.
        if (rawAdapter === "responses") {
          baseUrl = "";
        }
        if (!name) {
          continue;
        }
        if (adapter === "codex" && !baseUrl) {
          continue;
        }
        harnesses.set(name, {
          name,
          baseUrl,
          adapter,
        });
      }

      if (harnesses.size === 0) {
        const fallback = createDefaultHarness();
        return {
          harnesses: new Map([[fallback.name, fallback]]),
          defaultHarnessName: fallback.name,
        };
      }

      const requestedDefault =
        typeof parsed?.defaultHarnessName === "string"
          ? parsed.defaultHarnessName
          : "";
      const firstHarnessName = this.firstHarnessName(harnesses);
      const defaultHarnessName =
        harnesses.has(requestedDefault) ? requestedDefault : firstHarnessName;

      return {
        harnesses,
        defaultHarnessName,
      };
    } catch (error) {
      console.error("Failed to load harnesses from storage", error);
      const fallback = createDefaultHarness();
      return {
        harnesses: new Map([[fallback.name, fallback]]),
        defaultHarnessName: fallback.name,
      };
    }
  }

  private firstHarnessName(harnesses: Map<string, HarnessProfile>): string {
    const first = harnesses.keys().next().value;
    return typeof first === "string" && first.length > 0
      ? first
      : DEFAULT_HARNESS_NAME;
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
      const payload: HarnessStorage = {
        harnesses: this.list(),
        defaultHarnessName: this.defaultHarnessName || null,
      };
      window.localStorage.setItem(HARNESS_STORAGE_KEY, JSON.stringify(payload));
      window.dispatchEvent(new CustomEvent(HARNESS_CHANGED_EVENT));
    } catch (error) {
      console.error("Failed to persist harnesses", error);
    }
  }

  private dispose(): void {
    if (typeof window !== "undefined" && this.handleStorageBound) {
      window.removeEventListener("storage", this.handleStorageBound);
    }
    if (typeof window !== "undefined" && this.handleHarnessChangedBound) {
      window.removeEventListener(HARNESS_CHANGED_EVENT, this.handleHarnessChangedBound);
    }
  }

  private handleStorage(event: StorageEvent): void {
    if (event.key !== HARNESS_STORAGE_KEY) {
      return;
    }
    this.syncFromStorage();
  }

  private syncFromStorage(): void {
    const loaded = this.loadFromStorage();
    const currentSerialized = JSON.stringify({
      harnesses: this.list(),
      defaultHarnessName: this.defaultHarnessName,
    });
    const nextSerialized = JSON.stringify({
      harnesses: [...loaded.harnesses.values()],
      defaultHarnessName: loaded.defaultHarnessName,
    });
    if (currentSerialized === nextSerialized) {
      return;
    }
    this.harnesses = loaded.harnesses;
    this.defaultHarnessName = loaded.defaultHarnessName;
    this.ensureDefaultHarness();
    this.notify();
  }
}

export function getHarnessManager(): HarnessManager {
  return HarnessManager.getInstance();
}

export function useHarness(): HarnessSnapshot {
  const manager = useMemo(() => getHarnessManager(), []);
  const [snapshot, setSnapshot] = useState<HarnessSnapshot>(() => manager.getSnapshot());

  useEffect(() => {
    return manager.subscribe(() => {
      setSnapshot(manager.getSnapshot());
    });
  }, [manager]);

  return snapshot;
}

export function __resetHarnessManagerForTests(): void {
  HarnessManager.resetForTests();
}
