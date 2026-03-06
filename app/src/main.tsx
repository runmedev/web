// Must be imported first to ensure Tailwind layers and style foundations are defined before component styles
import "./index.css";

import { setContext } from "@runmedev/renderers";
import type { RendererContext } from "vscode-notebook-renderer";

import { createRoot } from "react-dom/client";
import App from "./App";
import runmeIcon from "./assets/runme-icon.svg";
import { getBrowserAdapter } from "./browserAdapter.client";
import { oidcConfigManager } from "./auth/oidcConfig";
import type { AppliedAppConfig } from "./lib/appConfig";
import {
  disableAppConfigOverridesOnLoad,
  enableAppConfigOverridesOnLoad,
  getDefaultAppConfigUrl,
  isLocalConfigPreferredOnLoad,
  maybeSetAppConfig,
  setLocalConfigPreferredOnLoad,
  setAppConfig,
} from "./lib/appConfig";
import { normalizeAppIndexUrl } from "./lib/appBase";

type AppConfigApi = {
  getDefaultConfigUrl: () => string;
  setConfig: (url?: string) => Promise<AppliedAppConfig>;
  isLocalConfigPreferredOnLoad: () => boolean;
  setLocalConfigPreferredOnLoad: (preferLocal: boolean) => boolean;
  disableConfigOverridesOnLoad: () => boolean;
  enableConfigOverridesOnLoad: () => boolean;
};

declare global {
  interface Window {
    oidc?: typeof oidcConfigManager;
    app?: AppConfigApi;
  }
}

window.oidc = oidcConfigManager;
window.app = {
  getDefaultConfigUrl: getDefaultAppConfigUrl,
  setConfig: setAppConfig,
  isLocalConfigPreferredOnLoad,
  setLocalConfigPreferredOnLoad,
  disableConfigOverridesOnLoad: disableAppConfigOverridesOnLoad,
  enableConfigOverridesOnLoad: enableAppConfigOverridesOnLoad,
};

// Provide a default noop messaging bridge so console-view has a context before
// any specific bridge is wired. Individual consoles override this on mount.
// This is a hack: per https://github.com/runmedev/web/pull/28
// We should be relying on per component contexts only.
// But if those don't get set we fall back to this noop to avoid an error caused by
// https://github.com/runmedev/web/blob/e6a7e5346eddeb02c5f9d9bc917d16d6bda6d294/packages/renderers/src/messaging.ts#L35
const noopBridge: RendererContext<void> = {
  postMessage: (msg: unknown) => {
    console.error("Unexpected call to noopBridge; this indicates a console-view messaging call before a specific bridge is wired up.", msg);
  },
  onDidReceiveMessage: () => ({ dispose: () => {} }),
};
setContext(noopBridge);

normalizeAppIndexUrl();

// Initialize auth, then render
maybeSetAppConfig().finally(() => {
  getBrowserAdapter()
    .init()
    .then(() => {
      createRoot(document.getElementById("root")!).render(
        <App
          branding={{
            name: "runme notebook",
            logo: runmeIcon,
          }}
        />,
      );
    });
});
