/* =====================================================================
   POINTAGE BL — écran principal : factures fournisseurs ↔ bons de livraison
   - liste des factures (à pointer / complètes / envoyées) + indicateurs
   - la facture s'affiche avec un voile lumineux sur chaque bloc BL + pièces :
       vert = BL reçu par mail, turquoise = photo du BL papier,
       bleu = validé à la main, rouge = litige, pointillés = à pointer
   - actions (valider, litige, ajouter un BL…) : instantanées à l'écran,
     envoyées par la file d'attente de l'appli (marche aussi sans réseau)
   - photo d'un BL papier : n° lu automatiquement par le serveur
   Rapidité : tout est gardé sur le téléphone (état + PDF déjà vus), le
   serveur ne renvoie l'état que s'il a changé, les PDF des factures à
   pointer sont préchargés en arrière-plan.
   Serveur : le projet Apps Script « Pointage BL » (fichier ApiAppli.gs).
   ===================================================================== */
(function () {
  'use strict';
  var PM = window.PM, el = PM.el;

  var LIB = { MANQUANT: 'À pointer', TROUVE_MAIL: 'Reçu par mail', TROUVE_PHOTO: 'BL papier', VALIDE_MANUEL: 'Validé', LITIGE: 'Litige' };
  var LIB_F = { A_POINTER: 'À pointer', SANS_BL: 'Aucun BL lu', COMPLETE: 'Complète', COMPLETE_FORCEE: 'Complète (forcée)', ENVOYEE: 'Envoyée', LITIGE: 'Litige' };
  var CLS = { MANQUANT: 'manquant', TROUVE_MAIL: 'mail', TROUVE_PHOTO: 'photo', VALIDE_MANUEL: 'manuel', LITIGE: 'litige' };
  var OK = ['TROUVE_MAIL', 'TROUVE_PHOTO', 'VALIDE_MANUEL'];
  var OUVERTES = ['A_POINTER', 'SANS_BL', 'LITIGE'];
  var MAX_PDF_GARDES = 60;

  /* ---------- Lecteur PDF : chargé une seule fois, gardé par le service worker ----------
     1er essai : la copie de l'appli (fichiers pdf.min.js et pdf.worker.min.js) ; secours : la même version sur cdnjs. */
  var SOURCES_PDFJS = [
    { lib: 'pdf.min.js', worker: 'pdf.worker.min.js' },
    { lib: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
      worker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js' }
  ];
  var pdfjsP = null;
  function chargerScript(src) {
    return new Promise(function (ok, ko) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = function () { window.pdfjsLib ? ok() : ko(new Error('vide')); };
      s.onerror = function () { s.remove(); ko(new Error('introuvable')); };
      document.head.appendChild(s);
    });
  }
  function chargerPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfjsP) return pdfjsP;
    pdfjsP = (function essai(i) {
      if (i >= SOURCES_PDFJS.length) { pdfjsP = null; return Promise.reject(new Error('Lecteur PDF indisponible (pas de réseau ?)')); }
      return chargerScript(SOURCES_PDFJS[i].lib).then(function () {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = SOURCES_PDFJS[i].worker;
        if (i > 0) console.warn('Lecteur PDF chargé depuis le secours (pdf.min.js absent du site ?)');
        return window.pdfjsLib;
      }, function () { return essai(i + 1); });
    })(0);
    return pdfjsP;
  }

  /* ---------- Petits outils ---------- */
  function b64VersOctets(b64) {
    var bin = atob(b64), o = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
    return o;
  }
  function fichierVersB64(f) {
    return new Promise(function (ok, ko) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result).split(',')[1]); };
      r.onerror = function () { ko(new Error('Lecture du fichier impossible')); };
      r.readAsDataURL(f);
    });
  }
  // Photo réduite (1800 px max, JPEG ≈ 300 Ko) : envoi rapide même en 4G faible.
  // Si le téléphone n'arrive pas à la réduire (format HEIC…), on envoie l'original.
  function compresser(f) {
    return new Promise(function (ok, ko) {
      var img = new Image(), url = URL.createObjectURL(f);
      img.onload = function () {
        try {
          var r = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
          var c = document.createElement('canvas');
          c.width = Math.round(img.naturalWidth * r); c.height = Math.round(img.naturalHeight * r);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          var b = c.toDataURL('image/jpeg', 0.82).split(',')[1];
          if (!b || b.length < 1000) throw new Error('vide');
          ok({ base64: b, mime: 'image/jpeg' });
        } catch (e) { URL.revokeObjectURL(url); original(); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); original(); };
      function original() {
        if (f.size > 12 * 1024 * 1024) { ko(new Error('Photo trop lourde et illisible par le téléphone : reprends-la en JPEG.')); return; }
        fichierVersB64(f).then(function (b) { ok({ base64: b, mime: f.type || 'image/jpeg' }); }, ko);
      }
      img.src = url;
    });
  }
  function dateFr(s) { // "dd/MM/yyyy HH:mm" -> Date
    var m = /^(\d{2})\/(\d{2})\/(\d{2,4})(?:\s+(\d{2}):(\d{2}))?/.exec(String(s || ''));
    if (!m) return null;
    var a = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return new Date(a, +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
  }
  function anneau(fait, total, taille) {
    taille = taille || 46;
    var r = (taille - 6) / 2, c = 2 * Math.PI * r, pct = total ? fait / total : 0;
    var svg = '<svg viewBox="0 0 ' + taille + ' ' + taille + '" width="' + taille + '" height="' + taille + '" aria-hidden="true">' +
      '<circle cx="' + taille / 2 + '" cy="' + taille / 2 + '" r="' + r + '" class="pt-anneau-fond"/>' +
      '<circle cx="' + taille / 2 + '" cy="' + taille / 2 + '" r="' + r + '" class="pt-anneau-val' + (total && fait === total ? ' plein' : '') +
      '" stroke-dasharray="' + (c * pct).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 ' + taille / 2 + ' ' + taille / 2 + ')"/></svg>';
    return el('div', { class: 'pt-anneau', style: 'width:' + taille + 'px;height:' + taille + 'px', html: svg + '<span>' + fait + '/' + total + '</span>' });
  }

  function ICONE_OEIL() {
    return el('span', { class: 'pt-oeil-ico', html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3.2"/></svg>' });
  }
  /* ---------- Fournisseurs : ordre des tuiles, couleur, logo ---------- */
  var ORDRE_FOURN = ['Ackermann', 'Tilly Manitou', 'Haag', 'Mecavista', 'Manutone'];
  var TEINTES = { 'ackermann': 195, 'tilly manitou': 28, 'haag': 145, 'mecavista': 275, 'manutone': 350 };
  function teinte(nom) {
    var k = String(nom || '').toLowerCase();
    if (TEINTES[k] !== undefined) return TEINTES[k];
    var h = 0; for (var i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) % 360;
    return h;
  }
  function slug(nom) {
    return String(nom || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function initiales(nom) {
    var m = String(nom || '?').split(/\s+/).filter(Boolean);
    return (m.length > 1 ? m[0][0] + m[1][0] : m[0].slice(0, 2)).toUpperCase();
  }
  /* Logo : fichier « logo-<nom>.png » posé à côté de l'appli (ex. logo-tilly-manitou.png).
     S'il n'existe pas : pastille lumineuse avec les initiales. */
  function logoFournisseur(nom, taille) {
    var box = el('span', { class: 'pt-logo', style: 'width:' + taille + 'px;height:' + taille + 'px;--teinte:' + teinte(nom) + ';font-size:' + Math.round(taille * 0.36) + 'px' }, [
      el('span', { class: 'pt-logo-ini' }, [initiales(nom)])]);
    var img = new Image();
    img.alt = '';
    img.onload = function () { box.classList.add('avec-image'); box.innerHTML = ''; box.appendChild(img); };
    img.src = 'logo-' + slug(nom) + '.png';
    return box;
  }

  /* =================================================================== */
  window.MODULES.pointage = {
    afficher: function (vue, ctx) {
      var CLE_ETAT = 'pointage_etat_' + ctx.site.id;
      var E = null;               // état reçu du serveur (+ saisies en attente appliquées)
      var brut = null;            // état brut du serveur
      var filtre = 'ouvertes', recherche = '', selId = null, selBL = null;
      var pdfCourant = null, blocs = [], numsVusPdf = {};
      var largeurRendu = 0, rendreSeq = 0;
      var FOURN = ctx.fournisseur || null;   // null = page d'accueil (tuiles fournisseurs)
      var panneauVisible = PM.Prefs.get('panneauBL', '1') !== '0';
      var enRafraichissement = false, avaitAttente = false;

      vue.style.maxWidth = '1440px';
      var racine = el('div', { class: 'pt' });
      vue.appendChild(racine);

      if (!ctx.apiUrl || !ctx.cle) {
        racine.appendChild(el('div', { class: 'bandeau pt-config' }, [
          el('div', { style: 'font-weight:700;margin-bottom:6px' }, ['Serveur à configurer']),
          el('p', { class: 'petit' }, ['Renseigne l’adresse du serveur (projet Apps Script « Pointage BL ») et sa clé dans ⚙ Réglages.']),
          el('button', { class: 'btn-second', onclick: function () { location.hash = 'reglages'; } }, ['Ouvrir les réglages'])
        ]));
        return;
      }

      // Squelette pendant la toute première ouverture
      racine.appendChild(el('div', { class: 'chargement' }, [el('div', { class: 'squelette' }), el('div', { class: 'squelette' })]));
      chargerPdfJs()['catch'](function () {}); // on prépare le lecteur PDF pendant ce temps

      PM.DB.get(CLE_ETAT).then(function (c) {
        if (c && c.factures) { brut = c; appliquerAttente().then(function () { dessiner(); ouvrirDepuisLien(); }); }
        rafraichir(!c);
      });

      // Quand la file d'envoi se vide, on recharge l'état (les pointages sont alors confirmés)
      PM.Envoi.surChangement(function (n) {
        if (!vivant()) return;
        if (n === 0 && avaitAttente) rafraichir(false);
        avaitAttente = n > 0;
      });
      var auRetour = function () { if (!document.hidden && vivant()) rafraichir(false); };
      document.addEventListener('visibilitychange', auRetour);
      // toutes les 60 s ; toutes les 12 s pendant un scan demandé depuis l'appli
      var derniereAuto = Date.now();
      var minuterie = setInterval(function () {
        if (!vivant() || document.hidden) return;
        var delai = (E && E.scanEnCours) ? 12000 : 60000;
        if (Date.now() - derniereAuto >= delai) { derniereAuto = Date.now(); rafraichir(false); }
      }, 3000);
      window.addEventListener('popstate', surRetourArriere);
      var redim = null;
      window.addEventListener('resize', function () {
        clearTimeout(redim);
        redim = setTimeout(function () {
          if (!vivant() || !pdfCourant) return;
          var z = racine.querySelector('.pt-pages');
          if (z && Math.abs(largeurDispo(z) - largeurRendu) > 40) rendrePdf();
        }, 250);
      });

      function vivant() {
        var ok = document.body.contains(racine);
        if (!ok) {
          document.removeEventListener('visibilitychange', auRetour);
          window.removeEventListener('popstate', surRetourArriere);
          clearInterval(minuterie);
        }
        return ok;
      }

      /* ---------------- Échanges avec le serveur ---------------- */
      function appel(action, extra, delai) {
        var corps = { action: action, cle: ctx.cle, operateur: PM.Prefs.get('agent', '') };
        Object.keys(extra || {}).forEach(function (k) { corps[k] = extra[k]; });
        return PM.Api.appeler(ctx.apiUrl, corps, delai || 60000);
      }

      /*
       * Envoi « fiable » d'une photo / facture : si la réponse se perd (réseau 4G qui coupe,
       * lecture OCR un peu longue), on demande au serveur où en est cet envoi au lieu d'afficher
       * un échec. La photo n'est jamais enregistrée deux fois.
       */
      function envoiFiable(action, extra, delai, suivi) {
        var id = PM.uid(), debut = Date.now(), envois = 0;
        extra.idEnvoi = id;
        function pause(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
        function envoyer() {
          envois++;
          return appel(action, extra, delai).then(function (j) { return j.enCours ? attendre() : j; }, function (e) {
            if (e.type === 'serveur') throw e;   // vraie erreur expliquée par le serveur
            return attendre();
          });
        }
        function attendre() {
          if (Date.now() - debut > 300000) throw new Error('Pas de réponse du serveur depuis 5 min. Regarde dans « BL reçus » si la photo est arrivée.');
          if (suivi) suivi(navigator.onLine === false ? 'pas de réseau, on attend…' : 'lecture en cours, on vérifie…');
          return pause(navigator.onLine === false ? 8000 : 5000).then(function () {
            if (navigator.onLine === false) return attendre();
            return appel('pointage.envoiEtat', { idEnvoi: id }, 20000).then(function (j) {
              if (j.inconnu) {
                if (envois < 3) return envoyer();
                throw new Error('La photo n’arrive pas au serveur (réseau trop faible ?). Réessaie près du bureau / en Wi-Fi.');
              }
              return j.enCours ? attendre() : j;
            }, function (e) { if (e.type === 'serveur') throw e; return attendre(); });
          });
        }
        return envoyer();
      }

      function rafraichir(premier) {
        if (enRafraichissement) return;
        enRafraichissement = true;
        majIndicateurSync('sync');
        appel('pointage.etat', { version: brut && brut.version || '' }, 45000).then(function (j) {
          enRafraichissement = false;
          if (j.inchange) { majIndicateurSync('ok'); return; }
          brut = j;
          brut.recuLe = Date.now();
          PM.DB.set(CLE_ETAT, brut);
          return appliquerAttente().then(function () {
            dessiner();
            if (premier) ouvrirDepuisLien();
            prechargerPdfs();
          });
        })['catch'](function (e) {
          enRafraichissement = false;
          majIndicateurSync('ko', e);
          if (premier && !brut) {
            racine.innerHTML = '';
            racine.appendChild(el('div', { class: 'vide-msg' }, ['Impossible de charger les factures.', el('br'),
              el('span', { class: 'petit' }, [e.message]), el('br'), el('br'),
              el('button', { class: 'btn-second', onclick: function () { rafraichir(true); } }, ['Réessayer']), ' ',
              el('button', { class: 'btn-second', onclick: function () { location.hash = 'reglages'; } }, ['Réglages'])]));
          }
        });
      }

      /* Saisies encore dans la file d'envoi : appliquées tout de suite à l'écran (marquées ⏳) */
      function appliquerAttente() {
        return PM.DB.listerEnvois().then(function (liste) {
          E = JSON.parse(JSON.stringify(brut));
          (liste || []).forEach(function (x) {
            if (x.siteId !== ctx.site.id || x.rejete) return;
            appliquerSaisie(E, x.payload || {});
          });
          E.factures.forEach(recompter);
        });
      }

      function appliquerSaisie(etat, p) {
        var f = etat.factures.filter(function (x) { return x.ID === p.factureId; })[0];
        if (!f) return;
        if (p.type === 'pointage.forcer') { f.Statut = 'COMPLETE_FORCEE'; f._attente = true; return; }
        if (p.type === 'pointage.envoyer') { f._envoi = true; f._attente = true; return; }
        var l = f.lignes.filter(function (x) { return String(x.NumBL) === String(p.numBL); })[0];
        var maintenant = new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
        if (p.action === 'AJOUTER') {
          if (!l) f.lignes.push({ NumBL: String(p.numBL), Statut: 'MANQUANT', Source: 'AJOUT', Commentaire: p.commentaire || 'Ajouté', _attente: true });
          if (f.Statut === 'SANS_BL') f.Statut = 'A_POINTER';
          return;
        }
        if (!l) return;
        l._attente = true;
        if (p.action === 'VALIDER') { l.Statut = 'VALIDE_MANUEL'; l.Operateur = p.operateur; l.Commentaire = p.commentaire || ''; l.DateValidation = maintenant; }
        else if (p.action === 'LITIGE') { l.Statut = 'LITIGE'; l.Operateur = p.operateur; l.Commentaire = p.commentaire; l.DateValidation = maintenant; }
        else if (p.action === 'ANNULER') {
          var auto = l.Statut === 'TROUVE_MAIL' || l.Statut === 'TROUVE_PHOTO';
          l.Statut = 'MANQUANT'; l.Operateur = ''; l.Commentaire = auto ? 'Dépointé par ' + p.operateur : ''; l.Detail = ''; l.FichierId = ''; l.MsgId = ''; l.DateValidation = '';
          if (auto) l.Source = 'EXCLU';
        }
        else if (p.action === 'SUPPRIMER') { f.lignes = f.lignes.filter(function (x) { return x !== l; }); }
      }

      function recompter(f) {
        f.NbBL = f.lignes.length;
        f.NbOK = f.lignes.filter(function (l) { return OK.indexOf(l.Statut) >= 0; }).length;
        if (f.Statut === 'ENVOYEE' || f.Statut === 'COMPLETE_FORCEE') return;
        if (!f.NbBL) f.Statut = 'SANS_BL';
        else if (f.lignes.some(function (l) { return l.Statut === 'LITIGE'; })) f.Statut = 'LITIGE';
        else f.Statut = f.NbOK === f.NbBL ? 'COMPLETE' : 'A_POINTER';
      }

      /* Ajoute une saisie dans la file d'envoi + l'applique tout de suite à l'écran */
      function saisir(payload, message) {
        var op = PM.Prefs.get('agent', '');
        if (!op) { choisirOperateur(function () { saisir(payload, message); }); return; }
        payload.operateur = op;
        appliquerSaisie(E, payload);
        var f = facture(payload.factureId);
        if (f) recompter(f);
        avaitAttente = true;
        dessiner();
        PM.Envoi.ajouter(ctx.site.id, payload).then(function () {
          PM.toast(message || 'Enregistré');
        });
      }

      /* ---------------- PDF : cache sur le téléphone + préchargement ---------------- */
      function pdfGarde(fichierId) { return PM.DB.get('pointage_pdf_' + fichierId); }
      function garderPdf(fichierId, donnees) {
        PM.DB.set('pointage_pdf_' + fichierId, donnees);
        PM.DB.get('pointage_pdf_index').then(function (idx) {
          idx = (idx || []).filter(function (x) { return x !== fichierId; });
          idx.unshift(fichierId);
          var trop = idx.splice(MAX_PDF_GARDES);
          trop.forEach(function (id) { PM.DB.del('pointage_pdf_' + id); });
          PM.DB.set('pointage_pdf_index', idx);
        });
      }
      function obtenirPdf(f) {
        return pdfGarde(f.FichierId).then(function (d) {
          if (d && d.base64) return d;
          return appel('pointage.pdf', { factureId: f.ID }, 60000).then(function (j) {
            var donnees = { mime: j.mime, base64: j.base64 };
            garderPdf(f.FichierId, donnees);
            return donnees;
          });
        });
      }
      var prechargeEnCours = false;
      function prechargerPdfs() {
        if (prechargeEnCours || !E || navigator.onLine === false) return;
        if (navigator.connection && navigator.connection.saveData) return;
        var aFaire = E.factures.filter(function (f) { return OUVERTES.indexOf(f.Statut) >= 0 || f.Statut === 'COMPLETE'; }).slice(0, 12);
        prechargeEnCours = true;
        (function suivant(i) {
          if (i >= aFaire.length || !vivant()) { prechargeEnCours = false; return; }
          pdfGarde(aFaire[i].FichierId).then(function (d) {
            if (d) return suivant(i + 1);
            appel('pointage.pdf', { factureId: aFaire[i].ID }, 60000).then(function (j) {
              garderPdf(aFaire[i].FichierId, { mime: j.mime, base64: j.base64 });
            })['catch'](function () {}).then(function () { setTimeout(function () { suivant(i + 1); }, 400); });
          });
        })(0);
      }

      /* ---------------- Dessin de l'écran ---------------- */
      function facturesVues() { return FOURN ? E.factures.filter(function (f) { return f.Fournisseur === FOURN; }) : E.factures; }
      function facture(id) { return E && E.factures.filter(function (f) { return f.ID === id; })[0]; }
      function config(nom) {
        return (E.fournisseurs || []).filter(function (x) { return x.Nom === nom; })[0] ||
          { RegexBLFacture: 'BL\\s*(\\d{6,})', DebutTableau: '', FinTableau: '' };
      }
      function petitEcran() { return window.innerWidth < 1000; }

      var zones = {};
      function dessiner() {
        if (!E || !vivant()) return;
        var y = window.scrollY;
        // La visionneuse PDF déjà rendue est conservée (pas de re-dessin du PDF à chaque action)
        var pagesExistantes = zones.pages && selId && zones.pagesPour === selId ? zones.pages : null;
        racine.innerHTML = '';
        if (!FOURN) { racine.classList.remove('pt-detail-ouvert'); racine.appendChild(accueil()); return; }
        racine.classList.toggle('pt-detail-ouvert', !!selId);

        racine.appendChild(barreHaut());
        var corps = el('div', { class: 'pt-corps' });
        racine.appendChild(corps);
        corps.appendChild(colonneListe());
        var f = selId && facture(selId);
        if (f) {
          var det = el('div', { class: 'pt-detail' });
          det.appendChild(enteteFacture(f));
          var grille = el('div', { class: 'pt-detail-grille' });
          var visu = el('section', { class: 'pt-visu' });
          if (pagesExistantes) { visu.appendChild(pagesExistantes); }
          else {
            zones.pages = el('div', { class: 'pt-pages' });
            zones.pagesPour = selId;
            visu.appendChild(zones.pages);
            chargerEtRendre(f);
          }
          grille.appendChild(visu);
          if (panneauVisible) grille.appendChild(panneauBL(f));
          else grille.classList.add('sans-panneau');
          det.appendChild(grille);
          corps.appendChild(det);
          majVoiles();
        } else if (!petitEcran()) {
          corps.appendChild(el('div', { class: 'pt-detail pt-vide' }, [
            el('div', { class: 'pt-vide-ico', html: '<svg viewBox="0 0 24 24" width="54" height="54" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6"/></svg>' }),
            el('div', {}, ['Choisis une facture']),
            el('div', { class: 'petit' }, ['Les blocs BL + pièces retrouvés s’affichent sous un voile lumineux.'])
          ]));
        }
        if (!selId || !petitEcran()) window.scrollTo(0, y);
      }

      /* ---------------- Page d'accueil : un fournisseur = une tuile ---------------- */
      function listeFournisseurs() {
        var noms = ORDRE_FOURN.slice();
        (E.fournisseurs || []).forEach(function (x) { if (noms.indexOf(x.Nom) < 0) noms.push(x.Nom); });
        E.factures.forEach(function (f) { if (f.Fournisseur && noms.indexOf(f.Fournisseur) < 0) noms.push(f.Fournisseur); });
        var actifs = (E.fournisseurs || []).map(function (x) { return x.Nom; });
        return noms.map(function (n) { return { nom: n, actif: !actifs.length || actifs.indexOf(n) >= 0 }; });
      }
      function accueil() {
        var bloc = el('div', { class: 'pt-accueil' });
        var toutes = E.factures.filter(function (f) { return OUVERTES.indexOf(f.Statut) >= 0; }).length;
        var sync = boutonSync();
        bloc.appendChild(el('div', { class: 'pt-accueil-haut' }, [
          el('div', {}, [
            el('div', { class: 'pt-accueil-titre' }, ['Choisis un fournisseur']),
            el('div', { class: 'petit' }, [toutes ? toutes + ' facture' + (toutes > 1 ? 's' : '') + ' à pointer au total' : 'Tout est à jour ✓'])
          ]),
          el('div', { class: 'pt-actions' }, [
            el('button', { class: 'pt-btn', title: 'Photo d’un BL papier', onclick: function () { feuillePhoto(''); } }, ['📷 ', el('span', {}, ['BL papier'])]),
            el('button', { class: 'pt-btn', title: 'Déposer une facture', onclick: deposerFacture }, ['＋ ', el('span', {}, ['Facture'])]),
            el('button', { class: 'pt-btn', title: 'Relancer la recherche des BL', onclick: menuScan }, ['⚡ ', el('span', {}, ['Scan'])]),
            sync
          ])
        ]));
        var grille = el('div', { class: 'pt-tuiles' });
        listeFournisseurs().forEach(function (x, i) {
          var fs = E.factures.filter(function (f) { return f.Fournisseur === x.nom; });
          var ouv = fs.filter(function (f) { return OUVERTES.indexOf(f.Statut) >= 0; });
          var manq = 0; ouv.forEach(function (f) { f.lignes.forEach(function (l) { if (l.Statut === 'MANQUANT') manq++; }); });
          var compl = fs.filter(function (f) { return f.Statut === 'COMPLETE' || f.Statut === 'COMPLETE_FORCEE'; }).length;
          var litiges = fs.filter(function (f) { return f.Statut === 'LITIGE'; }).length;
          grille.appendChild(el('button', { class: 'pt-tuile' + (ouv.length ? ' a-faire' : '') + (x.actif ? '' : ' inactif'),
            style: '--i:' + i + ';--teinte:' + teinte(x.nom),
            onclick: function () { location.hash = 'four/' + encodeURIComponent(x.nom); } }, [
            ouv.length ? el('span', { class: 'pt-tuile-badge' }, [String(ouv.length)]) : null,
            el('div', { class: 'pt-tuile-logo' }, [logoFournisseur(x.nom, 84)]),
            el('div', { class: 'pt-tuile-nom' }, [x.nom]),
            el('div', { class: 'pt-tuile-stats' }, [
              el('span', { class: ouv.length ? 'a-pointer' : '' }, [ouv.length + ' à pointer']),
              manq ? el('span', { class: 'manquants' }, [manq + ' BL manquant' + (manq > 1 ? 's' : '')]) : null,
              litiges ? el('span', { class: 'litige' }, [litiges + ' litige' + (litiges > 1 ? 's' : '')]) : null,
              compl ? el('span', { class: 'completes' }, [compl + ' complète' + (compl > 1 ? 's' : '')]) : null
            ]),
            x.actif ? null : el('div', { class: 'pt-tuile-info' }, ['À activer dans la feuille Fournisseurs'])
          ]));
        });
        bloc.appendChild(grille);
        setTimeout(function () { majIndicateurSync(enRafraichissement ? 'sync' : 'ok'); }, 0);
        return bloc;
      }

      var derniereErreurSync = '';
      function majIndicateurSync(etat, e) {
        var b = racine.querySelector('.pt-sync');
        if (etat === 'ko') derniereErreurSync = (e && e.message) || '';
        if (etat === 'ok') derniereErreurSync = '';
        if (!b) return;
        b.className = 'pt-sync ' + etat + (E && E.scanEnCours && etat !== 'ko' ? ' scan' : '');
        b.textContent = etat === 'sync' ? 'SYNCHRO…' : etat === 'ko' ? (PM.raison ? PM.raison(e) : 'Hors ligne') + ' · copie locale'
          : (E && E.scanEnCours) ? '⚡ SCAN EN COURS…'
          : 'SERVEUR ' + (E && E.derniereSynchro ? '· SCAN ' + E.derniereSynchro : 'À JOUR');
        b.title = derniereErreurSync || (E && E.scanEnCours ? 'Le serveur relit les mails et les factures' : 'État du lien avec le serveur');
      }
      function boutonSync() {
        return el('div', { class: 'pt-sync', role: 'button', onclick: function () {
          if (derniereErreurSync) PM.toast('Serveur : ' + derniereErreurSync, 7000);
          else if (E && E.scanEnCours) PM.toast('Scan en cours sur le serveur : les BL trouvés apparaîtront d’ici quelques minutes.', 5000);
          else rafraichir(false);
        } });
      }

      function barreHaut() {
        var vues = facturesVues();
        var ouvertes = vues.filter(function (f) { return OUVERTES.indexOf(f.Statut) >= 0; });
        var manquants = 0;
        ouvertes.forEach(function (f) { f.lignes.forEach(function (l) { if (l.Statut === 'MANQUANT') manquants++; }); });
        var completes = vues.filter(function (f) { return f.Statut === 'COMPLETE' || f.Statut === 'COMPLETE_FORCEE'; }).length;
        var il30 = Date.now() - 30 * 86400000;
        var envoyees = vues.filter(function (f) { var d = dateFr(f.DateEnvoi); return f.Statut === 'ENVOYEE' && d && d.getTime() > il30; }).length;

        function kpi(val, lib, cls, f, sansActif) {
          return el('button', { class: 'pt-kpi ' + cls + (filtre === f && !sansActif ? ' actif' : ''), onclick: function () { filtre = f; dessiner(); } }, [
            el('div', { class: 'pt-kpi-val' }, [String(val)]), el('div', { class: 'pt-kpi-lib' }, [lib])]);
        }
        var sync = boutonSync();
        var barre = el('div', { class: 'pt-barre' }, [
          el('button', { class: 'pt-fourn-retour', title: 'Changer de fournisseur', onclick: function () { location.hash = ''; } }, [
            el('span', { class: 'pt-fourn-retour-fl' }, ['‹']), logoFournisseur(FOURN, 38), el('span', { class: 'pt-fourn-retour-nom' }, [FOURN])]),
          el('div', { class: 'pt-kpis' }, [
            kpi(ouvertes.length, 'Factures à pointer', 'a-pointer', 'ouvertes'),
            kpi(manquants, 'BL manquants', 'manquants', 'ouvertes', true),
            el('button', { class: 'pt-kpi bl-recus', title: 'Voir tous les BL reçus', onclick: feuilleBLRecus }, [
              el('div', { class: 'pt-kpi-val' }, [String((E.blRecus && E.blRecus[FOURN]) || 0), el('span', { class: 'pt-kpi-oeil' }, ['👁'])]),
              el('div', { class: 'pt-kpi-lib' }, ['BL reçus'])]),
            kpi(envoyees, 'Envoyées · 30 j', 'envoyees', 'envoyees')
          ]),
          el('div', { class: 'pt-actions' }, [
            el('button', { class: 'pt-btn', title: 'Photo d’un BL papier', onclick: function () { feuillePhoto(''); } }, ['📷 ', el('span', {}, ['BL papier'])]),
            el('button', { class: 'pt-btn', title: 'Déposer une facture', onclick: deposerFacture }, ['＋ ', el('span', {}, ['Facture'])]),
            el('button', { class: 'pt-btn', title: 'Relancer la recherche des BL', onclick: menuScan }, ['⚡ ', el('span', {}, ['Scan'])]),
            sync
          ])
        ]);
        setTimeout(function () { majIndicateurSync(enRafraichissement ? 'sync' : 'ok'); }, 0);
        return barre;
      }

      function colonneListe() {
        var col = el('aside', { class: 'pt-liste' });
        var champ = el('input', { type: 'search', class: 'pt-recherche', placeholder: 'N° facture ou BL…', value: recherche });
        champ.addEventListener('input', function () { recherche = champ.value.trim().toLowerCase(); remplir(); });
        var onglets = el('div', { class: 'onglets pt-onglets' }, [['ouvertes', 'À pointer'], ['completes', 'Complètes'], ['envoyees', 'Envoyées'], ['toutes', 'Toutes']].map(function (o) {
          return el('button', { class: filtre === o[0] ? 'actif' : '', onclick: function () { filtre = o[0]; dessiner(); } }, [o[1]]);
        }));
        col.appendChild(onglets);
        col.appendChild(champ);
        var liste = el('div', { class: 'pt-cartes' });
        col.appendChild(liste);
        function remplir() {
          liste.innerHTML = '';
          var fs = facturesVues().filter(function (f) {
            if (filtre === 'ouvertes' && OUVERTES.indexOf(f.Statut) < 0) return false;
            if (filtre === 'completes' && f.Statut !== 'COMPLETE' && f.Statut !== 'COMPLETE_FORCEE') return false;
            if (filtre === 'envoyees' && f.Statut !== 'ENVOYEE') return false;
            if (recherche) {
              var t = (f.NumFacture + ' ' + f.Fournisseur + ' ' + f.lignes.map(function (l) { return l.NumBL; }).join(' ')).toLowerCase();
              if (t.indexOf(recherche) < 0) return false;
            }
            return true;
          });
          if (!fs.length) { liste.appendChild(el('div', { class: 'vide-msg petit' }, [recherche ? 'Aucun résultat.' : 'Rien ici pour l’instant.'])); return; }
          fs.forEach(function (f, i) {
            var manq = f.lignes.filter(function (l) { return l.Statut === 'MANQUANT'; }).length;
            liste.appendChild(el('button', { class: 'pt-carte' + (f.ID === selId ? ' active' : '') + ' st-' + f.Statut, style: '--i:' + Math.min(i, 12),
              onclick: function () { ouvrir(f.ID); } }, [
              anneau(f.NbOK || 0, f.NbBL || 0, 44),
              el('div', { class: 'pt-carte-txt' }, [
                el('div', { class: 'pt-carte-num' }, [el('b', {}, ['n°' + f.NumFacture]), ' ', el('span', { class: 'pt-carte-fourn' }, [f.Fournisseur])]),
                el('div', { class: 'pt-carte-meta' }, [(f.DateFacture || '') + (manq ? ' · ' + manq + ' manquant' + (manq > 1 ? 's' : '') : '')])
              ]),
              el('span', { class: 'pt-chip st-' + f.Statut }, [(f._attente ? '⏳ ' : '') + (LIB_F[f.Statut] || f.Statut)])
            ]));
          });
        }
        remplir();
        return col;
      }

      function ouvrir(id) {
        if (selId === id) return;
        selId = id; selBL = null; pdfCourant = null; blocs = []; numsVusPdf = {};
        zones.pages = null;
        if (petitEcran()) { try { history.pushState({ ptFacture: id }, '', location.href); } catch (e) {} }
        dessiner();
        if (petitEcran()) window.scrollTo(0, 0);
      }
      function fermer() { selId = null; zones.pages = null; pdfCourant = null; dessiner(); }
      function surRetourArriere() { if (vivant() && selId && petitEcran()) fermer(); }
      function ouvrirDepuisLien() { // #outil/<id>/<factureId>
        var id = ctx.params && ctx.params[0];
        var fx = id && facture(id);
        if (fx && !FOURN) { location.replace('#four/' + encodeURIComponent(fx.Fournisseur) + '/' + encodeURIComponent(id)); return; }
        if (fx && !selId) ouvrir(id);
      }

      function enteteFacture(f) {
        return el('div', { class: 'pt-entete' }, [
          el('button', { class: 'pt-retour', onclick: function () { if (petitEcran()) history.back(); else fermer(); }, 'aria-label': 'Retour à la liste' }, ['‹']),
          anneau(f.NbOK || 0, f.NbBL || 0, 54),
          el('div', { class: 'pt-entete-txt' }, [
            el('div', { class: 'pt-entete-titre' }, [f.Fournisseur + ' · facture n°' + f.NumFacture]),
            el('div', { class: 'petit' }, [(f.DateFacture ? 'du ' + f.DateFacture + ' · ' : '') + 'importée ' + (f.DateImport || '') + (f.Commentaire ? ' · ' + f.Commentaire : '')])
          ]),
          el('span', { class: 'pt-chip grand st-' + f.Statut }, [LIB_F[f.Statut] || f.Statut]),
          el('button', { class: 'pt-btn pt-bascule' + (panneauVisible ? ' actif' : ''), title: panneauVisible ? 'Masquer la liste des BL' : 'Afficher la liste des BL',
            onclick: function () {
              panneauVisible = !panneauVisible; PM.Prefs.set('panneauBL', panneauVisible ? '1' : '0');
              dessiner();
              setTimeout(function () { var z = racine.querySelector('.pt-pages'); if (pdfCourant && z && Math.abs(largeurDispo(z) - largeurRendu) > 40) rendrePdf(); }, 60);
            } }, [panneauVisible ? '⇥ Masquer BL' : '☰ BL (' + (f.NbOK || 0) + '/' + (f.NbBL || 0) + ')'])
        ]);
      }

      /* ---------------- Visionneuse : PDF + voiles ---------------- */
      function largeurDispo(z) { return Math.min(Math.max(z.clientWidth - 4, 280), 1100); }

      function chargerEtRendre(f) {
        var z = zones.pages;
        z.innerHTML = '';
        z.appendChild(el('div', { class: 'pt-scan' }, [el('div', { class: 'pt-scan-ligne' }), el('span', {}, ['Lecture de la facture…'])]));
        var seq = ++rendreSeq;
        Promise.all([obtenirPdf(f), chargerPdfJs()]).then(function (r) {
          if (seq !== rendreSeq || selId !== f.ID) return;
          var d = r[0];
          if (/^image\//.test(d.mime)) {
            z.innerHTML = '';
            z.appendChild(el('div', { class: 'pt-bandeau-info' }, ['Facture en image : pas de surbrillance, utilise la liste des BL.']));
            z.appendChild(el('div', { class: 'pt-page' }, [el('img', { src: 'data:' + d.mime + ';base64,' + d.base64, alt: 'Facture' })]));
            return;
          }
          return r[1].getDocument({ data: b64VersOctets(d.base64) }).promise.then(function (pdf) {
            if (seq !== rendreSeq) return;
            pdfCourant = { pdf: pdf, f: f };
            return rendrePdf();
          });
        })['catch'](function (e) {
          if (seq !== rendreSeq) return;
          z.innerHTML = '';
          z.appendChild(el('div', { class: 'vide-msg' }, ['PDF indisponible : ' + e.message, el('br'),
            el('button', { class: 'btn-second', style: 'margin-top:10px', onclick: function () { chargerEtRendre(f); } }, ['Réessayer'])]));
        });
      }

      function rendrePdf() {
        if (!pdfCourant || !zones.pages) return Promise.resolve();
        var z = zones.pages, pdf = pdfCourant.pdf, f = pdfCourant.f, seq = ++rendreSeq;
        var cfg = config(f.Fournisseur);
        var largeur = largeurDispo(z);
        largeurRendu = largeur;
        var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        var frag = document.createDocumentFragment();
        var report = null, texte = false, nouveauxBlocs = [], vus = {};
        var n = 0;
        function page() {
          n++;
          if (n > pdf.numPages) return Promise.resolve();
          return pdf.getPage(n).then(function (pg) {
            var vp = pg.getViewport({ scale: largeur / pg.getViewport({ scale: 1 }).width });
            var div = el('div', { class: 'pt-page', style: 'width:' + vp.width + 'px;height:' + vp.height + 'px' });
            var cv = document.createElement('canvas');
            cv.width = Math.floor(vp.width * dpr); cv.height = Math.floor(vp.height * dpr);
            cv.style.width = vp.width + 'px'; cv.style.height = vp.height + 'px';
            div.appendChild(cv);
            frag.appendChild(div);
            return pg.render({ canvasContext: cv.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise
              .then(function () { return pg.getTextContent(); })
              .then(function (tc) {
                var lignes = regrouperLignes(tc.items, vp);
                if (lignes.length) texte = true;
                var res = calculerBlocs(lignes, vp, cfg, report);
                report = res.report;
                res.blocs.forEach(function (b) {
                  b.el = el('div', { class: 'pt-voile', style: 'left:' + b.x + 'px;top:' + b.y + 'px;width:' + b.w + 'px;height:' + b.h + 'px' }, [el('span', { class: 'pt-etiquette' })]);
                  b.el.addEventListener('click', function () { cliquerVoile(b.num); });
                  div.appendChild(b.el);
                  nouveauxBlocs.push(b);
                  vus[b.num] = true;
                });
                return page();
              });
          });
        }
        return page().then(function () {
          if (seq !== rendreSeq) return;
          z.innerHTML = '';
          if (!texte) z.appendChild(el('div', { class: 'pt-bandeau-info' }, ['PDF scanné (sans texte) : pas de surbrillance, utilise la liste des BL.']));
          z.appendChild(frag);
          blocs = nouveauxBlocs; numsVusPdf = vus;
          majVoiles();
          // les BL repérés sur le PDF mais pas par le serveur : signalés dans le panneau
          var p = racine.querySelector('.pt-panneau');
          if (p && selId) { var nv = panneauBL(facture(selId)); p.parentNode.replaceChild(nv, p); }
        });
      }

      function regrouperLignes(items, vp) {
        var elems = [];
        items.forEach(function (it) {
          if (!it.str || !it.str.trim()) return;
          var t = window.pdfjsLib.Util.transform(vp.transform, it.transform);
          var h = Math.hypot(t[2], t[3]) || 10;
          elems.push({ x: t[4], y: t[5], h: h, w: it.width * vp.scale, s: it.str });
        });
        elems.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
        var lignes = [];
        elems.forEach(function (e) {
          var l = null;
          for (var i = lignes.length - 1; i >= 0 && i >= lignes.length - 4; i--) if (Math.abs(lignes[i].y - e.y) < Math.max(2, e.h * 0.45)) { l = lignes[i]; break; }
          if (l) { l.items.push(e); l.h = Math.max(l.h, e.h); } else lignes.push({ y: e.y, h: e.h, items: [e] });
        });
        lignes.forEach(function (l) {
          l.items.sort(function (a, b) { return a.x - b.x; });
          var txt = '', fin = null;
          l.items.forEach(function (it) { if (fin !== null && it.x - fin > it.h * 0.2) txt += ' '; txt += it.s; fin = it.x + it.w; });
          l.texte = txt.replace(/\s+/g, ' ');
          l.top = l.y - l.h * 0.85; l.bottom = l.y + l.h * 0.25;
          l.x0 = Math.min.apply(null, l.items.map(function (i) { return i.x; }));
          l.x1 = Math.max.apply(null, l.items.map(function (i) { return i.x + i.w; }));
        });
        lignes.sort(function (a, b) { return a.y - b.y; });
        return lignes;
      }

      /* Découpe le tableau en blocs « ligne BL + ses pièces » (même règle que l'appli d'origine) */
      function calculerBlocs(lignes, vp, cfg, report) {
        var reBL = new RegExp(cfg.RegexBLFacture, 'i');
        var reDeb = cfg.DebutTableau ? new RegExp(cfg.DebutTableau, 'i') : null;
        var reFin = cfg.FinTableau ? new RegExp(cfg.FinTableau, 'i') : null;
        var iDeb = -1, iFin = -1, i;
        if (reDeb) for (i = 0; i < lignes.length; i++) if (reDeb.test(lignes[i].texte)) { iDeb = i; break; }
        if (reFin) for (i = iDeb + 1; i < lignes.length; i++) if (reFin.test(lignes[i].texte)) { iFin = i; break; }
        var corps = lignes.slice(iDeb + 1, iFin >= 0 ? iFin : lignes.length);
        if (!corps.length) return { blocs: [], report: iFin >= 0 ? null : report };
        var x0, x1;
        if (iDeb >= 0) { x0 = lignes[iDeb].x0; x1 = lignes[iDeb].x1; }
        else { x0 = Math.min.apply(null, corps.map(function (l) { return l.x0; })); x1 = Math.max.apply(null, corps.map(function (l) { return l.x1; })); }
        x0 = Math.max(2, x0 - 8); x1 = Math.min(vp.width - 2, x1 + 8);
        var hs = corps.map(function (l) { return l.h; }).sort(function (a, b) { return a - b; });
        var ecartMax = (hs[Math.floor(hs.length / 2)] || 10) * 3.6;
        var entetes = [];
        corps.forEach(function (l, k) { var m = reBL.exec(l.texte); if (m && m[1]) entetes.push({ i: k, num: m[1] }); });
        var res = [];
        function fermer(num, a, b) {
          var sel = corps.slice(a, b);
          if (!sel.length) return;
          for (var k = 1; k < sel.length; k++) if (sel[k].top - sel[k - 1].bottom > ecartMax) { sel = sel.slice(0, k); break; }
          var top = Math.min.apply(null, sel.map(function (l) { return l.top; })) - 4;
          var bottom = Math.max.apply(null, sel.map(function (l) { return l.bottom; })) + 4;
          res.push({ num: num, x: x0, y: top, w: x1 - x0, h: bottom - top });
        }
        if (report && (!entetes.length || entetes[0].i > 0)) fermer(report, 0, entetes.length ? entetes[0].i : corps.length);
        entetes.forEach(function (e, k) { fermer(e.num, e.i, k + 1 < entetes.length ? entetes[k + 1].i : corps.length); });
        return { blocs: res, report: iFin >= 0 ? null : (entetes.length ? entetes[entetes.length - 1].num : report) };
      }

      function majVoiles() {
        var f = selId && facture(selId);
        if (!f) return;
        var parNum = {};
        f.lignes.forEach(function (l) { parNum[String(l.NumBL)] = l; });
        blocs.forEach(function (b, k) {
          var l = parNum[b.num], st = l ? l.Statut : 'MANQUANT';
          b.el.className = 'pt-voile ' + (l ? CLS[st] : 'inconnu') + (selBL === b.num ? ' selection' : '') + (l && l._attente ? ' attente' : '');
          b.el.style.setProperty('--i', k);
          var txt = !l ? '? NON LU · AJOUTER' : st === 'MANQUANT' ? '◌ À POINTER' : st === 'LITIGE' ? '⛔ LITIGE'
            : st === 'VALIDE_MANUEL' ? '✓ ' + String(l.Operateur || 'VALIDÉ').toUpperCase() : st === 'TROUVE_PHOTO' ? '✓ PHOTO' : '✓ MAIL';
          b.el.firstChild.textContent = 'BL ' + b.num + ' · ' + txt + (l && l._attente ? ' ⏳' : '');
        });
      }

      function cliquerVoile(num) {
        var f = facture(selId);
        if (!f) return;
        if (!f.lignes.some(function (l) { return String(l.NumBL) === num; })) {
          if (f.Statut === 'ENVOYEE') return;
          if (window.confirm('Le BL ' + num + ' est sur la facture mais n’a pas été lu par le serveur. L’ajouter ?')) {
            saisir({ type: 'pointage.action', factureId: f.ID, numBL: num, action: 'AJOUTER', commentaire: 'Lu sur la facture' }, 'BL ' + num + ' ajouté');
          }
          return;
        }
        selBL = num;
        majVoiles();
        Array.prototype.forEach.call(racine.querySelectorAll('.pt-bl'), function (x) { x.classList.toggle('selection', x.getAttribute('data-num') === num); });
        var cible = racine.querySelector('.pt-bl[data-num="' + num + '"]');
        if (cible) cible.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }

      /* ---------------- Panneau des BL ---------------- */
      function panneauBL(f) {
        var envoyee = f.Statut === 'ENVOYEE';
        var p = el('section', { class: 'pt-panneau' });
        p.appendChild(el('div', { class: 'liste-titre' }, ['BL de la facture']));
        if (!f.lignes.length) p.appendChild(el('div', { class: 'pt-bandeau-info' }, ['Aucun n° de BL lu sur cette facture : ajoute-les ci-dessous ou force la validation.']));

        f.lignes.forEach(function (l, k) {
          var num = String(l.NumBL);
          var acts = [];
          function bouton(txt, cls, fn) { acts.push(el('button', { class: 'pt-mini ' + (cls || ''), onclick: function (e) { e.stopPropagation(); fn(); } }, [txt])); }
          var idApercu = l.FichierId || (l.MsgId ? 'MSG:' + l.MsgId : '');
          if (!envoyee) {
            if (l.Statut === 'MANQUANT') {
              bouton('✓ Valider', 'principal', function () {
                demander('Valider le BL ' + num, 'Commentaire (facultatif)', false, function (c) {
                  saisir({ type: 'pointage.action', factureId: f.ID, numBL: num, action: 'VALIDER', commentaire: c }, 'BL ' + num + ' validé');
                });
              });
              bouton('📷 Photo', '', function () { feuillePhoto(num); });
              bouton('⚠ Litige', 'danger', function () { litige(f, num); });
              if (l.Source === 'AJOUT') bouton('🗑', '', function () {
                if (window.confirm('Retirer le BL ' + num + ' de la facture ?')) saisir({ type: 'pointage.action', factureId: f.ID, numBL: num, action: 'SUPPRIMER' }, 'BL retiré');
              });
            } else if (l.Statut === 'TROUVE_MAIL' || l.Statut === 'TROUVE_PHOTO') {
              bouton('⚠ Litige', 'danger', function () { litige(f, num); });
              bouton('↺ Dépointer', '', function () { saisir({ type: 'pointage.action', factureId: f.ID, numBL: num, action: 'ANNULER' }, 'BL dépointé'); });
            } else {
              bouton('↺ Annuler', '', function () { saisir({ type: 'pointage.action', factureId: f.ID, numBL: num, action: 'ANNULER' }, 'Annulé'); });
            }
          }
          var detail = [l.Detail, l.Operateur && l.Statut !== 'TROUVE_MAIL' ? 'par ' + l.Operateur : '', l.DateValidation, l.Commentaire].filter(Boolean).join(' · ');
          var horsPdf = blocs.length && !numsVusPdf[num];
          p.appendChild(el('div', { class: 'pt-bl ' + CLS[l.Statut] + (selBL === num ? ' selection' : ''), 'data-num': num, style: '--i:' + k,
            onclick: function () { selectionnerLigne(num); } }, [
            el('div', { class: 'pt-bl-haut' }, [
              el('span', { class: 'pt-bl-num' }, ['BL ' + num, horsPdf ? el('small', {}, [' hors PDF']) : null]),
              el('span', { class: 'pt-bl-etat' }, [(l._attente ? '⏳ ' : '') + (LIB[l.Statut] || l.Statut)]),
              idApercu ? el('button', { class: 'pt-oeil', title: 'Voir le BL', 'aria-label': 'Voir le BL ' + num,
                onclick: function (e) { e.stopPropagation(); voirFichier(idApercu, 'BL ' + num); } }, [ICONE_OEIL()]) : null
            ]),
            (l.DateBL || detail) ? el('div', { class: 'pt-bl-detail' }, [(l.DateBL ? 'du ' + l.DateBL + (detail ? ' · ' : '') : '') + detail]) : null,
            acts.length ? el('div', { class: 'pt-bl-acts' }, acts) : null
          ]));
        });

        if (!envoyee) {
          var champ = el('input', { type: 'text', inputmode: 'numeric', class: 'pt-champ', placeholder: 'Ajouter un n° de BL' });
          var ajouter = function () {
            var v = champ.value.trim();
            if (!v) return;
            if (f.lignes.some(function (l) { return String(l.NumBL) === v; })) { PM.toast('Ce BL est déjà sur la facture'); return; }
            saisir({ type: 'pointage.action', factureId: f.ID, numBL: v, action: 'AJOUTER' }, 'BL ' + v + ' ajouté');
          };
          champ.addEventListener('keydown', function (e) { if (e.key === 'Enter') ajouter(); });
          p.appendChild(el('div', { class: 'pt-ajout' }, [champ, el('button', { class: 'pt-mini principal', onclick: ajouter }, ['＋'])]));
        }

        var bas = el('div', { class: 'pt-bas' });
        if (envoyee) {
          bas.appendChild(el('div', { class: 'pt-bandeau-info ok' }, ['✉ Envoyée à la compta le ' + (f.DateEnvoi || '') + ' par ' + (f.EnvoyePar || '') + '.']));
          bas.appendChild(el('button', { class: 'btn-second', onclick: function () { envoyer(f, true); } }, ['Renvoyer à la compta']));
        } else if (f.Statut === 'COMPLETE' || f.Statut === 'COMPLETE_FORCEE') {
          bas.appendChild(el('div', { class: 'pt-bandeau-info ok' }, [f._attente || f.lignes.some(function (l) { return l._attente; })
            ? '✓ Tous les BL sont pointés : la facture part à la compta dès l’envoi des saisies.'
            : '✓ Tous les BL sont pointés.' + (E.envoiAuto ? '' : ' Envoi automatique désactivé.')]));
          if (!E.envoiAuto) bas.appendChild(el('button', { class: 'btn-principal', onclick: function () { envoyer(f, false); } }, ['✉ Envoyer à la compta']));
        } else {
          bas.appendChild(el('button', { class: 'btn-second', onclick: function () {
            demander('Forcer la validation', 'Pourquoi valider sans tous les BL ? (obligatoire)', true, function (c) {
              saisir({ type: 'pointage.forcer', factureId: f.ID, commentaire: c }, 'Validation forcée');
            });
          } }, ['Forcer la validation…']));
        }
        p.appendChild(bas);

        if (f.historique && f.historique.length) {
          p.appendChild(el('div', { class: 'liste-titre', style: 'margin-top:18px' }, ['Historique']));
          p.appendChild(el('div', { class: 'pt-histo' }, f.historique.map(function (h) {
            return el('div', {}, [el('b', {}, [h.Operateur || '']), ' · ' + h.Action + ' ' + (h.Detail || ''), el('br'), el('small', {}, [h.Date])]);
          })));
        }
        return p;
      }

      function selectionnerLigne(num) {
        selBL = num;
        majVoiles();
        Array.prototype.forEach.call(racine.querySelectorAll('.pt-bl'), function (x) { x.classList.toggle('selection', x.getAttribute('data-num') === num); });
        var b = blocs.filter(function (x) { return x.num === num; })[0];
        if (b) b.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      function litige(f, num) {
        demander('Litige sur le BL ' + num, 'Raison du litige (obligatoire)', true, function (c) {
          saisir({ type: 'pointage.action', factureId: f.ID, numBL: num, action: 'LITIGE', commentaire: c }, 'Litige enregistré');
        });
      }
      function envoyer(f, renvoi) {
        if (!window.confirm((renvoi ? 'Renvoyer' : 'Envoyer') + ' la facture n°' + f.NumFacture + ' à ' + (E.emailCompta || 'la compta') + ' ?')) return;
        saisir({ type: 'pointage.envoyer', factureId: f.ID }, 'Envoi à la compta programmé');
      }

      /* ---------------- Feuilles (fenêtres du bas) ---------------- */
      function feuille(titre, contenu) {
        var fond = el('div', { class: 'pt-fond' });
        var f = el('div', { class: 'pt-feuille', role: 'dialog' }, [el('div', { class: 'pt-feuille-poignee' }), el('div', { class: 'pt-feuille-titre' }, [titre])].concat(contenu));
        function fermerF() { fond.classList.remove('visible'); setTimeout(function () { fond.remove(); }, 200); }
        fond.addEventListener('click', function (e) { if (e.target === fond) fermerF(); });
        fond.appendChild(f);
        document.body.appendChild(fond);
        requestAnimationFrame(function () { fond.classList.add('visible'); });
        return fermerF;
      }

      function demander(titre, label, obligatoire, suite) {
        var zone = el('textarea', { class: 'pt-champ', rows: '3', placeholder: label });
        var fermerF = feuille(titre, [zone, el('div', { class: 'pt-feuille-boutons' }, [
          el('button', { class: 'btn-second', onclick: function () { fermerF(); } }, ['Annuler']),
          el('button', { class: 'btn-principal', onclick: function () {
            var v = zone.value.trim();
            if (obligatoire && !v) { PM.toast('Ce champ est obligatoire'); zone.focus(); return; }
            fermerF(); suite(v);
          } }, ['OK'])
        ])]);
        setTimeout(function () { zone.focus(); }, 250);
      }

      function choisirOperateur(suite) {
        var noms = (E && E.operateurs) || [];
        var champ = el('input', { type: 'text', class: 'pt-champ', placeholder: 'Ou tape ton prénom' });
        var fermerF;
        function choisir(n) { if (!n) return; PM.Prefs.set('agent', n); fermerF(); PM.toast('Bonjour ' + n); if (suite) suite(); }
        fermerF = feuille('Qui pointe ?', [
          el('p', { class: 'petit' }, ['Ton nom est noté sur chaque pointage (modifiable dans Réglages).']),
          el('div', { class: 'pt-noms' }, noms.map(function (n) { return el('button', { class: 'btn-second', onclick: function () { choisir(n); } }, [n]); })),
          champ,
          el('button', { class: 'btn-principal', style: 'margin-top:10px', onclick: function () { choisir(champ.value.trim()); } }, ['Continuer'])
        ]);
      }

      function menuScan() {
        var fermerF = feuille('Recherche des BL', [
          el('p', { class: 'petit' }, ['Le serveur cherche aussi tout seul toutes les 15 minutes.' + (E.derniereSynchro ? ' Dernier passage : ' + E.derniereSynchro + '.' : '')]),
          el('button', { class: 'btn-principal', onclick: function () { fermerF(); lancerScan(false); } }, ['⚡ Lancer un scan (≈ 1 min)']),
          el('button', { class: 'btn-second', style: 'width:100%;margin-top:10px', onclick: function () {
            if (!window.confirm('Scan forcé : relit TOUS les mails BL et toutes les factures sans BL. Jusqu’à 5 minutes. Continuer ?')) return;
            fermerF(); lancerScan(true);
          } }, ['Scan forcé complet (≈ 5 min)'])
        ]);
      }
      function lancerScan(force) {
        if (!PM.Prefs.get('agent', '')) { choisirOperateur(function () { lancerScan(force); }); return; }
        majIndicateurSync('sync');
        appel('pointage.scan', { force: !!force }, 330000).then(function (j) {
          if (j.dejaEnCours) PM.toast('Un scan est déjà en cours : patiente quelques minutes.', 5000);
          else if (j.lance) { if (E) E.scanEnCours = true; PM.toast(force ? 'Scan forcé lancé : il tourne sur le serveur (jusqu’à 5 min), les résultats arrivent tout seuls.' : 'Scan lancé : résultats dans 1 à 2 minutes.', 6000); }
          else if (j.resume) PM.toast('Scan terminé : ' + j.resume.factures + ' facture(s), ' + j.resume.bl + ' BL trouvé(s), ' + j.resume.pointes + ' pointé(s)', 6000);
          else PM.toast('Scan terminé', 4000);
          derniereAuto = Date.now();
          rafraichir(false);
        })['catch'](function (e) { PM.toast('Scan : ' + e.message, 6000); majIndicateurSync('ko', e); });
      }

      /* ---------------- Photo d'un BL papier ---------------- */
      function feuillePhoto(numImpose) {
        if (!PM.Prefs.get('agent', '')) { choisirOperateur(function () { feuillePhoto(numImpose); }); return; }
        var f = selId && facture(selId);
        var choixF = el('select', { class: 'pt-champ' }, (E.fournisseurs || []).map(function (x) {
          return el('option', { selected: (f ? f.Fournisseur === x.Nom : FOURN === x.Nom) ? 'selected' : null }, [x.Nom]);
        }));
        var num = el('input', { type: 'text', inputmode: 'numeric', class: 'pt-champ', placeholder: 'N° de BL (facultatif, sinon lu sur la photo)', value: numImpose || '' });
        var res = el('div', { class: 'pt-resultats' });
        var camera = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: 'hidden' });
        var fichiers = el('input', { type: 'file', accept: 'image/*,application/pdf', multiple: 'multiple', hidden: 'hidden' });
        [camera, fichiers].forEach(function (inp) {
          inp.addEventListener('change', function () {
            var l = Array.prototype.slice.call(inp.files || []); inp.value = '';
            envoyerPhotos(l, choixF.value, num.value.trim(), res);
          });
        });
        var contenu = [
          el('label', { class: 'petit' }, ['Fournisseur']), choixF, num,
          el('div', { class: 'pt-deux' }, [
            el('label', { class: 'btn-principal pt-label-btn' }, [camera, '📷 Prendre la photo']),
            el('label', { class: 'btn-second pt-label-btn' }, [fichiers, '📁 Fichier'])
          ])
        ];
        if (numImpose && f) contenu.push(el('button', { class: 'btn-second', style: 'width:100%;margin-top:10px', onclick: function () {
          fermerF();
          saisir({ type: 'pointage.action', factureId: f.ID, numBL: numImpose, action: 'VALIDER', commentaire: 'BL papier vu (sans photo)' }, 'BL ' + numImpose + ' validé');
        } }, ['✓ Valider sans photo']));
        contenu.push(res);
        var fermerF = feuille('BL papier', contenu);
      }

      function envoyerPhotos(liste, fournisseur, numImpose, res) {
        if (navigator.onLine === false) { PM.toast('Pas de réseau : la photo partira plus tard, garde-la dans la galerie.'); return; }
        (function suivante(i) {
          if (i >= liste.length) return;
          var fic = liste[i];
          var ligne = el('div', { class: 'pt-resultat' }, ['⏳ ' + fic.name + ' : envoi et lecture du n°…']);
          res.insertBefore(ligne, res.firstChild);
          (fic.type === 'application/pdf' ? fichierVersB64(fic).then(function (b) { return { base64: b, mime: 'application/pdf' }; }) : compresser(fic))
            .then(function (d) {
              ligne.textContent = '⏳ ' + fic.name + ' : envoi (' + Math.round(d.base64.length * 0.75 / 1024) + ' Ko) et lecture du n°…';
              return envoiFiable('pointage.photo', { base64: d.base64, mime: d.mime, nom: fic.name, fournisseur: fournisseur, numImpose: numImpose }, 90000,
                function (m) { ligne.textContent = '⏳ ' + fic.name + ' : ' + m; });
            }).then(function (r) {
              if (r.retenus && r.retenus.length) {
                ligne.className = 'pt-resultat ok';
                ligne.textContent = '✓ BL ' + r.retenus.join(', ') + (r.differe ? ' enregistré · pointage dans quelques minutes' : ' enregistré et pointé');
                rafraichir(false);
              } else {
                ligne.className = 'pt-resultat ko';
                ligne.innerHTML = '';
                var c = el('input', { type: 'text', inputmode: 'numeric', class: 'pt-champ', placeholder: 'N° du BL' });
                var b = el('button', { class: 'pt-mini principal' }, ['✓ Valider']);
                var valider = function () {
                  var v = c.value.trim(); if (!v) { c.focus(); return; }
                  b.disabled = true; b.textContent = '⏳';
                  appel('pointage.associer', { fichierId: r.fichierId, numBL: v, fournisseur: fournisseur }, 60000).then(function (x) {
                    ligne.className = 'pt-resultat ok';
                    ligne.textContent = '✓ BL ' + v + (x.differe ? ' enregistré · pointage dans quelques minutes' : ' enregistré et pointé');
                    rafraichir(false);
                  })['catch'](function (e) { b.disabled = false; b.textContent = '✓ Valider'; PM.toast(e.message, 5000); });
                };
                b.addEventListener('click', valider);
                c.addEventListener('keydown', function (e) { if (e.key === 'Enter') valider(); });
                ligne.appendChild(el('div', {}, ['⚠ ' + fic.name + ' : n° non lu. Tape-le :']));
                ligne.appendChild(el('div', { class: 'pt-ajout' }, [c, b]));
                setTimeout(function () { c.focus(); }, 50);
              }
            })['catch'](function (e) {
              ligne.className = 'pt-resultat ko';
              ligne.textContent = '✗ ' + fic.name + ' : ' + e.message;
            }).then(function () { suivante(i + 1); });
        })(0);
      }

      /* ---------------- Dépôt d'une facture ---------------- */
      function deposerFacture() {
        if (!PM.Prefs.get('agent', '')) { choisirOperateur(deposerFacture); return; }
        var choixF = el('select', { class: 'pt-champ' }, (E.fournisseurs || []).map(function (x) { return el('option', {}, [x.Nom]); }));
        var res = el('div', { class: 'pt-resultats' });
        var inp = el('input', { type: 'file', accept: 'application/pdf', multiple: 'multiple', hidden: 'hidden' });
        inp.addEventListener('change', function () {
          var l = Array.prototype.slice.call(inp.files || []); inp.value = '';
          (function suivante(i) {
            if (i >= l.length) { rafraichir(false); return; }
            var ligne = el('div', { class: 'pt-resultat' }, ['⏳ ' + l[i].name + ' : import et lecture des BL…']);
            res.insertBefore(ligne, res.firstChild);
            fichierVersB64(l[i]).then(function (b) {
              return envoiFiable('pointage.facture', { base64: b, nom: l[i].name, fournisseur: choixF.value }, 120000,
                function (m) { ligne.textContent = '⏳ ' + l[i].name + ' : ' + m; });
            }).then(function () { ligne.className = 'pt-resultat ok'; ligne.textContent = '✓ ' + l[i].name + ' importée'; })
              ['catch'](function (e) { ligne.className = 'pt-resultat ko'; ligne.textContent = '✗ ' + l[i].name + ' : ' + e.message; })
              .then(function () { suivante(i + 1); });
          })(0);
        });
        feuille('Déposer une facture', [
          el('p', { class: 'petit' }, ['La compta peut aussi déposer les PDF dans le dossier Drive partagé.' + (E.lienDepot ? '' : '')]),
          E.lienDepot ? el('a', { href: E.lienDepot, target: '_blank', rel: 'noopener', class: 'petit' }, ['Ouvrir le dossier de dépôt ↗']) : null,
          el('label', { class: 'petit', style: 'display:block;margin-top:10px' }, ['Fournisseur']), choixF,
          el('label', { class: 'btn-principal pt-label-btn' }, [inp, '📄 Choisir le(s) PDF']),
          res
        ]);
      }

      /* ---------------- Tous les BL reçus du fournisseur ---------------- */
      function feuilleBLRecus() {
        var cleCache = 'pointage_bls_' + FOURN;
        var recherche = el('input', { type: 'search', class: 'pt-champ', placeholder: 'Chercher un n° de BL ou de facture…' });
        var info = el('div', { class: 'petit pt-blr-info' }, ['Chargement…']);
        var liste = el('div', { class: 'pt-blr-liste' });
        var donnees = null;
        var fermerF = feuille('BL reçus · ' + FOURN, [recherche, info, liste]);
        recherche.addEventListener('input', remplir);
        function remplir() {
          if (!donnees) return;
          var q = recherche.value.trim().toLowerCase();
          var bls = donnees.filter(function (b) {
            return !q || (b.num + ' ' + b.detail + ' ' + b.factures.map(function (x) { return x.num; }).join(' ')).toLowerCase().indexOf(q) >= 0;
          });
          liste.innerHTML = '';
          var surFact = donnees.filter(function (b) { return b.factures.length; }).length;
          info.textContent = donnees.length + ' BL reçu' + (donnees.length > 1 ? 's' : '') + ' · ' + surFact + ' sur une facture · ' + (donnees.length - surFact) + ' en attente de facture';
          if (!bls.length) { liste.appendChild(el('div', { class: 'vide-msg petit' }, [q ? 'Aucun résultat.' : 'Aucun BL reçu pour l’instant.'])); return; }
          bls.slice(0, 200).forEach(function (b, i) {
            var idA = b.fichierId || (b.msgId ? 'MSG:' + b.msgId : '');
            var fac = b.factures.length ? b.factures.map(function (x) {
              return el('button', { class: 'pt-blr-fact', onclick: function () { fermerF(); if (facture(x.id)) ouvrir(x.id); } }, ['Facture n°' + x.num]);
            }) : [el('span', { class: 'pt-blr-attente' }, ['Pas encore sur une facture'])];
            liste.appendChild(el('div', { class: 'pt-blr ' + (b.source === 'PHOTO' ? 'photo' : 'mail'), style: '--i:' + Math.min(i, 12) }, [
              el('div', { class: 'pt-blr-ico' }, [b.source === 'PHOTO' ? '📷' : '✉']),
              el('div', { class: 'pt-blr-txt' }, [
                el('div', { class: 'pt-bl-num' }, ['BL ' + b.num, el('small', {}, [b.date ? '  · ' + b.date : ''])]),
                b.detail ? el('div', { class: 'pt-bl-detail' }, [b.detail]) : null,
                el('div', { class: 'pt-blr-facts' }, fac)
              ]),
              idA ? el('button', { class: 'pt-oeil grand', title: 'Voir le BL', onclick: function () { voirFichier(idA, 'BL ' + b.num); } }, [ICONE_OEIL()]) : null
            ]));
          });
        }
        PM.DB.get(cleCache).then(function (c) { if (c && !donnees) { donnees = c; remplir(); } });
        appel('pointage.bls', { fournisseur: FOURN }, 45000).then(function (j) {
          donnees = j.bls || []; PM.DB.set(cleCache, donnees); remplir();
        })['catch'](function (e) { if (!donnees) info.textContent = 'Impossible de charger : ' + e.message; });
      }

      /* ---------------- Aperçu d'un BL (mail ou photo) ---------------- */
      function voirFichier(id, titre) {
        var zone = el('div', { class: 'pt-apercu-corps' }, [el('div', { class: 'pt-scan' }, [el('div', { class: 'pt-scan-ligne' }), el('span', {}, ['Chargement…'])])]);
        var ov = el('div', { class: 'pt-apercu' }, [
          el('div', { class: 'pt-apercu-tete' }, [el('span', {}, [titre]), el('button', { class: 'pt-mini', onclick: function () { ov.remove(); } }, ['✕ Fermer'])]),
          zone]);
        document.body.appendChild(ov);
        var garde = 'pointage_fic_' + id;
        PM.DB.get(garde).then(function (d) {
          return d || appel('pointage.fichier', { fichierId: id }, 60000).then(function (j) {
            var x = { mime: j.mime, base64: j.base64 }; PM.DB.set(garde, x); return x;
          });
        }).then(function (d) {
          zone.innerHTML = '';
          if (/^image\//.test(d.mime)) { zone.appendChild(el('img', { src: 'data:' + d.mime + ';base64,' + d.base64, alt: titre })); return; }
          if (/^text\//.test(d.mime)) {
            var txt = new TextDecoder('utf-8').decode(b64VersOctets(d.base64));
            zone.appendChild(el('div', { class: 'pt-apercu-texte' }, [el('div', { class: 'petit', style: 'margin-bottom:8px' }, ['Pas de pièce jointe : texte du mail']), txt]));
            return;
          }
          return chargerPdfJs().then(function (lib) { return lib.getDocument({ data: b64VersOctets(d.base64) }).promise; }).then(function (pdf) {
            var n = 0;
            (function page() {
              if (++n > Math.min(pdf.numPages, 6)) return;
              pdf.getPage(n).then(function (pg) {
                var w = Math.min(zone.clientWidth - 10, 900);
                var vp = pg.getViewport({ scale: w / pg.getViewport({ scale: 1 }).width });
                var c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
                zone.appendChild(c);
                return pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
              }).then(page);
            })();
          });
        })['catch'](function (e) { zone.innerHTML = ''; zone.appendChild(el('div', { class: 'vide-msg' }, [e.message])); });
      }
    }
  };
})();
