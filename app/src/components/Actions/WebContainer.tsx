import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as d3 from "d3";
import { create } from "@bufbuild/protobuf";
import { jwtDecode } from "jwt-decode";

import {
  RunmeMetadataKey,
  createCellOutputs,
  parser_pb,
} from "../../contexts/CellContext";
import { useNotebookContext } from "../../contexts/NotebookContext";
import { useCurrentDoc } from "../../contexts/CurrentDocContext";
import { googleClientManager } from "../../lib/googleClientManager";
import { createDriveFile, updateDriveFileBytes } from "../../lib/driveTransfer";
import { oidcConfigManager } from "../../auth/oidcConfig";
import { getAuthData } from "../../token";
import { getDefaultAppConfigUrl, setAppConfig } from "../../lib/appConfig";
import { JSKernel } from "../../lib/runtime/jsKernel";
import { createRunmeConsoleApi } from "../../lib/runtime/runmeConsole";

import * as datadog from "../../lib/runtime/datadog";
import { useBaseUrl } from "../../lib/useAisreClient";
// JS/Observable notebook cells execute through JSKernel so they can share the
// same helper namespaces exposed by AppConsole (runme/drive/oidc/app).

type ObservableOutputProps = {
  cell: parser_pb.Cell;
  onExitCode: (code: number | null) => void;
  onPid: (pid: number | null) => void;
};

