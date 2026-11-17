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
// Szándékosan NINCS beégetett "ismert Worker-host": a repó publikus, a Worker hostja
// pedig eddig nem az (amíg a Worker nyitott tételei, B4/B5 állnak, ne is legyen).
// "Ismert" itt = amivel ez a böngésző már párosítva van.
var HealthPairing = (function () {
  'use strict';
  var API = 'health_api', KEY = 'health_key';
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
    return {api: ep && key ? ep : '', key: ep && key ? key : '', bad: !!api && !ep};
  }
  function params(s) { return new URLSearchParams(String(s || '').replace(/^[?#]/, '')); }
  function has(p) { return p.has('api') || p.has('key'); }

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
        + '\n\nThe read key will be sent there, and this dashboard will show whatever it returns.';
    if (!confirm(ask + '\n\nOnly continue if you opened your own setup link.'))
      return 'Nothing was saved.' + (cur.api ? ' This browser still uses ' + host(cur.api) + ' with its current key.' : '');
    try { localStorage.setItem(API, ep); localStorage.setItem(KEY, key); }
    catch (e) { return 'Could not save the connection: this browser blocks storage for the page.'; }
    return 'Connected this browser to ' + host(ep) + '.';
  }

  // Visszajelzés csak szövegként (textContent) — a host és a link tartalma külső adat.
  function note(msgs) {
    var el = document.getElementById('pairNote');
    if (!el || !msgs.length) return;
    el.textContent = msgs.join(' ');
    el.hidden = false;
  }

  // A link feldolgozása (ha van), utána a HASZNÁLHATÓ beállítás: {api, key} vagy üres.
  function run() {
    var q = params(location.search), h = params(location.hash), msgs = [];
    if (has(q) || has(h)) {
      // A címsor tisztítása ELŐSZÖR: a kulcs ne maradjon benne, bármi jön is ezután
      // (a megerősítő ablak nyitva hagyása alatt sem). A ?demo=1 marad.
      try { history.replaceState(null, '', location.pathname + (q.get('demo') === '1' ? '?demo=1' : '')); } catch (e) {}
      msgs.push(has(h) ? pair(h)
        : 'This setup link carries the key after "?", so it was sent to the web server. Nothing was saved. '
          + 'Use the same link with "#" instead of "?": …/health/#api=…&key=…');
    }
    var s = stored();
    if (s.bad) msgs.push('The saved data endpoint is not an https:// address, so it is not used. Open your setup link again.');
    note(msgs);
    return {api: s.api, key: s.key};
  }

  // Egy már nyitott lapon a link beillesztése csak a #-t változtatja: a böngésző nem
  // tölt újra, és a párosítás nem futna le. Ilyenkor újratöltünk.
  window.addEventListener('hashchange', function () { if (has(params(location.hash))) location.reload(); });

  return {run: run, endpoint: endpoint};
})();
