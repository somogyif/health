// pairing.js — a böngésző párosítása a privát adat-végponttal (Cloudflare Worker).
// EGYETLEN közös belépési pont: az index.html és a brief.html is ezt hívja, és a
// tárolt beállítást is csak ezen át olvassák (B1+B6, hygiene-audit 2026-10-14).
//
// Párosító link — a kulcs a # UTÁN áll, mert a fragment soha nem megy el a
// szerverre; a ?query a GitHub Pages felé menő kérés része (naplók, B6):
//   https://somogyif.github.io/health/#api=https://<worker-host>&key=<READ_KEY>
//   (a brief ugyanígy: …/health/brief.html#api=…&key=…)
//
// Szabályok:
//  • csak https:// végpont, felhasználónév/jelszó, query és fragment nélkül — a
//    data:, http:, javascript: és minden más séma elutasítva, megerősítéssel sem;
//  • MINDEN változáshoz kifejezett megerősítés kell, a host nevével: új vagy másik
//    végponthoz, és ugyanannál a végpontnál új kulcshoz is (a host kitalálható, így
//    egy link különben csendben elronthatná a működő párosítást). Nemre semmi nem
//    változik; ugyanaz a link újra (azonos végpont és kulcs) nem kérdez, nem ír.
//    Teljes egyezés, nem előtag: a régi előtag-összevetés a …workers.dev-hez a
//    …work-öt is "ugyanannak" vette;
//  • a régi ?api=…&key=… linket nem fogadja el (a kulcs már a szerver felé ment
//    kérés része volt): kiveszi a címsorból, és megmondja, mi a helyes forma;
//  • a kulcs csak Bearer-tokenben megengedett karakterekből állhat (RFC 6750);
//  • a tárolt végpontot olvasáskor is ellenőrzi: ami nem https, azt nem használja.
//
// ÍRÓkulcs (kamra.html — a /nutrition dokumentum írása), külön a localStorage-ban
// (health_nkey):   https://somogyif.github.io/health/kamra.html#nkey=<WRITE_KEY>
//  • ugyanazok a szabályok: csak a # utáni részből, a címsorból azonnal kivéve,
//    Bearer-karakterek, és MINDEN változáshoz megerősítés a host nevével;
//  • csak az a lap veszi át, amelyik kéri (run({write:true}) — a kamra.html); a többi
//    lap a címsort kitisztítja, és megmondja, hol a helye;
//  • csak már párosított (https) végponthoz menthető: az írókulcs oda megy, ahová az
//    olvasókulcs. Ha a végpont másikra vált, a régi írókulcs törlődik — egy
//    végpontváltó link így nem viheti el egy idegen hostnak;
//  • írókulcs nélkül a kamra csak olvas.
//
// Szándékosan NINCS beégetett "ismert Worker-host": a repó publikus, a Worker hostja
// pedig eddig nem az (amíg a Worker nyitott tételei, B4/B5 állnak, ne is legyen).
// "Ismert" itt = amivel ez a böngésző már párosítva van.
var HealthPairing = (function () {
  'use strict';
  var API = 'health_api', KEY = 'health_key', NKEY = 'health_nkey';
  var TOKEN = /^[A-Za-z0-9\-._~+\/]+=*$/;

  // https-végpont normalizálva (origin + útvonal, záró / nélkül), vagy null.
  function endpoint(raw) {
    var u;
    try { u = new URL(String(raw)); } catch (e) { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  }
  function host(ep) { return new URL(ep).host; }
  function read(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function stored() {
    var api = read(API), key = read(KEY), ep = api ? endpoint(api) : null;
    var ok = !!(ep && key);
    return {api: ok ? ep : '', key: ok ? key : '', nkey: ok && TOKEN.test(read(NKEY)) ? read(NKEY) : '', bad: !!api && !ep};
  }
  function params(s) { return new URLSearchParams(String(s || '').replace(/^[?#]/, '')); }
  function has(p) { return p.has('api') || p.has('key'); }
  function hasN(p) { return p.has('nkey'); }

  function pair(h) {
    var ep = endpoint(h.get('api')), key = h.get('key') || '';
    if (!ep) return 'Setup link refused: the data endpoint must be an https:// address. Nothing was saved.';
    if (!TOKEN.test(key) || key.length > 512)
      return 'Setup link refused: the key is missing or contains characters a key cannot have. Nothing was saved.';
    var cur = stored();
    if (cur.api === ep && cur.key === key) return 'This browser is already connected to ' + host(ep) + '.';
    var ask = cur.api === ep
      ? 'Replace the read key this browser uses for\n\n' + host(ep)
      : (cur.api ? 'Switch this browser to a different data endpoint?\n\nNow: ' + host(cur.api) + '\nNew: ' + host(ep)
                 : 'Connect this browser to the data endpoint\n\n' + host(ep))
        + '\n\nThe read key will be sent there, and this dashboard will show whatever it returns.'
        + (read(NKEY) ? '\nThe saved pantry write key belongs to the old endpoint and will be removed.' : '');
    if (!confirm(ask + '\n\nOnly continue if you opened your own setup link.'))
      return 'Nothing was saved.' + (cur.api ? ' This browser still uses ' + host(cur.api) + ' with its current key.' : '');
    try {
      // Az írókulcs a RÉGI végponté: másik végpontra váltva nem maradhat meg.
      if (cur.api !== ep) localStorage.removeItem(NKEY);
      localStorage.setItem(API, ep); localStorage.setItem(KEY, key);
    }
    catch (e) { return 'Could not save the connection: this browser blocks storage for the page.'; }
    return 'Connected this browser to ' + host(ep) + '.';
  }

  // Az írókulcs átvétele (kamra.html#nkey=…). Magyarul szól: a kamra felülete magyar.
  function pairWrite(key) {
    key = key || '';
    if (!TOKEN.test(key) || key.length > 512)
      return 'Az írókulcs-link elutasítva: a kulcs hiányzik, vagy olyan karakter van benne, ami kulcsban nem lehet. Semmi nem lett elmentve.';
    var cur = stored();
    if (!cur.api)
      return 'Az írókulcs nem menthető: ez a böngésző még nincs párosítva az adat-végponttal. Előbb nyisd meg a párosító linket (…/health/#api=…&key=…), utána újra ezt.';
    if (cur.nkey === key) return 'Az írókulcs már be van állítva ehhez: ' + host(cur.api) + '.';
    var ask = (cur.nkey ? 'Lecseréled az írókulcsot, amit ez a böngésző ehhez a végponthoz használ?\n\n'
                        : 'Beállítod az írókulcsot ehhez a végponthoz?\n\n') + host(cur.api)
      + '\n\nA kulcs oda megy el, és ezzel a böngésző írni tudja a kamrát és az étkezési naplót.'
      + '\n\nCsak akkor folytasd, ha a saját linkedet nyitottad meg.';
    if (!confirm(ask))
      return 'Semmi nem lett elmentve.' + (cur.nkey ? ' A böngésző a korábbi írókulcsot használja tovább.' : ' A kamra csak olvasható marad.');
    try { localStorage.setItem(NKEY, key); }
    catch (e) { return 'Az írókulcs nem menthető: a böngésző tiltja a tárolást ezen a lapon.'; }
    return 'Írókulcs beállítva ehhez: ' + host(cur.api) + '.';
  }

  // Visszajelzés csak szövegként (textContent) — a host és a link tartalma külső adat.
  function note(msgs) {
    var el = document.getElementById('pairNote');
    if (!el || !msgs.length) return;
    el.textContent = msgs.join(' ');
    el.hidden = false;
  }

  // A link feldolgozása (ha van), utána a HASZNÁLHATÓ beállítás: {api, key, nkey} vagy üres.
  // opt.write: ez a lap átveheti az írókulcsot (#nkey=…) — csak a kamra.html kéri.
  function run(opt) {
    var q = params(location.search), h = params(location.hash), msgs = [];
    var link = has(q) || has(h), wlink = hasN(q) || hasN(h);
    if (link || wlink) {
      // A címsor tisztítása ELŐSZÖR: a kulcs ne maradjon benne, bármi jön is ezután
      // (a megerősítő ablak nyitva hagyása alatt sem). A ?demo=1 marad.
      try { history.replaceState(null, '', location.pathname + (q.get('demo') === '1' ? '?demo=1' : '')); } catch (e) {}
      if (link) msgs.push(has(h) ? pair(h)
        : 'This setup link carries the key after "?", so it was sent to the web server. Nothing was saved. '
          + 'Use the same link with "#" instead of "?": …/health/#api=…&key=…');
      // Az írókulcs a végpont UTÁN: ahhoz kötjük, ami a fenti lépés után érvényes.
      if (wlink) msgs.push(hasN(q)
        ? 'Ez a link a "?" után hordozza az írókulcsot, így az elment a webszervernek. Semmi nem lett elmentve. '
          + 'A helyes forma "#"-tel: …/health/kamra.html#nkey=…'
        : (opt && opt.write ? pairWrite(h.get('nkey'))
           : 'Az írókulcsot csak a kamra oldal veszi át. Semmi nem lett elmentve. A helyes link: …/health/kamra.html#nkey=…'));
    }
    var s = stored();
    if (s.bad) msgs.push('The saved data endpoint is not an https:// address, so it is not used. Open your setup link again.');
    note(msgs);
    return {api: s.api, key: s.key, nkey: s.nkey};
  }

  // Egy már nyitott lapon a link beillesztése csak a #-t változtatja: a böngésző nem
  // tölt újra, és a párosítás nem futna le. Ilyenkor újratöltünk.
  window.addEventListener('hashchange', function () { var h = params(location.hash); if (has(h) || hasN(h)) location.reload(); });

  return {run: run, endpoint: endpoint};
})();
