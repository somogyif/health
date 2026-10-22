#!/usr/bin/env node
// tests/page_checks.js — a két oldal (index.html, brief.html) SAJÁT kódját futtatja:
// a HTML-ből kiolvasott <script>-eket (a helyi src-fájlokat is), dokumentum-sorrendben,
// egy minimális ál-böngészőben (node:vm). Nincs függőség és nincs hálózat: a fetch
// ál-válaszokat ad, a végpontok és a kulcsok kitaláltak.
//
//   node tests/page_checks.js          # minden ellenőrzés
//   node tests/page_checks.js B9       # csak azok, amelyek nevében "B9" szerepel
//
// Az ál-DOM nem értelmezi a HTML-t: azt nézzük, MI kerül innerHTML-be. Ami ott nyers
// "<img …"-ként áll, azt egy böngésző elemként rajzolná ki — ez a hiba, amit keresünk.
// Kilépési kód: 0 = minden zöld · 1 = van bukó ellenőrzés.
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const esc = s => String(s).replace(/[&<>"']/g,
  c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// A <script> blokkok sorrendben; a CDN-ről jövő (Chart.js) kimarad, helyette csonk.
function scriptsOf(file) {
  const out = [], re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m; (m = re.exec(read(file)));) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1]);
    if (!src) out.push({name: `${file} (inline)`, code: m[2]});
    else if (!/^(https?:)?\/\//i.test(src[1])) out.push({name: src[1], code: read(src[1])});
  }
  return out;
}

class El {
  constructor(id) {
    this.id = id; this.style = {}; this.dataset = {}; this.attrs = {}; this.children = [];
    this.hidden = false; this._html = ''; this._text = ''; this.parentNode = null;
    this.classList = {add() {}, remove() {}, toggle() {}, contains: () => false};
  }
  set innerHTML(h) { this._html = String(h); this._text = this._html.replace(/<[^>]*>/g, ''); }
  get innerHTML() { return this._html; }
  set textContent(t) { this._text = String(t); this._html = esc(this._text); }
  get textContent() { return this._text; }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  insertBefore(c) { return this.appendChild(c); }
  remove() {}
  addEventListener() {}
  querySelector() { return new El(); }
  querySelectorAll() { return []; }
  getContext() { return {}; }
}

// Egy oldal betöltése: a szkriptjei lefutnak, mint a böngészőben a betöltéskor.
function page(file, opt = {}) {
  const calls = {confirm: [], fetch: [], replaceState: [], reload: 0, warn: []};
  const store = new Map(Object.entries(opt.storage || {}));
  const loc = {reload: () => { calls.reload++; }};
  const setLoc = href => {
    const u = new URL(href);
    Object.assign(loc, {href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname,
                        origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash});
  };
  setLoc(opt.url || `https://somogyif.github.io/health/${file}`);
  const els = new Map(), body = new El('body'), listeners = {};
  const byId = id => {
    if (!els.has(id)) { const e = new El(id); e.parentNode = body; els.set(id, e); }
    return els.get(id);
  };
  const document = {
    getElementById: byId, body, title: '',
    querySelector: sel => byId(`query:${sel}`),
    querySelectorAll: () => [],
    createElement: () => { const e = new El(); e.parentNode = body; return e; },
    createTextNode: t => ({textContent: String(t)}),
    addEventListener() {},
  };
  const ctx = {
    console: {log() {}, info() {}, error() {}, warn: (...a) => calls.warn.push(a.join(' '))},
    URL, URLSearchParams, setTimeout, clearTimeout, AbortSignal, Response, Headers, queueMicrotask,
    location: loc, document, navigator: {},
    history: {replaceState(s, t, u) { calls.replaceState.push(String(u)); setLoc(new URL(String(u), loc.href).href); }},
    localStorage: {getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
                   removeItem: k => store.delete(k), clear: () => store.clear()},
    confirm: msg => { calls.confirm.push(String(msg)); return typeof opt.confirm === 'function' ? opt.confirm(msg) : !!opt.confirm; },
    alert() {},
    fetch: async (u, init) => {
      calls.fetch.push({url: String(u), init: init || {}});
      return opt.fetch ? opt.fetch(String(u), init || {}) : new Promise(() => {});
    },
    Chart: class { destroy() {} },
    addEventListener: (t, f) => (listeners[t] = listeners[t] || []).push(f),
    removeEventListener() {},
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  for (const s of scriptsOf(file)) vm.runInContext(s.code, ctx, {filename: s.name});
  return {
    ctx, calls, store, loc, el: byId,
    fire: t => (listeners[t] || []).forEach(f => f({type: t})),
    run: code => vm.runInContext(code, ctx),
  };
}

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const demo = () => JSON.parse(read('demo-data.json'));
const json = obj => new Response(JSON.stringify(obj), {status: 200, headers: {'content-type': 'application/json'}});

// Minden kulcs, minden mélységben (a deepEscape kimenetének vizsgálatához).
function allKeys(v, out = []) {
  if (Array.isArray(v)) v.forEach(x => allKeys(x, out));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) { out.push(k); allKeys(v[k], out); }
  return out;
}

