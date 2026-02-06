import { useCallback, useEffect, useMemo, useRef } from "react";
import { Helmet } from "react-helmet";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Callback from "./routes/callback";
import RunRoute from "./routes/run";
import RunsRoute from "./routes/runs";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import AuthStatus from "./components/AuthStatus/AuthStatus";
import aisreIcon from "./assets/aisreicon.svg";
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
import { ContentsNotebookStore } from "./storage/contents";
import { DriveNotebookStore } from "./storage/drive";
import { FilesystemNotebookStore } from "./storage/fs";
import { isFileSystemAccessSupported } from "./storage/fs";
import LocalNotebooks from "./storage/local";
import { CurrentDocProvider } from "./contexts/CurrentDocContext";
import {
  ContentsStoreProvider,
  useContentsStore,
} from "./contexts/ContentsStoreContext";
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

const queryClient = new QueryClient();

export interface AppBranding {
  name: string;
  logo: string;
}

export interface AppProps {
  branding?: AppBranding;
  initialState?: {
    agentEndpoint?: string;
    requireAuth?: boolean;
    webApp?: WebAppConfig;
    google?: {
      oauthClientId?: string;
      oauthClientSecret?: string;
    };
  };
}

function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MainPage />} />
        <Route path="/runs" element={<RunsRoute />} />
        <Route path="/runs/:runName" element={<RunRoute />} />
        <Route path="/runs/:runName/edit" element={<MainPage />} />
        <Route path="/auth/status" element={<BrowserAuthStatus />} />
        <Route path="/oidc/callback" element={<Callback />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}

function App({ branding, initialState = {} }: AppProps) {
  const appBranding = {
    name: branding?.name ?? "AISRE",
    logo: branding?.logo ?? aisreIcon,
  };
  const makeInterceptors = useCallback(makeAuthInterceptor, []);
  const initialRunnerEndpoint =
    initialState?.webApp?.runner ?? import.meta.env.VITE_DEFAULT_RUNNER_ENDPOINT;
  const initialRunnerReconnect = initialState?.webApp?.reconnect ?? true;
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
  }, []);

  return (
    <>
      <Theme accentColor="gray" scaling="110%" radius="small">
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
              <ContentsStoreProvider>
              <CurrentDocProvider>
                  <NotebookStoreInitializer
                    agentEndpoint={
                      initialState?.agentEndpoint ??
                      import.meta.env.VITE_DEFAULT_AGENT_ENDPOINT
                    }
                  />
                  <SettingsProvider
                    requireAuth={initialState?.requireAuth}
                    agentEndpoint={
                      initialState?.agentEndpoint ??
                      import.meta.env.VITE_DEFAULT_AGENT_ENDPOINT
                    }
                    webApp={
                      initialState?.webApp ??
                      ({
                        runner: import.meta.env.VITE_DEFAULT_RUNNER_ENDPOINT,
                      } as WebAppConfig)
                    }
                    createAuthInterceptors={useCallback(
                      makeAuthInterceptor,
                      [],
                    )}
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
                              <AppRouter />
                            </SidePanelProvider>
                          </CellProvider>
                        </NotebookProvider>
                      </OutputProvider>
                    </RunnersProvider>
                  </SettingsProvider>                
                </CurrentDocProvider>
              </ContentsStoreProvider>
              </FilesystemStoreProvider>
              </NotebookStoreProvider>
            </WorkspaceProvider>
          </GoogleAuthProvider>
        </QueryClientProvider>
      </Theme>
    </>
  );
}

function NotebookStoreInitializer({ agentEndpoint }: { agentEndpoint?: string }) {
  const { ensureAccessToken } = useGoogleAuth();
  const { store, setStore } = useNotebookStore();
  const { fsStore, setFsStore } = useFilesystemStore();
  const { contentsStore, setContentsStore } = useContentsStore();
  const instanceRef = useRef<LocalNotebooks | null>(null);
  const fsInstanceRef = useRef<FilesystemNotebookStore | null>(null);
  const contentsInstanceRef = useRef<ContentsNotebookStore | null>(null);

  useEffect(() => {
    if (instanceRef.current || store) {
      return;
    }

    const driveStore = new DriveNotebookStore(ensureAccessToken);
    const localStore = new LocalNotebooks(driveStore);

    appState.setDriveNotebookStore(driveStore);
    appState.setLocalNotebooks(localStore);

    instanceRef.current = localStore;
    setStore(localStore);
  }, [ensureAccessToken, setStore, store]);

  useEffect(() => {
    if (fsInstanceRef.current || fsStore) {
      return;
    }

    if (!isFileSystemAccessSupported()) {
      return;
    }

    const filesystemStore = new FilesystemNotebookStore();
    appState.setFilesystemStore(filesystemStore);

    fsInstanceRef.current = filesystemStore;
    setFsStore(filesystemStore);
  }, [fsStore, setFsStore]);

  useEffect(() => {
    if (contentsInstanceRef.current || contentsStore) {
      return;
    }

    if (!agentEndpoint) {
      return;
    }

    const contentsStoreInstance = new ContentsNotebookStore(
      agentEndpoint,
      async () => {
        const authData = await getAuthData();
        const token = authData?.idToken || "";
        if (token) {
          return { Authorization: `Bearer ${token}` };
        }
        return {};
      },
    );

    appState.setContentsStore(contentsStoreInstance);
    contentsInstanceRef.current = contentsStoreInstance;
    setContentsStore(contentsStoreInstance);
  }, [agentEndpoint, contentsStore, setContentsStore]);

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
