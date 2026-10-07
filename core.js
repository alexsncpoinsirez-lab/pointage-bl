/* =====================================================================
   POINTAGE BL — moteur de l'appli
   - stockage local (IndexedDB) : affichage instantané, même sans réseau
   - file d'attente d'envoi : les pointages partent dès qu'il y a du réseau
   - réglages : serveur, clé, nom de l'opérateur, thème
   ===================================================================== */
(function () {
  'use strict';
  var CFG = window.APPLI_CONFIG || {};
  var ID_APPLI = 'pointage';

  /* ---------- Utilitaires ---------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  function el(tag, attrs, enfants) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k === 'style') n.setAttribute('style', attrs[k]);
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    });
    (enfants || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  var minuteurToast;
  function toast(msg, duree) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('visible');
    clearTimeout(minuteurToast);
    minuteurToast = setTimeout(function () { t.classList.remove('visible'); }, duree || 2600);
  }

  var Prefs = {
    get: function (k, def) { try { var v = localStorage.getItem('pbl_' + k); return v === null ? def : JSON.parse(v); } catch (e) { return def; } },
    set: function (k, v) { try { localStorage.setItem('pbl_' + k, JSON.stringify(v)); } catch (e) {} }
  };

  /* ---------- IndexedDB (secours en mémoire si indisponible) ---------- */
  var DB = (function () {
    var dbp = null, memoire = { kv: {}, outbox: {} }, seq = 1;
    function ouvrir() {
      if (dbp) return dbp;
      dbp = new Promise(function (ok) {
        try {
          var req = indexedDB.open('pointage-bl', 1);
          req.onupgradeneeded = function () {
            var db = req.result;
            if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
            if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
          };
          req.onsuccess = function () { ok(req.result); };
          req.onerror = function () { ok(null); };
        } catch (e) { ok(null); }
      });
      return dbp;
    }
    function tx(store, mode, fn) {
      return ouvrir().then(function (db) {
        if (!db) { var r = fn(null); return (r && r.result !== undefined) ? r.result : r; }
        return new Promise(function (ok, ko) {
          var t = db.transaction(store, mode), res = fn(t.objectStore(store));
          t.oncomplete = function () { ok(res instanceof IDBRequest ? res.result : undefined); };
          t.onerror = function () { ko(t.error); };
        });
      });
    }
    return {
      get: function (k) { return tx('kv', 'readonly', function (s) { return s ? s.get(k) : { result: memoire.kv[k] }; }); },
      set: function (k, v) { return tx('kv', 'readwrite', function (s) { if (s) s.put(v, k); else memoire.kv[k] = v; }); },
      del: function (k) { return tx('kv', 'readwrite', function (s) { if (s) s['delete'](k); else delete memoire.kv[k]; }); },
      ajouterEnvoi: function (it) { return tx('outbox', 'readwrite', function (s) { if (s) s.add(it); else { it.seq = seq++; memoire.outbox[it.seq] = it; } }); },
      listerEnvois: function () {
        return tx('outbox', 'readonly', function (s) {
          if (s) return s.getAll();
          return { result: Object.keys(memoire.outbox).map(function (k) { return memoire.outbox[k]; }) };
        });
      },
      majEnvoi: function (it) { return tx('outbox', 'readwrite', function (s) { if (s) s.put(it); else memoire.outbox[it.seq] = it; }); },
      supprimerEnvoi: function (q) { return tx('outbox', 'readwrite', function (s) { if (s) s['delete'](q); else delete memoire.outbox[q]; }); }
    };
  })();

  /* ---------- Serveur ---------- */
  function erreur(type, m) { var e = new Error(m); e.type = type; e.serveur = type === 'serveur'; return e; }
  function raison(e) {
    var t = e && e.type;
    return t === 'reseau' ? 'Pas de réseau' : t === 'delai' ? 'Serveur trop lent' : t === 'occupe' ? 'Serveur occupé' : t === 'page' ? 'Serveur indisponible' : 'Erreur du serveur';
  }
  function apiUrl() { return CFG.apiUrl || Prefs.get('api', ''); }
  function cle() { return Prefs.get('cle', ''); }

  var Api = {
    // text/plain : pas de pré-vérification CORS, Apps Script répond directement
    appeler: function (url, corps, delaiMs) {
      if (!url) return Promise.reject(erreur('serveur', 'Adresse du serveur non renseignée (Réglages)'));
      var action = String(corps && corps.action || '');
      var lecture = action === 'pointage.etat' || action === 'pointage.pdf' || action === 'pointage.fichier';
      var delai = delaiMs || 60000;
      function essai(n) {
        if (navigator.onLine === false) return Promise.reject(erreur('reseau', 'Pas de réseau'));
        var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, delai) : null;
        return fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(corps), redirect: 'follow', signal: ctrl ? ctrl.signal : undefined })
          ['catch'](function (e) {
            if (timer) clearTimeout(timer);
            if (e && e.name === 'AbortError') throw erreur('delai', 'Le serveur n’a pas répondu en ' + Math.round(delai / 1000) + ' s.');
            throw erreur('reseau', 'Connexion coupée pendant l’échange.');
          }).then(function (r) {
            if (timer) clearTimeout(timer);
            if (!r.ok) throw erreur(r.status === 429 || r.status >= 500 ? 'occupe' : 'page', 'Serveur : code ' + r.status);
            return r.text();
          }).then(function (txt) {
            var j;
            try { j = JSON.parse(txt); } catch (x) { throw erreur('page', 'Le serveur a renvoyé une page Google (autorisation ou déploiement à refaire ?).'); }
            if (!j || j.ok !== true) {
              var m = (j && j.erreur) || 'Réponse invalide du serveur';
              throw erreur(/en même temps|occup|verrou|lock/i.test(m) ? 'occupe' : 'serveur', m);
            }
            return j;
          }).then(null, function (e) {
            if (!e.type) e = erreur('serveur', e.message || String(e));
            // une lecture lente ou interrompue est retentée une fois, automatiquement
            if (lecture && n === 0 && e.type !== 'serveur' && navigator.onLine !== false) {
              return new Promise(function (ok) { setTimeout(ok, 1500); }).then(function () { return essai(1); });
            }
            throw e;
          });
      }
      return essai(0);
    }
  };

  /* ---------- File d'attente d'envoi ----------
     un pointage n'est retiré de l'appareil QUE si le serveur l'a accepté ;
     un pointage refusé est mis de côté (Réglages) et ne bloque pas les suivants. */
  var Envoi = (function () {
    var enCours = false, ecouteurs = [], derniereErreur = null, pause = 0;
    function notifier() {
      return DB.listerEnvois().then(function (l) {
        l = l || [];
        var refus = l.filter(function (x) { return x.rejete; }).length, attente = l.length - refus;
        majEtat(attente, refus);
        ecouteurs = ecouteurs.filter(function (f) { return !f.__mort; });
        ecouteurs.forEach(function (f) { try { f(attente); } catch (x) {} });
        return attente;
      });
    }
    function vider(force) {
      if (enCours || navigator.onLine === false || (!force && pause > Date.now())) return notifier();
      enCours = true;
      function suivant() {
        return DB.listerEnvois().then(function (l) {
          var lot = (l || []).filter(function (x) { return !x.rejete; }).slice(0, 8);
          if (!lot.length) return;
          return Api.appeler(apiUrl(), { action: 'enregistrer', cle: cle(), items: lot.map(function (x) { return x.payload; }) }, 90000).then(function (j) {
            derniereErreur = null; pause = 0;
            var rejets = {}, restants = {};
            (j.rejets || []).forEach(function (r) { if (r && r.id) rejets[r.id] = r.erreur || 'Refusé'; });
            (j.restants || []).forEach(function (id) { restants[id] = true; });
            return Promise.all(lot.map(function (x) {
              var id = x.payload.id;
              if (rejets[id]) { x.rejete = true; x.erreur = rejets[id]; toast('⚠ Un pointage est refusé par le serveur — voir Réglages', 5000); return DB.majEnvoi(x); }
              if (restants[id]) return null;
              return DB.supprimerEnvoi(x.seq);
            })).then(function () { if (!j.occupe) return suivant(); pause = Date.now() + 15000; });
          }, function (e) {
            derniereErreur = raison(e) + ' — ' + e.message;
            pause = Date.now() + 20000;
          });
        });
      }
      return suivant()['catch'](function () {}).then(function () { enCours = false; return notifier(); });
    }
    return {
      ajouter: function (siteId, payload) {
        payload.id = payload.id || uid();
        return DB.ajouterEnvoi({ siteId: siteId, payload: payload, cree: Date.now() }).then(function () { vider(true); return payload.id; });
      },
      vider: vider,
      forcer: function () { return vider(true); },
      compter: notifier,
      surChangement: function (f) { ecouteurs.push(f); },
      oublierEcouteurs: function () { ecouteurs.forEach(function (f) { f.__mort = true; }); },
      erreur: function () { return derniereErreur; }
    };
  })();

  function majEtat(attente, refus) {
    var e = $('#etatSync');
    e.className = 'etat-sync';
    if (refus) { e.classList.add('attente'); e.textContent = '⚠ ' + refus + ' refusé' + (refus > 1 ? 's' : ''); }
    else if (navigator.onLine === false) { e.classList.add('horsligne'); e.textContent = attente ? 'Hors ligne · ' + attente + ' en attente' : 'Hors ligne'; }
    else if (attente) { e.classList.add('attente'); e.textContent = attente + ' à envoyer'; }
    else e.textContent = 'À jour';
    e.title = Envoi.erreur() ? 'Dernière erreur : ' + Envoi.erreur() : '';
  }
  window.addEventListener('online', function () { Envoi.forcer(); });
  window.addEventListener('offline', function () { Envoi.compter(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) Envoi.vider(); });
  setInterval(function () { Envoi.vider(); }, 30000);

  /* ---------- Lien de configuration (#config/…) : règle l'appareil d'un collègue ---------- */
  function b64e(t) { return btoa(unescape(encodeURIComponent(t))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function b64d(t) { t = t.replace(/-/g, '+').replace(/_/g, '/'); while (t.length % 4) t += '='; return decodeURIComponent(escape(atob(t))); }
  function lienConfig() {
    if (!apiUrl() || !cle()) return '';
    return location.origin + location.pathname.replace(/index\.html$/, '') + '#config/' + b64e(JSON.stringify({ u: apiUrl(), k: cle() }));
  }
  function appliquerConfig(code) {
    var d = JSON.parse(b64d(code));
    if (!d || !d.k) throw new Error('Lien de configuration invalide.');
    if (CFG.apiUrl && d.u && d.u !== CFG.apiUrl) throw new Error('Ce lien indique un autre serveur que celui de l’appli : ignoré.');
    if (!window.confirm('Régler l’appli Pointage BL avec ce lien ? N’accepte que s’il vient de quelqu’un de l’équipe.')) throw new Error('Configuration annulée.');
    if (!CFG.apiUrl) Prefs.set('api', d.u);
    Prefs.set('cle', d.k);
  }

  /* ---------- Réglages ---------- */
  function ecranReglages(vue) {
    $('#titre').textContent = 'Réglages';
    $('#sousTitre').textContent = 'Serveur, clé, opérateur';
    var url = el('input', { type: 'url', value: apiUrl(), placeholder: 'https://script.google.com/macros/s/…/exec' });
    if (CFG.apiUrl) { url.readOnly = true; url.title = 'Adresse fixée dans config.js'; }
    var k = el('input', { type: 'password', value: cle(), placeholder: 'Clé (initialiserApiAppli)', autocomplete: 'off' });
    var res = el('div', { class: 'petit' });
    var zoneLien = el('div');
    var op = el('input', { type: 'text', value: Prefs.get('agent', ''), placeholder: 'Prénom' });
    op.addEventListener('change', function () { Prefs.set('agent', op.value.trim()); toast('Nom enregistré'); });

    vue.appendChild(el('button', { class: 'btn-second', style: 'margin-bottom:14px', onclick: function () { location.hash = ''; } }, ['‹ Retour aux fournisseurs']));
    vue.appendChild(el('div', { class: 'bandeau' }, [
      el('div', { class: 'r-titre' }, ['Connexion au serveur']),
      el('div', { class: 'champ' }, [el('label', {}, ['Adresse du serveur (projet Apps Script « Pointage BL »)']), url]),
      el('div', { class: 'champ' }, [el('label', {}, ['Clé']), k,
        el('button', { class: 'btn-second', type: 'button', style: 'margin-top:6px', onclick: function (e) { k.type = k.type === 'password' ? 'text' : 'password'; e.target.textContent = k.type === 'password' ? 'Afficher' : 'Masquer'; } }, ['Afficher'])]),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, [
        el('button', { class: 'btn-second', onclick: function () {
          var u = url.value.trim(), c = k.value.trim();
          res.textContent = 'Test en cours…';
          Api.appeler(u, { action: 'ping', cle: c }, 20000).then(function (j) {
            if (!CFG.apiUrl) Prefs.set('api', u);
            Prefs.set('cle', c);
            res.textContent = '✓ Connecté à « ' + (j.nomSite || 'serveur') + ' » — enregistré';
            Envoi.forcer();
          })['catch'](function (e) { res.textContent = '✗ ' + e.message + ' — rien n’a été modifié'; });
        } }, ['Enregistrer et tester']),
        el('button', { class: 'btn-second', onclick: function () {
          var l = lienConfig();
          if (!l) { toast('Enregistre d’abord le serveur et la clé'); return; }
          zoneLien.innerHTML = '';
          var champ = el('input', { type: 'text', value: l, readonly: 'readonly' });
          zoneLien.appendChild(el('div', { class: 'champ', style: 'margin-top:8px' }, [el('label', {}, ['Lien à envoyer à l’équipe (contient la clé)']), champ]));
          if (navigator.share) navigator.share({ title: 'Pointage BL', text: 'Ouvre ce lien pour régler l’appli Pointage BL :', url: l })['catch'](function () {});
          else if (navigator.clipboard) navigator.clipboard.writeText(l).then(function () { toast('Lien copié'); })['catch'](function () { champ.select(); });
        } }, ['Partager la configuration']),
        res
      ]),
      zoneLien
    ]));
    vue.appendChild(el('div', { class: 'bandeau' }, [el('div', { class: 'r-titre' }, ['Nom de l’opérateur sur cet appareil']), el('div', { class: 'champ' }, [op])]));
    var zonePhoto = el('div');
    vue.appendChild(el('div', { class: 'bandeau' }, [el('div', { class: 'r-titre' }, ['Outil Photo BL (à partager)']),
      el('p', { class: 'petit' }, ['Petite appli à part, juste pour photographier les BL et les factures papier. Le lien partagé contient une clé LIMITÉE : le collaborateur peut envoyer des photos, mais ne voit ni les factures ni les pointages.']),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
        el('a', { class: 'btn-second', href: 'photo.html', style: 'display:inline-grid;place-items:center;text-decoration:none' }, ['📷 Ouvrir Photo BL']),
        el('button', { class: 'btn-second', onclick: function () {
          zonePhoto.textContent = 'Préparation du lien…';
          Api.appeler(apiUrl(), { action: 'pointage.clePhoto', cle: cle() }, 20000).then(function (j) {
            var l = location.origin + location.pathname.replace(/index\.html$/, '').replace(/[^/]*$/, '') + 'photo.html#config/' + b64e(JSON.stringify({ u: apiUrl(), k: j.clePhoto }));
            zonePhoto.innerHTML = '';
            var champ = el('input', { type: 'text', value: l, readonly: 'readonly' });
            zonePhoto.appendChild(el('div', { class: 'champ', style: 'margin-top:8px' }, [el('label', {}, ['Lien à envoyer au collaborateur (WhatsApp, SMS, mail)']), champ]));
            if (navigator.share) navigator.share({ title: 'Photo BL', text: 'Ouvre ce lien sur ton téléphone pour photographier les BL et factures, puis « Ajouter à l’écran d’accueil » :', url: l })['catch'](function () {});
            else if (navigator.clipboard) navigator.clipboard.writeText(l).then(function () { toast('Lien copié'); })['catch'](function () { champ.select(); });
          })['catch'](function (e) { zonePhoto.textContent = '✗ ' + e.message; });
        } }, ['📤 Partager l’outil Photo BL'])
      ]), zonePhoto]));

    // Pointages en attente / refusés
    var blocEnvois = el('div', { class: 'bandeau' }, [el('div', { class: 'r-titre' }, ['Envois'])]);
    vue.appendChild(blocEnvois);
    (function remplir() {
      DB.listerEnvois().then(function (l) {
        l = l || [];
        while (blocEnvois.children.length > 1) blocEnvois.removeChild(blocEnvois.lastChild);
        var att = l.filter(function (x) { return !x.rejete; }), ref = l.filter(function (x) { return x.rejete; });
        blocEnvois.appendChild(el('p', { class: 'petit' }, [att.length ? att.length + ' pointage(s) en attente d’envoi.' : 'Aucun pointage en attente.']));
        if (Envoi.erreur()) blocEnvois.appendChild(el('p', { class: 'petit', style: 'color:var(--attente)' }, ['⚠ ' + Envoi.erreur()]));
        if (att.length) blocEnvois.appendChild(el('button', { class: 'btn-second', onclick: function () { Envoi.forcer().then(remplir); } }, ['Envoyer maintenant']));
        ref.forEach(function (x) {
          var p = x.payload || {};
          blocEnvois.appendChild(el('div', { class: 'champ', style: 'border-left:3px solid var(--attente);padding-left:8px;margin:10px 0' }, [
            el('div', {}, [(p.action || p.type || '') + (p.numBL ? ' · BL ' + p.numBL : '')]),
            el('div', { class: 'petit', style: 'color:var(--attente)' }, ['Motif : ' + (x.erreur || '?')]),
            el('div', { style: 'display:flex;gap:8px' }, [
              el('button', { class: 'btn-second', onclick: function () { delete x.rejete; delete x.erreur; DB.majEnvoi(x).then(function () { return Envoi.forcer(); }).then(remplir); } }, ['Renvoyer']),
              el('button', { class: 'btn-second', onclick: function () { if (window.confirm('Supprimer ce pointage de l’appareil ?')) DB.supprimerEnvoi(x.seq).then(Envoi.compter).then(remplir); } }, ['Supprimer'])
            ])
          ]));
        });
      });
    })();

    var theme = Prefs.get('theme', 'futur');
    vue.appendChild(el('div', { class: 'bandeau' }, [el('div', { class: 'r-titre' }, ['Apparence']),
      el('div', { style: 'display:flex;gap:8px' }, [['futur', 'Futuriste'], ['classique', 'Classique (plein soleil)']].map(function (t) {
        return el('button', { class: 'btn-second' + (theme === t[0] ? ' actif' : ''), onclick: function () { Prefs.set('theme', t[0]); appliquerTheme(); router(); } }, [t[1]]);
      }))]));

    var installee = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    var ligneVersion = el('p', { class: 'petit' }, ['Version : …']);
    if (window.caches) caches.keys().then(function (ks) { var v = ks.filter(function (x) { return x.indexOf('pointage-bl-') === 0; }).sort().pop(); ligneVersion.textContent = 'Version installée : ' + (v ? v.replace('pointage-bl-', '') : '—'); });
    vue.appendChild(el('div', { class: 'bandeau' }, [el('div', { class: 'r-titre' }, ['Installation et mise à jour']),
      installee ? el('p', { class: 'petit' }, ['L’appli est installée sur cet appareil.'])
        : window.__invitInstall ? el('button', { class: 'btn-principal', onclick: function () { var i = window.__invitInstall; window.__invitInstall = null; i.prompt(); } }, ['Installer l’appli'])
        : el('p', { class: 'petit' }, ['Chrome : menu ⋮ → « Installer l’application ». iPhone : Safari → Partager → « Sur l’écran d’accueil ».']),
      ligneVersion,
      el('button', { class: 'btn-second', onclick: function () {
        var et = [];
        if (navigator.serviceWorker) et.push(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); }));
        if (window.caches) et.push(caches.keys().then(function (ks) { return Promise.all(ks.map(function (x) { return caches.delete(x); })); }));
        Promise.all(et)['catch'](function () {}).then(function () { location.reload(); });
      } }, ['Forcer la mise à jour'])
    ]));
  }

  function appliquerTheme() {
    var futur = Prefs.get('theme', 'futur') === 'futur';
    document.body.classList.toggle('futur', futur);
    var m = document.querySelector('meta[name=theme-color]');
    if (m) m.setAttribute('content', futur ? '#05080f' : '#1d2a24');
  }

  /* ---------- Routeur : factures (par défaut) / réglages ---------- */
  function router() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    var vue = $('#vue');
    Envoi.oublierEcouteurs();
    vue.innerHTML = '';
    vue.removeAttribute('style');
    if (h.indexOf('config/') === 0) {
      try { appliquerConfig(h.slice(7)); toast('Appli réglée ✓', 3500); } catch (e) { toast(e.message, 4500); }
      history.replaceState(null, '', location.pathname);
      h = '';
    }
    if (h === 'reglages') { ecranReglages(vue); return; }
    // ''               → accueil (tuiles fournisseurs)
    // four/<Nom>       → factures de ce fournisseur
    // four/<Nom>/<id>  → une facture ouverte   (ancien lien f/<id> : redirigé)
    var p = h.split('/');
    var fourn = p[0] === 'four' ? decodeURIComponent(p[1] || '') : '';
    var idFacture = p[0] === 'four' ? decodeURIComponent(p[2] || '') : p[0] === 'f' ? decodeURIComponent(p[1] || '') : '';
    $('#titre').textContent = CFG.nom || 'Pointage BL';
    $('#sousTitre').textContent = fourn ? fourn + ' · factures ↔ BL' : 'Factures fournisseurs ↔ BL';
    window.MODULES.pointage.afficher(vue, {
      site: { id: ID_APPLI, nom: CFG.nom || 'Pointage BL' },
      apiUrl: apiUrl(), cle: cle(),
      fournisseur: fourn || null,
      params: idFacture ? [idFacture] : []
    });
  }
  window.addEventListener('hashchange', router);
  $('#btnReglages').addEventListener('click', function () { location.hash = location.hash === '#reglages' ? '' : 'reglages'; });
  $('#etatSync').addEventListener('click', function () { location.hash = 'reglages'; });
  // Logo / titre en haut : retour à l'accueil (choix du fournisseur)
  ['.barre-logo', '.barre-titre'].forEach(function (sel) {
    var x = document.querySelector(sel);
    if (x) { x.style.cursor = 'pointer'; x.addEventListener('click', function () { location.hash = ''; }); }
  });

  /* ---------- Exposé au module ---------- */
  window.PM = { el: el, $: $, toast: toast, Prefs: Prefs, DB: DB, Api: Api, Envoi: Envoi, uid: uid, raison: raison };
  window.MODULES = window.MODULES || {};

  document.addEventListener('DOMContentLoaded', function () {
    appliquerTheme();
    router();
    Envoi.vider();
  });
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); window.__invitInstall = e; });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        document.addEventListener('visibilitychange', function () { if (!document.hidden) reg.update()['catch'](function () {}); });
      })['catch'](function () {});
      var avait = !!navigator.serviceWorker.controller, fait = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () { if (!avait || fait) return; fait = true; location.reload(); });
    });
  }
})();
