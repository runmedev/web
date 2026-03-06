import { describe, expect, it } from "vitest";

import {
  APP_ROUTE_PATHS,
  deriveAppBasePath,
  getAppPath,
  getGoogleDriveOAuthCallbackUrl,
  getOidcCallbackUrl,
  normalizeAppIndexUrl,
  resolveAppUrl,
} from "./appBase";

describe("deriveAppBasePath", () => {
  it("uses the bundled asset location outside development", () => {
    expect(
      deriveAppBasePath({
        dev: false,
        pathname: "/runme-dev-assets/runs",
        moduleUrl:
          "https://storage.googleapis.com/runme-dev-assets/index.BdN4INbO.js",
      }),
    ).toBe("/runme-dev-assets/");
  });

  it("falls back to the current document path in development", () => {
    expect(
      deriveAppBasePath({
        dev: true,
        pathname: "/runme-dev-assets/index.html",
      }),
    ).toBe("/runme-dev-assets/");
  });
});

describe("app base URL helpers", () => {
  it("resolves app-relative paths beneath the mounted base path", () => {
    window.history.replaceState(null, "", "/runme-dev-assets/index.html");
    const origin = window.location.origin;

    expect(getAppPath(APP_ROUTE_PATHS.oidcCallback)).toBe(
      "/runme-dev-assets/oidc/callback",
    );
    expect(resolveAppUrl("configs/app-configs.yaml").toString()).toBe(
      `${origin}/runme-dev-assets/configs/app-configs.yaml`,
    );
    expect(getOidcCallbackUrl()).toBe(
      `${origin}/runme-dev-assets/oidc/callback`,
    );
    expect(getGoogleDriveOAuthCallbackUrl()).toBe(
      `${origin}/runme-dev-assets/gdrive/callback`,
    );
  });

  it("normalizes index.html entry URLs to the directory path", () => {
    window.history.replaceState(
      null,
      "",
      "/runme-dev-assets/index.html?doc=foo#section-1",
    );

    normalizeAppIndexUrl();

    expect(window.location.pathname).toBe("/runme-dev-assets/");
    expect(window.location.search).toBe("?doc=foo");
    expect(window.location.hash).toBe("#section-1");
  });
});