const HOSTILE = '<img src=x onerror=alert(1)>';
const checks = [];
const check = (name, fn) => checks.push({name, fn});
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// ── Őrszem: a render() első lépése a deepEscape (2. kemény szabály) ─────────────
for (const file of ['index.html', 'brief.html']) {
  check(`őrszem: ${file} render() első utasítása a d = deepEscape(d)`, () => {
    const m = /function render\(d\)\s*\{\s*([^;]*;)/.exec(read(file));
    must(m && /^d\s*=\s*deepEscape\(d\);$/.test(m[1].trim()), `a render() első utasítása: ${m && m[1]}`);
  });
}

// ── B2: a deepEscape a KULCSOKAT is semlegesítse ────────────────────────────────
for (const file of ['index.html', 'brief.html']) {
  check(`B2: ${file} deepEscape a kulcsokat is semlegesíti`, () => {
    const p = page(file);
    const out = p.run('deepEscape')({freshness: {[HOSTILE]: '2020-01-01 00:00'}, list: [{[HOSTILE]: 1}]});
    const raw = allKeys(out).filter(k => /[<>"']/.test(k));
    must(!raw.length, `nyers kulcs maradt: ${JSON.stringify(raw)}`);
    must(allKeys(out).includes(esc(HOSTILE)), 'a kulcs eltűnt, nem semlegesítve maradt meg');
  });
}

check('B2: index.html elavultság-sáv: ismeretlen freshness-kulcs nem lesz elem', () => {
  const p = page('index.html');
  const d = demo();
  d.freshness = {[HOSTILE]: '2020-01-01 00:00'};
  p.ctx.render(d);
  const el = p.el('staleBanner'), html = el.innerHTML;
  // előfeltétel: a sáv kirajzolódott, és benne van a próba — különben nem bizonyít semmit
  must(el.style.display === 'block' && html.includes('onerror'), `a sáv nem jelent meg: ${html.slice(0, 120)}`);
  must(!/<img\b/i.test(html), `nyers <img> a sáv innerHTML-jében: …${html.slice(html.indexOf('<b>'), html.indexOf('<b>') + 60)}…`);
  must(html.includes(esc(HOSTILE)), 'a forrás neve nem semlegesítve jelenik meg');
});

// ── B3: a hibadoboz a hibaüzenetet SZÖVEGKÉNT írja ki ───────────────────────────
// A Chrome (V8) JSON-hibaüzenete a rövid választörzset szó szerint idézi: egy nem-JSON
// válasz (<svg onload=…>) így a hibaüzeneten át jutott el az innerHTML-ig.
check('B3: index.html hibadoboz: a válasz szövege nem lesz elem', async () => {
  const body = '<svg onload=f()>';
  const p = page('index.html', {url: 'https://somogyif.github.io/health/index.html?demo=1',
                                fetch: () => new Response(body, {status: 200})});
  p.fire('DOMContentLoaded');
  await settle();
  const eb = p.el('errbox');
  // előfeltétel: a próba eljutott a dobozig (akár jelölőként, akár szövegként)
  must(eb.style.display === 'block' && (eb.innerHTML + eb.textContent).includes('svg onload'),
       `a hibadoboz nem a próbát mutatja (nem bizonyít): ${eb.innerHTML.slice(0, 160)}`);
  must(!/<svg\b/i.test(eb.innerHTML), `nyers <svg> a hibadoboz innerHTML-jében: ${eb.innerHTML.slice(0, 200)}`);
});

// ── B12: a keresők kizárása a LAPON (a /health/robots.txt hatástalan) ───────────
// A keresők csak a host gyökerében keresik a robots.txt-t (somogyif.github.io/robots.txt),
// a /health/robots.txt-t nem olvassák. A kizárás egyetlen működő módja itt a meta tag.
for (const file of ['index.html', 'brief.html']) {
  check(`B12: ${file} <head>-jében robots noindex`, () => {
    const head = (/<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(read(file)) || [])[1] || '';
    const metas = head.match(/<meta\b[^>]*>/gi) || [];
    const ok = metas.some(m => /\bname\s*=\s*["']?robots["']?/i.test(m) && /\bcontent\s*=\s*["'][^"']*\bnoindex\b/i.test(m));
    must(ok, `nincs <meta name="robots" content="noindex"> a <head>-ben (${metas.length} meta tag)`);
  });
}

// ── futtatás ────────────────────────────────────────────────────────────────────
(async () => {
  const only = process.argv[2];
  let bad = 0, ran = 0;
  for (const c of checks) {
    if (only && !c.name.includes(only)) continue;
    ran++;
    try { await c.fn(); console.log(`  ✓ ${c.name}`); }
    catch (e) { bad++; console.log(`  ✗ ${c.name}\n      ${String(e && e.stack || e).split('\n').slice(0, 3).join('\n      ')}`); }
  }
  console.log(bad ? `BUKÓ: ${bad}/${ran}` : `OK: ${ran}/${ran}`);
  process.exit(bad ? 1 : 0);
})();
