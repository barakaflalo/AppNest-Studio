/* AppNest Studio service worker — caches the app shell only.
   External engines (ffmpeg / lamejs from CDN) are NOT cached and load on demand. */
const CACHE = 'appnest-studio-v9';
const SHELL = ['./','./index.html','./manifest.json','./appnest-assistant.js','./icon-192.png','./icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE).map(k => caches.delete(k))
  )).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // let CDN requests pass through
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      if (e.request.method === 'GET' && resp.ok) {
        const clone = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return resp;
    }).catch(()=>caches.match('./index.html')))
  );
});
