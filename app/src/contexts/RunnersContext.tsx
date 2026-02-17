import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { type Interceptor } from "@connectrpc/connect";

import { Runner, RunnerMap } from "../lib/runner";
import { getRunnersManager } from "../lib/runtime/runnersManager";

const RUNNERS_STORAGE_KEY = "runme/runners";
const DEFAULT_RUNNER_NAME_STORAGE_KEY = "runme/defaultRunner";
const LEGACY_RUNNERS_STORAGE_KEY = "aisre/runners";
const LEGACY_DEFAULT_RUNNER_NAME_STORAGE_KEY = "aisre/defaultRunner";

type StoredRunner = {
  name: string;
  endpoint: string;
  reconnect: boolean;
};

type RunnersContextValue = {
  defaultRunnerName: string | null;
  getRunner: (name: string) => Runner | undefined;
  listRunners: () => Runner[];
  setDefaultRunner: (name: string) => void;
  updateRunner: (runner: Runner) => void;
  deleteRunner: (name: string) => void;
};

const RunnersContext = createContext<RunnersContextValue | undefined>(
  undefined,
);

// eslint-disable-next-line react-refresh/only-export-components
export const useRunners = () => {
  const context = useContext(RunnersContext);
  if (!context) {
    throw new Error("useRunners must be used within a RunnersProvider");
  }
  return context;
};

type RunnersProviderProps = {
  children: ReactNode;
  initialRunners?: Runner[];
  initialDefaultRunnerName?: string;
  makeInterceptors?: () => Interceptor[];
};

function loadStoredRunners(
  makeInterceptors?: () => ReturnType<Runner["interceptors"]>,
): { runners: RunnerMap; defaultRunnerName: string | null } {
  if (typeof window === "undefined") {
    return { runners: new Map(), defaultRunnerName: null };
  }

  const interceptors = makeInterceptors ? makeInterceptors() : [];
  try {
    const mgr = getRunnersManager();
    const storedDefaultRunnerName =
      window.localStorage.getItem(DEFAULT_RUNNER_NAME_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_DEFAULT_RUNNER_NAME_STORAGE_KEY) ??
      mgr.getDefaultRunnerName();
    const runners = mgr.list().map(
      (r) =>
        new Runner({
          name: r.name,
          endpoint: r.endpoint,
          reconnect: r.reconnect,
          interceptors,
        }),
    );
    return {
      runners: new Map(runners.map((runner) => [runner.name, runner])),
      defaultRunnerName: storedDefaultRunnerName ?? null,
    };
  } catch (error) {
    console.error("Failed to load runners from storage", error);
    return { runners: new Map(), defaultRunnerName: null };
  }
}

function persistRunners(
  runners: RunnerMap,
  defaultRunnerName: string | null,
): void {
  if (typeof window === "undefined") {
    return;
  }
  const serialized = [...runners.values()].map((runner) => ({
    name: runner.name,
    endpoint: runner.endpoint,
    reconnect: runner.reconnect,
  }));
  try {
    window.localStorage.setItem(RUNNERS_STORAGE_KEY, JSON.stringify(serialized));
    window.localStorage.removeItem(LEGACY_RUNNERS_STORAGE_KEY);
    if (defaultRunnerName) {
      window.localStorage.setItem(
        DEFAULT_RUNNER_NAME_STORAGE_KEY,
        defaultRunnerName,
      );
      window.localStorage.removeItem(LEGACY_DEFAULT_RUNNER_NAME_STORAGE_KEY);
    } else {
      window.localStorage.removeItem(DEFAULT_RUNNER_NAME_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_DEFAULT_RUNNER_NAME_STORAGE_KEY);
    }
  } catch (error) {
    console.error("Failed to persist runners to storage", error);
  }
}

export function RunnersProvider({
  children,
  initialRunners = [],
  initialDefaultRunnerName = null,
  makeInterceptors,
}: RunnersProviderProps) {
  const initialFromStorage = useMemo(
    () => loadStoredRunners(makeInterceptors),
    [makeInterceptors],
  );

  const [runners, setRunners] = useState<RunnerMap>(() => {
    if (initialFromStorage.runners.size > 0) {
      return initialFromStorage.runners;
    }
    const interceptors = makeInterceptors ? makeInterceptors() : [];
    if (initialRunners.length > 0) {
      return new Map(
        initialRunners.map((runner) => [
          runner.name,
          new Runner({
            name: runner.name,
            endpoint: runner.endpoint,
            reconnect: runner.reconnect,
            interceptors,
          }),
        ]),
      );
    }
    return new Map();
  });

  const [defaultRunnerName, setDefaultRunnerName] = useState<string | null>(() =>
    initialFromStorage.defaultRunnerName !== null
      ? initialFromStorage.defaultRunnerName
      : initialDefaultRunnerName ?? initialRunners[0]?.name ?? null,
  );

  useEffect(() => {
    persistRunners(runners, defaultRunnerName);
    // Sync React state to the RunnersManager singleton so that non-React code
    // (e.g. NotebookData.getRunner) can resolve runners.
    const mgr = getRunnersManager();
    for (const runner of runners.values()) {
      mgr.update(runner.name, runner.endpoint, runner.reconnect);
    }
    if (defaultRunnerName) {
      mgr.setDefault(defaultRunnerName);
    }
  }, [defaultRunnerName, runners]);

  useEffect(() => {
    if (!makeInterceptors) {
      return;
    }
    const interceptors = makeInterceptors();
    setRunners((prev) => {
      const next = new Map(prev);
      for (const [name, runner] of next.entries()) {
        runner.interceptors = interceptors;
        next.set(name, runner);
      }
      return next;
    });
  }, [makeInterceptors]);

  const getRunner = useCallback(
    (name: string) => {
      return runners.get(name);
    },
    [runners],
  );

  const listRunners = useCallback(() => {
    return [...runners.values()];
  }, [runners]);

  const setDefaultRunner = useCallback(
    (name: string) => {
      if (!runners.has(name)) {
        return;
      }
      setDefaultRunnerName(name);
      getRunnersManager().setDefault(name);
    },
    [runners],
  );

  const updateRunner = useCallback((runner: Runner) => {
    setRunners((prev) => {
      const next = new Map(prev);
      next.set(runner.name, runner);
      return next;
    });
    const mgr = getRunnersManager();
    mgr.update(runner.name, runner.endpoint, runner.reconnect);
  }, []);

  const deleteRunner = useCallback((name: string) => {
    setRunners((prev) => {
      if (!prev.has(name)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(name);
      return next;
    });
    getRunnersManager().delete(name);
  }, []);

  const value = useMemo(
    () => ({
      defaultRunnerName,
      getRunner,
      listRunners,
      setDefaultRunner,
      updateRunner,
      deleteRunner,
    }),
    [
      defaultRunnerName,
      getRunner,
      listRunners,
      setDefaultRunner,
      updateRunner,
      deleteRunner,
    ],
  );

  return (
    <RunnersContext.Provider value={value}>
      {children}
    </RunnersContext.Provider>
  );
}
