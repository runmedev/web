import { useCallback, useEffect, useMemo, useRef } from "react";
import { Helmet } from "react-helmet";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Callback from "./routes/callback";
import RunRoute from "./routes/run";
import RunsRoute from "./routes/runs";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import AuthStatus from "./components/AuthStatus/AuthStatus";
import runmeIcon from "./assets/runme-icon.svg";
import { WebAppConfig } from "@buf/stateful_runme.bufbuild_es/agent/v1/webapp_pb";

// import Actions from "./components/Actions/Actions";
// import Chat from "./components/Chat/Chat";
// import FileViewer from "./components/Files/Viewer";
import NotFound from "./components/NotFound";
import { SettingsProvider } from "./contexts/SettingsContext";
import { OutputProvider } from "./contexts/OutputContext";
import { CellProvider } from "./contexts/CellContext";
import { WorkspaceProvider } from "./contexts/WorkspaceContext";
import {
  NotebookStoreProvider,
  useNotebookStore,
} from "./contexts/NotebookStoreContext";
import { NotebookProvider } from "./contexts/NotebookContext";
import {
  GoogleAuthProvider,
  useGoogleAuth,
} from "./contexts/GoogleAuthContext";
import { DriveNotebookStore } from "./storage/drive";
import { FilesystemNotebookStore } from "./storage/fs";
import { isFileSystemAccessSupported } from "./storage/fs";
import LocalNotebooks from "./storage/local";
import { CurrentDocProvider } from "./contexts/CurrentDocContext";
import {
  FilesystemStoreProvider,
  useFilesystemStore,
} from "./contexts/FilesystemStoreContext";

import MainPage from "./components/MainPage/MainPage";

import { RunnersProvider } from "./contexts/RunnersContext";
import { Runner } from "./lib/runner";
import { getBrowserAdapter, useBrowserAuthData } from "./browserAdapter.client";
import { getAuthData } from "./token";
import { Interceptor } from "@connectrpc/connect";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidePanelProvider } from "./contexts/SidePanelContext";
import { appState } from "./lib/runtime/AppState";
import GlobalToast from "./components/Toast";
import DriveLinkCoordinatorHost from "./components/DriveLinkCoordinatorHost";
import { appLogger } from "./lib/logging/runtime";
import {
  getConfiguredAgentEndpoint,
  getConfiguredDefaultRunnerEndpoint,
} from "./lib/appConfig";
import { APP_ROUTE_PATHS, getAppRouterBasename } from "./lib/appBase";

const queryClient = new QueryClient();

let hasLoggedStartup = false;

export interface AppBranding {
  name: string;
  logo: string;
}

export interface AppProps {
  branding?: AppBranding;
}

