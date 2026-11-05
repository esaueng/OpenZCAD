/*
 * OpenZCAD's offline shell (L02 slice 7, docs/plans/ipad-touch-plan-2026-11-05.md).
 *
 * Registered only by an installed (Home Screen) app in a production build
 * (src/lib/offlineShell.ts), so a tab in a browser never runs it.
 *
 * - Page loads go to the network first; the last good page is kept and served
 *   only when the network fails, so an online load is exactly what it was.
 * - /assets/ files are content-hashed and immutable (public/_headers), so they
 *   are served from the cache once fetched, the kernel's WASM included.
 * - Everything else (the API, sharing, analytics) passes through untouched.
 *
 * To retire it, deploy a sw.js whose activate handler calls
 * self.registration.unregister(); a missing file would leave this one running.
 */
const CACHE = 'openzcad-shell-v1';
/** Hashed files kept at most: each deploy adds new names, oldest go first. */
const ASSET_LIMIT = 400;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('openzcad-') && name !== CACHE)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstAsset(request));
  }
});

async function networkFirstPage(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      await cache.put('/', response.clone());
    }
    return response;
  } catch (error) {
    const page = await cache.match('/');
    if (page) return page;
    throw error;
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone());
    await trim(cache);
  }
  return response;
}

async function trim(cache) {
  const keys = await cache.keys();
  const assets = keys.filter((key) =>
    new URL(key.url).pathname.startsWith('/assets/')
  );
  // Cache keys come back in insertion order: the oldest deploys go first.
  await Promise.all(
    assets
      .slice(0, Math.max(0, assets.length - ASSET_LIMIT))
      .map((key) => cache.delete(key))
  );
}
