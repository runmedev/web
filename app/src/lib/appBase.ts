const ROOT_PATH = "/";

export const APP_ROUTE_PATHS = {
  home: "/",
  authStatus: "/auth/status",
  oidcCallback: "/oidc/callback",
  runs: "/runs",
  run: (runName: string) => `/runs/${runName}`,
  editRun: (runName: string) => `/runs/${runName}/edit`,
} as const;

function ensureTrailingSlash(pathname: string): string {
  if (!pathname || pathname === ROOT_PATH) {
    return ROOT_PATH;
  }
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

function stripTrailingSlash(pathname: string): string {
  if (!pathname || pathname === ROOT_PATH) {
    return ROOT_PATH;
  }
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function getBasePathFromModuleUrl(moduleUrl: string): string {
  const url = new URL(moduleUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    return ROOT_PATH;
  }
  return ensureTrailingSlash(new URL(".", url).pathname);
}

function getBasePathFromLocation(pathname: string): string {
  if (!pathname || pathname === ROOT_PATH) {
    return ROOT_PATH;
  }

  const lastSlashIndex = pathname.lastIndexOf("/");
  const lastSegment = pathname.slice(lastSlashIndex + 1);
  if (lastSegment === "index.html") {
    return ensureTrailingSlash(pathname.slice(0, -lastSegment.length));
  }
  if (lastSegment.includes(".")) {
    return ensureTrailingSlash(pathname.slice(0, lastSlashIndex + 1));
  }
  return ROOT_PATH;
}

export function deriveAppBasePath(options?: {
  dev?: boolean;
  moduleUrl?: string;
  pathname?: string;
}): string {
  if (options?.dev) {
    return getBasePathFromLocation(options.pathname ?? ROOT_PATH);
  }
  if (options?.moduleUrl) {
    const fromModuleUrl = getBasePathFromModuleUrl(options.moduleUrl);
    if (fromModuleUrl !== ROOT_PATH) {
      return fromModuleUrl;
    }
  }
  return getBasePathFromLocation(options?.pathname ?? ROOT_PATH);
}

let cachedAppBasePath: string | null = null;

export function getAppBasePath(): string {
  if (cachedAppBasePath) {
    return cachedAppBasePath;
  }

  if (typeof window === "undefined") {
    return ROOT_PATH;
  }

  cachedAppBasePath = deriveAppBasePath({
    dev: import.meta.env.DEV,
    moduleUrl: import.meta.url,
    pathname: window.location.pathname,
  });
  return cachedAppBasePath;
}

export function getAppRouterBasename(): string {
  return stripTrailingSlash(getAppBasePath());
}

export function resolveAppUrl(path = ""): URL {
  if (typeof window === "undefined") {
    return new URL(path || ROOT_PATH, "http://localhost");
  }
  const baseUrl = new URL(getAppBasePath(), window.location.origin);
  const normalizedPath = path.replace(/^\/+/, "");
  return new URL(normalizedPath, baseUrl);
}

export function getAppPath(path = ""): string {
  const url = resolveAppUrl(path);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function getOidcCallbackUrl(): string {
  return resolveAppUrl(APP_ROUTE_PATHS.oidcCallback).toString();
}

export function normalizeAppIndexUrl(): void {
  if (typeof window === "undefined") {
    return;
  }

  const { pathname, search, hash } = window.location;
  if (!pathname.endsWith("/index.html")) {
    return;
  }

  const normalizedPath = pathname.slice(0, -"/index.html".length) || ROOT_PATH;
  window.history.replaceState(null, "", `${ensureTrailingSlash(normalizedPath)}${search}${hash}`);
}