const WebContainer = ({ cell, onExitCode, onPid }: ObservableOutputProps) => {
  const baseUrl = useBaseUrl();
  const { getNotebookData } = useNotebookContext();
  const { getCurrentDoc } = useCurrentDoc();
  const currentDocUri = getCurrentDoc();
  const notebookData = useMemo(
    () => (currentDocUri ? getNotebookData(currentDocUri) : undefined),
    [currentDocUri, getNotebookData],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const [stdout, setStdout] = useState<string>("");
  const [stderr, setStderr] = useState<string>("");
  const [lastRunId, setLastRunId] = useState<number>(0);
  const activeRunIdRef = useRef<number | null>(null);
  const resolveNotebookData = useCallback(() => {
    return currentDocUri ? getNotebookData(currentDocUri) ?? null : null;
  }, [currentDocUri, getNotebookData]);
  const runme = useMemo(
    () =>
      createRunmeConsoleApi({
        resolveNotebook: () => resolveNotebookData(),
      }),
    [resolveNotebookData],
  );

  const runCode = useCallback(async () => {
    const container = containerRef.current;
    if (!container) {
      console.warn("ObservableOutput: container not mounted");
      return;
    }

    const runId = Date.now();
    activeRunIdRef.current = runId;
    setLastRunId(runId);
    setStdout("");
    setStderr("");
    container.innerHTML = "";
    onPid(null);

    let stdoutText = "";
    let stderrText = "";
    let exitCode: number | null = null;

    const kernel = new JSKernel({
      globals: {
        datadog,
        runme: {
          getCurrentNotebook: () => runme.getCurrentNotebook(),
          clear: () => {
            if (activeRunIdRef.current !== runId) {
              return;
            }
            container.innerHTML = "";
          },
          render: (
            renderFn: (
              selection: d3.Selection<HTMLDivElement, unknown, null, undefined>,
            ) => void | Promise<void>,
          ) => {
            if (activeRunIdRef.current !== runId) {
              return;
            }
            container.innerHTML = "";
            return renderFn(d3.select(container));
          },
          clearOutputs: (target?: unknown) => runme.clearOutputs(target),
          runAll: (target?: unknown) => runme.runAll(target),
          rerun: (target?: unknown) => runme.rerun(target),
          help: () => runme.help(),
        },
        googleClientManager: {
          get: () => googleClientManager.getOAuthClient(),
          setClientId: (clientId: string) =>
            googleClientManager.setOAuthClient({ clientId }),
          setClientSecret: (clientSecret: string) =>
            googleClientManager.setClientSecret(clientSecret),
          setFromJson: (raw: string) =>
            googleClientManager.setOAuthClientFromJson(raw),
        },
        oidc: {
          get: () => oidcConfigManager.getConfig(),
          getRedirectURI: () => oidcConfigManager.getRedirectURI(),
          getScope: () => oidcConfigManager.getScope(),
          setClientId: (clientId: string) =>
            oidcConfigManager.setClientId(clientId),
          setClientSecret: (clientSecret: string) =>
            oidcConfigManager.setClientSecret(clientSecret),
          setDiscoveryURL: (discoveryUrl: string) =>
            oidcConfigManager.setDiscoveryURL(discoveryUrl),
          setScope: (scope: string) => oidcConfigManager.setScope(scope),
          setGoogleDefaults: () => oidcConfigManager.setGoogleDefaults(),
          getStatus: async () => {
            const authData = await getAuthData();
            if (!authData) {
              return { isAuthenticated: false };
            }
            let decodedAccessToken: unknown = null;
            let decodedIdToken: unknown = null;
            try {
              decodedAccessToken = jwtDecode(authData.accessToken);
            } catch {
              decodedAccessToken = null;
            }
            try {
              decodedIdToken = jwtDecode(authData.idToken);
            } catch {
              decodedIdToken = null;
            }
            return {
              isAuthenticated: true,
              isExpired: authData.isExpired(),
              rawAuthData: authData,
              decodedAccessToken,
              decodedIdToken,
              tokenType: authData.tokenType,
              scope: authData.scope,
            };
          },
        },
        drive: {
          create: (folder: string, name: string) => createDriveFile(folder, name),
          update: (
            idOrUri: string,
            bytes: Uint8Array | ArrayBuffer | ArrayLike<number>,
            mimeType?: string,
          ) => updateDriveFileBytes(idOrUri, bytes, mimeType),
          help: () =>
            [
              "drive.create(folder, name)     - Create a Drive file in folder; returns file id",
              "drive.update(id, bytes)        - Write UTF-8 bytes to a Drive file id/URI",
              "drive.help()                   - Show this help",
            ].join("\n"),
        },
        app: {
          getCurrentNotebook: () => runme.getCurrentNotebook(),
          getDefaultConfigUrl: () => getDefaultAppConfigUrl(),
          setConfig: (url?: string) => setAppConfig(url),
        },
        help: () =>
          [
            "Notebook JS helpers:",
            "- d3: D3.js",
            "- datadog: Datadog helpers",
            "- app.clear()/app.render(fn): render helpers",
            "- app.getCurrentNotebook(): active notebook handle",
            "- app.getDefaultConfigUrl()/app.setConfig(url?): runtime config helpers",
            "- runme.*: notebook helpers (clearOutputs/runAll/rerun)",
            "- drive.create()/drive.update(): Google Drive helpers",
            "- oidc.* / googleClientManager.*: auth/client config helpers",
            "- help(): show this message",
          ].join("\n"),
      },
      hooks: {
        onStdout: (data) => {
          if (activeRunIdRef.current !== runId) {
            return;
          }
          stdoutText += data;
        },
        onStderr: (data) => {
          if (activeRunIdRef.current !== runId) {
            return;
          }
          stderrText += data;
        },
        onExit: (code) => {
          if (activeRunIdRef.current !== runId) {
            return;
          }
          exitCode = code;
        },
      },
    });

    try {
      await kernel.run(cell.value ?? "", { container });
    } catch (err) {
      // JSKernel currently reports errors via hooks and resolves; keep this as
      // a defensive guard in case that behavior changes.
      if (exitCode === null) {
        exitCode = 1;
      }
      stderrText += `${String(err)}\n`;
    } finally {
      activeRunIdRef.current = null;
    }
    const resolvedExitCode = exitCode ?? 0;

    const updatedCell = create(parser_pb.CellSchema, cell);
    updatedCell.outputs = createCellOutputs(
      { pid: null, exitCode: resolvedExitCode },
      stdoutText,
      stderrText,
      null,
    );

    if (resolvedExitCode !== null) {
      if (resolvedExitCode === 0) {
        delete updatedCell.metadata[RunmeMetadataKey.ExitCode];
      } else {
        updatedCell.metadata[RunmeMetadataKey.ExitCode] = resolvedExitCode.toString();
      }
    }

    notebookData?.updateCell(updatedCell);

    setStdout(stdoutText);
    setStderr(stderrText);
    onExitCode(resolvedExitCode);
  }, [cell, notebookData, onExitCode, onPid, runme]);

  useEffect(() => {
    datadog.configureDatadogRuntime({ baseUrl });
  }, [baseUrl]);

  useEffect(() => {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<{ cellId: string }>;
      if (customEvent.detail.cellId === cell.refId) {
        void runCode();
      }
    };
    window.addEventListener("runCodeCell", handler as EventListener);
    return () => {
      window.removeEventListener("runCodeCell", handler as EventListener);
    };
  }, [cell.refId, runCode]);

  const hasStdIO = useMemo(() => {
    return stdout.trim().length > 0 || stderr.trim().length > 0;
  }, [stderr, stdout]);

  return (
    <div className="mt-2 rounded-md border border-nb-cell-border bg-white p-2 text-xs text-nb-text">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-nb-text-faint">
        Observable Output{" "}
        {lastRunId
          ? `(last run: ${new Date(lastRunId).toLocaleTimeString()})`
          : ""}
      </div>
      <div
        ref={containerRef}
        className="mb-2 min-h-[240px] w-full overflow-auto rounded border border-dashed border-nb-cell-border bg-nb-surface-2"
      />

      {hasStdIO ? (
        <div className="space-y-2 font-mono">
          {stdout.trim().length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase text-emerald-600">
                stdout
              </div>
              <pre className="whitespace-pre-wrap break-words text-[11px] text-emerald-900">
                {stdout}
              </pre>
            </div>
          )}
          {stderr.trim().length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase text-rose-600">
                stderr
              </div>
              <pre className="whitespace-pre-wrap break-words text-[11px] text-rose-900">
                {stderr}
              </pre>
            </div>
          )}
        </div>
      ) : (
        <div className="font-mono text-[11px] italic text-nb-text-faint">
          Use d3 (or runme.render) to draw into the panel above.
        </div>
      )}
    </div>
  );
};

export default WebContainer;
