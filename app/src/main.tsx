// Must be imported first to ensure Tailwind layers and style foundations are defined before component styles
import "./index.css";

import { setContext } from "@runmedev/renderers";
import type { RendererContext } from "vscode-notebook-renderer";

import { createRoot } from "react-dom/client";
import App, { AppProps } from "./App";
import aisreIcon from "./assets/aisreicon.svg";

// Define the type for the window object with initial state
declare global {
  interface Window {
    __INITIAL_STATE__?: AppProps["initialState"];
  }

}

// Read initial state from window object
const initialState = window.__INITIAL_STATE__ || {};

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

// Render without initializing the browser adapter for debugging.
createRoot(document.getElementById("root")!).render(
  <App
    initialState={initialState}
    branding={{
      name: "AISRE",
      logo: aisreIcon,
    }}
  />,
);
