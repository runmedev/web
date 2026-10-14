/* global self, caches, fetch */

// Vite replaces these two tokens while emitting dist/sw.js.
const PRECACHE_URLS = __RUNME_PRECACHE_URLS__;
const BUILD_ID = "__RUNME_BUILD_ID__";
const PRECACHE_NAME = `runme-precache-${BUILD_ID}`;
const RUNTIME_NAME = `runme-runtime-${BUILD_ID}`;
const RUNME_CACHE_PREFIX = "runme-";
const INDEX_URL = "/index.html";

/** Returns true when a response is safe to retain for offline use. */
function isCacheable(response) {
  return response.ok || response.type === "opaque";
}

/** Uses the network when available and falls back to the app shell offline. */
async function handleNavigation(request) {
  try {
    return await fetch(request);
  } catch {
    return caches.match(INDEX_URL);
  }
}

/** Precaches only assets shipped in this release; no external loader is needed. */
async function precacheAppShell() {
  const precache = await caches.open(PRECACHE_NAME);
  await precache.addAll(PRECACHE_URLS);
}

/** Release assets have identical bytes for every same-origin request. Servers
 * may send Vary: Origin, while module and precache requests use different Origin
 * headers. Ignore that variance only in the declared release cache, never in
 * the runtime cache used for arbitrary resources.
 */
async function matchPrecache(request) {
  const precache = await caches.open(PRECACHE_NAME);
  return precache.match(request, { ignoreVary: true });
}

/** Serves immutable, content-hashed build assets directly from the precache. */
async function handleRevisionedAsset(request) {
  const cached = (await matchPrecache(request)) ?? (await caches.match(request));
  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  if (isCacheable(response)) {
    const cache = await caches.open(RUNTIME_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

/** Keeps stable URLs current online while retaining the latest offline copy. */
async function handleNetworkFirst(request) {
  const runtime = await caches.open(RUNTIME_NAME);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      await runtime.put(request, response.clone());
    }
    return response;
  } catch {
    return (await runtime.match(request)) ?? matchPrecache(request);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheAppShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(
              (name) =>
                name.startsWith(RUNME_CACHE_PREFIX) &&
                name !== PRECACHE_NAME &&
                name !== RUNTIME_NAME,
            )
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }
  if (
    url.pathname === "/v1" ||
    url.pathname.startsWith("/v1/") ||
    url.pathname === "/__runme-dev" ||
    url.pathname.startsWith("/__runme-dev/")
  ) {
    return;
  }

  const isRevisioned = /\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+$/.test(
    url.pathname,
  );
  event.respondWith(
    isRevisioned
      ? handleRevisionedAsset(request)
      : handleNetworkFirst(request),
  );
});
