import { vi } from "vitest";

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
