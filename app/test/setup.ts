import { vi } from "vitest";

// Excalidraw's browser bundle depends on canvas and extensionless ESM imports
// that are unavailable in Vitest's Node environment. Tests that need the real
// component can explicitly unmock it.
vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { NEVER: "never" },
  Excalidraw: () => null,
  restore: (data: any) => ({
    elements: data?.elements ?? [],
    appState: data?.appState ?? {},
    files: data?.files ?? {},
  }),
  serializeAsJSON: (elements: unknown[], appState: unknown, files: unknown) =>
    JSON.stringify({ type: "excalidraw", elements, appState, files }),
}));

vi.mock("@excalidraw/excalidraw/index.css", () => ({}));

// Shared Vitest setup run before every test suite.
// Provide minimal browser globals so modules that expect `window`/`document`
// don't crash in Node.
const g = globalThis as any;

if (!g.window) {
  g.window = {
    location: {
      origin: "http://localhost",
    },
  };
}

if (!g.document) {
  g.document = {};
}

if (typeof g.HTMLElement === "undefined") {
  g.HTMLElement = class {};
}

if (typeof g.ResizeObserver === "undefined") {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Mock the browser adapter to avoid pulling in real browser-only auth code.
vi.mock("../browserAdapter.client", () => ({
  getBrowserAdapter: () => ({
    simpleAuth: {
      willExpireSoon: () => false,
      accessToken: "",
    },
    refresh: async () => {},
  }),
}));

// You can add more stubs here as needed (e.g., localStorage, matchMedia).
