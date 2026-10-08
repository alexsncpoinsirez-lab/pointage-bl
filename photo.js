/* =====================================================================
   PHOTO BL — outil de terrain : photographier un BL ou une facture papier
   - même serveur que l'appli Pointage BL (adresse dans config.js)
   - à partager aux collaborateurs avec le lien « Partager l'outil Photo BL »
     (⚙ Réglages de l'appli) : il contient une clé LIMITÉE aux photos
   - chaque photo est d'abord gardée sur le téléphone, puis envoyée :
     pas de réseau ? elle part toute seule au retour du réseau
   - BL : le n° est lu par le serveur et pointé sur la facture ;
     facture : elle est importée et ses BL sont lus
   ===================================================================== */
(function () {
  'use strict';
  var CFG = window.APPLI_CONFIG || {};
  var $ = function (s) { return document.querySelector(s); };

  /* ---------- réglages partagés avec l'appli Pointage BL (même site = même stockage) ---------- */
  var Prefs = {
    get: function (k, d) { try { var v = localStorage.getItem('pbl_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('pbl_' + k, JSON.stringify(v)); } catch (e) {} }
  };
  function apiUrl() { return CFG.apiUrl || Prefs.get('api', ''); }

  /* ---------- lien de configuration partagé par Alex : …/photo.html#config/… ---------- */
  (function lireLienConfig() {
    var h = location.hash || '';
    if (h.indexOf('#config/') !== 0) return;
    try {
      var t = h.slice(8).replace(/-/g, '+').replace(/_/g, '/');
      while (t.length % 4) t += '=';
      var d = JSON.parse(decodeURIComponent(escape(atob(t))));
      if (!d.k) throw 0;
      if (!CFG.apiUrl && d.u) Prefs.set('api', d.u);
      Prefs.set('cle', d.k);
    } catch (e) { setTimeout(function () { toast('Lien de configuration invalide', 4000); }, 300); }
    history.replaceState(null, '', location.pathname);
  })();
  function cle() { return Prefs.get('cle', ''); }

  function el(tag, attrs, enfants) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    });
    (enfants || []).forEach(function (c) { if (c !== null && c !== undefined) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  var minToast;
  function toast(m, d) { var t = $('#toast'); t.textContent = m; t.classList.add('visible'); clearTimeout(minToast); minToast = setTimeout(function () { t.classList.remove('visible'); }, d || 2600); }

  /* ---------- photos gardées sur le téléphone (IndexedDB) ---------- */
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (ok) {
      try {
        var r = indexedDB.open('photo-bl', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('photos', { keyPath: 'id' }); r.result.createObjectStore('kv'); };
        r.onsuccess = function () { ok(r.result); };
        r.onerror = function () { ok(null); };
      } catch (e) { ok(null); }
    });
    return dbp;
  }
  var memoire = {};
  function tx(store, mode, fn) {
    return db().then(function (d) {
      if (!d) return fn(null);
      return new Promise(function (ok, ko) {
        var t = d.transaction(store, mode), res = fn(t.objectStore(store));
        t.oncomplete = function () { ok(res && res.result !== undefined ? res.result : undefined); };
        t.onerror = function () { ko(t.error); };
      });
    });
  }
  var Photos = {
    toutes: function () { return tx('photos', 'readonly', function (s) { return s ? s.getAll() : { result: Object.keys(memoire).map(function (k) { return memoire[k]; }) }; }).then(function (l) { return (l || []).sort(function (a, b) { return b.quand - a.quand; }); }); },
    garder: function (p) { return tx('photos', 'readwrite', function (s) { if (s) s.put(p); else memoire[p.id] = p; }); },
    oublier: function (id) { return tx('photos', 'readwrite', function (s) { if (s) s['delete'](id); else delete memoire[id]; }); }
  };
  function kvGet(k) { return tx('kv', 'readonly', function (s) { return s ? s.get(k) : { result: null }; }); }
  function kvSet(k, v) { return tx('kv', 'readwrite', function (s) { if (s) s.put(v, k); }); }

  /* ---------- serveur ---------- */
  function appeler(corps, delai) {
    if (!apiUrl()) return Promise.reject(new Error('Serveur non réglé'));
    if (navigator.onLine === false) { var e = new Error('Pas de réseau'); e.reseau = true; return Promise.reject(e); }
    corps.cle = cle(); corps.operateur = Prefs.get('agent', '');
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, delai || 120000) : null;
    return fetch(apiUrl(), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(corps), redirect: 'follow', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { if (t) clearTimeout(t); return r.text(); }, function (e) { if (t) clearTimeout(t); var x = new Error('Réseau coupé'); x.reseau = true; throw x; })
      .then(function (txt) {
        var j; try { j = JSON.parse(txt); } catch (e) { var x = new Error('Serveur indisponible'); x.reseau = true; throw x; }
        if (!j.ok) { var y = new Error(j.erreur || 'Erreur serveur'); y.reseau = /en même temps|occup/i.test(y.message); throw y; }
        return j;
      });
  }

  /* ---------- réduction de la photo (2200 px, JPEG) : envoi rapide en 4G ---------- */
  function compresser(f) {
    return new Promise(function (ok, ko) {
      var img = new Image(), url = URL.createObjectURL(f);
      img.onload = function () {
        function rendu(max, q) {
          var r = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          var c = document.createElement('canvas');
          c.width = Math.round(img.naturalWidth * r); c.height = Math.round(img.naturalHeight * r);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          return c.toDataURL('image/jpeg', q);
        }
        var grand = rendu(1800, 0.82), vignette = rendu(160, 0.7);
        URL.revokeObjectURL(url);
        ok({ base64: grand.split(',')[1], vignette: vignette });
      };
      img.onerror = function () { ko(new Error('Image illisible')); };
      img.src = url;
    });
  }

  /* ---------- envoi de la file ---------- */
  var envoiEnCours = false;
  function envoyerTout() {
    if (envoiEnCours || navigator.onLine === false || !apiUrl() || !cle()) return majEtat();
    envoiEnCours = true;
    return Photos.toutes().then(function (l) {
      var aFaire = l.filter(function (p) { return p.etat === 'attente'; }).reverse(); // les plus anciennes d'abord
      return (function suivante(i) {
        if (i >= aFaire.length) return;
        var p = aFaire[i];
        p.etat = 'envoi'; dessinerListe();
        // n° d'envoi : si la réponse se perd, le serveur reconnaît la photo (pas de doublon)
        var dejaTente = !!p.idEnvoi;
        if (!p.idEnvoi) p.idEnvoi = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        var corps = p.type === 'facture'
          ? { action: 'pointage.facture', base64: p.base64, mime: 'image/jpeg', nom: 'Photo facture ' + new Date(p.quand).toLocaleString('fr-FR').replace(/[/:]/g, '-') + '.jpg', fournisseur: p.fournisseur }
          : { action: 'pointage.photo', base64: p.base64, mime: 'image/jpeg', nom: 'photo.jpg', fournisseur: p.fournisseur, numImpose: p.num || '' };
        corps.idEnvoi = p.idEnvoi;
        return Photos.garder(p).then(function () {
          if (!dejaTente) return appeler(corps, 150000);
          // déjà envoyée une fois : on demande d'abord au serveur s'il l'a reçue
          return appeler({ action: 'pointage.envoiEtat', idEnvoi: p.idEnvoi }, 20000).then(function (x) {
            return x.inconnu ? appeler(corps, 150000) : x;
          });
        }).then(function (j) {
          if (j.enCours) { var w = new Error('Lecture en cours sur le serveur'); w.reseau = true; throw w; }
          p.base64 = null; // envoyée : plus besoin de la garder en grand
          if (p.type === 'facture') {
            p.etat = 'ok';
            p.resultat = 'Facture n°' + (j.num || '?') + ' importée · ' + (j.nbBL || 0) + ' BL lu' + ((j.nbBL || 0) > 1 ? 's' : '') + (j.nbBL ? ' · ' + (j.nbOK || 0) + ' déjà pointé' + ((j.nbOK || 0) > 1 ? 's' : '') : '');
          } else if (j.retenus && j.retenus.length) {
            p.etat = 'ok';
            p.resultat = 'BL ' + j.retenus.join(', ') + (j.differe ? ' enregistré · pointage dans quelques minutes' : ' enregistré et pointé');
          } else {
            p.etat = 'numero'; p.fichierId = j.fichierId;
            p.resultat = 'N° non lu sur la photo : tape-le';
          }
          return Photos.garder(p);
        }, function (e) {
          if (e.reseau || /opérateur/i.test(e.message)) { p.etat = 'attente'; p.resultat = e.message + ' · nouvel essai automatique'; return Photos.garder(p).then(function () { throw 'stop'; }); }
          p.etat = 'erreur'; p.resultat = e.message;
          return Photos.garder(p);
        }).then(function () { dessinerListe(); return suivante(i + 1); });
      })(0);
    })['catch'](function () {}).then(function () { envoiEnCours = false; dessinerListe(); });
  }

  function associer(p, num, bouton) {
    bouton.disabled = true; bouton.textContent = '⏳';
    appeler({ action: 'pointage.associer', fichierId: p.fichierId, numBL: num, fournisseur: p.fournisseur }, 60000).then(function (j) {
      p.etat = 'ok'; p.num = num;
      p.resultat = 'BL ' + num + (j.differe ? ' enregistré · pointage dans quelques minutes' : ' enregistré et pointé');
      return Photos.garder(p);
    }, function (e) { bouton.disabled = false; bouton.textContent = 'Valider'; toast(e.message, 4000); })
      .then(dessinerListe);
  }

  /* ---------- écran ---------- */
  var mode = Prefs.get('photo_mode', 'bl');
  var fournisseurs = [], listeEl = null;

  function majEtat() {
    return Photos.toutes().then(function (l) {
      var n = l.filter(function (p) { return p.etat === 'attente' || p.etat === 'envoi'; }).length;
      var e = $('#etat');
      e.className = 'etat' + (navigator.onLine === false ? ' hors' : n ? ' attente' : '');
      e.textContent = navigator.onLine === false ? (n ? n + ' en attente · hors ligne' : 'Hors ligne') : n ? n + ' à envoyer' : 'À jour';
    });
  }

  function dessiner() {
    var vue = $('#vue');
    vue.innerHTML = '';
    $('#operateur').textContent = Prefs.get('agent', '') ? 'Opérateur · ' + Prefs.get('agent', '') : 'Opérateur non choisi';

    if (!apiUrl() || !cle()) vue.appendChild(blocReglage());

    vue.appendChild(el('div', { class: 'choix' }, [['bl', 'BL'], ['facture', 'Facture']].map(function (m) {
      return el('button', { class: mode === m[0] ? 'actif' : '', onclick: function () { mode = m[0]; Prefs.set('photo_mode', mode); dessiner(); } }, [m[1]]);
    })));

    var choixF = el('select', { 'aria-label': 'Fournisseur' }, (fournisseurs.length ? fournisseurs : ['Ackermann']).map(function (f) {
      return el('option', { selected: Prefs.get('photo_fourn', '') === f ? 'selected' : null }, [f]);
    }));
    choixF.addEventListener('change', function () { Prefs.set('photo_fourn', choixF.value); });
    var num = el('input', { type: 'text', inputmode: 'numeric', placeholder: 'N° de BL (facultatif : lu sur la photo)', id: 'num' });
    vue.appendChild(el('div', { class: 'champs' }, [choixF, mode === 'bl' ? num : null]));
    vue.appendChild(el('p', { class: 'aide' }, [mode === 'bl'
      ? '› Cadre le BL bien à plat, n° lisible. Il est pointé tout seul sur sa facture.'
      : '› Une photo = une facture (1 page). Ses BL sont lus et cherchés tout de suite.']));

    var camera = el('input', { type: 'file', accept: 'image/*', capture: 'environment', id: 'camera' });
    var galerie = el('input', { type: 'file', accept: 'image/*', multiple: 'multiple', id: 'galerie' });
    [camera, galerie].forEach(function (inp) {
      inp.addEventListener('change', function () {
        var fs = Array.prototype.slice.call(inp.files || []); inp.value = '';
        prendre(fs, choixF.value, mode === 'bl' ? num.value.trim() : '');
        num.value = '';
      });
    });
    vue.appendChild(el('div', { class: 'declencheur' }, [
      el('label', { for: 'camera' }, [svgAppareil(), mode === 'bl' ? 'Photo du BL' : 'Photo de la facture']), camera]));
    vue.appendChild(el('label', { class: 'galerie', for: 'galerie' }, ['📁 Choisir dans la galerie']));
    vue.appendChild(galerie);

    vue.appendChild(el('div', { class: 'liste-titre' }, ['Dernières photos']));
    listeEl = el('div');
    vue.appendChild(listeEl);
    dessinerListe();
  }

  function svgAppareil() {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '54'); s.setAttribute('height', '54');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', '#38e1ff'); s.setAttribute('stroke-width', '1.6');
    s.innerHTML = '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="4"/>';
    return s;
  }

  function blocReglage() {
    var k = el('input', { type: 'password', placeholder: 'Clé de l’appli Pointage BL' });
    var u = CFG.apiUrl ? null : el('input', { type: 'url', placeholder: 'Adresse du serveur (…/exec)', value: Prefs.get('api', '') });
    return el('div', { class: 'reglage' }, [
      el('p', {}, ['⚠ Outil pas encore réglé. Ouvre le lien de configuration reçu d’Alex, ou colle la clé ici :']),
      u, k,
      el('button', { class: 'btn', onclick: function () {
        if (u) Prefs.set('api', u.value.trim());
        Prefs.set('cle', k.value.trim());
        appeler({ action: 'ping' }, 20000).then(function () { toast('✓ Connecté'); chargerListe(); dessiner(); envoyerTout(); })
          ['catch'](function (e) { toast('✗ ' + e.message, 4000); });
      } }, ['Enregistrer'])
    ]);
  }

  function dessinerListe() {
    majEtat();
    if (!listeEl) return;
    Photos.toutes().then(function (l) {
      listeEl.innerHTML = '';
      if (!l.length) { listeEl.appendChild(el('div', { class: 'vide' }, ['Aucune photo pour l’instant.'])); return; }
      l.slice(0, 30).forEach(function (p) {
        var cls = p.etat === 'ok' ? 'ok' : (p.etat === 'erreur' ? 'ko' : '');
        var titre = (p.type === 'facture' ? 'Facture' : 'BL' + (p.num ? ' ' + p.num : '')) + ' · ' + p.fournisseur;
        var statut = p.etat === 'envoi' ? '⏳ Envoi et lecture…' : p.etat === 'attente' ? '⏳ ' + (p.resultat || 'En attente d’envoi')
          : (p.etat === 'ok' ? '✓ ' : p.etat === 'erreur' ? '✗ ' : '⚠ ') + (p.resultat || '');
        var enfants = [el('div', { class: 'l1' }, [titre]), el('div', { class: 'l2' }, [new Date(p.quand).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' · ' + statut])];
        if (p.etat === 'numero') {
          var c = el('input', { type: 'text', inputmode: 'numeric', placeholder: 'N° du BL' });
          var b = el('button', { class: 'btn' }, ['Valider']);
          b.addEventListener('click', function () { if (c.value.trim()) associer(p, c.value.trim(), b); else c.focus(); });
          c.addEventListener('keydown', function (e) { if (e.key === 'Enter' && c.value.trim()) associer(p, c.value.trim(), b); });
          enfants.push(el('div', { class: 'saisie' }, [c, b]));
        }
        if (p.etat === 'erreur') {
          enfants.push(el('div', { class: 'saisie' }, [
            el('button', { class: 'btn second', onclick: function () { Photos.oublier(p.id).then(dessinerListe); } }, ['Retirer de la liste'])]));
        }
        listeEl.appendChild(el('div', { class: 'carte ' + cls }, [el('img', { src: p.vignette, alt: '' }), el('div', { class: 'txt' }, enfants)]));
      });
      // on ne garde que les 30 dernières
      l.slice(30).forEach(function (p) { if (p.etat === 'ok' || p.etat === 'erreur') Photos.oublier(p.id); });
    });
  }

  function prendre(fichiers, fournisseur, num) {
    Prefs.set('photo_fourn', fournisseur);
    if (!Prefs.get('agent', '')) {
      var n = window.prompt('Ton prénom (noté sur chaque photo) :', '');
      if (n && n.trim()) Prefs.set('agent', n.trim());
      $('#operateur').textContent = 'Opérateur · ' + Prefs.get('agent', '?');
      if (!Prefs.get('agent', '')) { toast('Indique ton prénom pour envoyer des photos (appuie sur « Opérateur » en haut).', 5000); return; }
    }
    (function suivant(i) {
      if (i >= fichiers.length) { envoyerTout(); return; }
      compresser(fichiers[i]).then(function (d) {
        return Photos.garder({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), quand: Date.now(), type: mode === 'facture' ? 'facture' : 'bl',
          fournisseur: fournisseur, num: fichiers.length === 1 ? num : '', base64: d.base64, vignette: d.vignette, etat: 'attente' });
      }).then(function () { if (navigator.vibrate) navigator.vibrate(40); dessinerListe(); }, function (e) { toast(e.message, 4000); })
        .then(function () { suivant(i + 1); });
    })(0);
    toast(navigator.onLine === false ? 'Photo gardée : envoi au retour du réseau' : 'Photo enregistrée, envoi…');
  }

  function chargerListe() {
    kvGet('liste').then(function (c) { if (c && c.fournisseurs) { fournisseurs = c.fournisseurs; dessiner(); } });
    if (!apiUrl() || !cle()) return;
    appeler({ action: 'pointage.liste' }, 30000).then(function (j) {
      var change = JSON.stringify(j.fournisseurs) !== JSON.stringify(fournisseurs);
      fournisseurs = j.fournisseurs || [];
      kvSet('liste', { fournisseurs: fournisseurs, operateurs: j.operateurs || [] });
      if (change) dessiner();
    })['catch'](function () {});
  }

  /* ---------- démarrage ---------- */
  // les photos restées « en cours d'envoi » (appli fermée pendant l'envoi) repartent
  Photos.toutes().then(function (l) {
    return Promise.all(l.filter(function (p) { return p.etat === 'envoi'; }).map(function (p) { p.etat = 'attente'; return Photos.garder(p); }));
  }).then(function () { dessiner(); chargerListe(); envoyerTout(); });
  $('#operateur').addEventListener('click', function () {
    var n = window.prompt('Ton prénom (noté sur chaque photo) :', Prefs.get('agent', ''));
    if (n !== null && n.trim()) { Prefs.set('agent', n.trim()); dessiner(); envoyerTout(); }
  });
  window.addEventListener('online', envoyerTout);
  window.addEventListener('offline', majEtat);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) envoyerTout(); });
  setInterval(envoyerTout, 30000);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // même service worker que l'appli Pointage BL : ouverture instantanée, même sans réseau
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js')['catch'](function () {}); });
  }
})();
