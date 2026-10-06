/* Service worker de l'outil Photo BL : ouverture instantanée, même sans réseau.
   Mise à jour : augmenter le numéro ci-dessous. */
var VERSION = 'photo-bl-v1';
var FICHIERS = ['./', 'index.html', 'photo.js', '../config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) {
    return Promise.all(FICHIERS.map(function (f) {
      return fetch(new Request(f, { cache: 'reload' })).then(function (r) { if (r.ok) return c.put(f, r); })['catch'](function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k.indexOf('photo-bl-') === 0 && k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  var polices = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== self.location.origin && !polices) return;
  e.respondWith(caches.open(VERSION).then(function (c) {
    return c.match(e.request, { ignoreSearch: true }).then(function (enCache) {
      var reseau = fetch(e.request).then(function (r) { if (r && r.ok) c.put(e.request, r.clone()); return r; }).catch(function () { return enCache; });
      return enCache || reseau;
    });
  }));
});
