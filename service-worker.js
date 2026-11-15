/* Web Dashers - offline static-site cache.
   Only same-origin site files are cached. Online APIs and community services stay online-only. */
'use strict';

const WD_CACHE_PREFIX = 'webdashers-pages-offline-';
const WD_CACHE_NAME = WD_CACHE_PREFIX + '2026-11-15-1';
const WD_APP_ROOT = new URL('./', self.registration.scope);
const WD_ASSET_MANIFEST_URL = new URL('offline-assets.json', WD_APP_ROOT).href;
const WD_INDEX_URL = new URL('index.html', WD_APP_ROOT).href;
const WD_ROOT_URL = WD_APP_ROOT.href;
const WD_BATCH_SIZE = 8;

async function wdNotifyProgress(done, total, phase, detail) {
  try {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      client.postMessage({
        type: 'WEBDASHERS_OFFLINE_PROGRESS',
        done,
        total,
        phase: phase || 'cache',
        detail: detail || ''
      });
    }
  } catch (_) { /* Progress reporting must never break installation. */ }
}

async function wdFetchAndStore(cache, path) {
  const url = new URL(path, WD_APP_ROOT).href;
  const response = await fetch(new Request(url, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'reload'
  }));
  if (!response.ok) {
    throw new Error('Precache failed: ' + path + ' (HTTP ' + response.status + ')');
  }
  if (response.type !== 'basic') {
    throw new Error('Unexpected response type while caching: ' + path);
  }
  await cache.put(url, response.clone());
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(WD_CACHE_NAME);

    const manifestResponse = await fetch(new Request(WD_ASSET_MANIFEST_URL, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'reload'
    }));
    if (!manifestResponse.ok) {
      throw new Error('Cannot load offline-assets.json: HTTP ' + manifestResponse.status);
    }
    const assetManifest = await manifestResponse.clone().json();
    if (!assetManifest || !Array.isArray(assetManifest.files) || assetManifest.files.length === 0) {
      throw new Error('offline-assets.json is missing its files list.');
    }
    await cache.put(WD_ASSET_MANIFEST_URL, manifestResponse.clone());

    const paths = Array.from(new Set(assetManifest.files));
    let done = 0;
    await wdNotifyProgress(done, paths.length, 'start', 'Preparing offline files');

    for (let offset = 0; offset < paths.length; offset += WD_BATCH_SIZE) {
      const batch = paths.slice(offset, offset + WD_BATCH_SIZE);
      await Promise.all(batch.map((path) => wdFetchAndStore(cache, path)));
      done += batch.length;
      await wdNotifyProgress(done, paths.length, 'cache', batch[batch.length - 1]);
    }

    await wdNotifyProgress(paths.length, paths.length, 'complete', 'All local files are cached');
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) => {
      if (name.startsWith(WD_CACHE_PREFIX) && name !== WD_CACHE_NAME) {
        return caches.delete(name);
      }
      return Promise.resolve(false);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  // Never intercept calls to third-party APIs, music hosts, login or community services.
  if (requestUrl.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(request);
        if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
          const cache = await caches.open(WD_CACHE_NAME);
          await cache.put(request, networkResponse.clone());
        }
        return networkResponse;
      } catch (_) {
        const cache = await caches.open(WD_CACHE_NAME);
        return (await cache.match(request, { ignoreSearch: true }))
          || (await cache.match(WD_ROOT_URL))
          || (await cache.match(WD_INDEX_URL))
          || new Response('Web Dashers is not available offline yet. Connect to the Internet and open offline-check.html.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
      }
    })());
    return;
  }

  // The game uses query strings such as ?latest for local JS files.
  // ignoreSearch lets those URLs reuse the precached original file.
  event.respondWith((async () => {
    const cache = await caches.open(WD_CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const networkResponse = await fetch(request);
      if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
        await cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    } catch (_) {
      return new Response('This file is not available in the offline cache.', {
        status: 504,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});

self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'WEBDASHERS_GET_OFFLINE_STATUS' || !event.ports || !event.ports[0]) return;
  event.waitUntil((async () => {
    const cache = await caches.open(WD_CACHE_NAME);
    const keys = await cache.keys();
    event.ports[0].postMessage({
      active: true,
      cacheName: WD_CACHE_NAME,
      cachedEntries: keys.length
    });
  })());
});
