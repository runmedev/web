/* global self, caches, fetch */
// Loader protocol changes require separate backwards-compatibility review.
const SHELL = __RUNME_LOADER_SHELL__;
const BOOTSTRAP = __RUNME_LOADER_BOOTSTRAP__;
const LOADER_CACHE = '__RUNME_LOADER_CACHE__';
const RETIRED_OWNER = "self.onconnect=e=>{const p=e.ports[0];p.onmessage=()=>p.postMessage('runme-legacy-owner-retired');p.start();p.postMessage('runme-legacy-owner-retired')}";
self.addEventListener('install', event => {
  // No skipWaiting: pre-contract pages must be retired before this worker takes
  // control. Installation never changes the application's selected release.
  event.waitUntil((async () => {
    const cache = await caches.open(LOADER_CACHE);
    await cache.addAll(BOOTSTRAP);
  })());
});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if (event.data === 'runme-loader-version') event.ports[0]?.postMessage('runme-loader-1');
});
/** Exact release matches only. Never cache runner/API/auth or user documents. */
async function releaseAsset(request, url) {
  const parts = url.pathname.split('/');
  const id = parts[2];
  const path = parts.slice(3).join('/');
  const cache = await caches.open(`runme-release-v1-${id}`);
  const cached = await cache.match(url.pathname, { ignoreVary: true });
  if (cached) return cached;
  // Loader modules have their own retained cache, independent of app selection.
  const bootstrap = await (await caches.open(LOADER_CACHE)).match(url.pathname, { ignoreVary: true });
  if (bootstrap) return bootstrap;
  const response = await fetch(request);
  const marker = await cache.match(`/version/${id}/release.json`);
  if (!marker) return response; // The staging client verifies before storing.
  const manifest = await marker.json();
  const asset = manifest.assets.find(a => a.path === path);
  if (!asset) return response;
  const bytes = await response.clone().arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  if (!response.ok || response.redirected || bytes.byteLength !== asset.bytes || digest !== asset.sha256) return new Response('Release asset verification failed', { status: 502 });
  await cache.put(url.pathname, response.clone());
  return response;
}
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (url.pathname === '/storage-owner.js') {
    event.respondWith(new Response(RETIRED_OWNER, { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' } }));
    return;
  }
  if (event.request.mode === 'navigate' && !url.pathname.startsWith('/version/') && !url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/__runme-dev/')) {
    event.respondWith(Promise.resolve(new Response(SHELL, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
    return;
  }
  if (/^\/version\/[a-f0-9]{40}-[a-f0-9]{64}\//.test(url.pathname)) event.respondWith(releaseAsset(event.request, url));
});
