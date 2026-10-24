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
/** Retire every pre-contract window, including uncontrolled historical tabs.
 * Known loader clients remain eligible while frozen; a missed probe is never
 * evidence that an unknown old writer stopped. Client IDs are browser assigned.
 */
self.addEventListener('message', event => {
  if (event.data === 'runme-loader-font-policy') {
    event.ports[0]?.postMessage('deferred-fonts-v1');
    return;
  }
  if (event.data !== 'runme-loader-version' || !event.source?.id) return;
  event.waitUntil((async () => {
    const registry = await caches.open('runme-loader-clients-v1');
    const key = id => `/__runme-loader-client/${encodeURIComponent(id)}`;
    await registry.put(key(event.source.id), new Response('1'));
    const peers = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const peer of peers) {
      if (await registry.match(key(peer.id))) continue;
      const compatible = await new Promise(resolve => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => {channel.port1.close(); resolve(false)}, 2000);
        channel.port1.onmessage = e => {clearTimeout(timer); channel.port1.close(); resolve(e.data === 'runme-loader-1')};
        peer.postMessage('runme-loader-probe', [channel.port2]);
      });
      if (!compatible) throw new Error('Preserve edits, close all older Runme tabs, then reload to install controlled upgrades.');
      await registry.put(key(peer.id), new Response('1'));
    }
    event.ports[0]?.postMessage('runme-loader-1');
  })().catch(error => event.ports[0]?.postMessage(String(error.message || error))));
});
/** Exact release matches only. Never cache runner/API/auth or user documents. */
async function releaseAsset(request, url) {
  const parts = url.pathname.split('/');
  const id = parts[2];
  const path = parts.slice(3).join('/');
  // release.json in CacheStorage is a local completion marker, serialized by
  // the launcher. Channel digests authenticate the original published bytes,
  // so discovery must never receive that reserialized marker as a response.
  if (path === 'release.json') return fetch(request);
  const cache = await caches.open(`runme-release-v1-${id}`);
  const cached = await cache.match(url.pathname, { ignoreVary: true });
  if (cached) return cached;
  // Loader modules have their own retained cache, independent of app selection.
  const bootstrap = await (await caches.open(LOADER_CACHE)).match(url.pathname, { ignoreVary: true });
  if (bootstrap) return bootstrap;
  const response = await fetch(request);
  // Startup can finish before unused fonts are cached. Its authenticated
  // manifest still lets on-demand font loads be verified before they are saved.
  const marker = await cache.match(`/version/${id}/release.json`) || await cache.match(`/__runme-startup/${id}`);
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
