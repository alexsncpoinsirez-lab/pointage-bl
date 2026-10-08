/* Service worker : garde l'appli sur l'appareil -> ouverture instantanée, même sans réseau.
   Pour publier une mise à jour : augmenter le numéro de VERSION ci-dessous. */
var VERSION = 'pointage-bl-v10';
var FICHIERS = ['./', 'index.html', 'styles.css', 'config.js', 'core.js', 'pointage.js',
  'pdf.min.js', 'pdf.worker.min.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'photo.html', 'photo.js', 'photo.webmanifest', 'photo-192.png', 'photo-512.png',
  'logo-ackermann.png', 'logo-tilly-manitou.png', 'logo-haag.png', 'logo-mecavista.png', 'logo-manutone.png'];
// le lecteur PDF n'est pas indispensable : s'il manque, l'appli prend le lecteur PDF de secours (cdnjs)
var ESSENTIELS = ['./', 'index.html', 'styles.css', 'config.js', 'core.js', 'pointage.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) {
    return Promise.all(FICHIERS.map(function (f) {
      var p = fetch(new Request(f, { cache: 'reload' })).then(function (r) {
        if (!r.ok) throw new Error(f + ' : ' + r.status);
        return c.put(f, r);
      });
      return ESSENTIELS.indexOf(f) >= 0 ? p : p['catch'](function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (cles) {
    return Promise.all(cles.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  var polices = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== self.location.origin && !polices) return; // serveur Apps Script : jamais en cache ici
  // Version gardée tout de suite, mise à jour en arrière-plan
  e.respondWith(caches.open(VERSION).then(function (c) {
    return c.match(e.request, { ignoreSearch: true }).then(function (enCache) {
      var reseau = fetch(e.request).then(function (r) { if (r && r.ok) c.put(e.request, r.clone()); return r; })
        .catch(function () { return enCache; });
      return enCache || reseau;
    });
  }));
});
