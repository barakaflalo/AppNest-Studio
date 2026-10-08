/* AppNest Studio DJ: offline application assets, scoped to this site (GitHub Pages or Cloudflare Pages).
   Imported songs, session files, external engines and API responses are never cached here. */
'use strict';
const VERSION = '3.2.1-release1';
const SCOPE = new URL(self.registration.scope);
const CACHE_PREFIX = 'appnest-studio-dj:' + encodeURIComponent(SCOPE.pathname) + ':';
const CACHE_NAME = CACHE_PREFIX + VERSION;
const FILES = [
  'index.html', 'manifest.json', 'privacy_policy.html',
  'appnest-assistant.js', 'icon-192.png', 'icon-512.png',
  'studio-audio.js', 'studio-projects.js', 'studio-editor.js', 'studio-editor.css',
  'studio-render-worker.js', 'studio-mp3-worker.js',
  'studio-dj.js', 'studio-dj.css', 'studio-dj-engine.js',
  'studio-dj-analysis.js', 'studio-dj-analysis-worker.js', 'studio-dj-session.js'
];
const ASSET_URLS = FILES.map(file => new URL(file, SCOPE).href);
const OWNED_ASSETS = new Set(ASSET_URLS);
const INDEX_URL = new URL('index.html', SCOPE).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Fetch everything first: one unavailable asset keeps the previous worker
    // active instead of activating an incomplete release. Bypass HTTP caches.
    const responses = await Promise.all(ASSET_URLS.map(async url => {
      const r = await fetch(new Request(url, { cache: 'reload' }));
      if (!r.ok) throw new Error('asset ' + url + ' ' + r.status);
      return clean(r);
    }));
    await Promise.all(responses.map((r, i) => cache.put(ASSET_URLS[i], r)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)));
    // Old globally named caches are deliberately left alone: another AppNest
    // project on the same github.io origin may still depend on them.
    await self.clients.claim();
  })());
});

// Cloudflare Pages redirects /index.html -> /. A cached *redirected* response
// makes Chrome fail the navigation (ERR_FAILED), so store a clean copy that
// keeps the status and headers (including COOP/COEP) but drops the redirect flag.
async function clean(response) {
  if (!response || !response.redirected) return response;
  const body = await response.blob();
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
function unavailable() {
  return new Response('The application asset is unavailable offline.', {
    status: 503, statusText: 'Offline asset unavailable',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}
async function ownedAsset(request, key) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(key);
  if (cached) return clean(cached);
  try {
    const response = await clean(await fetch(request));
    if (response.ok && response.type !== 'opaque') {
      // Await the write so it cannot outlive this fetch event. Cache failures
      // must not hide an otherwise usable network response.
      try { await cache.put(key, response.clone()); } catch (_) {}
    }
    return response;
  } catch (_) {
    // Never substitute the application HTML for missing scripts or CSS.
    return unavailable();
  }
}
async function scopedNavigation(request) {
  try { return await clean(await fetch(request)); }
  catch (_) {
    const cache = await caches.open(CACHE_NAME);
    return await clean(await cache.match(INDEX_URL)) || unavailable();
  }
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== SCOPE.origin) return;
  url.search = ''; url.hash = '';
  const key = url.href === SCOPE.href ? INDEX_URL : url.href;
  // Page loads are network-first, so a fresh release (and its headers) wins.
  if (event.request.mode === 'navigate' && url.pathname.startsWith(SCOPE.pathname)) {
    event.respondWith(scopedNavigation(event.request));
    return;
  }
  if (OWNED_ASSETS.has(key)) {
    event.respondWith(ownedAsset(event.request, key));
    return;
  }
  // Only navigation inside this registration can use the shell fallback.
  // All other unowned requests pass through without interception or caching.
  if (event.request.mode === 'navigate' && url.pathname.startsWith(SCOPE.pathname)) {
    event.respondWith(scopedNavigation(event.request));
  }
});
