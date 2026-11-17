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
  set innerHTML(h) {
    this._html = String(h); this._text = this._html.replace(/<[^>]*>/g, '');
    if (this._recreate) this._recreate(this._html);
  }
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
  // Az innerHTML-be írt jelölő a benne lévő id-jű elemeket ÚJRA létrehozza, ahogy a
  // böngésző: a korábbi (már kitöltött) elem elvész, az új a jelölő szerinti induló
  // állapotban áll (inline display, üres tartalom). Enélkül az ál-DOM megőrizné azt,
  // amit a render() a sablon kiírása ELŐTT töltött ki — a böngésző nem őrzi meg.
  const recreate = html => {
    for (const m of html.matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/gi)) {
      const e = mk(m[1]), disp = /\bstyle="[^"]*\bdisplay:\s*([a-z-]+)/i.exec(m[0]);
      if (disp) e.style.display = disp[1];
      els.set(m[1], e);
    }
  };
  const mk = id => { const e = new El(id); e.parentNode = body; e._recreate = recreate; return e; };
  const byId = id => {
    if (!els.has(id)) els.set(id, mk(id));
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
  // opt.now (ms): a lap "mostja" — a néző órája. Csak az argumentum nélküli new Date()
  // és a Date.now() változik; a dátumszámítás (helyi időzóna) a valódi.
  if (opt.now != null) vm.runInContext(`(() => { const R = Date, NOW = ${Number(opt.now)};
    globalThis.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } };
  })()`, ctx);
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

// ── Napi terv + Feladatok: a kártyák a sablon kiírása UTÁN legyenek kitöltve ────
// A render() a #dayPlanBody / #tasksBody elemet a tab-today.innerHTML= ELŐTT töltötte ki;
// a sablon utána rejtve és üresen hozta létre őket újra — a két kártya sosem látszott.
check('napi terv: a demó adattal a Day plan és a Tasks kártya látszik, és nem üres', () => {
  const d = demo();
  must(d.day_plan && d.tasks, 'a demó adatban nincs day_plan / tasks (nem bizonyít)');
  const p = page('index.html', {now: at(2026, 3, 17, 22)});   // a néző órája a demó sync-napján (2026-03-17) áll
  p.ctx.render(d);
  // előfeltétel: a sablon kiíródott, és benne van a két (induláskor rejtett) szakasz
  must(/id="dayPlanSection"/.test(p.el('tab-today').innerHTML) && /id="tasksSection"/.test(p.el('tab-today').innerHTML),
       'a tab-today sablonban nincs meg a két szakasz (nem bizonyít)');
  for (const [sec, body, szo] of [['dayPlanSection', 'dayPlanBody', 'Clear day — good for deep work'],
                                  ['tasksSection', 'tasksBody', '19 open tasks']]) {
    must(p.el(sec).style.display !== 'none', `${sec} rejtve maradt (display=${p.el(sec).style.display})`);
    must(p.el(body).textContent.includes(szo), `${body} nem a demó tartalmát mutatja: "${p.el(body).textContent.replace(/\s+/g, ' ').slice(0, 80)}"`);
  }
  must(p.el('dayPlanLabel').textContent.includes('Tomorrow'), `a címke nem az esti kontextusé: ${p.el('dayPlanLabel').textContent}`);
});
check('napi terv: day_plan / tasks nélkül a két szakasz rejtve marad', () => {
  const d = demo(); delete d.day_plan; delete d.tasks;
  const p = page('index.html');
  p.ctx.render(d);
  must(p.el('dayPlanSection').style.display === 'none' && p.el('tasksSection').style.display === 'none',
       `üres adatnál is látszik: ${p.el('dayPlanSection').style.display} / ${p.el('tasksSection').style.display}`);
});
check('napi terv: ellenséges szöveg a tervben és a feladatokban nem lesz elem (2. szabály)', () => {
  const d = demo();
  d.day_plan.tomorrow.lines = [HOSTILE];
  d.day_plan.today.tasks = [{name: HOSTILE}];
  d.tasks.tomorrow = {tasks: [{name: HOSTILE, project: HOSTILE}], count: 1, score: 1, label: 'Light'};
  const p = page('index.html');
  p.ctx.render(d);
  for (const body of ['dayPlanBody', 'tasksBody']) {
    const html = p.el(body).innerHTML;
    must(html.includes('onerror'), `${body}: a próba nem jelent meg (nem bizonyít)`);
    must(!/<img\b/i.test(html), `${body}: nyers <img> az innerHTML-ben`);
  }
});

// ── Napi terv: az ismeretlen terhelés-címke NEM kaphat zöld "Clear" stílust ─────
// A sync "Unknown"-t küld, ha a feladatlistát nem tudta beolvasni. A jelvény stílusa
// styles[l] || styles.Clear volt: az "Unknown" zölden, "minden rendben" színnel jelent meg.
const badgeOf = (html, label) => {
  const m = new RegExp(`<span style="([^"]*border-radius:20px[^"]*)">${label}</span>`).exec(html);
  return m && m[1];
};
const GREEN = /#E1F5EE|#0F6E56/i;
check('napi terv: az "Unknown" és az ismeretlen címke semleges jelvényt kap, nem zöldet', () => {
  for (const label of ['Unknown', 'Valami-uj-cimke', 'constructor']) {
    const d = demo();
    d.day_plan.today.label = label;
    const p = page('index.html');
    p.ctx.render(d);
    const st = badgeOf(p.el('dayPlanBody').innerHTML, label);
    must(st, `a(z) "${label}" jelvény nem jelent meg (nem bizonyít)`);
    must(!GREEN.test(st), `a(z) "${label}" címke zöld "Clear" stílust kapott: ${st}`);
    must(/background:var\(--s2\)/.test(st) && /color:var\(--text2\)/.test(st), `a(z) "${label}" jelvénye nem a semleges stílus: ${st}`);
  }
});
check('napi terv: az ismert címkék stílusa változatlan (Clear zöld, Heavy sárga, Packed piros)', () => {
  for (const [label, re] of [['Clear', GREEN], ['Light', GREEN], ['Moderate', /#FAEEDA/], ['Heavy', /#FAEEDA/], ['Packed', /#FCEBEB/]]) {
    const d = demo();
    d.day_plan.today.label = label; d.day_plan.tomorrow.label = label;
    const p = page('index.html');
    p.ctx.render(d);
    const st = badgeOf(p.el('dayPlanBody').innerHTML, label);
    must(st && re.test(st), `${label}: ${st}`);
  }
});

// ── Napi terv: hiányzó címke → semleges "—", nem kitalált zöld "Clear" ──────────
check('napi terv: hiányzó label → semleges "—" jelvény; a valódi "Clear" zöld marad', () => {
  for (const hiany of [undefined, null, '']) {
    const d = demo();
    if (hiany === undefined) delete d.day_plan.today.label; else d.day_plan.today.label = hiany;
    const p = page('index.html');
    p.ctx.render(d);
    const html = p.el('dayPlanBody').innerHTML;
    const st = badgeOf(html, '—');
    must(st, `label=${JSON.stringify(hiany)}: nincs "—" jelvény (a jelvények: ${JSON.stringify(html.match(/border-radius:20px[^>]*>[^<]*/g))})`);
    must(!GREEN.test(st) && /background:var\(--s2\)/.test(st), `label=${JSON.stringify(hiany)}: a "—" jelvény nem semleges: ${st}`);
    // a holnapi blokk címkéje a demóban valódi "Clear": az zöld marad, és csak egy van belőle
    must(GREEN.test(badgeOf(html, 'Clear') || ''), 'a valódi "Clear" jelvény eltűnt vagy nem zöld');
    must((html.match(/>Clear<\/span>/g) || []).length === 1, 'a hiányzó címke helyén is "Clear" áll');
  }
});

// ── Napi terv: a terv NAPJA a dokumentumból jön, nem a böngésző mai napjából ────
// A sync a day_plan-t és a synced_at-et ugyanabból a pillanatból írja; a kártya mégis
// new Date()-et rajzolt — régi adatnál a mai dátum állt egy korábbi nap terve fölött.
const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();   // a néző helyi ideje
const planView = (now, mut) => {
  const d = demo(); mut(d);
  const p = page('index.html', {now});
  p.ctx.render(d);
  return {text: p.el('dayPlanBody').textContent.replace(/\s+/g, ' '), head: p.el('dayPlanLabel').textContent};
};
const syncAt = (stampStr, context) => d => { d.synced_at = stampStr; d.day_plan.context = context; };
check('napi terv: a dátum a synced_at napja; ugyanazon a napon nézve Today/Tonight/Tomorrow', () => {
  // a demó synced_at-je 2026-03-17; a néző órája ugyanaz a nap
  const este = planView(at(2026, 3, 17, 22), () => {});
  must(este.text.includes('Tomorrow · 18 Mar') && este.text.includes('Tonight · 17 Mar'), `esti terv: ${este.text.slice(0, 120)}`);
  must(este.head === "📋 Tomorrow's plan", `esti fejléc: ${este.head}`);
  const reggel = planView(at(2026, 3, 17, 8), d => { d.day_plan.context = 'morning'; });
  must(reggel.text.includes('Today · 17 Mar') && reggel.text.includes('Tomorrow · 18 Mar'), `reggeli terv: ${reggel.text.slice(0, 120)}`);
  must(reggel.head === "📋 Today's plan", `reggeli fejléc: ${reggel.head}`);
  const honapveg = planView(at(2026, 1, 31, 22), syncAt('2026-01-31 21:30', 'evening'));
  must(honapveg.text.includes('Tomorrow · 1 Feb') && honapveg.text.includes('Tonight · 31 Jan'), `hónapvég: ${honapveg.text.slice(0, 120)}`);
});
// F1: a napszó a NÉZŐ mai napjához igazodik. A sync 07:00-kor és 12:00-kor fut: éjfél és
// reggel 7 között (és 24 óránál fiatalabb régi adatnál, sáv nélkül) "Today · 14 Nov" állt 15-én.
check('napi terv F1: esti terv éjfél után nézve → a holnapi blokk "Today", a tegnapi "Yesterday"', () => {
  const v = planView(at(2026, 11, 15, 6, 30), syncAt('2026-11-14 21:30', 'evening'));
  must(v.text.includes('Today · 15 Nov') && v.text.includes('Yesterday · 14 Nov'), `a kártya: ${v.text.slice(0, 140)}`);
  must(!/Tomorrow|Tonight/.test(v.text), `hamis napszó maradt: ${v.text.slice(0, 140)}`);
  must(v.head === "📋 Today's plan", `fejléc: ${v.head}`);
});
check('napi terv F1: reggeli (és délutáni) terv másnap reggel nézve → "Yesterday" + "Today"', () => {
  for (const ctx of ['morning', 'afternoon']) {
    const v = planView(at(2026, 11, 15, 6, 30), syncAt('2026-11-14 12:00', ctx));
    must(v.text.includes('Yesterday · 14 Nov') && v.text.includes('Today · 15 Nov'), `${ctx}: ${v.text.slice(0, 140)}`);
    must(!/Tomorrow|Tonight|Today · 14/.test(v.text), `${ctx}: hamis napszó: ${v.text.slice(0, 140)}`);
    must(v.head === "📋 Yesterday's plan", `${ctx} fejléc: ${v.head}`);
  }
});
check('napi terv F1: hónapvégi esti terv éjfél után; régi terv → "Plan from"; előrébb járó sync → "Tomorrow"', () => {
  const hv = planView(at(2026, 12, 1, 0, 30), syncAt('2026-11-30 21:30', 'evening'));
  must(hv.text.includes('Today · 1 Dec') && hv.text.includes('Yesterday · 30 Nov') && hv.head === "📋 Today's plan",
       `hónapvég: ${hv.head} / ${hv.text.slice(0, 140)}`);
  const regi = planView(at(2026, 11, 15, 9), syncAt('2026-11-10 07:00', 'morning'));
  must(regi.text.includes('Plan from 10 Nov') && regi.text.includes('Plan from 11 Nov') && !/Today|Tomorrow|Tonight|Yesterday/.test(regi.text),
       `régi terv: ${regi.text.slice(0, 140)}`);
  must(regi.head === '📋 Plan from 10 Nov', `régi fejléc: ${regi.head}`);
  // a néző órája a sync mögött jár (pl. más időzóna): a terv napja a néző holnapja
  const elol = planView(at(2026, 11, 14, 23), syncAt('2026-11-15 07:00', 'morning'));
  must(elol.text.includes('Tomorrow · 15 Nov') && elol.text.includes('Plan from 16 Nov') && elol.head === "📋 Tomorrow's plan",
       `előrébb járó sync: ${elol.head} / ${elol.text.slice(0, 140)}`);
});
check('napi terv: synced_at nélkül (vagy hibás dátummal) nincs kitalált dátum', () => {
  for (const mut of [d => { delete d.synced_at; }, d => { d.synced_at = 'nem dátum'; }, d => { d.synced_at = '2026-13-45 07:00'; }]) {
    const v = planView(at(2026, 11, 15, 6, 30), mut);
    must(v.text.includes('Tomorrow') && v.text.includes('Tonight'), `a terv nem rajzolódott ki (nem bizonyít): ${v.text.slice(0, 80)}`);
    must(!/(Tomorrow|Tonight|Today|Yesterday) · /.test(v.text) && !/Plan from/.test(v.text + v.head),
         `dátum áll a címben, pedig a dokumentumban nincs: ${v.head} / ${v.text.slice(0, 120)}`);
  }
});

// ── Napi terv + Tasks: a két szakaszcím és az ikonok (most látszanak először) ───
// A sec-label osztálynak nem volt CSS-e (a cím stílus nélkül, a többi szakaszcímtől
// eltérően jelent meg), a `ti ti-…` ikonokhoz pedig egyik lap sem tölt be ikon-betűkészletet
// (üres hely a szöveg előtt). Új külső forrást nem veszünk fel: emoji, mint a lap többi részén.
const cssRule = sel => {
  const css = (/<style\b[^>]*>([\s\S]*?)<\/style>/i.exec(read('index.html')) || [])[1] || '';
  const m = new RegExp(`(?:^|[}\\s])${sel.replace(/[.:#,]/g, '\\$&')}\\{([^}]*)\\}`).exec(css);
  return m ? m[1].split(';').map(x => x.trim()).filter(Boolean) : null;
};
check('napi terv: a .sec-label szakaszcím ugyanazt a stílust kapja, mint a többi szakaszcím (CSS)', () => {
  const head = cssRule('.sec-head'), title = cssRule('.sec-title'), line = cssRule('.sec-line');
  must(head && title && line, 'a mérce (.sec-head/.sec-title/.sec-line) nincs meg (nem bizonyít)');
  const label = cssRule('.sec-label'), after = cssRule('.sec-label::after');
  must(label, 'nincs .sec-label CSS-szabály — a két szakaszcím stílus nélküli');
  const hiany = [...head, ...title].filter(x => !label.includes(x));
  must(!hiany.length, `a .sec-label-ből hiányzik: ${hiany.join('; ')}`);
  must(after && line.every(x => after.includes(x)) && after.some(x => /^content:/.test(x)),
       `a .sec-label::after nem rajzolja meg a vonalat: ${after}`);
  // a jelölő nem változott: a két cím továbbra is sec-label
  must(/class="sec-label" id="dayPlanLabel"/.test(read('index.html')), 'a dayPlanLabel már nem sec-label');
});
check('napi terv: nincs betöltetlen ikon-betűkészletre mutató ikon; emoji van helyette; nincs új külső forrás', () => {
  const src = read('index.html');
  must(!/class="ti\b/.test(src), 'az index.html-ben még van `ti ti-…` ikon (a betűkészlet nincs betöltve)');
  const hosts = [...new Set([...src.matchAll(/(?:src|href)=["']https?:\/\/([^\/"']+)/g)].map(m => m[1]))].sort();
  must(hosts.join(',') === 'cdnjs.cloudflare.com,fonts.googleapis.com', `a külső források megváltoztak: ${hosts}`);
  const d = demo();
  Object.assign(d.day_plan.today, {work_shifts: 2, has_gym: true, task_count: 2,
                                   tasks: [{name: 'Call the bank'}, {name: 'Send review'}, {name: 'Prep interview'}, {name: 'Water plants'}]});
  const p = page('index.html');
  p.ctx.render(d);
  const html = p.el('dayPlanBody').innerHTML;
  must(html.includes('Work shifts ×2') && html.includes('Call the bank'), 'a pillek nem jelentek meg (nem bizonyít)');
  must(!/<i\b/.test(html), 'a kirajzolt tervben még <i> ikon-elem van');
  for (const e of ['☕', '🏋', '📞', '✉', '💼', '✓', '🌙', '⏱'])
    must(html.includes(e), `hiányzik az ikon: ${e}`);
});

// ── Tasks kártya: az ismeretlen címke itt sem lehet zöld ────────────────────────
// scoreColor: minden, ami nem Packed/Heavy/Moderate, var(--teal) volt — az "Unknown" is.
const taskLabelColor = (html, label) => {
  const m = new RegExp(`<span style="[^"]*color:([^;"]+)[^"]*">${label}</span>`).exec(html);
  return m && m[1];
};
const withTaskLabel = label => {
  const d = demo();
  d.tasks.today = {tasks: [{name: 'Demo task'}], count: 1, score: 1, label};
  const p = page('index.html');
  p.ctx.render(d);
  return taskLabelColor(p.el('tasksBody').innerHTML, label);
};
check('tasks: az "Unknown" és az ismeretlen címke semleges színű, nem zöld', () => {
  for (const label of ['Unknown', 'Valami-uj-cimke', 'constructor']) {
    const c = withTaskLabel(label);
    must(c, `a(z) "${label}" címke nem jelent meg (nem bizonyít)`);
    must(c !== 'var(--teal)', `a(z) "${label}" címke zöld (var(--teal))`);
    must(c === 'var(--text3)', `a(z) "${label}" címke színe nem a semleges: ${c}`);
  }
});
check('tasks: az ismert címkék színe változatlan (Clear/Light zöld, Moderate/Heavy sárga, Packed piros)', () => {
  for (const [label, want] of [['Clear', 'var(--teal)'], ['Light', 'var(--teal)'], ['Moderate', 'var(--amber)'],
                               ['Heavy', 'var(--amber)'], ['Packed', 'var(--red)']]) {
    const c = withTaskLabel(label);
    must(c === want, `${label}: ${c} (várt: ${want})`);
  }
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

// ── B9: az elavultság a MOSTANI időhöz mérve, mindkét lapon ─────────────────────
// Egy teljesen leállt pipeline-ban a synced_at és minden freshness-bélyeg egyformán
// régi: a synced_at-hez mérve semmi nem "régebbi", tehát nem volt figyelmeztetés.
const API = 'https://api.example.test';                                   // kitalált végpont
const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // kitalált kulcs
const PAIRED = {health_api: API, health_key: KEY};
const DAY = 86400000;
const stamp = ms => { const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
// ±1 óra (nyári időszámítás) se vigye át a napszámot: x.5 napos bélyegek
function aged(days, extra = {}) {
  const d = demo(), t = stamp(Date.now() - days * DAY);
  delete d._demo;
  d.synced_at = t;
  d.freshness = {garmin: t, hevy: t, calendar: t, weather: t, body_comp: t, ...extra};
  return d;
}
async function indexWith(payload) {
  const p = page('index.html', {storage: PAIRED, fetch: () => json(payload)});
  p.fire('DOMContentLoaded');
  await settle();
  return p;
}
async function briefWith(payload) {
  const p = page('brief.html', {storage: PAIRED, fetch: () => json(payload)});
  await settle();
  return p;
}

check('B9: index.html leállt pipeline (minden bélyeg 5,5 napos) → piros sáv, 5d', async () => {
  const p = await indexWith(aged(5.5));
  must(p.calls.fetch.length && p.calls.fetch[0].url === `${API}/data`, 'a privát végpontot nem kérdezte le');
  const el = p.el('staleBanner'), html = el.innerHTML;
  must(el.style.display === 'block', `nincs figyelmeztetés (display=${el.style.display})`);
  must(html.includes('(5d)') && html.includes('var(--red)'), `nem 5 napos/piros: ${html.replace(/\s+/g, ' ').slice(0, 200)}`);
});
check('B9: index.html a küszöbök maradnak: 2,5 nap → sárga 2d · 20 óra → nincs sáv', async () => {
  const a = await indexWith(aged(2.5)), h = a.el('staleBanner').innerHTML;
  must(a.el('staleBanner').style.display === 'block' && h.includes('(2d)') && h.includes('var(--amber)') && !h.includes('var(--red)'),
       `2,5 napnál nem sárga 2d: ${h.replace(/\s+/g, ' ').slice(0, 200)}`);
  const f = await indexWith(aged(20 / 24));
  must(f.el('staleBanner').style.display === 'none', '20 órás adatnál is figyelmeztet');
});
check('B9: brief.html leállt pipeline → figyelmeztetés, 5d', async () => {
  const html = (await briefWith(aged(5.5))).el('root').innerHTML;
  must(/older data/i.test(html) && html.includes('(5d)'), `a brief nem figyelmeztet: ${html.replace(/\s+/g, ' ').slice(0, 160)}`);
});
check('B9: brief.html friss adat (1 óra) → nincs figyelmeztetés', async () => {
  const html = (await briefWith(aged(1 / 24))).el('root').innerHTML;
  must(html.includes('Readiness') && !/older data/i.test(html), 'friss adatnál is figyelmeztet, vagy nem rajzolt');
});
check('B9+B2: brief.html ismeretlen freshness-kulcs a figyelmeztetésben sem lesz elem', async () => {
  const html = (await briefWith(aged(1 / 24, {[HOSTILE]: stamp(Date.now() - 5.5 * DAY)}))).el('root').innerHTML;
  must(/older data/i.test(html) && html.includes('onerror'), 'a próba nem jelent meg (nem bizonyít)');
  must(!/<img\b/i.test(html), 'nyers <img> a brief figyelmeztetésében');
});

// ── B1+B6: a párosító link (api + kulcs) őrzött átvétele, mindkét lapon ─────────
// A kulcs csak a # utáni részből jöhet (a fragment nem megy el a szerverre); csak
// https végpont; idegen (vagy első) végpont csak kifejezett megerősítéssel.
const BASE = 'https://somogyif.github.io/health/';
const EVIL = 'https://evil.example';
const KEY2 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';  // kitalált
const PAGES = ['index.html', 'brief.html'];
const link = (file, api, key, form) => form === 'query'
  ? `${BASE}${file}?api=${encodeURIComponent(api)}&key=${encodeURIComponent(key)}`
  : `${BASE}${file}#api=${encodeURIComponent(api)}&key=${encodeURIComponent(key)}`;
const saved = p => ({api: p.store.get('health_api') || null, key: p.store.get('health_key') || null});

for (const file of PAGES) {
  for (const form of ['query', 'hash']) {
    check(`B1: ${file} (${form}) párosított böngészőben idegen végpontra csak megerősítéssel`, () => {
      const p = page(file, {url: link(file, EVIL, KEY2, form), storage: PAIRED, confirm: false});
      const s = saved(p);
      must(s.api === API && s.key === KEY, `átírta megerősítés nélkül: ${JSON.stringify(s)}`);
    });
    check(`B1: ${file} (${form}) friss böngészőben sem fogad el végpontot megerősítés nélkül`, () => {
      const p = page(file, {url: link(file, EVIL, KEY2, form), confirm: false});
      must(!saved(p).api && !saved(p).key, `elmentette kérdezés nélkül: ${JSON.stringify(saved(p))}`);
    });
    check(`B1: ${file} (${form}) csak https végpont — megerősítéssel sem más`, () => {
      for (const bad of ['http://evil.example', 'data:application/json,{}#', 'javascript:alert(1)',
                         'https://user:pw@evil.example', 'nem egy url']) {
        const p = page(file, {url: link(file, bad, KEY2, form), confirm: true});
        must(!saved(p).api, `elfogadta: ${bad} → ${saved(p).api}`);
      }
    });
    check(`B6: ${file} (${form}) a kulcs nem marad a címsorban`, () => {
      const p = page(file, {url: link(file, API, KEY2, form) , confirm: true});
      must(!p.loc.href.includes(KEY2) && !/[?#&]key=/.test(p.loc.href), `a címsor: ${p.loc.href}`);
    });
  }
  check(`B1: ${file} előtag-egyezés nem "ugyanaz a végpont" (…workers.dev ↔ …work)`, () => {
    // kitalált hostpár (a valódi Worker-host nem kerülhet a publikus repóba)
    const stored = {health_api: 'https://health-data.example.workers.dev', health_key: KEY};
    const p = page(file, {url: link(file, 'https://health-data.example.work', KEY2, 'hash'), storage: stored, confirm: false});
    must(saved(p).api === stored.health_api, `átírta: ${saved(p).api}`);
    must(p.calls.confirm.length === 1, `nem kérdezett (${p.calls.confirm.length} megerősítés)`);
  });
  check(`B6: ${file} a kulcsot a query stringből NEM veszi át (megerősítéssel sem)`, () => {
    const p = page(file, {url: link(file, API, KEY2, 'query'), confirm: true});
    must(!saved(p).key, `a query-ből vett kulcs mentve: ${saved(p).key}`);
    must(p.el('pairNote').textContent.includes('#api='), 'nem mondja meg, hogyan kell helyesen (#api=…)');
  });
  check(`B6: ${file} párosítás a # utáni részből: megerősítés a host nevével, mentés, ?demo=1 marad`, () => {
    const p = page(file, {url: link(file, API + '/', KEY2, 'hash').replace(file, `${file}?demo=1`), confirm: true});
    must(saved(p).api === API && saved(p).key === KEY2, `nem párosított: ${JSON.stringify(saved(p))}`);
    must(p.calls.confirm.length === 1 && p.calls.confirm[0].includes('api.example.test'), `a megerősítés: ${p.calls.confirm}`);
    must(p.loc.search === '?demo=1' && !p.loc.hash, `a címsor: ${p.loc.href}`);
    must(p.el('pairNote').textContent.includes('api.example.test'), 'nincs visszajelzés a párosításról');
  });
  // A host kitalálható: ha a kulcscsere kérdés nélkül menne, egy link csendben
  // elronthatná a működő párosítást. Ezért minden VÁLTOZÁS megerősítést kér.
  check(`B1: ${file} kulcscsere ugyanarra a végpontra is csak megerősítéssel (nem-re a régi marad)`, () => {
    const no = page(file, {url: link(file, API, KEY2, 'hash'), storage: PAIRED, confirm: false});
    must(saved(no).api === API && saved(no).key === KEY && no.calls.confirm.length === 1 &&
         no.calls.confirm[0].includes('api.example.test'), `nem-re: ${JSON.stringify(saved(no))}, ${no.calls.confirm}`);
    const yes = page(file, {url: link(file, API, KEY2, 'hash'), storage: PAIRED, confirm: true});
    must(saved(yes).key === KEY2, `igen-re nem cserélt: ${JSON.stringify(saved(yes))}`);
  });
  check(`B1: ${file} ugyanaz a link újra (azonos végpont és kulcs): nincs kérdés, nincs változás`, () => {
    const p = page(file, {url: link(file, API, KEY, 'hash'), storage: PAIRED, confirm: false});
    must(saved(p).api === API && saved(p).key === KEY && !p.calls.confirm.length && !p.loc.hash,
         `${JSON.stringify(saved(p))}, ${p.calls.confirm.length} megerősítés, ${p.loc.href}`);
  });
  check(`B1: ${file} hibás kulcsot (szóköz, vezérlőjel) nem ment`, () => {
    for (const k of ['abc def', 'abc\ndef', '']) {
      const p = page(file, {url: link(file, API, k, 'hash'), confirm: true});
      must(!saved(p).key, `elfogadta: ${JSON.stringify(k)}`);
    }
  });
  check(`B1: ${file} a korábban tárolt nem-https végpontot nem használja`, async () => {
    const p = page(file, {storage: {health_api: 'data:application/json,{}#', health_key: KEY}});
    p.fire('DOMContentLoaded');
    await settle();
    const off = p.calls.fetch.map(f => f.url).filter(u => /^[a-z]+:/i.test(u) && !u.startsWith('https://'));
    must(!off.length, `lekérte: ${off}`);
  });
  check(`B1: ${file} egy már nyitott lapon a # módosítása újratölt (a link feldolgozódjon)`, () => {
    const p = page(file, {storage: PAIRED});
    p.loc.hash = `#api=${encodeURIComponent(API)}&key=${KEY2}`;
    p.fire('hashchange');
    must(p.calls.reload === 1, `újratöltés: ${p.calls.reload}`);
  });
  check(`B1: ${file} a meglévő párosítás változatlanul működik (lekérés Bearer-kulccsal)`, async () => {
    const p = page(file, {storage: PAIRED, fetch: () => json(aged(1 / 24))});
    p.fire('DOMContentLoaded');
    await settle();
    const f = p.calls.fetch.find(x => x.url === `${API}/data`);
    must(f && (f.init.headers || {}).Authorization === `Bearer ${KEY}`, `lekérések: ${JSON.stringify(p.calls.fetch.map(x => x.url))}`);
  });
}
check('B1: egyetlen író — a lapok maguk nem írják a localStorage-t, mindkettő a pairing.js-t tölti', () => {
  for (const file of PAGES) {
    const html = read(file);
    must(!/localStorage\.setItem\s*\(/.test(html), `${file}: saját localStorage.setItem`);
    must(/<script\s+src=["']pairing\.js["']\s*><\/script>/.test(html), `${file}: nincs <script src="pairing.js">`);
  }
});

// ── F2: a két kártya hibája nem viheti magával a lap többi részét ───────────────
// A kitöltés a render() közepén fut (a sablon után): egy null tétel a feladatok között
// kivételt dobott, és elmaradt az elavultság-sáv, a Training és a Trends fül is.
const restRendered = (p, hol) => {
  must(p.el('staleBanner').style.display === 'block', `${hol}: az elavultság-sáv nem jelent meg`);
  for (const tab of ['tab-training', 'tab-trends'])
    must(p.el(tab).innerHTML.length > 200, `${hol}: a(z) ${tab} üres maradt`);
};
const renderOf = d => {
  const p = page('index.html');
  let err = null;
  try { p.ctx.render(d); } catch (e) { err = e; }
  return {p, err};
};
check('F2: null és nem-objektum tétel a feladatok között → kimarad, a többi és a lap megmarad', () => {
  for (const [hol, mut] of [
    ['day_plan.today.tasks', d => { d.day_plan.today.tasks = [null, 'szöveg', 7, {name: 'Call the bank'}]; }],
    ['day_plan.tomorrow.tasks', d => { d.day_plan.tomorrow.tasks = [null, {name: 'Call the bank'}]; }],
    ['tasks.today.tasks', d => { d.tasks.today = {tasks: [null, 'szöveg', {name: 'Call the bank'}], count: 1, score: 1, label: 'Light'}; }],
    ['tasks.tomorrow.tasks', d => { d.tasks.tomorrow = {tasks: [null, {name: 'Call the bank'}], count: 1, score: 1, label: 'Light'}; }],
    ['tasks.overdue.tasks', d => { d.tasks.overdue = {tasks: [null, {name: 'Call the bank', overdue: true}], count: 1}; }],
    ['tasks.tomorrow.tasks nem tömb', d => { d.tasks.tomorrow = {tasks: 5, count: 1, label: 'Light'}; }],
  ]) {
    const d = aged(5.5); mut(d);
    const {p, err} = renderOf(d);
    must(!err, `${hol}: a render() kivételt dobott: ${err && err.message}`);
    restRendered(p, hol);
    must(p.el('dayPlanSection').style.display !== 'none' && p.el('tasksSection').style.display !== 'none', `${hol}: egy kártya eltűnt`);
    if (!/nem tömb/.test(hol))
      must((p.el('dayPlanBody').textContent + p.el('tasksBody').textContent).includes('Call the bank'), `${hol}: a jó tétel is eltűnt`);
    must(!/undefined|null/.test(p.el('dayPlanBody').textContent + p.el('tasksBody').textContent), `${hol}: "undefined"/"null" a kártyán`);
  }
});
check('F2: ha egy kártya kitöltése mégis elhasal, csak az a szakasz tűnik el — és kiírja, miért', () => {
  const d = aged(5.5);
  d.day_plan.today.lines = 5;                     // (5).filter → TypeError a renderDayPlan-ben
  const {p, err} = renderOf(d);
  must(!err, `a render() kivételt dobott: ${err && err.message}`);
  must(p.el('dayPlanSection').style.display === 'none', 'a hibás Day plan szakasz nem lett elrejtve');
  must(p.el('tasksSection').style.display !== 'none' && p.el('tasksBody').textContent.includes('19 open tasks'), 'a Tasks kártya is eltűnt');
  restRendered(p, 'hibás day_plan');
  must(p.calls.warn.some(w => /day plan/i.test(w)), `a hiba nincs kiírva (console.warn): ${JSON.stringify(p.calls.warn)}`);
  // a Tasks kitöltése ugyanígy védett (a forrásban: mindkét kitöltés try { … } catch-ben áll)
  const src = read('index.html');
  for (const call of ['dpEl.innerHTML = renderDayPlan(dayPlan);', 'tasksEl.innerHTML = renderTasks(tasks);']) {
    const i = src.indexOf(call), elotte = src.slice(Math.max(0, i - 900), i), utana = src.slice(i, i + 400);
    must(i > 0 && /try\s*\{[^}]*$/.test(elotte) && /\}\s*catch\s*\(/.test(utana), `nincs try/catch körülötte: ${call}`);
  }
});

// ── F3: hosszú, törhetetlen szó (e-mail-cím) ne lógjon ki 375 px-en ─────────────
// A tényleges mérés böngészőben történik (scrollWidth 375 px-es keretben: 397 → 375);
// itt azt rögzítjük, ami a törést lehetővé teszi (10. szabály: Safari Mobile).
check('F3: a két kártya törzse bárhol törhet (overflow-wrap:anywhere), a feladatnév zsugorodhat (min-width:0)', () => {
  const rule = cssRule('#dayPlanBody,#tasksBody');
  must(rule && rule.includes('overflow-wrap:anywhere'), `nincs #dayPlanBody,#tasksBody{overflow-wrap:anywhere}: ${rule}`);
  const d = demo(), nev = 'Email kristofer.johannessen@nordiskakonsulter.se re contract';
  d.tasks.today = {tasks: [{name: nev, project: 'Admin'}], count: 1, score: 1, label: 'Light'};
  const p = page('index.html');
  p.ctx.render(d);
  const m = new RegExp(`<span style="([^"]*)">${nev}</span>`).exec(p.el('tasksBody').innerHTML);
  must(m, 'a feladat neve nem jelent meg (nem bizonyít)');
  must(/(^|;)min-width:0(;|$)/.test(m[1]), `a feladatnév elemén nincs min-width:0: ${m[1]}`);
});

// ── A két kártya csak LÉTEZŐ CSS-változót használjon ───────────────────────────
// A --card2, --card, --text1 az index.html-ben nincs definiálva: a "semleges" jelvény
// háttér nélküli szürke szöveg volt, nem szürke pirula (és a dobozoknak sem volt háttere).
check('napi terv + tasks: a kártyák minden var(--…) változója definiálva van a :root-ban', () => {
  const root = (/:root\s*\{([^}]*)\}/.exec(read('index.html')) || [])[1] || '';
  const defined = new Set([...root.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
  must(defined.has('--s2') && defined.has('--text2'), 'a :root változói nem olvashatók (nem bizonyít)');
  const d = demo();
  Object.assign(d.day_plan.today, {label: 'Unknown', work_shifts: 2, has_gym: true,
                                   tasks: [{name: 'Send review'}, {name: 'Call the bank'}, {name: 'Prep interview'}, {name: 'Water plants'}]});
  d.tasks.today = {tasks: [{name: 'Call the bank', project: 'Admin'}], count: 1, score: 1, label: 'Unknown'};
  d.tasks.overdue = {tasks: [{name: 'Old one', overdue: true}], count: 1};
  const p = page('index.html');
  p.ctx.render(d);
  const html = p.el('dayPlanBody').innerHTML + p.el('tasksBody').innerHTML;
  const used = [...new Set([...html.matchAll(/var\((--[a-z0-9-]+)\)/g)].map(m => m[1]))];
  must(used.length >= 4, `túl kevés változó a kártyákon (nem bizonyít): ${used}`);
  const undef = used.filter(v => !defined.has(v));
  must(!undef.length, `nem definiált CSS-változó a kártyákon: ${undef.join(', ')}`);
});

// ── (d) A TELJES forrás csak létező CSS-változót használjon ────────────────────
// A fenti ellenőrzés csak a két kártya kirajzolt HTML-jét nézi. A `var(--mono)` 27 helyen
// állt az index.html-ben (parfüm-, edzés-, Spotify-, gauge-feliratok), definíció nélkül:
// a font-family érvénytelen volt, a címkék az örökölt betűvel jelentek meg. A név: --m.
for (const file of ['index.html', 'brief.html']) {
  check(`CSS (d): ${file} minden var(--…) változója definiálva van a :root-ban (a teljes forrásban)`, () => {
    const src = read(file);
    const defined = new Set([...src.matchAll(/:root\s*\{([^}]*)\}/g)]
      .flatMap(r => [...r[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1])));
    must(defined.has('--m') && defined.size >= 8, `a :root változói nem olvashatók (nem bizonyít): ${[...defined]}`);
    const used = [...src.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map(m => m[1]);
    must(used.length >= 20, `túl kevés var(--…) a forrásban (nem bizonyít): ${used.length}`);
    const undef = {};
    for (const v of used) if (!defined.has(v)) undef[v] = (undef[v] || 0) + 1;
    must(!Object.keys(undef).length,
         `nem definiált CSS-változó: ${Object.entries(undef).map(([k, n]) => `${k} (${n}×)`).join(', ')}`);
  });
}

// ── (a) Naptár: a 7 napos szűrés ugyanabból a mezőből megy, mint a csoportosítás ──
// A csoportkulcs a `start_date` (helyi nap), a szűrő viszont a `start`-ból számolt: az
// iCal-úton az nyers UTC, tehát a 8. nap 00:30-as (helyi) eseménye UTC szerint még a 7.
// napra esett → átment, és 8. nap-fejléc lett belőle. Hiányzó `start`-nál a kivétel
// elnyelődött, és az esemény szűrés nélkül került be (akármilyen távoli).
const calView = (now, events) => {
  const d = demo();
  d.calendar = events;
  const p = page('index.html', {now});
  p.ctx.render(d);
  const html = p.el('calBody').innerHTML;
  return {html, text: p.el('calBody').textContent.replace(/\s+/g, ' '),
          days: [...html.matchAll(/text-transform:uppercase;margin-bottom:\.5rem;display:flex[^>]*>(\d{4}-\d{2}-\d{2})/g)].map(m => m[1])};
};
const week = () => [15, 16, 17, 18, 19, 20, 21].map(n => (
  {title: `Nap${n}`, start: `2026-11-${n}T09:00:00+01:00`, start_date: `2026-11-${n}`, time: '09:00', category: 'work'}));
check('naptár (a): UTC-s start + helyi 8. napi start_date → nincs 8. nap', () => {
  const v = calView(at(2026, 11, 15, 10), [...week(),
    {title: 'Late', start: '2026-11-21T23:30:00Z', start_date: '2026-11-22', time: '00:30', category: 'social'}]);
  must(v.text.includes('Nap15') && v.text.includes('Nap21'), `a hét nem rajzolódott ki (nem bizonyít): ${v.text.slice(0, 120)}`);
  must(!v.text.includes('2026-11-22') && !v.text.includes('Late'), `8. nap a listában: ${JSON.stringify(v.days)}`);
  must(v.days.length === 7, `a napfejlécek száma ${v.days.length}, nem 7: ${JSON.stringify(v.days)}`);
});
check('naptár (a): hiányzó / hibás start mellett a távoli esemény nem csúszik be', () => {
  for (const start of [undefined, 12345, null, '', 'nem dátum']) {
    const far = {title: 'Far', start_date: '2027-01-10', time: '10:00', category: 'other'};
    if (start !== undefined) far.start = start;
    const v = calView(at(2026, 11, 15, 10), [...week(), far]);
    must(v.text.includes('Nap15'), `a hét nem rajzolódott ki (nem bizonyít): ${v.text.slice(0, 120)}`);
    must(!v.text.includes('Far') && !v.text.includes('2027-01-10'), `start=${JSON.stringify(start)}: a távoli esemény bekerült: ${JSON.stringify(v.days)}`);
  }
});
check('naptár (a): a start_date, ami nem ISO nap, nem rajzolódik ki (nincs kitalált nap)', () => {
  for (const sd of ['holnap', '2026-11-16T09:00:00', 20261116, '2026-11-1'])
    must(!calView(at(2026, 11, 15, 10), [...week(), {title: 'Rossz', start: '2026-11-16T09:00:00Z', start_date: sd}]).text.includes('Rossz'),
         `start_date=${JSON.stringify(sd)}: az esemény megjelent`);
});
check('naptár (a) őrző: a 7. nap eseménye megjelenik, a mai napnál ott a "today" jelölés, start nélkül is', () => {
  const evs = week(); delete evs[6].start; evs[2].start = '2026-11-16T23:30:00Z';   // UTC-ben az előző nap
  const v = calView(at(2026, 11, 15, 10), evs);
  must(v.days.join() === '2026-11-15,2026-11-16,2026-11-17,2026-11-18,2026-11-19,2026-11-20,2026-11-21', `napok: ${v.days}`);
  must(v.text.includes('Nap21') && v.text.includes('Nap17'), `hiányzó esemény: ${v.text.slice(0, 200)}`);
  must(/2026-11-15\s*· today/.test(v.text) && (v.text.match(/· today/g) || []).length === 1, `a "today" jelölés: ${v.text.slice(0, 80)}`);
});

check('naptár (a) őrző: a néző mai napja előtti nap nem kerül a "Next 7 days" alá (régi adat)', () => {
  // Hideg review (2026-11-17): a szűrőnek csak felső határa volt. Régi (pótolt vagy késő
  // éjjel nézett) adatnál a tegnapi nap is a "következő 7 nap" fejléc alá került.
  const mult = [13, 14].map(n => ({title: `Mult${n}`, start: `2026-11-${n}T09:00:00+01:00`,
                                   start_date: `2026-11-${n}`, time: '09:00', category: 'work'}));
  const v = calView(at(2026, 11, 15, 10), [...mult, ...week()]);
  must(v.text.includes('Nap15') && v.text.includes('Nap21'), `a hét nem rajzolódott ki (nem bizonyít): ${v.text.slice(0, 120)}`);
  must(!v.text.includes('Mult13') && !v.text.includes('Mult14'), `múltbeli nap a listában: ${JSON.stringify(v.days)}`);
  must(v.days.length === 7 && v.days[0] === '2026-11-15', `napok: ${JSON.stringify(v.days)}`);
});

// ── Lábléc: a synced_at Safarin ──────────────────────────────────────────────────
// A synced_at helyi, időzóna nélküli "ÉÉÉÉ-HH-NN óó:pp" (health_sync.py: NOW.strftime). A
// Safari (iOS) a szóközös alakot nem érti — new Date(...) → Invalid Date —, és a lábléc
// "synced Invalid Date"-et írt. A V8 elnézi, ezért a próba egy szigorú, Safari-szerű
// Date-et tesz a lap alá. (Hideg review, 2026-11-17.)
const safariDate = p => vm.runInContext(`(() => { const R = Date;
  globalThis.Date = class extends R {
    constructor(...a) {
      if (a.length === 1 && typeof a[0] === 'string' && /^\\d{4}-\\d{2}-\\d{2} \\d/.test(a[0])) super(NaN);
      else super(...a);
    }
    static now() { return R.now(); }
  }; })()`, p.ctx);
check('lábléc: a synced_at ("ÉÉÉÉ-HH-NN óó:pp") Safarin sem lesz "Invalid Date"', () => {
  const d = demo(); d.synced_at = '2026-03-17 07:12';
  const p = page('index.html', {now: at(2026, 3, 17, 9)});
  safariDate(p);
  p.ctx.render(d);
  const html = p.el('tab-today').innerHTML;
  const upd = (/synced ([^·<]*)·/.exec(html) || [])[1] || '';
  must(upd.trim(), `nincs "synced …" sor (nem bizonyít): ${html.length} karakter`);
  must(!/invalid/i.test(upd), `a lábléc: synced ${upd.trim()}`);
  must(/17 Mar/.test(upd) && /07:12/.test(upd), `rossz idő a láblécben: synced ${upd.trim()}`);
});

// ── (c) Tasks kártya: a napszavak a NÉZŐ mai napjához igazodnak (mint a Day plan, F1) ──
// A tasks.today / tasks.tomorrow a SYNC napjához képest értendő; a kártya feltétel nélkül
// "Today" / "Tomorrow" szót írt. 15-én reggel a 14-i adat "Tomorrow" blokkja valójában a mai nap.
const one = (name, label = 'Light') => ({tasks: [{name}], count: 1, score: 1, label});
const tasksView = (now, mut) => {
  const d = demo(); mut(d);
  const p = page('index.html', {now});
  p.ctx.render(d);
  return p.el('tasksBody').textContent.replace(/\s+/g, ' ');
};
const twoTasks = d => { d.tasks.today = one('Call the bank'); d.tasks.tomorrow = one('Send review'); d.tasks.overdue = {tasks: [], count: 0}; };
check('tasks (c) F1: 14-i sync 15-én reggel → "Yesterday · 14 Nov" és "Today · 15 Nov", nincs Tomorrow', () => {
  const t = tasksView(at(2026, 11, 15, 6, 30), d => { syncAt('2026-11-14 21:30', 'evening')(d); twoTasks(d); });
  must(t.includes('Call the bank') && t.includes('Send review'), `a feladatok nem jelentek meg (nem bizonyít): ${t.slice(0, 120)}`);
  must(/Yesterday · 14 Nov\s*Light\s*□\s*Call the bank/.test(t), `a sync-napi blokk címe: ${t.slice(0, 160)}`);
  must(/Today · 15 Nov\s*Light\s*□\s*Send review/.test(t), `a rákövetkező nap címe: ${t.slice(0, 160)}`);
  must(!/Tomorrow|Tonight/.test(t), `hamis napszó maradt: ${t.slice(0, 160)}`);
});
check('tasks (c) F1: régi adat → "Plan from 12 Nov" / "Plan from 13 Nov"; előrébb járó sync → "Tomorrow · 15 Nov"', () => {
  const regi = tasksView(at(2026, 11, 15, 9), d => { syncAt('2026-11-12 07:00', 'morning')(d); twoTasks(d); });
  must(regi.includes('Plan from 12 Nov') && regi.includes('Plan from 13 Nov'), `régi adat: ${regi.slice(0, 160)}`);
  must(!/Today|Tomorrow|Yesterday|Tonight/.test(regi), `régi adatnál napszó áll: ${regi.slice(0, 160)}`);
  const elol = tasksView(at(2026, 11, 14, 23), d => { syncAt('2026-11-15 07:00', 'morning')(d); twoTasks(d); });
  must(elol.includes('Tomorrow · 15 Nov') && elol.includes('Plan from 16 Nov') && !/Today|Yesterday/.test(elol), `előrébb járó sync: ${elol.slice(0, 160)}`);
});
check('tasks (c) F1: üres sync-napi lista régi adatnál nem írja, hogy "Nothing due today"', () => {
  const ures = d => { d.tasks.today = {tasks: [], count: 0, score: 0, label: 'Clear'}; d.tasks.overdue = {tasks: [], count: 0}; d.tasks.tomorrow = one('Send review'); };
  const tegnap = tasksView(at(2026, 11, 15, 6, 30), d => { syncAt('2026-11-14 21:30', 'evening')(d); ures(d); });
  must(tegnap.includes('Nothing due · Yesterday · 14 Nov') && !/due today/i.test(tegnap), `tegnapi adat: ${tegnap.slice(0, 160)}`);
  const regi = tasksView(at(2026, 11, 15, 9), d => { syncAt('2026-11-12 07:00', 'morning')(d); ures(d); });
  must(regi.includes('Nothing due · Plan from 12 Nov') && !/today/i.test(regi), `régi adat: ${regi.slice(0, 160)}`);
  // őrző: ugyanazon a napon a szöveg marad
  const ma = tasksView(at(2026, 11, 15, 9), d => { syncAt('2026-11-15 07:00', 'morning')(d); ures(d); });
  must(ma.includes('✓ Nothing due today'), `aznapi adat: ${ma.slice(0, 160)}`);
});
check('tasks (c): ugyanazon a napon "Today · 17 Mar" és "Tomorrow · 18 Mar" (este sem "Tonight")', () => {
  for (const ora of [8, 22]) {
    const t = tasksView(at(2026, 3, 17, ora), twoTasks);           // a demó synced_at-je 2026-03-17, esti kontextus
    must(t.includes('Today · 17 Mar') && t.includes('Tomorrow · 18 Mar') && !/Tonight/.test(t), `${ora} óra: ${t.slice(0, 160)}`);
  }
});
check('tasks (c): synced_at nélkül (vagy hibás dátummal) "Today" / "Tomorrow" dátum nélkül', () => {
  for (const mut of [d => { delete d.synced_at; }, d => { d.synced_at = 'nem dátum'; }, d => { d.synced_at = '2026-13-45 07:00'; }]) {
    const t = tasksView(at(2026, 11, 15, 6, 30), d => { mut(d); twoTasks(d); });
    must(/Today\s*Light/.test(t) && /Tomorrow\s*Light/.test(t), `a kártya: ${t.slice(0, 160)}`);
    must(!/(Today|Tomorrow|Yesterday) · /.test(t) && !/Plan from/.test(t), `kitalált dátum a címben: ${t.slice(0, 160)}`);
  }
});
check('tasks (c): a fejléc bal oldala zsugorodhat, a címke nem törik (375 px)', () => {
  const d = demo(); twoTasks(d);
  const p = page('index.html', {now: at(2026, 3, 17, 8)});
  p.ctx.render(d);
  const html = p.el('tasksBody').innerHTML;
  for (const cim of ['Today · 17 Mar', 'Tomorrow · 18 Mar']) {
    const m = new RegExp(`<span style="([^"]*)">${cim}</span>\\s*<span style="([^"]*)">Light</span>`).exec(html);
    must(m, `nincs meg a(z) "${cim}" fejlécsor (nem bizonyít)`);
    must(/(^|;)min-width:0(;|$)/.test(m[1]), `${cim}: a cím elemén nincs min-width:0: ${m[1]}`);
    must(/(^|;)flex-shrink:0(;|$)/.test(m[2]) && /(^|;)white-space:nowrap(;|$)/.test(m[2]), `${cim}: a címke törhet: ${m[2]}`);
  }
});

// ── (b) brief.html: a napszavak a NÉZŐ mai napjához igazodnak (mint az index, bb254a0) ──
// A brief az ADAT napját nevezte "mának": 15-én reggel, a 07:00-s sync előtt a 14-i terv
// fölött "Good morning" és "Today's focus" állt. A terv napja a synced_at-ből jön.
const briefAt = async (now, mut = () => {}) => {
  const d = demo(); mut(d);
  const p = page('brief.html', {storage: PAIRED, fetch: () => json(d), now});
  await settle();
  const html = p.el('root').innerHTML;
  // az ál-DOM nem oldja fel az entitásokat: a böngészőben a &#39; aposztróf
  return {html, text: p.el('root').textContent.replace(/&#39;/g, "'").replace(/\s+/g, ' '),
          kicker: ((/<div class="kicker">([\s\S]*?)<\/div>/.exec(html) || [])[1] || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()};
};
const briefSync = (stampStr, more = () => {}) => d => {
  d.synced_at = stampStr; d.garmin.date = stampStr.slice(0, 10);
  d.day_plan.today.lines = ['Deep work block'];
  d.calendar = [{title: 'Standup', start_date: stampStr.slice(0, 10), time: '09:00', category: 'work'}];
  more(d);
};
check('brief (b) F1: 14-i esti sync 15-én 06:30-kor → "Yesterday\'s focus", a fejlécben "Yesterday"; nincs "Today\'s focus"', async () => {
  const v = await briefAt(at(2026, 11, 15, 6, 30), briefSync('2026-11-14 21:30'));
  must(v.text.includes('Deep work block') && v.text.includes('Standup'), `a brief nem rajzolódott ki (nem bizonyít): ${v.text.slice(0, 120)}`);
  must(v.text.includes("Yesterday's focus") && !/Today's focus/.test(v.text), `a fókusz címe: ${v.text.slice(0, 300)}`);
  must(v.kicker.includes('Yesterday · Saturday 14 November'), `a fejléc: ${v.kicker}`);
});
check('brief (b) F1 őrző: ugyanazon a napon "Today\'s focus" és a dátum napszó nélkül', async () => {
  const v = await briefAt(at(2026, 11, 15, 9), briefSync('2026-11-15 07:00'));
  must(v.text.includes("Today's focus") && v.text.includes('Standup'), `a brief: ${v.text.slice(0, 300)}`);
  must(v.kicker.startsWith('Morning Brief · Sunday 15 November') && !/Yesterday|Tomorrow|Plan from/.test(v.kicker), `a fejléc: ${v.kicker}`);
});
check('brief (b) F1: 12-i sync 15-én → "Plan from 12 Nov"; előrébb járó sync → "Tomorrow\'s focus"', async () => {
  const regi = await briefAt(at(2026, 11, 15, 9), briefSync('2026-11-12 07:00'));
  must(regi.text.includes('Plan from 12 Nov') && !/(Today|Yesterday|Tomorrow)'s focus/.test(regi.text), `régi: ${regi.text.slice(0, 300)}`);
  must(regi.kicker.includes('Plan from Thursday 12 November'), `régi fejléc: ${regi.kicker}`);
  const elol = await briefAt(at(2026, 11, 14, 23), briefSync('2026-11-15 07:00'));
  must(elol.text.includes("Tomorrow's focus") && elol.kicker.includes('Tomorrow · Sunday 15 November'), `előrébb járó: ${elol.kicker} / ${elol.text.slice(0, 200)}`);
});
check('brief (b): a terv napja a synced_at, nem a garmin.date; a naptár a terv napjának eseményeit mutatja', async () => {
  const v = await briefAt(at(2026, 11, 15, 6, 30), briefSync('2026-11-14 21:30', d => {
    d.garmin.date = '2026-11-13';
    d.calendar.push({title: 'Mai dolog', start_date: '2026-11-15', time: '10:00'}, {title: 'Garmin-napi', start_date: '2026-11-13', time: '10:00'});
  }));
  must(v.kicker.includes('Yesterday · Saturday 14 November'), `a fejléc: ${v.kicker}`);
  must(v.text.includes('Standup') && !v.text.includes('Mai dolog') && !v.text.includes('Garmin-napi'), `a naptár: ${v.text.slice(0, 400)}`);
});
check('brief (b): hibás synced_at mellett nincs kitalált dátum (a cím "Focus", a fejlécben nincs nap)', async () => {
  for (const rossz of ['nem dátum', '2026-13-45 07:00']) {
    const v = await briefAt(at(2026, 11, 15, 6, 30), briefSync('2026-11-14 21:30', d => { d.synced_at = rossz; delete d.garmin.date; }));
    must(v.text.includes('Deep work block'), `a brief nem rajzolódott ki (nem bizonyít): ${v.text.slice(0, 120)}`);
    must(v.kicker.replace(/\s*DEMO$/, '') === 'Morning Brief', `${rossz}: a fejléc: ${v.kicker}`);
    must(!/\d{1,2} (November|Nov)\b/.test(v.text.replace(/synced .*/, '')) && !/Invalid Date/.test(v.text), `${rossz}: dátum áll a lapon: ${v.text.slice(0, 200)}`);
    must(/bpm Focus ›\s*Deep work block/.test(v.text) && !/(Today|Yesterday|Tomorrow)'s focus|Plan from/.test(v.text), `${rossz}: a fókusz címe: ${v.text.slice(0, 300)}`);
    must(!/scheduled today|for today/i.test(v.text) && !v.text.includes('Standup'), `${rossz}: a naptár "mát" állít: ${v.text.slice(0, 400)}`);
  }
});
check('brief (b): üres terv / üres naptár szövege nem mond "today"-t, ha az adat nem mai', async () => {
  const ures = d => { d.day_plan.today.lines = []; d.calendar = []; };
  const tegnap = await briefAt(at(2026, 11, 15, 6, 30), briefSync('2026-11-14 21:30', ures));
  must(tegnap.text.includes('No plan from yesterday.') && tegnap.text.includes('Nothing was scheduled yesterday.'), `tegnap: ${tegnap.text.slice(0, 400)}`);
  const mat = t => /for today|scheduled today|Today's focus/i.test(t);
  must(!mat(tegnap.text), `tegnapi adatnál "today": ${tegnap.text.slice(0, 400)}`);
  const regi = await briefAt(at(2026, 11, 15, 9), briefSync('2026-11-12 07:00', ures));
  must(regi.text.includes('No plan from 12 Nov.') && regi.text.includes('Nothing scheduled on 12 Nov.') && !mat(regi.text), `régi: ${regi.text.slice(0, 400)}`);
  const holnap = await briefAt(at(2026, 11, 14, 23), briefSync('2026-11-15 07:00', ures));
  must(holnap.text.includes('No plan generated for tomorrow.') && holnap.text.includes('Nothing scheduled tomorrow.'), `holnap: ${holnap.text.slice(0, 400)}`);
  const ma = await briefAt(at(2026, 11, 15, 9), briefSync('2026-11-15 07:00', ures));
  must(ma.text.includes('No plan generated for today.') && ma.text.includes('Nothing scheduled today.'), `ma (őrző): ${ma.text.slice(0, 400)}`);
});
check('brief (b): a hosszabb fejléc 375 px-en törhet (.kicker flex-wrap), a betöltő szöveg nem ígér "today"-t', () => {
  const src = read('brief.html');
  const k = (/\.kicker\{([^}]*)\}/.exec(src) || [])[1] || '';
  must(/flex-wrap:wrap/.test(k), `.kicker: ${k}`);
  must(!/Loading today/.test(src), 'a betöltő szöveg: "Loading today\'s brief…"');
});

// ── (d) utójavítás: a DM Mono szélesebb — a Training fül 375 px-en ne lógjon ki ──
// Böngészőben mérve (375 px-es keret, demó adat): a (d) után a Training fül scrollWidth-je
// 375 → 393 lett. Ok: a .ws-row rácsa `56px 1fr` volt (10. szabály: minmax(0,1fr)), és a
// gyakorlat-pirula (.ex-tag) nem törhetett — "Back Extension (Weighted Hyperextension)".
check('CSS (d) 375 px: a .ws-row rácscellája minmax(0,1fr), a gyakorlat-pirula törhet', () => {
  const row = cssRule('.ws-row'), tag = cssRule('.ex-tag');
  must(row && tag, 'a .ws-row / .ex-tag szabály nem olvasható (nem bizonyít)');
  const cols = row.find(x => /^grid-template-columns:/.test(x)) || '';
  must(/minmax\(0,\s*1fr\)/.test(cols) && !/(^|\s)1fr/.test(cols.replace(/minmax\([^)]*\)/g, '')), `.ws-row: ${cols}`);
  must(!tag.includes('white-space:nowrap') && tag.includes('overflow-wrap:anywhere'), `.ex-tag: ${tag.join(';')}`);
});

// ── Időjárás: a hiány nem lehet állítás ("No rain — biking ok", 0 mm) ───────────
// A sync mostantól null-t küld, ha a csapadék ismeretlen (rain, precip_mm) vagy a kód
// ismeretlen (description). A sáv hiányzó esőnél is ☀️-t és zöld "No rain — biking ok"-t
// írt; a deviceWeather pedig a böngészőben találta ki ugyanezt: (precipitation_sum||[0])[0].
const wxStrip = mut => {
  const d = demo(); mut(d.weather);
  const p = page('index.html');
  p.ctx.render(d);
  return p.el('weatherStrip').textContent.replace(/\s+/g, ' ').trim();
};
check('időjárás: ismeretlen eső (rain: null, precip_mm: null) → nincs biciklis tanács és nincs nap/eső ikon', () => {
  for (const mut of [w => { w.rain = null; w.precip_mm = null; }, w => { delete w.rain; delete w.precip_mm; }]) {
    const t = wxStrip(mut);
    must(t.includes('12°C') && t.includes('Partly cloudy'), `a sáv nem rajzolódott ki (nem bizonyít): ${t}`);
    must(!/biking|No rain|Rain/.test(t), `tanács adat nélkül: ${t}`);
    must(!/☀️|🌧/.test(t), `ikon adat nélkül: ${t}`);
    must(!/undefined|null|NaN/.test(t) && !/· ·|^·|·$/.test(t), `csonka sáv: ${t}`);
  }
});
check('időjárás őrző: ismeretlen leírás (description: null) → "—", nem kitalált címke', () => {
  const t = wxStrip(w => { w.description = null; });
  must(/☀️ — ·\s*12°C/.test(t) && !/Cloudy|Clear|null/.test(t), `a sáv: ${t}`);
});
check('időjárás őrző: a valódi érték marad — száraz nap, eső, valódi 0 mm, rain nélkül a precip_mm-ből', () => {
  must(/☀️.*No rain — biking ok/.test(wxStrip(() => {})), `demó (rain: false): ${wxStrip(() => {})}`);
  must(/🌧.*Rain — no biking/.test(wxStrip(w => { w.rain = true; w.precip_mm = 4.2; })), 'rain: true');
  must(/No rain — biking ok/.test(wxStrip(w => { delete w.rain; w.precip_mm = 0; })), 'rain nélkül, precip_mm: 0');
  must(/Rain — no biking/.test(wxStrip(w => { delete w.rain; w.precip_mm = 3; })), 'rain nélkül, precip_mm: 3');
  must(/UV 0\b/.test(wxStrip(w => { w.uv_index = 0; })), 'a valódi UV 0 eltűnt');
});
// Az élő (eszköz-) időjárás: a deviceWeather a lap saját függvénye, ál-helymeghatározással
// és ál-válasszal futtatjuk (hálózat nincs).
const liveWx = async (file, meteo) => {
  const p = page(file, {fetch: u => /open-meteo/.test(u) ? json(meteo) : json({city: 'Teszt'})});
  p.ctx.navigator.geolocation = {getCurrentPosition: ok => ok({coords: {latitude: 1, longitude: 2}})};
  return {p, w: await p.run('deviceWeather')()};
};
for (const file of ['index.html', 'brief.html']) {
  check(`időjárás: ${file} deviceWeather — hiányzó csapadék → precip_mm és rain null, nem 0 / false`, async () => {
    for (const daily of [{}, {precipitation_sum: []}, {precipitation_sum: [null]}, {precipitation_sum: null}, undefined]) {
      const {w} = await liveWx(file, {current: {temperature_2m: 5, weather_code: 3}, daily});
      must(w && w.temp === 5, `nem adott időjárást (nem bizonyít): ${JSON.stringify(w)}`);
      must(w.precip_mm == null && w.rain == null, `daily=${JSON.stringify(daily)}: kitalált érték: precip_mm=${w.precip_mm}, rain=${w.rain}`);
      must(w.uv_index == null, `kitalált UV: ${w.uv_index}`);
    }
  });
  check(`időjárás őrző: ${file} deviceWeather — a valódi 0 mm száraz nap, a 2 mm eső`, async () => {
    const dry = (await liveWx(file, {current: {temperature_2m: 5, weather_code: 0}, daily: {precipitation_sum: [0], uv_index_max: [0]}})).w;
    must(dry.precip_mm === 0 && dry.rain === false && dry.uv_index === 0 && dry.description === 'Clear', `száraz: ${JSON.stringify(dry)}`);
    const wet = (await liveWx(file, {current: {temperature_2m: 5, weather_code: 61}, daily: {precipitation_sum: [2]}})).w;
    must(wet.precip_mm === 2 && wet.rain === true, `eső: ${JSON.stringify(wet)}`);
  });
  check(`időjárás: ${file} forrásában nincs "||[0]" kitalált alapérték`, () => {
    const hits = read(file).match(/\|\|\s*\[0\]/g) || [];
    must(!hits.length, `${hits.length} találat: ||[0]`);
  });
}
check('időjárás: index.html élő sáv hiányzó csapadékkal → nincs biciklis tanács', async () => {
  const {p} = await liveWx('index.html', {current: {temperature_2m: 7, weather_code: 3}, daily: {}});
  p.ctx.render(demo());
  await settle();
  const t = p.el('weatherStrip').textContent.replace(/\s+/g, ' ').trim();
  must(t.includes('7°C') && t.includes('Teszt'), `az élő időjárás nem jelent meg (nem bizonyít): ${t}`);
  must(!/biking|☀️|🌧/.test(t), `tanács/ikon adat nélkül: ${t}`);
});
check('időjárás: brief.html — eső ismeretlen mennyiséggel nem ír "mm"-t szám nélkül; ismeretlen eső → nincs eső-rész', () => {
  const p = page('brief.html');
  const wx = w => p.run('wxHtml')(w, false).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  must(!/rain|mm|🌧/.test(wx({temp: 5, description: null, rain: null, precip_mm: null, uv_index: null})), `ismeretlen eső: ${wx({temp: 5, rain: null})}`);
  must(!/null|undefined|UV/.test(wx({temp: 5, description: null, rain: null, precip_mm: null, uv_index: null})), 'null a sávban');
  must(/🌧 rain/.test(wx({temp: 5, rain: true, precip_mm: null})) && !/\bmm/.test(wx({temp: 5, rain: true, precip_mm: null})), `eső mm nélkül: ${wx({temp: 5, rain: true, precip_mm: null})}`);
  must(/🌧 3\.2mm rain/.test(wx({temp: 5, rain: true, precip_mm: 3.2})), `eső (őrző): ${wx({temp: 5, rain: true, precip_mm: 3.2})}`);
});

// ── Időjárás: a WMO-kódtábla teljes; a listán kívüli kód nem kap kitalált címkét ──
// Forrás: open-meteo.com/en/docs, "WMO Weather interpretation codes (WW)" (2026-11-17-én
// olvasva). A 97 ("Heavy thunderstorm") is ott áll: a jégeső-előrejelzés nélküli modellek
// 95-öt és 97-et adnak. A lapok táblájából hiányzott: 56, 57, 66, 67, 77, 85, 86, 97, 99 —
// hózáporban, ónos esőben az élő sáv címke nélkül ("—") maradt.
const WMO_CODES = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 97, 99];
for (const file of ['index.html', 'brief.html']) {
  check(`időjárás WMO: ${file} táblája a teljes Open-Meteo-lista, se több, se kevesebb`, () => {
    const t = page(file).run('WMO');
    const hiany = WMO_CODES.filter(c => typeof t[c] !== 'string' || !t[c].trim() || t[c] === '—');
    must(!hiany.length, `hiányzó kód: ${hiany.join(', ')}`);
    const tobb = Object.keys(t).filter(k => !WMO_CODES.includes(+k));
    must(!tobb.length, `a listán kívüli kód a táblában: ${tobb.join(', ')}`);
    for (const [c, re] of [[56, /freezing/i], [66, /freezing/i], [77, /snow/i], [85, /snow/i], [86, /snow/i], [97, /thunder/i], [99, /thunder/i]])
      must(re.test(t[c]), `${c}: félrevezető címke: ${t[c]}`);
  });
  check(`időjárás WMO: ${file} deviceWeather — új kód címkét kap; ismeretlen vagy hiányzó kód → null, nem kitalált címke`, async () => {
    const d86 = (await liveWx(file, {current: {temperature_2m: -2, weather_code: 86}, daily: {}})).w;
    must(/snow/i.test(d86.description || ''), `86 (hózápor): ${d86.description}`);
    for (const code of [4, 100, -1, null, undefined, 'constructor', '__proto__', 'toString']) {
      const w = (await liveWx(file, {current: {temperature_2m: 5, weather_code: code}, daily: {}})).w;
      must(w.temp === 5, 'nem adott időjárást (nem bizonyít)');
      must(w.description === null, `kód=${JSON.stringify(code)}: a leírás ${JSON.stringify(String(w.description).slice(0, 40))}, nem null`);
    }
  });
}
check('időjárás WMO: a két lap táblája szóról szóra azonos', () => {
  const a = page('index.html').run('WMO'), b = page('brief.html').run('WMO');
  must(JSON.stringify(a) === JSON.stringify(b), 'az index.html és a brief.html WMO-táblája eltér');
});
check('időjárás WMO: ismeretlen kódnál az élő sáv "—"-t (index) / semmit (brief) ír, nem címkét', async () => {
  const {p} = await liveWx('index.html', {current: {temperature_2m: 7, weather_code: 4}, daily: {precipitation_sum: [0]}});
  p.ctx.render(demo());
  await settle();
  const t = p.el('weatherStrip').textContent.replace(/\s+/g, ' ').trim();
  must(t.includes('7°C') && /☀️ — ·/.test(t) && !/null|undefined|Cloudy/.test(t), `index: ${t}`);
  const b = page('brief.html').run('wxHtml')({temp: 7, description: null, city: 'Teszt'}, true).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  must(b === '🌡 7°C · 📍 Teszt', `brief: ${b}`);
});

// ── Tasks kártya: hiányzó címke → "—", nem "undefined" ─────────────────────────
check('tasks: hiányzó label (count > 0) mellett "—" áll, nem "undefined"/"null"', () => {
  for (const hiany of [undefined, null, '']) {
    const d = demo();
    d.tasks.today = {tasks: [{name: 'Call the bank'}], count: 1, score: 1};
    d.tasks.tomorrow = {tasks: [{name: 'Send review'}], count: 1, score: 1};
    if (hiany !== undefined) { d.tasks.today.label = hiany; d.tasks.tomorrow.label = hiany; }
    const p = page('index.html', {now: at(2026, 3, 17, 10)});   // a néző a demó sync-napján áll (a fejléc: Today · 17 Mar)
    p.ctx.render(d);
    const t = p.el('tasksBody').textContent.replace(/\s+/g, ' ');
    must(t.includes('Call the bank') && t.includes('Send review'), `a feladatok nem jelentek meg (nem bizonyít): ${t.slice(0, 100)}`);
    must(!/undefined|null/.test(t), `label=${JSON.stringify(hiany)}: "${(/undefined|null/.exec(t) || [])[0]}" a kártyán: ${t.slice(0, 100)}`);
    must(/Today · 17 Mar\s*—/.test(t) && /Tomorrow · 18 Mar\s*—/.test(t), `label=${JSON.stringify(hiany)}: nincs "—" a címke helyén: ${t.slice(0, 100)}`);
    must(taskLabelColor(p.el('tasksBody').innerHTML, '—') === 'var(--text3)', 'a "—" nem semleges színű');
  }
});

// ── futtatás ────────────────────────────────────────────────────────────────────
module.exports = {page, settle, demo, json};   // egyedi próbákhoz: require('./page_checks')
if (require.main === module) (async () => {
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