function AppRouter() {
  const basename = getAppRouterBasename();
  return (
    <BrowserRouter basename={basename === "/" ? undefined : basename}>
      <Routes>
        <Route path="/" element={<MainPage />} />
        <Route
          path={APP_ROUTE_PATHS.indexEntry}
          element={<Navigate replace to={APP_ROUTE_PATHS.home} />}
        />
        <Route path="/runs" element={<RunsRoute />} />
        <Route path="/runs/:runName" element={<RunRoute />} />
        <Route path="/runs/:runName/edit" element={<MainPage />} />
        <Route path="/auth/status" element={<BrowserAuthStatus />} />
        <Route path="/oidc/callback" element={<Callback />} />
        <Route
          path={APP_ROUTE_PATHS.googleDriveOauthCallback}
          element={<GoogleDriveOAuthCallback />}
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}

function App({ branding }: AppProps) {
  const appBranding = {
    name: branding?.name ?? "runme notebook",
    logo: branding?.logo ?? runmeIcon,
  };
  const makeInterceptors = useCallback(makeAuthInterceptor, []);
  const configuredRunnerEndpoint = getConfiguredDefaultRunnerEndpoint();
  const initialRunnerEndpoint = configuredRunnerEndpoint;
  const initialRunnerReconnect = true;
  const configuredAgentEndpoint = getConfiguredAgentEndpoint();
  const initialRunnerList = useMemo(
    () => [
      new Runner({
        name: "default",
        endpoint: initialRunnerEndpoint,
        reconnect: initialRunnerReconnect,
        interceptors: makeInterceptors(),
      }),
    ],
    [initialRunnerEndpoint, initialRunnerReconnect, makeInterceptors],
  );

  useEffect(() => {
    // Store app state in window for debugging.
    // This should allow us to access it inside the chrome console.
    if (typeof window !== "undefined") {
      (window as any).app = appState;
    }

    // React StrictMode can mount/unmount components twice in development.
    // We gate this message so startup emits exactly one validation event.
    if (!hasLoggedStartup) {
      appLogger.info("Application startup complete", {
        attrs: {
          routeCount: 8,
        },
      });
      hasLoggedStartup = true;
    }
  }, []);

  return (
    <>
      <Theme accentColor="blue" scaling="100%" radius="medium">
        <Helmet>
          <title>{appBranding.name}</title>
          <meta name="description" content={`${appBranding.name}`} />
          <link rel="icon" href={appBranding.logo} />
        </Helmet>
        <QueryClientProvider client={queryClient}>
          <GoogleAuthProvider>
            <WorkspaceProvider>
              <NotebookStoreProvider>
              <FilesystemStoreProvider>
              <CurrentDocProvider>
                  <NotebookStoreInitializer />
                  <DriveLinkCoordinatorHost />
                  <SettingsProvider
                    agentEndpoint={configuredAgentEndpoint}
                    webApp={
                      {
                        runner: configuredRunnerEndpoint,
                      } as WebAppConfig
                    }
                    createAuthInterceptors={makeInterceptors}
                  >
                    <RunnersProvider
                      initialRunners={initialRunnerList}
                      initialDefaultRunnerName="default"
                      makeInterceptors={makeInterceptors}
                    >
                      <OutputProvider>
                        <NotebookProvider>
                          <CellProvider>
                            <SidePanelProvider>
                              <GlobalToast />
                              <AppRouter />
                            </SidePanelProvider>
                          </CellProvider>
                        </NotebookProvider>
                      </OutputProvider>
                    </RunnersProvider>
                  </SettingsProvider>                
                </CurrentDocProvider>
              </FilesystemStoreProvider>
              </NotebookStoreProvider>
            </WorkspaceProvider>
          </GoogleAuthProvider>
        </QueryClientProvider>
      </Theme>
    </>
  );
}

function NotebookStoreInitializer() {
  const { ensureAccessToken, isDriveSyncing } = useGoogleAuth();
  const { store, setStore } = useNotebookStore();
  const { fsStore, setFsStore } = useFilesystemStore();
  const instanceRef = useRef<LocalNotebooks | null>(null);
  const fsInstanceRef = useRef<FilesystemNotebookStore | null>(null);
  const wasDriveSyncingRef = useRef(false);

  useEffect(() => {
    if (instanceRef.current || store) {
      return;
    }

    // Background Drive store operations should never force an OAuth redirect.
    // Interactive login is handled explicitly via UI actions (picker/status tab).
    const driveStore = new DriveNotebookStore(() =>
      ensureAccessToken({ interactive: false }),
    );
    const localStore = new LocalNotebooks(driveStore);
    localStore.setFilesystemStore(fsInstanceRef.current);

    appState.setDriveNotebookStore(driveStore);
    appState.setLocalNotebooks(localStore);

    instanceRef.current = localStore;
    setStore(localStore);
  }, [ensureAccessToken, setStore, store]);

  // When Drive auth/connectivity recovers, enqueue all drive-backed files with
  // unapplied local edits so sync resumes without requiring a fresh manual edit.
  useEffect(() => {
    const localStore = instanceRef.current;
    if (!localStore) {
      return;
    }

    const becameSyncable = isDriveSyncing && !wasDriveSyncingRef.current;
    wasDriveSyncingRef.current = isDriveSyncing;
    if (!becameSyncable) {
      return;
    }

    void (async () => {
      try {
        appLogger.info("Drive sync became available; reconciling pending notebooks", {
          attrs: {
            scope: "storage.drive.sync",
            code: "DRIVE_RESYNC_AUTH_RECOVERED",
          },
        });
        const enqueued = await localStore.enqueueDriveBackedFilesNeedingSync();
        appLogger.info("Drive resync reconciliation completed", {
          attrs: {
            scope: "storage.drive.sync",
            code: "DRIVE_RESYNC_RECONCILE_COMPLETE",
            enqueuedCount: enqueued.length,
            localUris: enqueued,
          },
        });
      } catch (error) {
        appLogger.error("Failed to enqueue drive-backed notebooks for resync", {
          attrs: {
            scope: "storage.drive.sync",
            code: "DRIVE_RESYNC_RECONCILE_FAILED",
            error: String(error),
          },
        });
      }
    })();
  }, [isDriveSyncing, store]);

  useEffect(() => {
    if (fsInstanceRef.current || fsStore) {
      return;
    }

    if (!isFileSystemAccessSupported()) {
      return;
    }

    const filesystemStore = new FilesystemNotebookStore();
    appState.setFilesystemStore(filesystemStore);
    instanceRef.current?.setFilesystemStore(filesystemStore);

    fsInstanceRef.current = filesystemStore;
    setFsStore(filesystemStore);
  }, [fsStore, setFsStore]);

  return null;
}

export default App;

const BrowserAuthStatus = () => {
  const authData = useBrowserAuthData();

  const browserAdapter = getBrowserAdapter();
  return (
    <AuthStatus
      authData={authData}
      onLogin={() => browserAdapter.loginWithRedirect()}
      onLogout={() => browserAdapter.logout()}
    />
  );
};

const GoogleDriveOAuthCallback = () => {
  return <div className="p-6 text-sm">Completing Google Drive sign-in...</div>;
};

export function makeAuthInterceptor(): Interceptor[] {
  console.log("Creating auth interceptor");
  return [
    (next) => async (req) => {
      const authData = await getAuthData();
      const token = authData?.idToken || "";
      if (token !== "") {
        req.header.set("Authorization", `Bearer ${token}`);
      } else {
        console.log("Error; no token found in browser adapter");
      }
      return next(req);
    },
  ];
}
