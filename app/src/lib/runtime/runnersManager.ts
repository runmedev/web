import { Runner } from "../runner";
import { makeAuthInterceptor } from "../../App";

const RUNNERS_STORAGE_KEY = "aisre/runners";
const DEFAULT_RUNNER_NAME_STORAGE_KEY = "aisre/defaultRunner";
export const DEFAULT_RUNNER_PLACEHOLDER = "<default>";

// TODO(jlewi): The use of makeAuthInterceptor() to attach interceptors for
// auth is a real bolt on. We should probably rethink that and try to do it in
// a cleaner way.

class RunnersManager {
  private static instance: RunnersManager | null = null;
  private runners: Map<string, Runner>;
  private defaultRunnerName: string | null;

  private constructor() {
    const { runners, defaultRunnerName } = this.loadFromStorage();
    this.runners = runners;
    this.defaultRunnerName = defaultRunnerName;
  }

  static getInstance(): RunnersManager {
    if (!RunnersManager.instance) {
      RunnersManager.instance = new RunnersManager();
    }
    return RunnersManager.instance;
  }

  getDefaultRunnerName(): string | null {
    if (this.defaultRunnerName && this.runners.has(this.defaultRunnerName)) {
      return this.defaultRunnerName;
    }
    const fallback = this.runners.size > 0 ? [...this.runners.keys()][0] : null;
    if (fallback !== this.defaultRunnerName) {
      this.defaultRunnerName = fallback;
      this.persist();
    }
    return fallback;
  }

  list(): Runner[] {
    return [...this.runners.values()];
  }

  get(name: string): Runner | undefined {
    return this.runners.get(name);
  }

  /**
   * Resolve a runner by name, falling back to default then first available.
   */
  getWithFallback(name?: string | null): Runner | undefined {
    if (name && this.runners.has(name)) {
      return this.runners.get(name);
    }
    const defaultName = this.getDefaultRunnerName();
    if (defaultName && this.runners.has(defaultName)) {
      return this.runners.get(defaultName);
    }
    return this.list()[0];
  }

  setDefault(name: string): void {
    if (!this.runners.has(name)) {
      return;
    }
    this.defaultRunnerName = name;
    this.persist();
  }

  update(name: string, endpoint: string, reconnect = true): Runner {
    const existing = this.runners.get(name);
    const next = new Runner({
      name,
      endpoint,
      reconnect: existing?.reconnect ?? reconnect,      
      interceptors: makeAuthInterceptor(),
    });
    this.runners.set(name, next);
    if (!this.defaultRunnerName) {
      this.defaultRunnerName = name;
    }
    this.persist();
    return next;
  }

  delete(name: string): void {
    if (!this.runners.has(name)) {
      return;
    }
    this.runners.delete(name);
    if (this.defaultRunnerName === name) {
      this.defaultRunnerName = this.runners.size > 0 ? [...this.runners.keys()][0] : null;
    }
    this.persist();
  }

  private loadFromStorage(): { runners: Map<string, Runner>; defaultRunnerName: string | null } {
    if (typeof window === "undefined") {
      return { runners: new Map(), defaultRunnerName: null };
    }
    try {
      const raw = window.localStorage.getItem(RUNNERS_STORAGE_KEY);
      const defaultName = window.localStorage.getItem(DEFAULT_RUNNER_NAME_STORAGE_KEY);
      if (!raw) {
        return { runners: new Map(), defaultRunnerName: defaultName };
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return { runners: new Map(), defaultRunnerName: defaultName };
      }
      const runners = parsed
        .map((item) => {
          if (
            !item ||
            typeof item !== "object" ||
            typeof (item as any).name !== "string" ||
            typeof (item as any).endpoint !== "string"
          ) {
            return null;
          }
          return new Runner({
            name: (item as any).name,
            endpoint: (item as any).endpoint,
            reconnect: typeof (item as any).reconnect === "boolean" ? (item as any).reconnect : true,
            interceptors: makeAuthInterceptor(),
          });
        })
        .filter((r): r is Runner => Boolean(r));
      return {
        runners: new Map(runners.map((r) => [r.name, r])),
        defaultRunnerName: defaultName ?? null,
      };
    } catch (error) {
      console.error("Failed to load runners from storage", error);
      return { runners: new Map(), defaultRunnerName: null };
    }
  }

  private persist(): void {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const serialized = [...this.runners.values()].map((runner) => ({
        name: runner.name,
        endpoint: runner.endpoint,
        reconnect: runner.reconnect,
      }));
      window.localStorage.setItem(RUNNERS_STORAGE_KEY, JSON.stringify(serialized));
      if (this.defaultRunnerName) {
        window.localStorage.setItem(DEFAULT_RUNNER_NAME_STORAGE_KEY, this.defaultRunnerName);
      } else {
        window.localStorage.removeItem(DEFAULT_RUNNER_NAME_STORAGE_KEY);
      }
    } catch (error) {
      console.error("Failed to persist runners to storage", error);
    }
  }
}

export function getRunnersManager(): RunnersManager {
  return RunnersManager.getInstance();
}
