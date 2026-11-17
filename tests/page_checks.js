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
    addEventListener: (t, f) => (listeners[`document:${t}`] = listeners[`document:${t}`] || []).push(f),
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
    fire: (t, ev) => (listeners[t] || []).forEach(f => f(Object.assign({type: t.replace(/^document:/, '')}, ev))),
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
for (const file of ['index.html', 'brief.html', 'kamra.html']) {
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
const PAGES = ['index.html', 'brief.html', 'kamra.html'];
const DATA_PATH = {'kamra.html': '/nutrition'};   // a kamra a /nutrition dokumentumot olvassa
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
    const f = p.calls.fetch.find(x => x.url === `${API}${DATA_PATH[file] || '/data'}`);
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

// ── (g) Tasks kártya: Things + Google Feladatok egy listában, forrásjelöléssel (2026-11-17) ──
// A sync a két forrást összefésüli (tasks.google: status ok/carried/unknown/off, as_of,
// truncated); a kártya minden tétel mellé kiírja a forrását, és kimondja, ha a Google-lista
// régi (carried) vagy hiányzik (unknown). A régi alak (nincs tasks.google) változatlan.
const googleTasks = (status, extra = {}) => d => {
  d.tasks.today = {tasks: [{name: 'Call the bank', source: 'things'},
                           {name: 'Dentist call', source: 'google', project: 'My Tasks'}],
                   count: 2, score: 20, label: 'Moderate'};
  d.tasks.tomorrow = {tasks: [{name: 'Send review', source: 'google'}], count: 1, score: 10, label: 'Light'};
  d.tasks.overdue = {tasks: [], count: 0};
  d.tasks.google = Object.assign({status, as_of: status === 'ok' ? d.synced_at : null,
                                  truncated: false, tasks: []}, extra);
};
check('tasks (g): két forrásnál minden tétel mellett ott a forrása (Things / Google)', () => {
  const t = tasksView(at(2026, 3, 17, 8), googleTasks('ok'));
  must(/Call the bank\s*Things/.test(t), `a Things-tétel forrása hiányzik: ${t.slice(0, 200)}`);
  must(/Dentist call\s*Google\s*My Tasks/.test(t), `a Google-tétel forrása hiányzik: ${t.slice(0, 200)}`);
  must(/Send review\s*Google/.test(t), `a holnapi Google-tétel forrása hiányzik: ${t.slice(0, 200)}`);
  must(!/last known|unavailable|only part/.test(t), `friss listánál állapot-jelzés áll: ${t.slice(0, 300)}`);
});
check('tasks (g): kikapcsolt Google-forrás, vagy a régi alak (nincs tasks.google) → nincs forrás-címke', () => {
  for (const [nev, mut] of [['off', googleTasks('off')],
                            ['régi alak', d => { googleTasks('ok')(d); delete d.tasks.google; }]]) {
    const t = tasksView(at(2026, 3, 17, 8), mut);
    must(t.includes('Dentist call'), `${nev}: a tétel nem jelent meg (nem bizonyít)`);
    // Szóhatár NÉLKÜL: a címke szövege szóköz nélkül tapad a névhez ("bankThings"), egy
    // \b-s minta nem látná — így maradt zölden egy mutáns (2026-11-17).
    must(!/Things|Google/.test(t), `${nev}: forrás-címke áll: ${t.slice(0, 200)}`);
  }
});
check('tasks (g): pótolt lista → "last known list from …"; ismeretlen → "unavailable"; csonka → jelzés', () => {
  const regi = tasksView(at(2026, 3, 17, 8), googleTasks('carried', {as_of: '2026-03-16 21:00'}));
  must(/Google Tasks: last known list from 16 Mar.{0,5}21:00 — the feed did not answer this sync/.test(regi),
       `pótolt lista: ${regi.slice(-220)}`);
  must(/Dentist call\s*Google/.test(regi), 'pótolt listánál is kell a forrás-címke');
  const rossz = tasksView(at(2026, 3, 17, 8), googleTasks('carried', {as_of: 'nem dátum'}));
  must(rossz.includes('Google Tasks: last known list — the feed') && !/Invalid|NaN/.test(rossz),
       `rossz bélyeg: ${rossz.slice(-220)}`);
  const nincs = tasksView(at(2026, 3, 17, 8), googleTasks('unknown'));
  must(nincs.includes('Google Tasks unavailable this sync — only Things is shown'), `ismeretlen: ${nincs.slice(-200)}`);
  const csonka = tasksView(at(2026, 3, 17, 8), googleTasks('ok', {truncated: true}));
  must(csonka.includes('Google Tasks: only part of the list arrived'), `csonka: ${csonka.slice(-200)}`);
});
check('tasks (g): 375 px-en az "overdue" és a forrás-címke nem törik (a név zsugorodik)', () => {
  const d = demo(); googleTasks('ok')(d);
  d.tasks.overdue = {tasks: [{name: 'Return library book', source: 'google', project: 'My Tasks', overdue: true}], count: 1};
  const p = page('index.html', {now: at(2026, 3, 17, 8)});
  p.ctx.render(d);
  const html = p.el('tasksBody').innerHTML;
  const over = /<span style="([^"]*)">overdue<\/span>/.exec(html), cimke = /<span style="([^"]*)">Google<\/span>/.exec(html);
  must(over && cimke, 'nincs "overdue" vagy forrás-címke a kártyán (nem bizonyít)');
  for (const [nev, m] of [['overdue', over], ['forrás-címke', cimke]])
    must(/(^|;)flex-shrink:0(;|$)/.test(m[1]) && (nev !== 'overdue' || /(^|;)white-space:nowrap(;|$)/.test(m[1])), `${nev} törhet: ${m[1]}`);
});
check('tasks (g): ellenséges forrás, név és bélyeg nem kerül nyersen a kártyára', () => {
  const d = demo();
  googleTasks('carried', {as_of: '<img src=x onerror=alert(1)>'})(d);
  d.tasks.today.tasks[1].source = '<img src=x onerror=alert(2)>';
  d.tasks.today.tasks[0].name = '<img src=x onerror=alert(3)>';
  const p = page('index.html', {now: at(2026, 3, 17, 8)});
  p.ctx.render(d);
  const html = p.el('tasksBody').innerHTML;
  must(html.includes('&lt;img src=x onerror=alert(3)&gt;'), 'a név nem jelent meg semlegesítve (nem bizonyít)');
  must(!/<img/i.test(html), `nyers tag a kártyán: ${html.slice(0, 300)}`);
  must(!/alert\(1\)|alert\(2\)/.test(html), 'a bélyeg vagy a forrás szövege kiíródott');
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

// ── Kamra: az ÍRÓkulcs (health_nkey) őrzött átvétele — kamra.html#nkey=<kulcs> ───
// Ugyanazok a szabályok, mint az olvasó párosításnál (pairing.js): csak a # utáni
// részből, a címsorból azonnal kivéve, minden változás csak megerősítéssel, és csak
// már párosított (https) végponthoz — az írókulcs oda megy, ahová az olvasókulcs.
const NKEY = 'nk0123456789abcdef0123456789abcdef0123456789abcdef';   // kitalált írókulcs
const NKEY2 = 'nkfedcba9876543210fedcba9876543210fedcba9876543210';  // kitalált
const WPAIRED = {...PAIRED, health_nkey: NKEY};
const nlink = (file, k, form = 'hash') => `${BASE}${file}${form === 'query' ? '?' : '#'}nkey=${encodeURIComponent(k)}`;
const nk = p => p.store.get('health_nkey') || null;

check('nkey: kamra.html#nkey=… párosított böngészőben megerősítéssel (a host nevével) mentődik, a címsorból eltűnik', () => {
  const p = page('kamra.html', {url: nlink('kamra.html', NKEY), storage: PAIRED, confirm: true});
  must(nk(p) === NKEY, `nem mentette: ${nk(p)}`);
  must(p.calls.confirm.length === 1 && p.calls.confirm[0].includes('api.example.test'), `a megerősítés: ${p.calls.confirm}`);
  must(!p.loc.href.includes(NKEY) && !p.loc.hash, `a címsor: ${p.loc.href}`);
  must(p.calls.replaceState.length === 1, 'a címsor tisztítása elmaradt');
  must(saved(p).api === API && saved(p).key === KEY, 'az olvasó párosításhoz hozzányúlt');
  must(p.el('pairNote').textContent.includes('api.example.test') && !p.el('pairNote').textContent.includes(NKEY), `visszajelzés: ${p.el('pairNote').textContent}`);
});
check('nkey: megerősítés nélkül (nem-re) semmi nem mentődik, de a címsor akkor is tiszta', () => {
  const p = page('kamra.html', {url: nlink('kamra.html', NKEY), storage: PAIRED, confirm: false});
  must(nk(p) === null && p.calls.confirm.length === 1, `mentve: ${nk(p)}, ${p.calls.confirm.length} kérdés`);
  must(!p.loc.href.includes(NKEY), `a címsor: ${p.loc.href}`);
});
check('nkey: párosítatlan böngészőben (nincs https végpont) megerősítéssel sem mentődik', () => {
  for (const storage of [{}, {health_api: 'http://evil.example', health_key: KEY}, {health_api: 'data:application/json,{}#', health_key: KEY}]) {
    const p = page('kamra.html', {url: nlink('kamra.html', NKEY), storage, confirm: true});
    must(nk(p) === null, `mentve végpont nélkül: ${JSON.stringify(storage)}`);
    must(!p.calls.confirm.length, 'kérdezett, pedig nincs hová kötni a kulcsot');
    must(!p.loc.href.includes(NKEY), `a címsor: ${p.loc.href}`);
  }
});
check('nkey: a ?nkey=… (query) formát megerősítéssel sem veszi át, és kiveszi a címsorból', () => {
  const p = page('kamra.html', {url: nlink('kamra.html', NKEY, 'query'), storage: PAIRED, confirm: true});
  must(nk(p) === null, `a query-ből vett írókulcs mentve: ${nk(p)}`);
  must(!p.loc.href.includes(NKEY) && !/nkey=/.test(p.loc.href), `a címsor: ${p.loc.href}`);
  must(p.el('pairNote').textContent.includes('#nkey='), 'nem mondja meg a helyes formát (#nkey=…)');
});
check('nkey: hibás kulcsot (szóköz, sortörés, üres, túl hosszú) nem ment', () => {
  for (const k of ['abc def', 'abc\ndef', '', '<img src=x>', 'a'.repeat(600)]) {
    const p = page('kamra.html', {url: nlink('kamra.html', k), storage: PAIRED, confirm: true});
    must(nk(p) === null, `elfogadta: ${JSON.stringify(k.slice(0, 20))}`);
  }
});
check('nkey: ugyanaz a link újra nem kérdez és nem ír; kulcscsere csak megerősítéssel', () => {
  const same = page('kamra.html', {url: nlink('kamra.html', NKEY), storage: WPAIRED, confirm: false});
  must(nk(same) === NKEY && !same.calls.confirm.length && !same.loc.hash, `azonos kulcs: ${same.calls.confirm.length} kérdés`);
  const no = page('kamra.html', {url: nlink('kamra.html', NKEY2), storage: WPAIRED, confirm: false});
  must(nk(no) === NKEY && no.calls.confirm.length === 1, `nem-re: ${nk(no)}`);
  const yes = page('kamra.html', {url: nlink('kamra.html', NKEY2), storage: WPAIRED, confirm: true});
  must(nk(yes) === NKEY2, `igen-re: ${nk(yes)}`);
});
for (const file of ['index.html', 'brief.html']) {
  check(`nkey: ${file}#nkey=… nem ment írókulcsot (csak a kamra.html veszi át), de a címsort kitisztítja`, () => {
    const p = page(file, {url: nlink(file, NKEY), storage: PAIRED, confirm: true});
    must(nk(p) === null && !p.calls.confirm.length, `mentve: ${nk(p)}`);
    must(!p.loc.href.includes(NKEY), `a címsor: ${p.loc.href}`);
    must(p.el('pairNote').textContent.includes('kamra.html#nkey='), `visszajelzés: ${p.el('pairNote').textContent}`);
  });
}
check('nkey: végpontváltáskor a régi írókulcs törlődik (nem megy el az új hostnak)', () => {
  const p = page('kamra.html', {url: link('kamra.html', EVIL, KEY2, 'hash'), storage: WPAIRED, confirm: true});
  must(saved(p).api === EVIL, 'a végpontváltás nem történt meg (nem bizonyít)');
  must(nk(p) === null, `az írókulcs megmaradt az új végponthoz: ${nk(p)}`);
  const same = page('kamra.html', {url: link('kamra.html', API, KEY2, 'hash'), storage: WPAIRED, confirm: true});
  must(saved(same).key === KEY2 && nk(same) === NKEY, 'olvasókulcs-cserénél (azonos végpont) az írókulcs elveszett');
});
check('nkey: egy linkben api+key+nkey — előbb a végpont, utána az írókulcs, mindkettő külön megerősítéssel', () => {
  const url = `${link('kamra.html', API, KEY, 'hash')}&nkey=${NKEY}`;
  const p = page('kamra.html', {url, confirm: true});
  must(saved(p).api === API && nk(p) === NKEY && p.calls.confirm.length === 2, `${JSON.stringify(saved(p))} ${nk(p)} ${p.calls.confirm.length}`);
  const no = page('kamra.html', {url, confirm: false});
  must(!saved(no).api && nk(no) === null, 'nem-re is mentett valamit');
});
check('nkey: nyitott lapon a #nkey=… beillesztése újratölt; a ⚙ (index) az írókulcsot is törli', () => {
  const p = page('kamra.html', {storage: PAIRED});
  p.loc.hash = `#nkey=${NKEY}`;
  p.fire('hashchange');
  must(p.calls.reload === 1, `újratöltés: ${p.calls.reload}`);
  const i = page('index.html', {storage: WPAIRED, confirm: true});
  i.run('clearToken')();
  must(nk(i) === null && !saved(i).api, `a leválasztás után maradt: ${nk(i)} / ${saved(i).api}`);
});

// ════════════════════════════════════════════════════════════════════════════════
// KAMRA (kamra.html): vonalkód → Open Food Facts → kamra + étkezési napló + célok.
// A Worker-szerződés: GET/PUT <api>/nutrition (olvasó-, ill. írókulcs), a teljes
// dokumentum megy vissza a betöltéskori rev-vel; 409-re újratöltés + EGY újrapróba.
// Az ál-szerver (nutri) ezt a szerződést játssza el; hálózat nincs.
// ════════════════════════════════════════════════════════════════════════════════
const KNOW = at(2026, 11, 17, 13, 5), KDAY = '2026-11-17';
const emptyDoc = () => ({version: 1, rev: 0, targets: null, products: {}, pantry: [], log: {}, days: {}});
const clone = o => JSON.parse(JSON.stringify(o));
const TUNA = {name: 'Tonhal sós lében', brand: 'Rio Mare', per100: {kcal: 100, protein: 24, carbs: 0, fat: 0.5},
              pack_g: 160, serving_g: 80, source: 'off', added: '2026-11-10'};
const MYST = {name: 'Házi lekvár', brand: null, per100: {kcal: null, protein: null, carbs: null, fat: null},
              pack_g: null, serving_g: null, source: 'manual', added: '2026-11-10'};
const offOk = product => () => json({code: product.code, status: 1, product});
const offMiss = () => new Response(JSON.stringify({code: 'x', status: 0, status_verbose: 'product not found'}), {status: 404});

function nutri(doc, o = {}) {
  const s = {doc: clone(doc), puts: [], gets: 0, off: [], other: [], rejected: [], conflicts: o.conflicts || 0, seq: [...(o.putSeq || [])]};
  s.fetch = (url, init) => {
    const m = String(init.method || 'GET').toUpperCase(), auth = (init.headers || {}).Authorization;
    if (url === `${API}/nutrition` && m === 'GET') {
      s.gets++; s.getAuth = auth;
      if (o.getFail) return o.getFail === 'net' ? Promise.reject(new TypeError('Load failed')) : new Response('nope', {status: o.getFail});
      return json(s.doc);
    }
    if (url === `${API}/nutrition` && m === 'PUT') {
      const body = JSON.parse(init.body);
      s.puts.push({body: clone(body), auth});
      const raw = o.putStatus || s.seq.shift(), st = raw && typeof raw === 'object' ? raw.status : raw;   // {status, scope, retryAfter} is lehet
      if (st === 'net') return Promise.reject(new TypeError('Load failed'));
      if (st === 'lost') { s.doc = clone(body); s.doc.rev++; return Promise.reject(new TypeError('Load failed')); }   // az írás megtörtént, a válasz elveszett
      if (st === 413) return new Response('Payload Too Large', {status: 413});
      if (st) return new Response(JSON.stringify({error: {401: 'unauthorized', 429: 'rate_limited', 503: 'storage', 500: 'storage'}[st] || 'invalid',
        ...(st === 429 ? {scope: raw.scope || 'gap'} : {detail: 'x'})}), {status: st, headers: raw && raw.retryAfter != null ? {'Retry-After': String(raw.retryAfter)} : {}});
      if (s.conflicts > 0) {                       // közben egy másik eszköz írt
        s.conflicts--; if (o.other) o.other(s.doc); s.doc.rev++;
        return new Response(JSON.stringify({error: 'conflict', rev: s.doc.rev}), {status: 409});
      }
      if (body.rev !== s.doc.rev) return new Response(JSON.stringify({error: 'conflict', rev: s.doc.rev}), {status: 409});
      const errs = o.noValidate ? [] : invalidDoc(body);          // mint az igazi Worker
      if (errs.length) { s.rejected.push(errs[0]); return new Response(JSON.stringify({error: 'invalid', detail: 'x'}), {status: 400}); }
      s.doc = clone(body); s.doc.rev += o.revJump || 1;
      return json(o.noRev ? {ok: true} : {ok: true, rev: s.doc.rev});
    }
    if (url.startsWith('https://world.openfoodfacts.org/')) {
      s.off.push(url);
      if (o.off === 'net') return Promise.reject(new TypeError('Load failed'));
      return o.off ? o.off(url) : offMiss();
    }
    s.other.push(`${m} ${url}`);
    return new Response('?', {status: 404});
  };
  return s;
}
// A kamra lap betöltve; alapból párosítva ÉS írókulccsal. A K a lap Kamra objektuma.
async function kamra(doc, o = {}) {
  const srv = nutri(doc || emptyDoc(), o);
  const p = page('kamra.html', {url: o.url, storage: o.storage || WPAIRED, now: o.now == null ? KNOW : o.now, fetch: srv.fetch, confirm: o.confirm});
  p.fire('DOMContentLoaded');
  await settle();
  Object.assign(p.run('Kamra').timing, {debounce: 0, lazy: 0, gap: 0, retry: 0, margin: 0}, o.timing);   // a valódi értékekre külön ellenőrzés van
  return {p, srv, K: p.run('Kamra'), txt: id => p.el(id).textContent.replace(/\s+/g, ' ').trim(), html: id => p.el(id).innerHTML};
}
const noRaw = (html, hol) => must(!/<img\b/i.test(html), `nyers <img> a(z) ${hol} innerHTML-jében: …${html.slice(Math.max(0, html.search(/<img\b/i) - 30), html.search(/<img\b/i) + 50)}…`);

// ── őrszem + statikus szabályok ─────────────────────────────────────────────────
check('kamra: a lap magyar, noindex, a pairing.js-t tölti, és nincs benne beégetett kulcs vagy Worker-host', () => {
  const html = read('kamra.html');
  must(/<html lang="hu">/.test(html) && /<meta name="robots" content="noindex">/.test(html), 'lang="hu" / noindex hiányzik');
  must(/HealthPairing\.run\(\{\s*write:\s*true\s*\}\)/.test(html), 'nem a pairing.js-en át olvassa a beállítást (run({write:true}))');
  must(!/workers\.dev/i.test(html) && !/Bearer\s+[A-Za-z0-9]{16,}/.test(html), 'beégetett host vagy kulcs');
  must(!/localStorage\.(setItem|getItem)\s*\(/.test(html), 'a lap maga nyúl a localStorage-hoz (a pairing.js dolga)');
});
check('kamra: külső adat csak a render(d)-n át kerül innerHTML-be (deepEscape), üzenet csak textContent-tel', () => {
  const js = read('kamra.html');
  const kivul = js.replace(/function render\(d\)\s*\{[\s\S]*?\n\}\n/, '');
  must(kivul.length < js.length, 'nem találom a render(d) függvényt (nem bizonyít)');
  must(!/\.innerHTML\s*=/.test(kivul) && !/insertAdjacentHTML|document\.write|outerHTML\s*=/.test(js), 'innerHTML-írás a render(d)-n kívül');
});
check('kamra: index.html fejlécében link a kamrához a brief mellett; demóban ?demo=1-gyel', () => {
  const html = read('index.html');
  must(/<a class="btn-sm" href="brief\.html"[^>]*>[^<]*<\/a>\s*<a class="btn-sm" href="kamra\.html"/.test(html), 'nincs kamra-link a brief-link után');
  must(/kamra\.html\?demo=1/.test(html), 'demóban a kamra-link nem kap ?demo=1-et');
});

// ── OFF → per100 leképezés (külső, megbízhatatlan adat) ─────────────────────────
check('kamra OFF: kcal az energy-kcal_100g-ből, különben kJ/4,184; a többi makró a *_100g mezőkből', async () => {
  const {K} = await kamra();
  const a = K.offToProduct({status: 1, product: {product_name: 'Zabpehely', brands: 'Teszt', quantity: '500 g', product_quantity: 500,
    product_quantity_unit: 'g', serving_quantity: 40, nutriments: {'energy-kcal_100g': 372, energy_100g: 1556, proteins_100g: 13.5, carbohydrates_100g: 58.7, fat_100g: 7}}});
  must(JSON.stringify(a.per100) === JSON.stringify({kcal: 372, protein: 13.5, carbs: 58.7, fat: 7}), JSON.stringify(a.per100));
  must(a.name === 'Zabpehely' && a.brand === 'Teszt' && a.pack_g === 500 && a.serving_g === 40 && a.source === 'off' && a.added === KDAY, JSON.stringify(a));
  const b = K.offToProduct({status: 1, product: {product_name: 'kJ-s', nutriments: {energy_100g: 418.4}}});
  must(b.per100.kcal === 100, `kJ → kcal: ${b.per100.kcal}`);
  must(b.per100.protein === null && b.per100.carbs === null && b.per100.fat === null && b.brand === null && b.pack_g === null && b.serving_g === null, JSON.stringify(b));
});
check('kamra OFF: nem véges / hiányzó / tartományon kívüli szám → null, sosem 0; számjegyes szöveg számként', async () => {
  const {K} = await kamra();
  const p = K.offToProduct({status: 1, product: {product_name: 'X', product_quantity: '250', product_quantity_unit: 'g', serving_quantity: 'sok',
    nutriments: {'energy-kcal_100g': 'NaN', energy_100g: null, proteins_100g: '12.5', carbohydrates_100g: -3, fat_100g: 1e9}}});
  must(p.per100.kcal === null && p.per100.protein === 12.5 && p.per100.carbs === null && p.per100.fat === null, JSON.stringify(p.per100));
  must(p.pack_g === 250 && p.serving_g === null, `pack=${p.pack_g} serving=${p.serving_g}`);
  for (const junk of [Infinity, {}, [], true, '', '1e400', '12abc'])
    must(K.offToProduct({status: 1, product: {product_name: 'X', nutriments: {'energy-kcal_100g': junk}}}).per100.kcal === null, `elfogadta: ${String(junk)}`);
});
check('kamra OFF: pack_g csak akkor, ha az egység g (ml, kg, hiányzó → null)', async () => {
  const {K} = await kamra();
  const pg = (q, u) => K.offToProduct({status: 1, product: {product_name: 'X', product_quantity: q, product_quantity_unit: u, nutriments: {}}}).pack_g;
  must(pg(330, 'ml') === null && pg(1, 'kg') === null && pg(500, undefined) === null && pg(500, 'g') === 500 && pg(0, 'g') === null,
       `${pg(330, 'ml')} ${pg(1, 'kg')} ${pg(500, undefined)} ${pg(500, 'g')} ${pg(0, 'g')}`);
});
check('kamra OFF: nem talált termék (status 0 / nincs product) → null; a név 200, a márka 200 karakterre vágva', async () => {
  const {K} = await kamra();
  must(K.offToProduct({status: 0}) === null && K.offToProduct({status: 1}) === null && K.offToProduct(null) === null && K.offToProduct('x') === null, 'nem null');
  const p = K.offToProduct({status: 1, product: {product_name: 'n'.repeat(500), brands: 'b'.repeat(500), nutriments: 'nem objektum'}});
  must(p.name.length === 200 && p.brand.length === 200 && p.per100.kcal === null, `${p.name.length}/${p.brand.length}`);
  const noname = K.offToProduct({status: 1, product: {product_name: {a: 1}, brands: 7, nutriments: {}}});
  must(typeof noname.name === 'string' && noname.name.length > 0 && noname.brand === null, JSON.stringify(noname));
});

// ── makró-számtan ───────────────────────────────────────────────────────────────
check('kamra számtan: gramm × per100 / 100, egy tizedesre; a null null marad (nem 0)', async () => {
  const {K} = await kamra();
  must(JSON.stringify(K.macros({kcal: 372, protein: 13.5, carbs: 58.7, fat: 7}, 40)) === JSON.stringify({kcal: 148.8, protein: 5.4, carbs: 23.5, fat: 2.8}),
       JSON.stringify(K.macros({kcal: 372, protein: 13.5, carbs: 58.7, fat: 7}, 40)));
  must(JSON.stringify(K.macros({kcal: 100, protein: null, carbs: 0}, 250)) === JSON.stringify({kcal: 250, protein: null, carbs: 0, fat: null}),
       JSON.stringify(K.macros({kcal: 100, protein: null, carbs: 0}, 250)));
  must(JSON.stringify(K.macros(null, 100)) === JSON.stringify({kcal: null, protein: null, carbs: null, fat: null}), 'per100 nélkül nem csupa null');
});
check('kamra számtan: az összeg a meglévő értékekből áll, és hiányosnak jelölt, ha bármelyik tétel null', async () => {
  const {K} = await kamra();
  const t = K.totals([{kcal: 100, protein: 10, carbs: 0, fat: 1}, {kcal: 50.5, protein: null, carbs: 0, fat: 2}, null, 'szemét']);
  must(t.kcal.sum === 150.5 && !t.kcal.incomplete && t.protein.sum === 10 && t.protein.incomplete && t.carbs.sum === 0 && !t.carbs.incomplete, JSON.stringify(t));
  const e = K.totals([]);
  must(e.kcal.sum === 0 && !e.kcal.incomplete, JSON.stringify(e));
});
check('kamra dátum: a napló kulcsa és az idő a NÉZŐ helyi órájából, számokból (23:30 → aznap, 00:10 → másnap)', async () => {
  for (const [now, day, time] of [[at(2026, 11, 17, 23, 30), '2026-11-17', '23:30'], [at(2026, 11, 18, 0, 10), '2026-11-18', '00:10'], [at(2027, 1, 5, 7, 5), '2027-01-05', '07:05']]) {
    const {K, srv} = await kamra({...emptyDoc(), products: {'111111': TUNA}}, {now});
    await K.eat({code: '111111', grams: 50});
    const log = srv.doc.log;
    must(Object.keys(log).join() === day && log[day][0].time === time, `${JSON.stringify(log)} ≠ ${day} ${time}`);
  }
});

// ── keresés: OFF, gyorsítótár, kézi űrlap ───────────────────────────────────────
const OFF_TUNA = {code: '8004030341234', product_name: 'Tonhal', brands: 'Rio Mare', product_quantity: 160, product_quantity_unit: 'g',
                  serving_quantity: 80, nutriments: {'energy-kcal_100g': 100, proteins_100g: 24, carbohydrates_100g: 0, fat_100g: 0.5}};
check('kamra keresés: az OFF v2 végpontot kéri a megadott mezőkkel, kulcs és fejléc nélkül; a találat kártyán jelenik meg', async () => {
  const {K, srv, p, txt} = await kamra(null, {off: offOk(OFF_TUNA)});
  await K.lookup(' 8004030341234 ');
  must(srv.off.length === 1 && srv.off[0] === 'https://world.openfoodfacts.org/api/v2/product/8004030341234?fields=code,product_name,brands,quantity,product_quantity,product_quantity_unit,serving_quantity,nutriments', `OFF-kérés: ${srv.off}`);
  const f = p.calls.fetch.find(x => x.url.includes('openfoodfacts'));
  must(!(f.init.headers || {}).Authorization && !JSON.stringify(f.init).includes(KEY) && !JSON.stringify(f.init).includes(NKEY), 'kulcs ment az OFF felé');
  const t = txt('productCard');
  must(t.includes('Tonhal') && t.includes('Rio Mare') && /100 kcal/.test(t) && /24 g/.test(t) && /0,5 g/.test(t), `kártya: ${t}`);
  must(/id="eatGrams"[^>]*value="80"/.test(p.el('productCard').innerHTML), 'a Megettem alapértéke nem a serving_g (80)');
});
check('kamra keresés: a talált termék a dokumentum products térképébe kerül, és legközelebb hálózat nélkül jön', async () => {
  const {K, srv, txt} = await kamra(null, {off: offOk(OFF_TUNA)});
  await K.lookup('8004030341234'); await K.flush();
  must(srv.puts.length === 1 && srv.doc.products['8004030341234'] && srv.doc.products['8004030341234'].source === 'off', `PUT-ok: ${srv.puts.length}`);
  must(JSON.stringify(Object.keys(srv.doc.products['8004030341234']).sort()) === JSON.stringify(['added', 'brand', 'name', 'pack_g', 'per100', 'serving_g', 'source']), `kulcsok: ${Object.keys(srv.doc.products['8004030341234'])}`);
  await K.lookup('8004030341234'); await K.flush();
  must(srv.off.length === 1 && srv.puts.length === 1, `újra kérte/írta: ${srv.off.length} OFF, ${srv.puts.length} PUT`);
  const again = await kamra({...emptyDoc(), products: {'8004030341234': TUNA}}, {off: 'net'});
  await again.K.lookup('8004030341234');
  must(again.srv.off.length === 0 && again.txt('productCard').includes('Tonhal sós lében'), 'a tárolt terméket nem a gyorsítótárból adta');
});
check('kamra XSS: <img onerror> az OFF nevében és márkájában szövegként jelenik meg (kártya, kamra, napló)', async () => {
  const {K, p, html, srv} = await kamra(null, {off: offOk({...OFF_TUNA, product_name: HOSTILE, brands: HOSTILE})});
  await K.lookup('8004030341234');
  must(html('productCard').includes('onerror'), 'a próba nem jelent meg a kártyán (nem bizonyít)');
  noRaw(html('productCard'), 'productCard');
  must(html('productCard').includes(esc(HOSTILE)), 'a név nem semlegesítve jelenik meg');
  await K.addPantry('8004030341234', 'pack', 1);
  await K.eat({code: '8004030341234', grams: 50});
  must(srv.doc.pantry[0].name === HOSTILE && srv.doc.log[KDAY][0].name === HOSTILE, 'a dokumentumba nem a nyers név került (kétszeres escape lenne)');
  for (const id of ['pantryBody', 'todayBody']) { must(html(id).includes('onerror'), `${id}: a próba nem jelent meg`); noRaw(html(id), id); }
});
check('kamra XSS: ellenséges kulcs, azonosító és szám-helyén-szöveg a betöltött dokumentumban sem lesz elem', async () => {
  const doc = {...emptyDoc(), targets: {sets: {strength: {kcal: HOSTILE, protein_g: 1, carbs_g: 1, fat_g: 1}, hyrox: HOSTILE, [HOSTILE]: {kcal: 1}}, schedule: {tue: HOSTILE, [HOSTILE]: 'rest'}, updated: HOSTILE},
    products: {[HOSTILE]: {...TUNA, name: HOSTILE, per100: {kcal: HOSTILE, protein: HOSTILE, carbs: 1, fat: 1}}},
    pantry: [{id: HOSTILE, code: HOSTILE, name: HOSTILE, qty: HOSTILE, unit: HOSTILE, added: HOSTILE}, null, 'x'],
    log: {[KDAY]: [{id: HOSTILE, code: HOSTILE, name: HOSTILE, grams: HOSTILE, kcal: HOSTILE, protein: 1, carbs: 1, fat: 1, time: HOSTILE}, null]},
    days: {[KDAY]: HOSTILE}};
  const {K, html} = await kamra(doc, {noValidate: true});
  await K.lookup(HOSTILE);
  must(html('pantryBody').includes('onerror') && html('todayBody').includes('onerror'), 'a próba nem jelent meg (nem bizonyít)');
  for (const id of ['pantryBody', 'todayBody', 'productCard', 'status']) { noRaw(html(id), id); must(!/undefined|NaN|\[object/.test(html(id)), `${id}: undefined/NaN`); }
});
// Attribútum-környezet: az <img …> próbában nincs idézőjel, így az a data-id="…" és a
// value="…" kitörését nem vizsgálja (az esc()-ből a " és a ' kivéve mind a 199 ellenőrzés
// zöld maradt). Itt minden kiírt címkének szigorú alakúnak kell lennie: név + attr="érték".
const QUOTED = ['" onmouseover=alert(1) x="', "' onfocus=alert(1) '", '"><b onclick=alert(1)>x</b><i a="'];
function tagProblems(html) {
  const problems = [];
  const rest = html.replace(/<\/[a-z0-9]+>/gi, '').replace(/<[a-z][a-z0-9]*((?:\s+[a-zA-Z-]+(?:="[^"<>]*")?)*)\s*>/g, (m, attrs) => {
    for (const a of attrs.matchAll(/\s+([a-zA-Z-]+)(?:="[^"]*")?/g))
      if (/^on/i.test(a[1]) || !/^(class|style|type|id|value|placeholder|inputmode|autocomplete|aria-label|aria-pressed|data-act|data-id)$/.test(a[1])) problems.push(`váratlan attribútum: ${a[1]}`);
    return '';
  });
  const i = rest.search(/[<>]/);
  if (i >= 0) problems.push(`szabálytalan címke: …${rest.slice(Math.max(0, i - 30), i + 70)}…`);
  return problems;
}
check('kamra XSS (attribútum): idézőjeles támadó szöveg az azonosítóban, névben, márkában, kódban nem tör ki egyetlen attribútumból sem', async () => {
  must(tagProblems('<button type="button" data-id="" onmouseover=alert(1) x="">x</button>').length > 0 &&
       tagProblems("<input value='' onfocus=alert(1) ''>").length > 0 && tagProblems('<i data-id=""><b onclick=alert(1)>x</b>').length > 0 &&
       tagProblems('<div class="a"><button type="button" data-act="eat" data-id="p_1">x</button></div>').length === 0, 'a vizsgáló nem vizsgál (nem bizonyít)');
  for (const Q of QUOTED) {
    const doc = {...emptyDoc(), targets: {sets: {strength: {kcal: Q, protein_g: Q, carbs_g: 1, fat_g: 1}}, schedule: {tue: Q}, updated: Q},
      products: {[Q]: {...TUNA, name: Q, brand: Q, serving_g: Q, pack_g: Q, source: Q}, '111111': {...TUNA, name: Q, brand: Q}},
      pantry: [{id: Q, code: Q, name: Q, qty: 2, unit: 'pack', added: Q}, {id: 'p_ok', code: '111111', name: Q, qty: Q, unit: Q, added: KDAY}],
      log: {[KDAY]: [{id: Q, code: Q, name: Q, grams: 50, kcal: 1, protein: Q, carbs: 1, fat: 1, time: Q}]}, days: {[KDAY]: Q}};
    const {K, p, html, srv} = await kamra(doc, {noValidate: true, off: offOk({...OFF_TUNA, product_name: Q, brands: Q})});
    const all = hol => { for (const id of ['productCard', 'todayBody', 'pantryBody']) { const pr = tagProblems(html(id)); must(!pr.length, `${JSON.stringify(Q)} — ${hol} — ${id}: ${pr[0]}`); } };
    all('betöltve');
    must(html('pantryBody').includes(`data-act="pantry-inc" data-id="${esc(Q)}"`) && html('todayBody').includes(`data-act="log-del" data-id="${esc(Q)}"`),
         `${JSON.stringify(Q)}: az azonosító nem semlegesítve áll a data-id-ben (nem bizonyít): ${html('pantryBody').slice(0, 300)}`);
    must(html('pantryBody').includes(esc(Q)) && html('todayBody').includes(esc(Q)), 'a név nem jelent meg (nem bizonyít)');
    await K.lookup(Q); all('kártya a dokumentum termékéből');
    must(html('productCard').includes(esc(Q)) && /id="eatGrams"[^>]*value="100"/.test(html('productCard')), `a kártya: ${html('productCard').slice(0, 200)}`);
    p.fire('document:click', {target: {closest: () => ({dataset: {act: 'pantry-eat', id: Q}})}, preventDefault() {}}); all('kártya a kamra-tételből');
    await K.lookup('8004030341234'); all('kártya az OFF-ből');
    fillManual(p, {mName: Q, mBrand: Q, mKcal: '100'}); await K.saveManual(); all('kézi termék');
    must(html('productCard').includes(esc(Q)), 'a kézi termék neve nem jelent meg (nem bizonyít)');
    await K.addPantry('111111', 'g', 100); await K.eat({code: '111111', grams: 10}); all('írás után');
    must(srv.puts.length > 0 && srv.puts[srv.puts.length - 1].body.pantry.some(x => x.name === Q), 'a dokumentumba nem a nyers szöveg került');
  }
});
check('kamra hiányzó adat: tápérték nélküli terméknél "—" áll (nem 0), a napi összeg pedig "legalább"', async () => {
  const {K, txt} = await kamra({...emptyDoc(), products: {'111111': TUNA}}, {off: offOk({product_name: 'Rejtély', nutriments: {'energy-kcal_100g': 200}})});
  await K.lookup('5999999999999');
  const c = txt('productCard');
  must(/200 kcal/.test(c) && (c.match(/—/g) || []).length >= 3 && !/\b0 g\b/.test(c), `kártya: ${c}`);
  await K.eat({code: '111111', grams: 100});
  must(!/legalább/.test(txt('todayBody')), `teljes adatnál is "legalább": ${txt('todayBody')}`);
  await K.eat({code: '5999999999999', grams: 50});
  const t = txt('todayBody');
  must(/200 kcal/.test(t) && !/legalább 200/.test(t), `a kcal teljes (100+100), mégis hiányosnak írja, vagy rossz: ${t}`);
  must(/legalább 24 g/.test(t) && /legalább 0 g/.test(t) && /legalább 0,5 g/.test(t), `a hiányos makrók nem "legalább"-bal állnak: ${t}`);
  must(/Rejtély[^]*?—/.test(t), 'a hiányos tétel sorában nincs "—"');
});
check('kamra hiányzó adat: ha egy makróra EGY tételnek sincs adata, az összeg "—" (nem "legalább 0"), cél mellett sáv és maradék nélkül', async () => {
  const unk = {id: 'l_u1', code: null, name: 'Ismeretlen leves', grams: 300, kcal: null, protein: null, carbs: null, fat: null, time: '12:00'};
  const half = {id: 'l_u2', code: null, name: 'Fél adat', grams: 100, kcal: 150, protein: null, carbs: null, fat: 0, time: '12:30'};
  const a = await kamra({...emptyDoc(), log: {[KDAY]: [unk]}});
  must(!/legalább/.test(a.txt('todayBody')) && !/\b0 (kcal|g)\b/.test(a.txt('todayBody').replace(/300 g/, '')), `cél nélkül: ${a.txt('todayBody')}`);
  must((a.txt('todayBody').match(/—/g) || []).length >= 8, 'nincs "—" az összegben');
  const b = await kamra({...emptyDoc(), targets: TG, log: {[KDAY]: [unk, half]}});
  const t = b.txt('todayBody');
  must(/legalább 150 \/ 2400 kcal/.test(t) && /legfeljebb 2250 kcal maradt/.test(t), `ismert rész: ${t}`);
  must(/Fehérje\s*— \/ 165 g/.test(t) && /Szénhidrát\s*— \/ 280 g/.test(t) && !/legalább 0 \/ (165|280)/.test(t), `ismeretlen makró: ${t}`);
  must(/Zsír\s*legalább 0 \/ 75 g/.test(t), `a valódi (ismert) 0 nem maradhat ki: ${t}`);
  must(bars(b.html('todayBody')) === 2, `sávok (kcal, zsír): ${bars(b.html('todayBody'))}`);
  const tt = a.K.totals([unk, half]);
  must(tt.protein.known === 0 && tt.kcal.known === 1 && tt.fat.known === 1 && tt.fat.sum === 0, JSON.stringify(tt));
});
check('kamra keresés: ismeretlen vonalkód → kézi űrlap a vonalkóddal, hálózati hiba → szintén, más szöveggel', async () => {
  const miss = await kamra();
  await miss.K.lookup('5990000000001');
  must(miss.p.el('manualForm').hidden === false && miss.p.el('mCode').value === '5990000000001', `űrlap: hidden=${miss.p.el('manualForm').hidden}, kód=${miss.p.el('mCode').value}`);
  must(/nem találhat/i.test(miss.txt('manualNote')), `szöveg: ${miss.txt('manualNote')}`);
  must(miss.srv.puts.length === 0, 'nem talált termékre is írt');
  const net = await kamra(null, {off: 'net'});
  await net.K.lookup('5990000000001');
  must(net.p.el('manualForm').hidden === false && /hálózat/i.test(net.txt('manualNote')), `szöveg: ${net.txt('manualNote')}`);
  const s500 = await kamra(null, {off: () => new Response('<html>hiba</html>', {status: 503})});
  await s500.K.lookup('5990000000001');
  must(s500.p.el('manualForm').hidden === false, '503-ra nincs kézi űrlap');
});
check('kamra keresés: nem számjegyes kód (pl. QR-ben URL) nem megy el az OFF-nek; kézi űrlap nyílik', async () => {
  const {K, srv, p, html} = await kamra();
  await K.lookup('https://evil.example/?q=' + HOSTILE);
  must(srv.off.length === 0, `elment az OFF-nek: ${srv.off}`);
  must(p.el('manualForm').hidden === false && !p.el('mCode').value, `kód az űrlapon: ${p.el('mCode').value}`);
  noRaw(html('manualNote'), 'manualNote');
});
const fillManual = (p, v) => { for (const [k, x] of Object.entries({mCode: '', mName: '', mBrand: '', mKcal: '', mProtein: '', mCarbs: '', mFat: '', mPack: '', ...v})) p.el(k).value = x; };
check('kamra kézi űrlap: vonalkód nélkül m_<véletlen> azonosító; üres mező null (nem 0); tizedesvessző is jó', async () => {
  const {K, srv, p, txt} = await kamra();
  fillManual(p, {mName: ' Házi granola ', mKcal: '450', mProtein: '12,5', mPack: ''});
  await K.saveManual();
  const ids = Object.keys(srv.doc.products);
  must(ids.length === 1 && /^m_[a-z0-9]{6,20}$/.test(ids[0]), `azonosító: ${ids}`);
  const pr = srv.doc.products[ids[0]];
  must(JSON.stringify(pr) === JSON.stringify({name: 'Házi granola', brand: null, per100: {kcal: 450, protein: 12.5, carbs: null, fat: null}, pack_g: null, serving_g: null, source: 'manual', added: KDAY}), JSON.stringify(pr));
  must(txt('productCard').includes('Házi granola') && p.el('manualForm').hidden === true, 'mentés után nem a termékkártya látszik');
});
check('kamra kézi űrlap: vonalkóddal a vonalkód a kulcs; név nélkül vagy rossz számmal nincs mentés', async () => {
  const {K, srv, p, txt} = await kamra();
  fillManual(p, {mCode: '5990000000001', mName: 'Túró Rudi', mBrand: 'Pöttyös', mKcal: '380', mProtein: '10', mCarbs: '35', mFat: '22', mPack: '30'});
  await K.saveManual();
  must(srv.doc.products['5990000000001'] && srv.doc.products['5990000000001'].pack_g === 30 && srv.doc.products['5990000000001'].brand === 'Pöttyös', JSON.stringify(srv.doc.products));
  const n = srv.puts.length;
  for (const bad of [{mName: ''}, {mName: 'X', mKcal: '-5'}, {mName: 'X', mFat: 'sok'}, {mName: 'X', mKcal: '200000'}, {mName: 'X', mCode: 'a b<c'}, {mName: 'n'.repeat(201)}]) {
    fillManual(p, bad);
    await K.saveManual();
    must(srv.puts.length === n, `mentett hibás űrlapot: ${JSON.stringify(bad).slice(0, 60)}`);
    must(txt('msg').length > 0, 'nem mondja meg, mi a hiba');
  }
});

// ── kamra-lista ─────────────────────────────────────────────────────────────────
check('kamra lista: Kamrába +1 csomag (ugyanaz a termék összevonva), grammban külön tétel; a lista mutatja', async () => {
  const {K, srv, txt} = await kamra({...emptyDoc(), products: {'111111': TUNA}});
  await K.addPantry('111111', 'pack', 1);
  await K.addPantry('111111', 'pack', 1);
  await K.addPantry('111111', 'g', 250);
  const pa = srv.doc.pantry;
  must(pa.length === 2 && pa[0].qty === 2 && pa[0].unit === 'pack' && pa[1].qty === 250 && pa[1].unit === 'g', JSON.stringify(pa));
  must(/^p_[a-z0-9]{6,20}$/.test(pa[0].id) && pa[0].code === '111111' && pa[0].name === TUNA.name && pa[0].added === KDAY, JSON.stringify(pa[0]));
  must(JSON.stringify(Object.keys(pa[0]).sort()) === JSON.stringify(['added', 'code', 'id', 'name', 'qty', 'unit']), `kulcsok: ${Object.keys(pa[0])}`);
  const t = txt('pantryBody');
  must(t.includes('Tonhal sós lében') && /2 csomag/.test(t) && /250 g/.test(t), `lista: ${t}`);
  for (const bad of [0, -1, NaN, 200000, '5']) { const n = srv.puts.length; await K.addPantry('111111', 'g', bad); must(srv.puts.length === n, `rossz mennyiséget mentett: ${bad}`); }
});
check('kamra lista: + / − lépés, nullánál a tétel kikerül; az eltávolítás gomb töröl', async () => {
  const doc = {...emptyDoc(), products: {'111111': TUNA}, pantry: [{id: 'p_a', code: '111111', name: 'Tonhal', qty: 1, unit: 'pack', added: KDAY},
                                                                  {id: 'p_b', code: null, name: 'Rizs', qty: 120, unit: 'g', added: KDAY}]};
  const {K, srv, html} = await kamra(doc);
  must(/data-act="pantry-inc"[^>]*data-id="p_a"/.test(html('pantryBody')) && /data-act="pantry-dec"/.test(html('pantryBody')) && /data-act="pantry-del"/.test(html('pantryBody')), 'nincs +/−/eltávolítás gomb');
  await K.pantryStep('p_a', 1);
  must(srv.doc.pantry[0].qty === 2, `+ után: ${srv.doc.pantry[0].qty}`);
  await K.pantryStep('p_a', -1); await K.pantryStep('p_a', -1);
  must(!srv.doc.pantry.some(x => x.id === 'p_a'), 'nullánál nem került ki');
  await K.pantryStep('p_b', -1);
  must(srv.doc.pantry[0].qty === 70, `g-lépés (50): ${srv.doc.pantry[0].qty}`);
  await K.pantryRemove('p_b');
  must(srv.doc.pantry.length === 0, 'az eltávolítás nem törölt');
  const n = srv.puts.length; await K.pantryRemove('nincs-ilyen');
  must(srv.puts.length === n, 'nem létező tételre is írt');
});
check('kamra lista: a kamrából evés csökkenti (g: grammal; csomag: gramm/pack_g); ismeretlen csomagtömegnél nem talál ki semmit', async () => {
  const doc = {...emptyDoc(), products: {'111111': TUNA, 'm_lekvar': MYST}, pantry: [
    {id: 'p_pack', code: '111111', name: 'Tonhal', qty: 2, unit: 'pack', added: KDAY},
    {id: 'p_g', code: '111111', name: 'Tonhal', qty: 100, unit: 'g', added: KDAY},
    {id: 'p_myst', code: 'm_lekvar', name: 'Házi lekvár', qty: 1, unit: 'pack', added: KDAY}]};
  const {K, srv, txt} = await kamra(doc);
  const q = id => (srv.doc.pantry.find(x => x.id === id) || {}).qty;
  await K.eat({code: '111111', pantryId: 'p_pack', grams: 80});
  must(q('p_pack') === 1.5, `csomag: ${q('p_pack')}`);
  await K.eat({code: '111111', pantryId: 'p_g', grams: 60});
  must(q('p_g') === 40, `gramm: ${q('p_g')}`);
  await K.eat({code: '111111', pantryId: 'p_g', grams: 60});
  must(q('p_g') === undefined, 'a kiürült tétel a listán maradt');
  await K.eat({code: 'm_lekvar', pantryId: 'p_myst', grams: 30});
  must(q('p_myst') === 1 && /csomag tömege ismeretlen/i.test(txt('msg')), `ismeretlen csomag: ${q('p_myst')} / ${txt('msg')}`);
  must(srv.doc.log[KDAY].length === 4, `napló: ${srv.doc.log[KDAY].length}`);
});

// ── napló + mai nap ─────────────────────────────────────────────────────────────
check('kamra napló: a Megettem tétele grammot, számolt makrókat, HH:MM időt tárol; törölhető', async () => {
  const {K, srv, txt, html} = await kamra({...emptyDoc(), products: {'111111': TUNA}});
  await K.eat({code: '111111', grams: 80});
  const e = srv.doc.log[KDAY][0];
  must(/^l_[a-z0-9]{6,20}$/.test(e.id) && e.code === '111111' && e.name === TUNA.name && e.grams === 80 && e.kcal === 80 && e.protein === 19.2 && e.carbs === 0 && e.fat === 0.4 && e.time === '13:05', JSON.stringify(e));
  must(JSON.stringify(Object.keys(e).sort()) === JSON.stringify(['carbs', 'code', 'fat', 'grams', 'id', 'kcal', 'name', 'protein', 'time']), `kulcsok: ${Object.keys(e)}`);
  must(txt('todayBody').includes('Tonhal sós lében') && /80 g/.test(txt('todayBody')) && /13:05/.test(txt('todayBody')), `mai nap: ${txt('todayBody')}`);
  must(new RegExp(`data-act="log-del"[^>]*data-id="${e.id}"`).test(html('todayBody')), 'nincs törlés gomb a tételen');
  await K.logDelete(e.id);
  must(!(srv.doc.log[KDAY] || []).length && !txt('todayBody').includes('Tonhal'), 'a törlés nem törölt');
  for (const bad of [0, -5, NaN, '80', 200000, null]) { const n = srv.puts.length; await K.eat({code: '111111', grams: bad}); must(srv.puts.length === n, `rossz grammot mentett: ${bad}`); }
});
check('kamra napló: a Megettem alapértéke serving_g, különben 100; csak a mai nap tételei látszanak', async () => {
  const doc = {...emptyDoc(), products: {'111111': TUNA, 'm_lekvar': MYST},
    log: {'2026-11-16': [{id: 'l_old', code: null, name: 'Tegnapi vacsora', grams: 300, kcal: 600, protein: 30, carbs: 60, fat: 20, time: '19:00'}]}};
  const {K, p, txt} = await kamra(doc);
  await K.lookup('111111');
  must(/id="eatGrams"[^>]*value="80"/.test(p.el('productCard').innerHTML), 'serving_g-vel nem 80');
  await K.lookup('m_lekvar');
  must(/id="eatGrams"[^>]*value="100"/.test(p.el('productCard').innerHTML), 'serving_g nélkül nem 100');
  must(!txt('todayBody').includes('Tegnapi vacsora') && /még nincs/i.test(txt('todayBody')), `mai nap: ${txt('todayBody')}`);
});

// ── célok: négy naptípus (sets), heti rend (schedule), napi felülírás (days) ─────
// A számok a teszt saját mintái — a lapban nincs beégetett cél, adatként kerülnek be.
const TYPES4 = ['strength', 'hyrox', 'rest', 'maintenance'], WD = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const HU = {strength: 'Erőedzés', hyrox: 'HYROX', rest: 'Pihenőnap', maintenance: 'Fenntartó hét'};
const tset = (kcal, protein_g, carbs_g, fat_g) => ({kcal, protein_g, carbs_g, fat_g});
const S4 = {strength: tset(2400, 165, 280, 75), hyrox: tset(2600, 165, 320, 75), rest: tset(2300, 165, 255, 75), maintenance: tset(2750, 165, 330, 80)};
const SCHED = {mon: 'rest', tue: 'strength', wed: 'rest', thu: 'strength', fri: 'strength', sat: 'hyrox', sun: 'rest'};
const TG = {sets: S4, schedule: SCHED, updated: KDAY};
const E700 = {id: 'l_1', code: '111111', name: 'Tonhal', grams: 700, kcal: 700, protein: 168, carbs: 0, fat: 3.5, time: '12:00'};
const fed = (extra, day = KDAY) => ({...emptyDoc(), products: {'111111': TUNA}, log: {[day]: [clone(E700)]}, ...extra});
const bars = html => (html.match(/class="bar"/g) || []).length;
const pressed = (html, type) => new RegExp(`aria-pressed="true"[^>]*data-act="day-${type}"`).test(html);
const anyGoal = t => /\b(2400|2600|2300|2750)\b/.test(t);

check('kamra célok: cél nélkül "nincs cél beállítva", sáv nélkül — az összeg akkor is látszik', async () => {
  const {txt, html} = await kamra(fed());
  must(/nincs cél beállítva/.test(txt('todayBody')) && bars(html('todayBody')) === 0, `mai nap: ${txt('todayBody')}`);
  must(/700 kcal/.test(txt('todayBody')) && /168 g/.test(txt('todayBody')), 'az összeg nem látszik');
});
check('kamra naptípus: felülírás nélkül a heti rend adja — a hét mind a 7 napjára —, és kiírja, hogy "heti rend szerint"', async () => {
  for (let i = 0; i < 7; i++) {
    const dn = 16 + i, day = `2026-11-${dn}`, type = SCHED[WD[i]];        // 2026-11-16 hétfő
    const {txt, html} = await kamra(fed({targets: TG}, day), {now: at(2026, 11, dn, 9, 0)});
    const t = txt('todayBody');
    must(t.includes(`700 / ${S4[type].kcal} kcal`), `${day} (${WD[i]} → ${type}): ${t.slice(0, 160)}`);
    must(new RegExp(`${HU[type]}[^]{0,30}heti rend szerint`).test(t) && !/kézzel/.test(t), `${day}: a nap sora: ${t.slice(0, 120)}`);
    must(bars(html('todayBody')) === 4 && pressed(html('todayBody'), type), `${day}: sávok / kapcsoló`);
  }
});
check('kamra naptípus: a sávok és a maradék a nap készletéhez mérnek (kedd = erőedzés)', async () => {
  const {txt, html} = await kamra(fed({targets: TG}));
  const t = txt('todayBody');
  must(/700 \/ 2400 kcal/.test(t) && /még 1700 kcal/.test(t) && /168 \/ 165 g/.test(t) && /túl: 3 g/.test(t) && /3,5 \/ 75 g/.test(t) && /még 71,5 g/.test(t), `mai nap: ${t}`);
  must(/width:29%/.test(html('todayBody')) && /width:100%/.test(html('todayBody')), 'a sávok szélessége (29% / 100%)');
  must(!/2600|2300|2750/.test(t), 'más készlet száma is látszik');
});
check('kamra naptípus: a days[nap] felülírás erősebb a heti rendnél ("kézzel beállítva"); más nap felülírása és a szemét érték nem hat', async () => {
  const {txt, html} = await kamra(fed({targets: TG, days: {[KDAY]: 'hyrox'}}));
  must(/700 \/ 2600 kcal/.test(txt('todayBody')) && /HYROX[^]{0,30}kézzel beállítva/.test(txt('todayBody')) && pressed(html('todayBody'), 'hyrox'), `felülírás: ${txt('todayBody').slice(0, 160)}`);
  for (const days of [{'2026-11-16': 'hyrox', '2026-11-18': 'maintenance'}, {[KDAY]: 'cheat'}, {[KDAY]: 5}, {[KDAY]: null}]) {
    const o = await kamra(fed({targets: TG, days}));
    must(/700 \/ 2400 kcal/.test(o.txt('todayBody')) && /heti rend szerint/.test(o.txt('todayBody')), `days=${JSON.stringify(days)}: ${o.txt('todayBody').slice(0, 120)}`);
  }
});
check('kamra naptípus: a négyes kapcsoló (Erőedzés / HYROX / Pihenőnap / Fenntartó hét) a days[ma]-t írja; "vissza a heti rendhez" törli', async () => {
  const {K, srv, txt, html} = await kamra(fed({targets: TG}));
  for (const type of TYPES4) must(new RegExp(`data-act="day-${type}"[^>]*>${HU[type]}<`).test(html('todayBody')), `nincs ${HU[type]} gomb`);
  await K.setDay('rest');
  must(JSON.stringify(srv.doc.days) === JSON.stringify({[KDAY]: 'rest'}), `days: ${JSON.stringify(srv.doc.days)}`);
  must(/700 \/ 2300 kcal/.test(txt('todayBody')) && pressed(html('todayBody'), 'rest') && /kézzel beállítva/.test(txt('todayBody')), `pihenőnap: ${txt('todayBody').slice(0, 160)}`);
  await K.setDay('maintenance');
  must(srv.doc.days[KDAY] === 'maintenance' && /700 \/ 2750 kcal/.test(txt('todayBody')), 'fenntartó');
  must(/data-act="day-auto"/.test(html('todayBody')), 'nincs "vissza a heti rendhez"');
  await K.setDay('auto');
  must(JSON.stringify(srv.doc.days) === '{}' && /700 \/ 2400 kcal/.test(txt('todayBody')) && !/data-act="day-auto"/.test(html('todayBody')), `vissza: ${JSON.stringify(srv.doc.days)}`);
  const n = srv.puts.length; await K.setDay('cheat'); await K.setDay('auto');
  must(srv.puts.length === n, 'ismeretlen naptípust / üres törlést mentett');
});
check('kamra naptípus: a "fenntartó hét" gyorsgomb a hét mind a 7 napját (hétfő–vasárnap) EGY írással állítja', async () => {
  const week = (y, m, d) => Array.from({length: 7}, (_, i) => { const x = new Date(y, m - 1, d + i), p = n => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`; });
  for (const [now, mon] of [[at(2026, 11, 17, 13, 5), [2026, 11, 16]], [at(2026, 11, 22, 23, 50), [2026, 11, 16]], [at(2026, 11, 16, 0, 5), [2026, 11, 16]],
                            [at(2026, 12, 1, 8, 0), [2026, 11, 30]], [at(2027, 1, 1, 8, 0), [2026, 12, 28]], [at(2026, 3, 29, 12, 0), [2026, 3, 23]]]) {
    const {K, srv, html} = await kamra({...emptyDoc(), targets: TG, days: {'2026-01-05': 'hyrox'}}, {now});
    must(/data-act="week-maintenance"/.test(html('todayBody')), 'nincs gyorsgomb');
    await K.maintenanceWeek();
    const want = week(...mon);
    must(srv.puts.length === 1, `${want[0]}: ${srv.puts.length} írás (1 kell)`);
    const got = Object.keys(srv.doc.days).filter(k => k !== '2026-01-05').sort();
    must(JSON.stringify(got) === JSON.stringify(want), `hét: ${got} ≠ ${want}`);
    must(got.every(k => srv.doc.days[k] === 'maintenance') && srv.doc.days['2026-01-05'] === 'hyrox', JSON.stringify(srv.doc.days));
    must(new Date(...mon.map((v, i) => (i === 1 ? v - 1 : v))).getDay() === 1, 'a teszt hétfője nem hétfő');
    await K.maintenanceWeek();
    must(srv.puts.length === 1, 'a már beállított hétre újra írt');
  }
});
check('kamra naptípus: ha a nap készlete null, vagy a típus ismeretlen → "erre a naptípusra nincs cél", sáv nélkül; más készletre SOSEM esik vissza', async () => {
  const cases = [
    ['null készlet', {sets: {...S4, hyrox: null}, schedule: SCHED, updated: KDAY}, {[KDAY]: 'hyrox'}],
    ['a heti rend szerinti készlet null', {sets: {...S4, strength: null}, schedule: SCHED, updated: KDAY}, {}],
    ['nincs heti rend erre a napra', {sets: S4, schedule: {mon: 'rest'}, updated: KDAY}, {}],
    ['nincs schedule', {sets: S4, updated: KDAY}, {}],
    ['a készlet nem objektum', {sets: {...S4, strength: 'sok'}, schedule: SCHED, updated: KDAY}, {}],
    ['nincs sets', {schedule: SCHED, updated: KDAY}, {}],
  ];
  for (const [nev, targets, days] of cases) {
    const {txt, html} = await kamra(fed({targets, days}));
    const t = txt('todayBody');
    must(/erre a naptípusra nincs cél/.test(t) && bars(html('todayBody')) === 0, `${nev}: ${t.slice(0, 160)}`);
    must(!anyGoal(t) && /700 kcal/.test(t) && !/undefined|null|NaN/.test(t), `${nev}: más készlet száma / szemét látszik: ${t.slice(0, 200)}`);
  }
  const unk = await kamra(fed({targets: {sets: S4, schedule: {}, updated: KDAY}}));
  must(/naptípus nincs megadva/.test(unk.txt('todayBody')) && !TYPES4.some(x => pressed(unk.html('todayBody'), x)), `ismeretlen típus: ${unk.txt('todayBody').slice(0, 120)}`);
});
check('kamra naptípus: a hét napja a helyi dátum SZÁMAIBÓL jön (Safari-biztos: nincs dátum-szöveg értelmezés)', async () => {
  const {K} = await kamra();
  for (const [d, w] of [['2026-11-16', 'mon'], ['2026-11-17', 'tue'], ['2026-11-18', 'wed'], ['2026-11-19', 'thu'], ['2026-11-20', 'fri'], ['2026-11-21', 'sat'],
                        ['2026-11-22', 'sun'], ['2028-02-29', 'tue'], ['2026-03-29', 'sun'], ['2026-10-25', 'sun'], ['2027-01-01', 'fri'], ['2026-12-31', 'thu']])
    must(K.weekday(d) === w, `${d}: ${K.weekday(d)} ≠ ${w}`);
  for (const bad of ['2026-02-30', '2026-13-01', '2026-11-17T10:00', '17/11/2026', '', null, undefined, 20261117])
    must(K.weekday(bad) === null, `elfogadta: ${String(bad)}`);
  const js = read('kamra.html');
  must(!/new Date\(\s*[`'"]/.test(js) && !/Date\.parse|toISOString|toLocale|Intl\./.test(js), 'dátum-szöveg értelmezés vagy locale-függő formázás a lapban');
  must(/new Date\(\s*y\s*,\s*m\s*-\s*1\s*,/.test(js), 'a hét napja nem számokból épített dátumból jön');
});
check('kamra célok: túllépésnél "túl", hiányos összegnél "legfeljebb … maradt"; 0 vagy hibás célnál "—" és nincs sáv', async () => {
  const doc = fed({targets: {sets: {...S4, strength: {kcal: 500, protein_g: 180, carbs_g: 0, fat_g: 'sok'}}, schedule: SCHED, updated: KDAY}});
  doc.log[KDAY].push({id: 'l_2', code: null, name: 'Ismeretlen', grams: 100, kcal: 100, protein: null, carbs: 5, fat: 1, time: '12:30'});
  const {txt, html} = await kamra(doc);
  const t = txt('todayBody');
  must(/800 \/ 500 kcal/.test(t) && /túl: 300/.test(t), `túllépés: ${t}`);
  must(/legalább 168 \/ 180 g/.test(t) && /legfeljebb 12/.test(t), `hiányos: ${t}`);
  must(bars(html('todayBody')) === 2, `sávok (kcal, fehérje): ${bars(html('todayBody'))}`);
  must(!/Infinity|NaN/.test(t) && /width:100%/.test(html('todayBody')), 'a sáv 100% fölé megy vagy NaN');
});
const TF4 = ['kcal', 'protein_g', 'carbs_g', 'fat_g'];
const fillT = (p, sets, sched) => {
  for (const t of TYPES4) TF4.forEach(k => { p.el(`t_${t}_${k}`).value = sets[t] ? String(sets[t][k]) : ''; });
  for (const d of WD) p.el(`s_${d}`).value = sched[d] == null ? '' : sched[d];
};
check('kamra célok űrlap: mind a négy készletet és a heti rendet menti; az üres készlet null (a kulcs megmarad); hibásnál nincs mentés', async () => {
  const {K, srv, p, txt} = await kamra();
  fillT(p, S4, SCHED);
  await K.saveTargets();
  must(JSON.stringify(srv.doc.targets) === JSON.stringify(TG), JSON.stringify(srv.doc.targets));
  must(p.el('targetsForm').hidden === true, 'mentés után nyitva maradt');
  fillT(p, {...S4, hyrox: null, maintenance: null}, SCHED);
  await K.saveTargets();
  must(JSON.stringify(srv.doc.targets.sets) === JSON.stringify({...S4, hyrox: null, maintenance: null}) && Object.keys(srv.doc.targets.sets).length === 4, JSON.stringify(srv.doc.targets.sets));
  const n = srv.puts.length;
  const part = {...S4, rest: {kcal: 2300, protein_g: '', carbs_g: '', fat_g: ''}};
  for (const [sets, sched, nev] of [[part, SCHED, 'félig kitöltött készlet'], [{...S4, strength: tset(-1, 165, 280, 75)}, SCHED, 'negatív'],
                                    [{...S4, strength: tset('x', 165, 280, 75)}, SCHED, 'nem szám'], [{...S4, hyrox: tset(2600, 165, 320, 1e9)}, SCHED, 'túl nagy'],
                                    [S4, {...SCHED, wed: ''}, 'hiányzó nap a heti rendben'], [S4, {...SCHED, sun: 'cheat'}, 'ismeretlen típus a heti rendben']]) {
    p.el('msg').textContent = '';
    fillT(p, sets, sched);
    await K.saveTargets();
    must(srv.puts.length === n && txt('msg').length > 0, `mentett hibás célokat: ${nev}`);
  }
});
check('kamra célok űrlap: megnyitáskor a tárolt értékekkel töltődik (a null készlet üres marad, nem 0); cél nélkül minden üres', async () => {
  const {K, p} = await kamra({...emptyDoc(), targets: {sets: {...S4, rest: null}, schedule: SCHED, updated: KDAY}});
  K.openTargets();
  must(p.el('targetsForm').hidden === false && p.el('t_strength_kcal').value === '2400' && p.el('t_maintenance_fat_g').value === '80', `erőedzés: ${p.el('t_strength_kcal').value}`);
  must(p.el('t_rest_kcal').value === '' && p.el('t_rest_fat_g').value === '', `pihenőnap: "${p.el('t_rest_kcal').value}"`);
  must(p.el('s_mon').value === 'rest' && p.el('s_sat').value === 'hyrox', `heti rend: ${p.el('s_mon').value}/${p.el('s_sat').value}`);
  const e = await kamra();
  e.K.openTargets();
  must(e.p.el('t_strength_kcal').value === '' && e.p.el('s_mon').value === '', 'cél nélkül is kitalált értéket mutat');
  const html = read('kamra.html');
  must(!/2400|2600|2750|165/.test(html.replace(/sha384-[A-Za-z0-9+/]+/, '')), 'a gazda valódi céljai be vannak égetve a lapba');
});

// ── írás: kulcsok, 409, hibák ───────────────────────────────────────────────────
check('kamra írás: a GET az olvasókulccsal, a PUT az írókulccsal megy, a betöltéskori rev-vel és pontosan a 7 kulccsal', async () => {
  const {K, srv} = await kamra({...emptyDoc(), rev: 41, products: {'111111': TUNA}});
  must(srv.getAuth === `Bearer ${KEY}`, `GET: ${srv.getAuth}`);
  await K.eat({code: '111111', grams: 50});
  must(srv.puts.length === 1 && srv.puts[0].auth === `Bearer ${NKEY}` && srv.puts[0].body.rev === 41, `PUT: ${JSON.stringify(srv.puts.map(x => [x.auth, x.body.rev]))}`);
  must(JSON.stringify(Object.keys(srv.puts[0].body).sort()) === JSON.stringify(['days', 'log', 'pantry', 'products', 'rev', 'targets', 'version']), `kulcsok: ${Object.keys(srv.puts[0].body)}`);
  await K.eat({code: '111111', grams: 50});
  must(srv.puts[1].body.rev === 42 && srv.doc.log[KDAY].length === 2, `a második írás rev-je: ${srv.puts[1].body.rev}`);
  must(!srv.puts.some(x => JSON.stringify(x.body).includes(KEY) || JSON.stringify(x.body).includes(NKEY)), 'kulcs került a dokumentumba');
});
check('kamra írás: írókulcs nélkül nincs PUT — a lap kimondja, hogy csak olvasható, és nem kínál író gombot', async () => {
  const doc = {...emptyDoc(), products: {'111111': TUNA}, pantry: [{id: 'p_a', code: '111111', name: 'Tonhal', qty: 1, unit: 'pack', added: KDAY}]};
  const {K, srv, p, txt, html} = await kamra(doc, {storage: PAIRED, off: offOk(OFF_TUNA)});
  must(/csak olvasható/i.test(txt('status')), `állapot: ${txt('status')}`);
  must(txt('pantryBody').includes('Tonhal'), 'olvasni sem tud (nem bizonyít)');
  await K.eat({code: '111111', grams: 50}); await K.addPantry('111111', 'pack', 1); await K.pantryStep('p_a', 1); await K.pantryRemove('p_a');
  await K.setDay('rest'); await K.lookup('8004030341234'); await K.lookup('111111');
  fillT(p, S4, SCHED); await K.saveTargets(); await K.maintenanceWeek(); await K.flush();
  fillManual(p, {mName: 'X'}); await K.saveManual();
  must(srv.puts.length === 0 && !p.calls.fetch.some(f => String(f.init.method || 'GET').toUpperCase() !== 'GET'), `írt kulcs nélkül: ${srv.puts.length}`);
  await K.lookup('111111');
  must(txt('productCard').includes('Tonhal') && !/data-act="(eat|pantry-add-pack|pantry-add-g)"/.test(html('productCard')), `a kártya író gombot kínál: ${txt('productCard')}`);
  must(!/data-act="(pantry-inc|pantry-dec|pantry-del|pantry-eat|log-del|day-[a-z]+|week-maintenance)"/.test(html('pantryBody') + html('todayBody')), 'a listák író gombot kínálnak');
  const ro = await kamra(fed({targets: TG}), {storage: PAIRED});
  must(/Erőedzés[^]{0,30}heti rend szerint/.test(ro.txt('todayBody')) && bars(ro.html('todayBody')) === 4, 'írókulcs nélkül a nap típusa / a sávok nem látszanak');
});
check('kamra írás: 409-re újratölt, a felhasználó utolsó lépését EGYSZER újra alkalmazza, és a másik eszköz írása megmarad', async () => {
  const other = d => { d.pantry.push({id: 'p_masik', code: null, name: 'A másik eszköz tétele', qty: 3, unit: 'pack', added: KDAY}); };
  const {K, srv, txt} = await kamra({...emptyDoc(), rev: 7, products: {'111111': TUNA}}, {conflicts: 1, other});
  const g0 = srv.gets;
  await K.eat({code: '111111', grams: 80});
  must(srv.puts.length === 2 && srv.gets === g0 + 1, `${srv.puts.length} PUT, ${srv.gets - g0} újratöltés`);
  must(srv.puts[0].body.rev === 7 && srv.puts[1].body.rev === 8, `rev-ek: ${srv.puts.map(x => x.body.rev)}`);
  must(srv.doc.pantry.some(x => x.id === 'p_masik'), 'felülírta a másik eszköz írását');
  must(srv.doc.log[KDAY].length === 1 && srv.doc.log[KDAY][0].id === srv.puts[0].body.log[KDAY][0].id, 'a lépés nem (vagy kétszer, más azonosítóval) került be');
  must(txt('pantryBody').includes('A másik eszköz tétele') && txt('todayBody').includes('Tonhal'), 'a felület nem az egyesített állapotot mutatja');
  await K.eat({code: '111111', grams: 20});
  must(srv.puts.length === 3 && srv.puts[2].body.rev === 9 && srv.doc.log[KDAY].length === 2, 'a 409 utáni következő írás nem a friss rev-vel megy');
});
check('kamra írás: második 409-re hibát ír, nem próbál harmadszor, és SOSEM ír felül csendben — a lépés "nincs mentve" marad', async () => {
  const o = await kamra({...emptyDoc(), products: {'111111': TUNA}}, {conflicts: 2});
  const ok = await o.K.eat({code: '111111', grams: 80});
  await new Promise(r => setTimeout(r, 100));
  must(ok === false && o.srv.puts.length === 2, `PUT-ok: ${o.srv.puts.length}`);
  must(/nem sikerült|nem mentődött/i.test(o.txt('msg')) && unsaved(o), `üzenet: ${o.txt('msg')}`);
  must(!o.srv.doc.log[KDAY] && o.txt('todayBody').includes('Tonhal'), 'a szerverre került, vagy a lapról eltűnt a lépés');
});
check('kamra írás: 401 / 400 / 413 → hibaüzenet, a lépés visszavonva (az újrapróba értelmetlen), nincs újrapróba', async () => {
  for (const [st, szo] of [[401, /írókulcs/i], [400, /elutasította/i], [413, /túl nagy/i]]) {
    const o = await kamra({...emptyDoc(), products: {'111111': TUNA}}, {putStatus: st});
    const ok = await o.K.eat({code: '111111', grams: 80});
    await new Promise(r => setTimeout(r, 60));
    must(ok === false && o.srv.puts.length === 1 && szo.test(o.txt('msg')), `${st}: ${o.srv.puts.length} PUT, "${o.txt('msg')}"`);
    must(!o.txt('todayBody').includes('Tonhal') && !unsaved(o), `${st}: a nem mentett tétel látszik`);
  }
});
check('kamra írás: ha a betöltés nem sikerült, SEMMIT nem ír (üres alapdokumentum nem írhat felül jó adatot)', async () => {
  for (const getFail of [500, 401, 'net']) {
    const {K, srv, p, txt} = await kamra({...emptyDoc(), products: {'111111': TUNA}}, {getFail});
    must(/nem sikerült/i.test(txt('status')), `${getFail}: állapot: ${txt('status')}`);
    await K.eat({code: '111111', grams: 80}); await K.setDay('rest'); await K.addPantry('111111', 'pack', 1);
    fillManual(p, {mName: 'X'}); await K.saveManual();
    must(srv.puts.length === 0, `${getFail}: írt betöltetlen dokumentumra`);
  }
  const bad = await kamra({version: 1, rev: 'x', pantry: 'nem lista'});
  await bad.K.setDay('rest');
  must(bad.srv.puts.length === 0 && /nem sikerült|hibás/i.test(bad.txt('status')), `hibás dokumentum: ${bad.txt('status')}`);
});
check('kamra írás: a hiányzó részek (régi alapdokumentum days nélkül) üres alapot kapnak, és az írás teljes dokumentum', async () => {
  const {K, srv} = await kamra({version: 1, rev: 3, targets: null, products: {}, pantry: [], log: {}});
  await K.setDay('rest');
  must(srv.puts.length === 1 && JSON.stringify(srv.puts[0].body) === JSON.stringify({version: 1, rev: 3, targets: null, products: {}, pantry: [], log: {}, days: {[KDAY]: 'rest'}}), JSON.stringify(srv.puts[0] && srv.puts[0].body));
});
check('kamra párosítatlanul: nincs lekérés, a lap megmondja, mit kell tenni', async () => {
  const {p, txt} = await kamra(null, {storage: {}});
  must(!p.calls.fetch.length && /párosít/i.test(txt('status')), `lekérések: ${p.calls.fetch.length}, állapot: ${txt('status')}`);
});

// ── demó ────────────────────────────────────────────────────────────────────────
check('kamra demó: ?demo=1 mintaadatot mutat, a végpontot nem kéri, és soha nem ír (kulcsokkal sem)', async () => {
  const {K, srv, p, txt, html} = await kamra(null, {url: `${BASE}kamra.html?demo=1`, storage: WPAIRED});
  must(/demó/i.test(txt('status')), `állapot: ${txt('status')}`);
  must(txt('pantryBody').length > 20 && bars(html('todayBody')) === 4, 'a demó nem mutat kamrát / célokat');
  const elotte = txt('todayBody');
  await K.eat({code: Object.keys(K.doc().products)[0], grams: 50}); await K.setDay('rest'); await K.maintenanceWeek(); await K.addPantry(Object.keys(K.doc().products)[0], 'pack', 1);
  fillManual(p, {mName: 'Demó étel', mKcal: '100'}); await K.saveManual();
  must(txt('todayBody') !== elotte, 'a demóban a lépés nem látszik (helyben kellene működnie)');
  must(srv.puts.length === 0 && srv.gets === 0 && !p.calls.fetch.some(f => f.url.startsWith(API) || String(f.init.method || 'GET').toUpperCase() !== 'GET'),
       `a demó hálózatra írt / a végpontot kérte: ${JSON.stringify(p.calls.fetch.map(f => f.url))}`);
  must(!JSON.stringify(p.calls.fetch).includes(KEY) && !JSON.stringify(p.calls.fetch).includes(NKEY), 'kulcs ment ki a demóból');
});
check('kamra demó: a mintaadat a néző mai napjára szól, és nincs benne undefined / NaN / null', async () => {
  const {txt} = await kamra(null, {url: `${BASE}kamra.html?demo=1`, storage: {}, now: at(2027, 2, 3, 9, 0)});
  const t = txt('todayBody') + txt('pantryBody') + txt('status');
  must(!/undefined|NaN|null|\[object/.test(t) && /kcal/.test(t), `demó: ${t.slice(0, 200)}`);
});

// ── szkennelés ──────────────────────────────────────────────────────────────────
function camera(p) {
  const cam = {constraints: null, stopped: 0, tracks: 0};
  p.ctx.navigator.mediaDevices = {getUserMedia: async c => {
    cam.constraints = c; cam.tracks++;
    return {getTracks: () => [{stop() { cam.stopped++; }}]};
  }};
  p.el('cam').play = async () => {};
  return cam;
}
check('kamra szkenner: BarcodeDetectorral — hátsó kamera, a kért formátumok, találat után a kamera leáll és keres', async () => {
  const {K, p, srv, txt} = await kamra(null, {off: offOk(OFF_TUNA)});
  const cam = camera(p);
  let formats = null, n = 0;
  p.ctx.BarcodeDetector = class {
    static async getSupportedFormats() { return ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'code_128']; }
    constructor(o) { formats = o.formats; }
    async detect() { return ++n < 2 ? [] : [{rawValue: '8004030341234', format: 'ean_13'}]; }
  };
  await K.startScan();
  for (let i = 0; i < 40 && !srv.off.length; i++) await new Promise(r => setTimeout(r, 25));
  await settle();
  must(JSON.stringify(cam.constraints) === JSON.stringify({video: {facingMode: 'environment'}, audio: false}), `getUserMedia: ${JSON.stringify(cam.constraints)}`);
  must(JSON.stringify([...formats].sort()) === JSON.stringify(['ean_13', 'ean_8', 'qr_code', 'upc_a', 'upc_e']), `formátumok: ${formats}`);
  must(srv.off.length === 1 && txt('productCard').includes('Tonhal'), 'a találat után nem keresett');
  must(cam.stopped === 1 && p.el('cam').srcObject === null, `a kamera nem állt le a találat után (${cam.stopped})`);
  const m = n; await new Promise(r => setTimeout(r, 400));
  must(n === m, 'a felismerő ciklus a leállítás után is fut');
});
check('kamra szkenner: a lap elrejtésekor (visibilitychange / pagehide) és a Leállítás gombra a kamera leáll', async () => {
  for (const how of ['document:visibilitychange', 'pagehide', 'stop']) {
    const {K, p} = await kamra();
    const cam = camera(p);
    p.ctx.BarcodeDetector = class { static async getSupportedFormats() { return ['ean_13']; } async detect() { return []; } };
    await K.startScan();
    must(cam.tracks === 1 && cam.stopped === 0, `${how}: a kamera nem indult el (nem bizonyít)`);
    if (how === 'stop') K.stopScan(); else { p.ctx.document.hidden = true; p.ctx.document.visibilityState = 'hidden'; p.fire(how); }
    must(cam.stopped === 1, `${how}: a kamera nem állt le`);
  }
});
check('kamra szkenner: BarcodeDetector nélkül (iPhone Safari) a ZXing CSAK ekkor töltődik: rögzített verzió, sha384 SRI, crossorigin', async () => {
  const html = read('kamra.html');
  must(!/<script[^>]+src=["']https?:/i.test(html), 'a lap induláskor külső szkriptet tölt (a könyvtár csak szkenneléskor kell)');
  const {K, p} = await kamra();
  const cam = camera(p), made = [];
  const orig = p.ctx.document.createElement;
  p.ctx.document.createElement = tag => { const e = orig(tag); e.tag = tag; made.push(e); return e; };
  must(!made.length, 'nem bizonyít');
  let hints = null, decoded = null, resets = 0;
  const run = K.startScan();
  for (let i = 0; i < 40 && !made.some(e => e.tag === 'script'); i++) await new Promise(r => setTimeout(r, 10));
  const s = made.find(e => e.tag === 'script');
  must(s, 'nem hozott létre <script> elemet');
  must(/^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)\/.*@?\d+\.\d+\.\d+\//.test(s.src) && !/latest|@\^|@~/.test(s.src), `forrás: ${s.src}`);
  must(/^sha384-[A-Za-z0-9+/]{64}$/.test(s.integrity) && s.crossOrigin === 'anonymous', `integrity=${s.integrity} crossOrigin=${s.crossOrigin}`);
  p.ctx.ZXing = {DecodeHintType: {POSSIBLE_FORMATS: 2}, BarcodeFormat: {EAN_13: 7, EAN_8: 6, UPC_A: 14, UPC_E: 15, QR_CODE: 11},
    BrowserMultiFormatReader: class { constructor(h) { hints = h; } decodeFromStream(st, v, cb) { decoded = cb; return Promise.resolve(); } reset() { resets++; } }};
  s.onload();
  await run; await settle();
  must(p.el('cam').srcObject == null, 'a ZXing-úton a lap maga is rákötötte a kamerát a videóra (a könyvtár dolga — kétszeres csatolásnál elakadhat)');
  must(decoded && JSON.stringify([...hints.get(2)].sort()) === JSON.stringify([11, 14, 15, 6, 7]), `ZXing formátumok: ${hints && [...hints.get(2)]}`);
  decoded(null, new Error('NotFoundException'));
  must(cam.stopped === 0, 'egy üres képkockára leállt');
  decoded({getText: () => '5990000000001'});
  await settle();
  must(cam.stopped === 0 && resets === 0, `egyetlen leolvasásra már leállt (két egyező kell): stopped=${cam.stopped}, reset=${resets}`);
  decoded({getText: () => '5990000000001'});
  await settle();
  must(cam.stopped === 1 && resets >= 1 && p.el('manualForm').hidden === false, `találat után: stopped=${cam.stopped}, reset=${resets}`);
});
// ZXing-es (iPhone-os) szkennelés hamis könyvtárral; z.read(t) = egy sikeres képkocka t kóddal.
// Ha a könyvtár már betöltődött (második szkennelés ugyanazon a lapon), nincs új <script>.
async function zxingScan(K, p) {
  const z = {cb: null, resets: 0};
  const fake = {DecodeHintType: {POSSIBLE_FORMATS: 2}, BarcodeFormat: {EAN_13: 7, EAN_8: 6, UPC_A: 14, UPC_E: 15, QR_CODE: 11},
    BrowserMultiFormatReader: class { decodeFromStream(st, v, cb) { z.cb = cb; return Promise.resolve(); } reset() { z.resets++; } }};
  if (p.ctx.ZXing) { p.ctx.ZXing = fake; await K.startScan(); await settle(); }
  else {
    const orig = p.ctx.document.createElement, made = [];
    p.ctx.document.createElement = tag => { const e = orig(tag); e.tag = tag; made.push(e); return e; };
    const run = K.startScan();
    for (let i = 0; i < 40 && !made.some(e => e.tag === 'script'); i++) await new Promise(r => setTimeout(r, 10));
    const s = made.find(e => e.tag === 'script');
    p.ctx.document.createElement = orig;
    must(s, 'nem hozott létre <script> elemet (nem bizonyít)');
    p.ctx.ZXing = fake;
    s.onload();
    await run; await settle();
  }
  must(typeof z.cb === 'function', 'a ZXing nem kapott visszahívást (nem bizonyít)');
  z.read = async text => { z.cb({getText: () => text}); await settle(); };
  return z;
}
const OFF_OAT = {code: '5701977002961', product_name: 'Oat Barista', brands: "Naturli'",
                 nutriments: {'energy-kcal_100g': 59, proteins_100g: 1, carbohydrates_100g: 6.6, fat_100g: 3}};
check('kamra szkenner: egyetlen leolvasás nem indít keresést — a valódi iPhone-on látott hamis EAN-8 (21910029 az Oat Barista 5701977002961-je helyett)', async () => {
  const {K, p, srv, txt} = await kamra(null, {off: url => url.includes('/5701977002961?') ? offOk(OFF_OAT)() : offMiss()});
  const cam = camera(p);
  const z = await zxingScan(K, p);
  await z.read('21910029');                        // egy elmosódott képkocka: ellenőrzőjegyre stimmel, mégis hamis
  must(srv.off.length === 0 && cam.stopped === 0, `egyetlen leolvasásra már keresett vagy leállt (OFF: ${srv.off}, stopped=${cam.stopped})`);
  await z.read('5701977002961');
  must(srv.off.length === 0 && cam.stopped === 0, 'egy MÁSIK kód első leolvasására keresett — a számolásnak újra kell kezdődnie');
  await z.read('5701977002961');
  must(srv.off.length === 1 && srv.off[0].includes('/5701977002961?'), `OFF-kérés: ${srv.off}`);
  must(cam.stopped === 1 && z.resets >= 1, `a kamera nem állt le az egyező leolvasások után (stopped=${cam.stopped}, reset=${z.resets})`);
  must(p.el('codeIn').value === '5701977002961' && txt('productCard').includes('Oat Barista'), `mező: ${p.el('codeIn').value}, kártya: ${txt('productCard')}`);
});
check('kamra szkenner: a rövid (≤ 8 jegyű) kódot háromszor kell egymás után látni, a hosszút kétszer — a valódi EAN-8 is átmegy; a BarcodeDetector-úton ugyanígy', async () => {
  const {K, p, srv} = await kamra();
  const cam = camera(p);
  const z = await zxingScan(K, p);
  await z.read('21910029'); await z.read('21910029');
  must(srv.off.length === 0 && cam.stopped === 0, 'egy 8 jegyű kódra két leolvasás már elég volt');
  await z.read('21910029');
  must(srv.off.length === 1 && srv.off[0].includes('/21910029?') && cam.stopped === 1, `harmadikra sem keresett: ${srv.off}`);
  const b = await kamra(null, {off: offOk(OFF_TUNA)});      // BarcodeDetector (Android / asztali Chrome)
  camera(b.p);
  const seq = ['21910029', '8004030341234', '8004030341234'];
  let n = 0;
  b.p.ctx.BarcodeDetector = class {
    static async getSupportedFormats() { return ['ean_13', 'ean_8']; }
    async detect() { const v = seq[n++]; return v ? [{rawValue: v}] : []; }
  };
  await b.K.startScan();
  for (let i = 0; i < 60 && !b.srv.off.length; i++) await new Promise(r => setTimeout(r, 25));
  await settle();
  must(b.srv.off.length === 1 && b.srv.off[0].includes('/8004030341234?'), `BarcodeDetector: OFF-kérés: ${b.srv.off}`);
  b.K.stopScan();
});
check('kamra szkenner: a leállítás nullázza a számolást — két külön szkennelés egy-egy leolvasása nem adódik össze', async () => {
  const {K, p, srv} = await kamra();
  const cam = camera(p);
  let z = await zxingScan(K, p);
  await z.read('5990000000001');
  K.stopScan();
  must(cam.stopped === 1 && srv.off.length === 0, `a Leállítás után: stopped=${cam.stopped}, OFF: ${srv.off} (nem bizonyít)`);
  z = await zxingScan(K, p);
  await z.read('5990000000001');
  must(srv.off.length === 0 && cam.stopped === 1, `a két külön szkennelés leolvasása összeadódott (OFF: ${srv.off})`);
  await z.read('5990000000001');
  must(srv.off.length === 1 && cam.stopped === 2, `az új szkennelés két egyező leolvasására sem keresett (OFF: ${srv.off}, stopped=${cam.stopped})`);
});
check('kamra szkenner: ha a BEOLVASOTT kód nincs az OFF-ben, az üzenet kiírja a kódot és figyelmeztet a félreolvasásra; a beírt kódnál a régi szöveg marad', async () => {
  const {K, p, txt} = await kamra();
  camera(p);
  const z = await zxingScan(K, p);
  await z.read('5990000000001'); await z.read('5990000000001');
  const note = txt('manualNote');
  must(p.el('manualForm').hidden === false && note.includes('5990000000001') && /vonalkód alatti/.test(note) && /újra/.test(note), `szkennelt kódnál: ${note}`);
  await K.lookup('5990000000002');
  must(!/vonalkód alatti/.test(txt('manualNote')) && /nem található/.test(txt('manualNote')), `beírt kódnál: ${txt('manualNote')}`);
});
check('kamra szkenner: kamera nélkül / megtagadott engedélynél érthető üzenet, a kézi vonalkód-bevitel megmarad', async () => {
  const {K, p, txt} = await kamra();
  await K.startScan();
  must(/kamer/i.test(txt('msg')) && /kézzel/.test(txt('msg')), `kamera nélkül: ${txt('msg')}`);
  p.ctx.navigator.mediaDevices = {getUserMedia: async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; }};
  await K.startScan();
  must(/engedély/i.test(txt('msg')), `megtagadva: ${txt('msg')}`);
  must(/id="codeIn"/.test(read('kamra.html')) && /data-act="lookup"/.test(read('kamra.html')), 'nincs kézi vonalkód-mező');
  must(/<video[^>]*\bid="cam"[^>]*\bplaysinline\b[^>]*\bmuted\b|<video[^>]*\bid="cam"[^>]*\bmuted\b[^>]*\bplaysinline\b/.test(read('kamra.html')), 'a <video> nem playsinline + muted');
});

// ── a Worker ellenőrzése (a szerződésen túli részletekkel) — kicsiben, a teszthez ─
// Az ál-szerver MINDEN PUT-ot ezzel néz meg, mint az igazi: ami itt elbukik, arra 400 jön.
function invalidDoc(d) {
  const errs = [], bad = m => errs.push(m);
  const obj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const keys = (o, want, hol) => { const k = Object.keys(o).sort().join(), w = [...want].sort().join(); if (k !== w) bad(`${hol}: kulcsok [${k}] ≠ [${w}]`); };
  const num = (v, hol, pos) => { if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 100000 || (pos && v <= 0)) bad(`${hol}: szám ${JSON.stringify(v)}`); };
  const numN = (v, hol) => { if (v !== null) num(v, hol); };
  const date = (v, hol) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof v === 'string' ? v : ''); const x = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!m || x.getUTCFullYear() !== +m[1] || x.getUTCMonth() !== +m[2] - 1 || x.getUTCDate() !== +m[3]) bad(`${hol}: dátum ${JSON.stringify(v)}`); };
  const name = (v, hol) => { if (typeof v !== 'string' || !v.length || v.length > 200) bad(`${hol}: név ${String(JSON.stringify(v)).slice(0, 30)}`); };
  const D = ['strength', 'hyrox', 'rest', 'maintenance'];
  if (!obj(d)) return ['nem objektum'];
  keys(d, ['version', 'rev', 'targets', 'products', 'pantry', 'log', 'days'], 'dokumentum');
  if (d.version !== 1) bad('version');
  if (!Number.isSafeInteger(d.rev) || d.rev < 0) bad(`rev ${d.rev}`);
  if (d.targets !== null) {
    if (!obj(d.targets)) bad('targets'); else {
      keys(d.targets, ['sets', 'schedule', 'updated'], 'targets'); date(d.targets.updated, 'targets.updated');
      if (obj(d.targets.sets)) { keys(d.targets.sets, D, 'targets.sets');
        for (const t of D) { const s = d.targets.sets[t]; if (s === null || s === undefined) continue;
          if (!obj(s)) { bad(`sets.${t}`); continue; } keys(s, ['kcal', 'protein_g', 'carbs_g', 'fat_g'], `sets.${t}`); for (const k of Object.keys(s)) num(s[k], `sets.${t}.${k}`); } }
      else bad('targets.sets');
      if (obj(d.targets.schedule)) { keys(d.targets.schedule, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], 'schedule'); for (const k of Object.keys(d.targets.schedule)) if (!D.includes(d.targets.schedule[k])) bad(`schedule.${k}`); }
      else bad('targets.schedule');
    }
  }
  const P = obj(d.products) ? d.products : (bad('products'), {});
  for (const [code, p] of Object.entries(P)) {
    if (!code.length || code.length > 40) bad(`termékkód hossza: ${code}`);
    if (code.startsWith('m_') ? !/^m_[A-Za-z0-9]{4,32}$/.test(code) : !/^\d{6,14}$/.test(code)) bad(`termékkód: ${code}`);
    if (!obj(p)) { bad(`termék ${code}`); continue; }
    keys(p, ['name', 'brand', 'per100', 'pack_g', 'serving_g', 'source', 'added'], `termék ${code}`);
    name(p.name, `termék ${code}`); if (p.brand !== null) name(p.brand, `márka ${code}`);
    if (obj(p.per100)) { keys(p.per100, ['kcal', 'protein', 'carbs', 'fat'], `per100 ${code}`); for (const k of Object.keys(p.per100)) numN(p.per100[k], `per100.${k} ${code}`); } else bad(`per100 ${code}`);
    numN(p.pack_g, `pack_g ${code}`); numN(p.serving_g, `serving_g ${code}`);
    if (p.source !== 'off' && p.source !== 'manual') bad(`source ${code}`);
    date(p.added, `added ${code}`);
  }
  const ids = new Set(), uniq = (id, hol) => { if (ids.has(id)) bad(`${hol}: ismétlődő azonosító ${id}`); ids.add(id); };
  const codeRef = (c, hol) => { if (c !== null && !(typeof c === 'string' && Object.prototype.hasOwnProperty.call(P, c))) bad(`${hol}: a code nem létező termékre mutat (${c})`); };
  if (!Array.isArray(d.pantry)) bad('pantry'); else for (const it of d.pantry) {
    if (!obj(it)) { bad('kamra-tétel'); continue; }
    keys(it, ['id', 'code', 'name', 'qty', 'unit', 'added'], `kamra ${it.id}`);
    if (!/^p_[A-Za-z0-9_-]{1,38}$/.test(it.id)) bad(`kamra-azonosító ${it.id}`); uniq(it.id, 'kamra');
    codeRef(it.code, `kamra ${it.id}`); name(it.name, `kamra ${it.id}`); num(it.qty, `qty ${it.id}`, true);
    if (it.unit !== 'pack' && it.unit !== 'g') bad(`unit ${it.id}`); date(it.added, `added ${it.id}`);
  }
  if (!obj(d.log)) bad('log'); else for (const [day, list] of Object.entries(d.log)) {
    date(day, 'napló-nap');
    if (!Array.isArray(list)) { bad(`log.${day}`); continue; }
    for (const e of list) {
      if (!obj(e)) { bad('napló-tétel'); continue; }
      keys(e, ['id', 'code', 'name', 'grams', 'kcal', 'protein', 'carbs', 'fat', 'time'], `napló ${e.id}`);
      if (!/^l_[A-Za-z0-9_-]{1,38}$/.test(e.id)) bad(`napló-azonosító ${e.id}`); uniq(e.id, 'napló');
      codeRef(e.code, `napló ${e.id}`); name(e.name, `napló ${e.id}`); num(e.grams, `grams ${e.id}`, true);
      for (const k of ['kcal', 'protein', 'carbs', 'fat']) numN(e[k], `${k} ${e.id}`);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.time)) bad(`time ${e.time}`);
    }
  }
  if (!obj(d.days)) bad('days'); else for (const [day, t] of Object.entries(d.days)) { date(day, 'days'); if (!D.includes(t)) bad(`days.${day}=${t}`); }
  return errs;
}
check('kamra szerződés: egy átlagos munkamenet MINDEN írása átmegy a Worker ellenőrzésén (kulcsok, azonosítók, dátumok, számok)', async () => {
  let n = 0;
  const off = url => (++n === 1 ? offOk(OFF_TUNA)() : offOk({product_name: 'Rejtély', brands: '', nutriments: {'energy-kcal_100g': 200}})());
  const {K, srv, p} = await kamra(null, {off});
  await K.lookup('8004030341234'); await K.flush();
  await K.lookup('5999999999999'); await K.flush();
  fillManual(p, {mName: 'Házi granola', mKcal: '450', mProtein: '12,5'}); await K.saveManual();
  fillManual(p, {mCode: '5990000000001', mName: 'Túró Rudi', mBrand: 'Pöttyös', mKcal: '380', mPack: '30'}); await K.saveManual();
  const manual = Object.keys(srv.doc.products).find(c => c.startsWith('m_'));
  await K.addPantry('8004030341234', 'pack', 2); await K.addPantry('8004030341234', 'g', 250); await K.addPantry(manual, 'pack', 1);
  const [pk, gr, mp] = srv.doc.pantry.map(x => x.id);
  await K.pantryStep(pk, 1); await K.pantryStep(gr, -1);
  await K.eat({code: '8004030341234', pantryId: pk, grams: 80}); await K.eat({code: '5999999999999', grams: 33.3}); await K.eat({code: manual, pantryId: mp, grams: 45});
  await K.eat({code: '8004030341234', pantryId: gr, grams: 200});
  await K.logDelete(srv.doc.log[KDAY][1].id);
  fillT(p, {...S4, hyrox: null}, SCHED); await K.saveTargets();
  await K.setDay('hyrox'); await K.maintenanceWeek(); await K.setDay('auto'); await K.pantryRemove(mp);
  must(srv.puts.length >= 15 && srv.rejected.length === 0, `${srv.puts.length} írás, elutasítva: ${JSON.stringify(srv.rejected.slice(0, 3))}`);
  const errs = srv.puts.flatMap(x => invalidDoc(x.body));
  must(!errs.length, `érvénytelen dokumentum: ${errs.slice(0, 4).join(' | ')}`);
  must(Object.keys(srv.doc.products).length === 4 && srv.doc.pantry.length === 1 && srv.doc.log[KDAY].length === 3 && Object.keys(srv.doc.days).length === 6, `a végállapot: ${JSON.stringify([Object.keys(srv.doc.products).length, srv.doc.pantry.length, srv.doc.log[KDAY].length, Object.keys(srv.doc.days).length])}`);
  must(JSON.stringify(K.doc()) === JSON.stringify(srv.doc), 'a lap állapota eltér a szerver dokumentumától');
  const d = await kamra(null, {url: `${BASE}kamra.html?demo=1`});
  must(!invalidDoc(d.K.doc()).length, `a demó dokumentum érvénytelen: ${invalidDoc(d.K.doc()).slice(0, 3)}`);
  must(invalidDoc({...emptyDoc(), pantry: [{id: 'x', code: null, name: '', qty: 0, unit: 'kg', added: '2026-02-30'}]}).length >= 5, 'az ellenőrző nem ellenőriz (nem bizonyít)');
});
check('kamra szerződés: túl nagy számot adó tételt (gramm × kcal > 100000) és nem létező termékre mutató kódot nem ír', async () => {
  const doc = {...emptyDoc(), products: {'111111': {...TUNA, per100: {kcal: 90000, protein: 1, carbs: 1, fat: 1}}},
               pantry: [{id: 'p_arva', code: null, name: 'Rizs', qty: 500, unit: 'g', added: KDAY}]};
  const {K, srv, txt} = await kamra(doc);
  await K.eat({code: '111111', grams: 500});
  must(srv.puts.length === 0 && txt('msg').length > 0, 'a 450000 kcal-os tételt elküldte');
  await K.eat({code: null, pantryId: 'p_arva', grams: 100});
  const e = srv.doc.log[KDAY][0];
  must(e.code === null && e.kcal === null && e.name === 'Rizs' && srv.doc.pantry[0].qty === 400, JSON.stringify(e));
});

// ── írás: 429 (sebességkorlát), 503 (tároló), "nincs mentve" + Mentés újra, összevonás ─
const unsaved = o => o.p.el('unsavedBox').hidden === false;
check('kamra írás: az időzítések alapértéke — összevonás ~1 s, 429 után ~2,5 s várakozás, két írás között > 2 s', async () => {
  const p = page('kamra.html', {storage: WPAIRED});
  const t = p.run('Kamra').timing;
  must(t.debounce >= 800 && t.debounce <= 1500 && t.retry >= 2500 && t.retry <= 4000 && t.gap >= 2000 && t.gap <= 3000, JSON.stringify(t));
  must(t.retryMax >= 8000 && t.retryMax <= 12000 && t.margin >= 0 && t.margin <= 1000, `Retry-After plafon ~10 s: ${JSON.stringify(t)}`);
});
check('kamra írás: 429-re vár, majd EGYSZER újrapróbál ugyanazzal a dokumentummal és rev-vel — siker után nincs "nincs mentve"', async () => {
  const o = await kamra({...emptyDoc(), rev: 5, products: {'111111': TUNA}}, {putSeq: [429], timing: {retry: 60}});
  const t0 = Date.now ? process.hrtime.bigint() : 0n;
  const ok = await o.K.eat({code: '111111', grams: 80});
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  must(ok === true && o.srv.puts.length === 2, `${o.srv.puts.length} PUT, eredmény: ${ok}`);
  must(JSON.stringify(o.srv.puts[0].body) === JSON.stringify(o.srv.puts[1].body) && o.srv.puts[1].body.rev === 5, 'az újrapróba más dokumentumot / rev-et küldött');
  must(ms >= 50, `nem várt az újrapróba előtt (${ms.toFixed(0)} ms)`);
  must(!unsaved(o) && o.srv.doc.log[KDAY].length === 1 && o.K.doc().rev === 6, `állapot: unsaved=${unsaved(o)}, rev=${o.K.doc().rev}`);
});
const timed = async f => { const t0 = process.hrtime.bigint(); const v = await f(); return [v, Number(process.hrtime.bigint() - t0) / 1e6]; };
check('kamra írás: 429-nél a Retry-After fejlécet követi (plafonnal), fejléc nélkül / szemét fejlécnél a ~2,5 s alapértéket', async () => {
  const doc = {...emptyDoc(), products: {'111111': TUNA}};
  const a = await kamra(doc, {putSeq: [{status: 429, scope: 'gap', retryAfter: '0.15'}], timing: {retry: 0}});
  const [okA, msA] = await timed(() => a.K.eat({code: '111111', grams: 80}));
  must(okA === true && a.srv.puts.length === 2 && msA >= 140, `Retry-After 0,15 s: ${msA.toFixed(0)} ms, ${a.srv.puts.length} PUT`);
  const b = await kamra(doc, {putSeq: [{status: 429, scope: 'gap', retryAfter: '3600'}], timing: {retry: 0, retryMax: 90}});
  const [okB, msB] = await timed(() => b.K.eat({code: '111111', grams: 80}));
  must(okB === true && b.srv.puts.length === 2 && msB >= 80 && msB < 1500, `plafon: ${msB.toFixed(0)} ms`);
  for (const ra of ['abc', '-5', '', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
    const c = await kamra(doc, {putSeq: [{status: 429, scope: 'gap', retryAfter: ra}], timing: {retry: 70, retryMax: 5000}});
    const [okC, msC] = await timed(() => c.K.eat({code: '111111', grams: 80}));
    must(okC === true && msC >= 60 && msC < 1500, `Retry-After=${JSON.stringify(ra)}: ${msC.toFixed(0)} ms (az alapérték 70 kellene)`);
  }
  const d = await kamra(doc, {putSeq: [{status: 429, scope: 'gap', retryAfter: '0.05'}], timing: {retry: 0, margin: 120}});
  const [, msD] = await timed(() => d.K.eat({code: '111111', grams: 80}));
  must(msD >= 160, `a ráhagyás (margin) nem adódott hozzá: ${msD.toFixed(0)} ms`);
});
check('kamra írás: 429 scope "day" (a mai írási keret elfogyott) → NINCS újrapróba, a lépés azonnal "nincs mentve", érthető üzenettel', async () => {
  const o = await kamra({...emptyDoc(), products: {'111111': TUNA}}, {putSeq: [{status: 429, scope: 'day', retryAfter: '0.05'}], timing: {retry: 0}});
  const [ok, ms] = await timed(() => o.K.eat({code: '111111', grams: 80}));
  await new Promise(r => setTimeout(r, 150));
  must(ok === false && o.srv.puts.length === 1, `${o.srv.puts.length} PUT (1 kell — a napi keretre nincs újrapróba)`);
  must(unsaved(o) && /mai írási keret elfogyott/i.test(o.txt('msg')) && o.txt('todayBody').includes('Tonhal'), `unsaved=${unsaved(o)}, msg="${o.txt('msg')}"`);
});
check('kamra írás: kétszeri 429 → a lépés megmarad a lapon, "nincs mentve" jelzéssel; a Mentés újra gomb menti, magától nem próbálkozik', async () => {
  const o = await kamra({...emptyDoc(), products: {'111111': TUNA}}, {putSeq: [429, 429]});
  const ok = await o.K.eat({code: '111111', grams: 80});
  must(ok === false && o.srv.puts.length === 2, `${o.srv.puts.length} PUT, eredmény: ${ok}`);
  must(unsaved(o) && /nincs mentve/i.test(o.txt('unsavedText')) && /data-act="save-retry"/.test(read('kamra.html')), `jelzés: ${o.txt('unsavedText')}`);
  must(o.txt('todayBody').includes('Tonhal') && !o.srv.doc.log[KDAY], 'a lépés eltűnt a lapról, vagy mégis mentődött');
  await new Promise(r => setTimeout(r, 150));
  must(o.srv.puts.length === 2, `magától újrapróbált (${o.srv.puts.length} PUT)`);
  o.p.fire('document:click', {target: {closest: () => ({dataset: {act: 'save-retry'}})}, preventDefault() {}});
  await o.K.flush(); await settle();
  must(o.srv.puts.length === 3 && o.srv.doc.log[KDAY].length === 1 && !unsaved(o), `Mentés újra után: ${o.srv.puts.length} PUT, unsaved=${unsaved(o)}`);
});
check('kamra írás: 503-ra (a tároló nem érhető el) vár, majd EGYSZER újrapróbál ugyanazzal a dokumentummal — siker után nincs "nincs mentve"', async () => {
  const o = await kamra({...emptyDoc(), rev: 5, products: {'111111': TUNA}}, {putSeq: [503], timing: {retry: 60}});
  const t0 = process.hrtime.bigint();
  const ok = await o.K.eat({code: '111111', grams: 80});
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  must(ok === true && o.srv.puts.length === 2, `${o.srv.puts.length} PUT, eredmény: ${ok}`);
  must(JSON.stringify(o.srv.puts[0].body) === JSON.stringify(o.srv.puts[1].body) && o.srv.puts[1].body.rev === 5, 'az újrapróba más dokumentumot / rev-et küldött');
  must(ms >= 50 && !unsaved(o) && o.srv.doc.log[KDAY].length === 1, `várakozás: ${ms.toFixed(0)} ms, unsaved=${unsaved(o)}`);
});
check('kamra írás: kétszeri 503 → hibaüzenet, a lépés "nincs mentve"; harmadszor magától nem próbál; a következő lépés mindkettőt menti', async () => {
  const o = await kamra({...emptyDoc(), products: {'111111': TUNA}}, {putSeq: [503, 503]});
  const ok = await o.K.eat({code: '111111', grams: 80});
  await new Promise(r => setTimeout(r, 120));
  must(ok === false && o.srv.puts.length === 2, `${o.srv.puts.length} PUT (2 kell: egy újrapróba)`);
  must(unsaved(o) && /tároló/i.test(o.txt('msg')) && o.txt('todayBody').includes('Tonhal'), `unsaved=${unsaved(o)}, msg="${o.txt('msg')}"`);
  await o.K.eat({code: '111111', grams: 20});
  must(o.srv.puts.length === 3 && o.srv.doc.log[KDAY].length === 2 && !unsaved(o), `a következő lépés után ${o.srv.puts.length} PUT`);
});
check('kamra írás: 500 (sérült tárolt dokumentum) és hálózati hiba → hibaüzenet, "nincs mentve", NINCS automatikus újrapróba', async () => {
  for (const st of [500, 'net']) {
    const o = await kamra({...emptyDoc(), products: {'111111': TUNA}}, {putSeq: [st]});
    const ok = await o.K.eat({code: '111111', grams: 80});
    await new Promise(r => setTimeout(r, 120));
    must(ok === false && o.srv.puts.length === 1, `${st}: ${o.srv.puts.length} PUT`);
    must(unsaved(o) && o.txt('msg').length > 0 && o.txt('todayBody').includes('Tonhal'), `${st}: unsaved=${unsaved(o)}, msg="${o.txt('msg')}"`);
    await o.K.eat({code: '111111', grams: 20});
    must(o.srv.puts.length === 2 && o.srv.doc.log[KDAY].length === 2 && !unsaved(o), `${st}: a következő lépés után ${o.srv.puts.length} PUT, ${(o.srv.doc.log[KDAY] || []).length} tétel`);
  }
});
check('kamra írás: a gyors +/− koppintások EGY írásba vonódnak össze (debounce); a felület azonnal követi', async () => {
  const doc = {...emptyDoc(), products: {'111111': TUNA}, pantry: [{id: 'p_a', code: '111111', name: 'Tonhal', qty: 1, unit: 'pack', added: KDAY}]};
  const o = await kamra(doc, {timing: {debounce: 80}});
  const runs = [o.K.pantryStep('p_a', 1), o.K.pantryStep('p_a', 1), o.K.pantryStep('p_a', 1), o.K.pantryStep('p_a', -1)];
  must(/3 csomag/.test(o.txt('pantryBody')), `a felület nem követi azonnal: ${o.txt('pantryBody')}`);
  must(o.srv.puts.length === 0, 'koppintásonként ír');
  await new Promise(r => setTimeout(r, 40));
  runs.push(o.K.pantryStep('p_a', 1));
  const res = await Promise.all(runs);
  must(o.srv.puts.length === 1 && o.srv.doc.pantry[0].qty === 4 && res.every(x => x === true), `${o.srv.puts.length} PUT, qty=${o.srv.doc.pantry[0].qty}, ${res}`);
});
// ── iOS: a háttérbe kerülő lapot a Safari hamar felfüggeszti ────────────────────
const hide = o => { o.p.ctx.document.hidden = true; o.p.ctx.document.visibilityState = 'hidden'; o.p.fire('document:visibilitychange'); };
check('kamra iOS: ha a lap rejtetté válik, a várakozó írás AZONNAL megy (az összevonás és a két írás közti szünet kivárása nélkül)', async () => {
  const doc = {...emptyDoc(), products: {'111111': TUNA}, pantry: [{id: 'p_a', code: '111111', name: 'Tonhal', qty: 1, unit: 'pack', added: KDAY}]};
  const a = await kamra(doc, {timing: {debounce: 1500, gap: 0}});                 // összevonásra váró koppintás
  const step = a.K.pantryStep('p_a', 1);
  await new Promise(r => setTimeout(r, 40));
  must(a.srv.puts.length === 0, 'előfeltétel: a koppintás még vár (nem bizonyít)');
  const [okA, msA] = await timed(async () => { hide(a); return step; });
  must(okA === true && a.srv.puts.length === 1 && msA < 700, `összevonás: ${msA.toFixed(0)} ms, ${a.srv.puts.length} PUT`);
  const b = await kamra(doc, {timing: {gap: 1500}});                              // a két írás közti szünetben álló írás
  await b.K.eat({code: '111111', grams: 80});
  const second = b.K.eat({code: '111111', grams: 20});
  await new Promise(r => setTimeout(r, 40));
  must(b.srv.puts.length === 1, 'előfeltétel: a második írás a szünetre vár (nem bizonyít)');
  const [okB, msB] = await timed(async () => { hide(b); return second; });
  must(okB === true && b.srv.puts.length === 2 && msB < 700, `szünet: ${msB.toFixed(0)} ms, ${b.srv.puts.length} PUT`);
  const c = await kamra(doc, {putSeq: [500]});                                    // hibára megállt sort a rejtés NEM indít újra
  await c.K.eat({code: '111111', grams: 80}); await settle();
  hide(c); await new Promise(r => setTimeout(r, 80));
  must(c.srv.puts.length === 1 && unsaved(c), `a hibára megállt sor magától újraindult: ${c.srv.puts.length} PUT`);
});
check('kamra iOS: a PUT keepalive-val megy, ha a törzs 60 KB alatti (nagyobbnál nem — a böngésző eldobná)', async () => {
  const small = await kamra({...emptyDoc(), products: {'111111': TUNA}});
  await small.K.eat({code: '111111', grams: 80});
  const f = small.p.calls.fetch.find(x => x.init.method === 'PUT');
  must(f && f.init.keepalive === true && f.init.body.length < 20000, `kicsi törzs: keepalive=${f && f.init.keepalive}`);
  const products = {};
  for (let i = 0; i < 400; i++) products[String(5990000000000 + i)] = {...TUNA, name: 'Árvíztűrő tükörfúrógép termék '.repeat(5) + i};
  const big = await kamra({...emptyDoc(), products});
  await big.K.eat({code: '5990000000000', grams: 80});
  const g = big.p.calls.fetch.find(x => x.init.method === 'PUT');
  must(g && g.init.body.length > 60000 && !g.init.keepalive && big.srv.doc.log[KDAY].length === 1, `nagy törzs (${g && g.init.body.length} karakter): keepalive=${g && g.init.keepalive}`);
});
check('kamra iOS: a lusta termék-gyorsítótár lépés nem vált ki "elhagyod a lapot?" kérdést; a valódi, mentetlen lépés igen', async () => {
  const leave = o => { let asked = false; o.p.fire('beforeunload', {preventDefault() { asked = true; }}); return asked; };
  const a = await kamra(null, {off: offOk(OFF_TUNA), timing: {lazy: 300}});
  must(leave(a) === false, 'üres sornál is kérdez');
  await a.K.lookup('8004030341234');
  must(a.srv.puts.length === 0 && a.K.doc().products['8004030341234'], 'előfeltétel: a termék lustán vár (nem bizonyít)');
  must(leave(a) === false, 'a lusta gyorsítótár-lépés miatt kérdez');
  await a.K.flush();
  must(a.srv.puts.length === 1, 'a lusta lépés nem mentődött');
  const b = await kamra({...emptyDoc(), products: {'111111': TUNA}}, {putSeq: [500]});
  await b.K.eat({code: '111111', grams: 80});
  must(leave(b) === true, 'mentetlen valódi lépésnél nem kérdez');
});
check('kamra írás: a rev MINDIG a PUT válaszából jön (nem helyben számolt); rev nélküli 200 után újratölt', async () => {
  const srvJump = await kamra({...emptyDoc(), rev: 3, products: {'111111': TUNA}}, {revJump: 10});
  await srvJump.K.eat({code: '111111', grams: 80}); await srvJump.K.eat({code: '111111', grams: 20});
  must(srvJump.srv.puts.length === 2 && srvJump.srv.puts[1].body.rev === 13 && srvJump.srv.doc.log[KDAY].length === 2, `rev-ek: ${srvJump.srv.puts.map(x => x.body.rev)}`);
  const norev = await kamra({...emptyDoc(), rev: 3, products: {'111111': TUNA}}, {noRev: true});
  const g = norev.srv.gets;
  await norev.K.eat({code: '111111', grams: 80}); await norev.K.eat({code: '111111', grams: 20});
  must(norev.srv.gets > g && norev.srv.doc.log[KDAY].length === 2 && norev.srv.rejected.length === 0, `rev nélkül: ${norev.srv.gets - g} újratöltés, ${norev.srv.puts.map(x => x.body.rev)}`);
});
check('kamra írás: ha az írás megtörtént, de a válasz elveszett, az újrapróba NEM duplázza a naplótételt / kamra-tételt', async () => {
  const o = await kamra({...emptyDoc(), products: {'111111': TUNA}}, {putSeq: ['lost']});
  const ok = await o.K.eat({code: '111111', grams: 80});
  must(ok === false && unsaved(o) && o.srv.doc.log[KDAY].length === 1, 'előfeltétel: a szerveren megvan, a lap nem tud róla (nem bizonyít)');
  await o.K.addPantry('111111', 'g', 300);
  const ids = o.srv.doc.log[KDAY].map(e => e.id);
  must(ids.length === 1 && o.srv.doc.pantry.length === 1 && !unsaved(o) && o.srv.rejected.length === 0, `napló: ${ids.length} tétel, kamra: ${o.srv.doc.pantry.length}, unsaved=${unsaved(o)}`);
  must(JSON.stringify(o.K.doc()) === JSON.stringify(o.srv.doc), 'a lap állapota eltér a szerverétől');
  const q = await kamra({...emptyDoc(), products: {'111111': TUNA}}, {putSeq: ['lost']});
  await q.K.addPantry('111111', 'pack', 1); await q.K.setDay('rest');
  must(q.srv.doc.pantry.length === 1 && q.srv.doc.pantry[0].qty === 1, `kamra duplázva: ${JSON.stringify(q.srv.doc.pantry)}`);
});
check('kamra írás: elveszett válasz után a +/− lépés és a meglévő tételbe olvasztás sem érvényesül kétszer (a lépés a CÉLmennyiséget viszi)', async () => {
  const doc = {...emptyDoc(), products: {'111111': TUNA}, pantry: [{id: 'p_a', code: '111111', name: 'Tonhal', qty: 1, unit: 'pack', added: KDAY},
                                                                  {id: 'p_g', code: '111111', name: 'Tonhal', qty: 100, unit: 'g', added: KDAY}]};
  const retry = async o => { o.p.fire('document:click', {target: {closest: () => ({dataset: {act: 'save-retry'}})}, preventDefault() {}}); await o.K.flush(); await settle(); };
  const q = (o, id) => (o.srv.doc.pantry.find(x => x.id === id) || {}).qty;
  const a = await kamra(doc, {putSeq: ['lost']});
  const ok = await a.K.pantryStep('p_a', 1);
  must(ok === false && unsaved(a) && q(a, 'p_a') === 2, `előfeltétel: a szerveren 2, a lap nem tud róla (nem bizonyít): ${q(a, 'p_a')}`);
  await retry(a);
  must(q(a, 'p_a') === 2 && !unsaved(a) && /2 csomag/.test(a.txt('pantryBody')), `+1 kétszer érvényesült: ${q(a, 'p_a')} (unsaved=${unsaved(a)})`);
  const b = await kamra(doc, {putSeq: ['lost']});
  await Promise.all([b.K.pantryStep('p_g', -1), b.K.pantryStep('p_a', 1), b.K.pantryStep('p_a', 1)]);
  await retry(b);
  must(q(b, 'p_g') === 50 && q(b, 'p_a') === 3 && !unsaved(b), `több lépés: g=${q(b, 'p_g')} csomag=${q(b, 'p_a')}`);
  const c = await kamra(doc, {putSeq: ['lost']});
  await c.K.addPantry('111111', 'g', 250);
  await retry(c);
  must(q(c, 'p_g') === 350 && c.srv.doc.pantry.length === 2 && !unsaved(c), `összeolvasztás kétszer: ${q(c, 'p_g')}, ${c.srv.doc.pantry.length} tétel`);
  const d = await kamra(doc, {putSeq: ['lost']});                   // nullára lépés: a tétel egyszer kerül ki
  await d.K.pantryStep('p_a', -1); await retry(d);
  must(q(d, 'p_a') === undefined && d.srv.doc.pantry.length === 1 && !unsaved(d) && d.srv.rejected.length === 0, `kivétel kétszer: ${JSON.stringify(d.srv.doc.pantry)}`);
  // valódi ütközés: a másik eszköz közben kivette a tételt → a lépés nem hozza vissza
  const e = await kamra(doc, {conflicts: 1, other: x => { x.pantry = x.pantry.filter(i => i.id !== 'p_a'); }});
  await e.K.pantryStep('p_a', 1);
  must(q(e, 'p_a') === undefined && !unsaved(e), `a kivett tétel visszajött: ${JSON.stringify(e.srv.doc.pantry)}`);
});
check('kamra írás: futó mentés közben az Újratöltés nem indul el (különben a friss írást a régi állapot írhatná felül)', async () => {
  const o = await kamra({...emptyDoc(), products: {'111111': TUNA}}, {confirm: true});
  const g = o.srv.gets, run = o.K.eat({code: '111111', grams: 80});
  o.p.fire('document:click', {target: {closest: () => ({dataset: {act: 'reload'}})}, preventDefault() {}});
  must(o.srv.gets === g && /folyamatban/i.test(o.txt('msg')), `GET: ${o.srv.gets - g}, üzenet: ${o.txt('msg')}`);
  must(await run === true && o.srv.doc.log[KDAY].length === 1 && o.txt('todayBody').includes('Tonhal'), 'a futó mentés nem ért célba');
});
check('kamra írás: mentetlen lépésekkel az Újratöltés megerősítést kér (nem dobja el csendben)', async () => {
  const o = await kamra({...emptyDoc(), products: {'111111': TUNA}}, {putSeq: [500], confirm: false});
  await o.K.eat({code: '111111', grams: 80});
  await settle();                                  // a mentési kör lezárul
  const g = o.srv.gets;
  o.p.fire('document:click', {target: {closest: () => ({dataset: {act: 'reload'}})}, preventDefault() {}}); await settle();
  must(o.p.calls.confirm.length === 1 && o.srv.gets === g && o.txt('todayBody').includes('Tonhal'), `megerősítés: ${o.p.calls.confirm.length}, GET: ${o.srv.gets - g}`);
});

// ── a gombok bekötése (kattintás-delegálás) ─────────────────────────────────────
check('kamra gombok: a data-act kattintás a megfelelő műveletet indítja (kamra +, napló törlés, naptípus, keresés)', async () => {
  const doc = {...fed(), pantry: [{id: 'p_a', code: '111111', name: 'Tonhal', qty: 1, unit: 'pack', added: KDAY}]};
  const {p, srv} = await kamra(doc);
  const click = async (act, id) => { p.fire('document:click', {target: {closest: () => ({dataset: {act, id}})}, preventDefault() {}}); await settle(8); };
  await click('pantry-inc', 'p_a');
  must(srv.doc.pantry[0].qty === 2, 'pantry-inc');
  await click('log-del', 'l_1');
  must(!(srv.doc.log[KDAY] || []).length, 'log-del');
  await click('day-rest');
  must(srv.doc.days[KDAY] === 'rest', 'day-rest');
  await click('week-maintenance');
  must(Object.keys(srv.doc.days).length === 7 && srv.doc.days[KDAY] === 'maintenance', 'week-maintenance');
  await click('pantry-eat', 'p_a');
  must(/id="eatGrams"/.test(p.el('productCard').innerHTML), 'pantry-eat nem nyitotta meg a kártyát');
  p.el('eatGrams').value = '40';
  await click('eat');
  must((srv.doc.log[KDAY] || []).length === 1 && srv.doc.log[KDAY][0].grams === 40 && srv.doc.pantry[0].qty === 1.75, `eat: ${JSON.stringify(srv.doc.log)} ${srv.doc.pantry[0].qty}`);
  p.el('codeIn').value = '111111';
  await click('lookup');
  must(p.el('productCard').textContent.includes('Tonhal sós lében'), 'lookup');
  const acts = new Set([...read('kamra.html').matchAll(/data-act="([a-z-]+)"/g)].map(m => m[1]));
  const handled = new Set([...read('kamra.html').matchAll(/'([a-z]+(?:-[a-z]+)*)':\s*(?:\(|[a-z]+\s*=>|async|function|\w+,|\w+\s*\})/g)].map(m => m[1]));
  const lost = [...acts].filter(a => !handled.has(a));
  must(acts.size >= 12 && !lost.length, `kezelő nélküli data-act: ${lost} (összes: ${acts.size})`);
});

// ── 375 px (a tényleges mérés headless Chrome-ban; itt a szabályok őrei) ────────
check('kamra CSS 375 px: minden rácscella minmax(0,1fr), a szöveg törhet, a videó és a mezők nem lógnak ki', () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(read('kamra.html'))[1].replace(/\s+/g, ' ');
  const grids = [...css.matchAll(/grid-template-columns:([^;}]+)/g)].map(m => m[1].trim());
  must(grids.length >= 2, `kevés rács (nem bizonyít): ${grids.length}`);
  for (const g of grids) must(!/(^|[\s(,])\d*\.?\d*fr/.test(g.replace(/minmax\(0,\s*\d*\.?\d*fr\)/g, '')), `csupasz fr a rácsban: ${g}`);
  must(/overflow-wrap:\s*anywhere/.test(css), 'nincs overflow-wrap:anywhere');
  must(/video\{[^}]*max-width:100%|#cam\{[^}]*width:100%/.test(css), 'a videó szélessége nincs korlátozva');
  must(/input[^{]*\{[^}]*font-size:16px/.test(css) && /input[^{]*\{[^}]*min-width:0/.test(css), 'a mezők: 16px (iOS nem nagyít rá) + min-width:0');
  must(/name="viewport" content="width=device-width, initial-scale=1/.test(read('kamra.html')), 'nincs viewport meta');
  must(/\[hidden\]\{display:none!important\}/.test(css), 'a [hidden] elemet egy display-szabály felülírhatja');
});

// ════════════════════════════════════════════════════════════════════════════════
// Megfelelés a VALÓDI Workernek. A fenti ellenőrzések az itteni ál-szerver (nutri) ellen
// futnak, ami a szerződés MÁSOLATA — ha a másolat téved, minden zöld, és élesben 400 jön.
// Ez az ellenőrzés a Worker saját forrását tölti be (worker.js, ES-modul), és a lap minden
// írását annak a fetch()-én küldi át, hamis KV-vel, hamis Cache API-val és hamis kulcsokkal
// (hálózat nincs). A Worker a sync-repóban él, nem ebben: ha a fájl nincs meg, az ellenőrzés
// LÁTHATÓAN kimarad (⊘ KIHAGYVA) — nem csendben zöld.
//   HEALTH_WORKER_JS=/út/worker.js node tests/page_checks.js Worker
// ════════════════════════════════════════════════════════════════════════════════
const os = require('node:os'), {pathToFileURL} = require('node:url');
const WORKER_CANDIDATES = [process.env.HEALTH_WORKER_JS,
  path.join(os.homedir(), 'health-sync/.claude/worktrees/taplalkozas/worker/worker.js'),
  path.join(os.homedir(), 'health-sync/worker/worker.js')].filter(Boolean);
async function realWorker() {
  const file = WORKER_CANDIDATES.find(f => fs.existsSync(f));
  if (!file) return {skip: `SKIP: a Worker forrása nincs meg (kerestem: ${WORKER_CANDIDATES.map(f => f.replace(os.homedir(), '~')).join(', ')}) — add meg: HEALTH_WORKER_JS=…/worker.js`};
  const src = fs.readFileSync(file, 'utf8');
  if (!/\/nutrition/.test(src)) return {skip: `SKIP: ${file.replace(os.homedir(), '~')} még nem ismeri a /nutrition végpontot (a táplálkozás-ág nincs beolvasztva)`};
  const mod = await import(pathToFileURL(file).href);           // ha nem tölthető be, az HIBA, nem kihagyás
  must(mod.default && typeof mod.default.fetch === 'function', 'a worker.js alapértelmezett exportjának nincs fetch()-e');
  return {worker: mod.default, file};
}
// A Worker köré: memóriabeli KV, a Cache API utánzata hamis órával (mint a worker.test.mjs-ben).
function workerWorld(worker, o = {}) {
  const store = new Map(), cstore = new Map(), clock = {now: 1_000_000};
  const kv = {failPuts: 0,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { if (kv.failPuts > 0) { kv.failPuts--; throw new Error('KV put failed'); } store.set(k, v); }};
  const cache = {
    async match(req) { const e = cstore.get(new URL(req.url).href); return !e || e.until <= clock.now ? undefined : new Response(e.text); },
    async put(req, res) { const m = /max-age=(\d+)/.exec(res.headers.get('Cache-Control') || ''); if (m) cstore.set(new URL(req.url).href, {text: await res.text(), until: clock.now + Number(m[1]) * 1000}); },
  };
  const env = {READ_KEY: KEY, WRITE_KEY: 'teszt-sync-irokulcs-nem-titok', NUTRITION_WRITE_KEY: o.nkey || NKEY, HEALTH_KV: kv};
  const w = {store, kv, cache, clock, calls: [], off: o.off, autoAdvance: o.autoAdvance !== false};
  w.fetch = async (url, init) => {
    if (url.startsWith('https://world.openfoodfacts.org/')) return w.off ? w.off(url) : offMiss();
    must(url.startsWith(API + '/'), `váratlan lekérés: ${url}`);
    const method = String(init.method || 'GET').toUpperCase();
    const headers = {...(init.headers || {}), Origin: 'https://somogyif.github.io', 'CF-Connecting-IP': '203.0.113.10'};
    const prevCaches = globalThis.caches, log = console.log;
    globalThis.caches = {default: cache}; console.log = () => {};          // a Worker naplósorai ne szemeteljenek
    let res;
    try { res = await worker.fetch(new Request(url, {method, headers, body: init.body}), env); }
    finally { console.log = log; if (prevCaches === undefined) delete globalThis.caches; else globalThis.caches = prevCaches; }
    let body = null;
    try { body = await res.clone().json(); } catch (e) {}
    w.calls.push({method, status: res.status, body, sent: method === 'PUT' ? JSON.parse(init.body) : null, retryAfter: res.headers.get('Retry-After')});
    // Az óra: sikeres írás után telik az idő (a Worker 2 s-es írás-szünete), 429 után a Retry-After.
    if (method === 'PUT' && res.status === 200 && w.autoAdvance) clock.now += 2500;
    if (method === 'PUT' && res.status === 429) clock.now += 2500;
    // A Worker az írás-szünet helyét a KV-írás ELŐTT foglalja le, tehát a 503-mal végződő írás
    // is elindítja a 2 s-es szünetet. A lap 503 után ~2,5 s-et vár (ez az alapérték, lásd az
    // időzítések ellenőrzését) — az óra itt ennyit lép. Ha a lap várakozása a szünetnél
    // rövidebb lenne, az újrapróba 429-et kapna, és a lépés mentetlen maradna.
    if (method === 'PUT' && res.status === 503) clock.now += o.after503 == null ? 2500 : o.after503;
    return res;
  };
  w.puts = () => w.calls.filter(c => c.method === 'PUT');
  w.stored = () => JSON.parse(store.get('nutrition'));
  return w;
}
async function kamraOnWorker(worker, o = {}) {
  const w = workerWorld(worker, o);
  const p = page('kamra.html', {storage: o.storage || WPAIRED, now: KNOW, fetch: w.fetch, confirm: true});
  p.fire('DOMContentLoaded'); await settle(8);
  Object.assign(p.run('Kamra').timing, {debounce: 0, lazy: 0, gap: 0, retry: 0, margin: 0, retryMax: 60}, o.timing);
  return {w, p, K: p.run('Kamra'), txt: id => p.el(id).textContent.replace(/\s+/g, ' ').trim()};
}
check('valódi Worker: egy teljes munkamenet MINDEN írására 200 jön, és a rev lépésenként nő (üres dokumentumtól, targets: null-lal indulva)', async () => {
  const rw = await realWorker();
  if (rw.skip) return rw.skip;
  let n = 0;
  const off = () => (++n === 1 ? offOk(OFF_TUNA)() : offOk({product_name: 'Rejtély', brands: '', nutriments: {'energy-kcal_100g': 200}})());
  const {w, p, K, txt} = await kamraOnWorker(rw.worker, {off});
  must(w.calls.length === 1 && w.calls[0].status === 200 && JSON.stringify(K.doc()) === JSON.stringify(emptyDoc()),
       `a Worker üres alapja nem az, amire a lap számít: ${JSON.stringify(w.calls[0] && w.calls[0].body)}`);
  must(/nincs cél beállítva/.test(txt('todayBody')), 'targets: null-lal nem "nincs cél beállítva" látszik');
  const step = async (nev, f) => {
    const before = w.puts().length;
    const r = await f(); await K.flush(); await settle();
    const now = w.puts().slice(before), bad = now.find(c => c.status !== 200);
    must(!bad, `${nev}: a valódi Worker ${bad && bad.status}-t adott: ${JSON.stringify(bad && bad.body)} — küldve: ${String(JSON.stringify(bad && bad.sent)).slice(0, 300)}`);
    must(now.length >= 1, `${nev}: nem ment írás (a lépés eredménye: ${r})`);
    must(p.el('unsavedBox').hidden !== false, `${nev}: "nincs mentve" maradt — ${txt('msg')}`);
    must(JSON.stringify(K.doc()) === JSON.stringify(w.stored()), `${nev}: a lap állapota eltér a Workerben tárolttól`);
  };
  await step('szkennelt termék (OFF) a gyorsítótárba', () => K.lookup('8004030341234'));
  await step('kamrába +1 csomag', () => K.addPantry('8004030341234', 'pack', 1));
  await step('kamrába grammban', () => K.addPantry('8004030341234', 'g', 250));
  const [pk, gr] = K.doc().pantry.map(x => x.id);
  await step('+ lépés', () => K.pantryStep(pk, 1));
  await step('− lépés (g)', () => K.pantryStep(gr, -1));
  await step('három gyors koppintás egy írásban', () => Promise.all([K.pantryStep(pk, 1), K.pantryStep(pk, 1), K.pantryStep(pk, -1)]));
  await step('evés a kamrából (csomag)', () => K.eat({code: '8004030341234', pantryId: pk, grams: 80}));
  await step('hiányos tápértékű termék: keresés + evés (null makrók)', async () => { await K.lookup('5999999999999'); return K.eat({code: '5999999999999', grams: 33.3}); });
  await step('evés a kamrából, a tétel kiürül', () => K.eat({code: '8004030341234', pantryId: gr, grams: 200}));
  fillManual(p, {mName: 'Házi granola', mKcal: '450', mProtein: '12,5'});
  await step('kézi termék vonalkód nélkül (m_…)', () => K.saveManual());
  fillManual(p, {mCode: '5990000000001', mName: 'Túró Rudi', mBrand: 'Pöttyös', mKcal: '380', mPack: '30'});
  await step('kézi termék vonalkóddal', () => K.saveManual());
  await step('napló: egy tétel törlése (a nap megmarad)', () => K.logDelete(K.doc().log[KDAY][1].id));
  must(K.doc().log[KDAY].length === 2, 'előfeltétel: két tétel maradt');
  await step('napló: még egy tétel törlése', () => K.logDelete(K.doc().log[KDAY][0].id));
  await step('napló: a nap UTOLSÓ tételének törlése (a nap kulcsa is kikerül)', () => K.logDelete(K.doc().log[KDAY][0].id));
  must(!(KDAY in w.stored().log), `a kiürült nap kulcsa a dokumentumban maradt: ${JSON.stringify(w.stored().log)}`);
  await step('naptípus kézzel (célok nélkül)', () => K.setDay('hyrox'));
  await step('fenntartó hét (7 nap egy írásban)', () => K.maintenanceWeek());
  fillT(p, {...S4, hyrox: null, maintenance: null}, SCHED);
  await step('célok: két készlet null', () => K.saveTargets());
  fillT(p, {strength: null, hyrox: null, rest: null, maintenance: null}, SCHED);
  await step('célok: mind a négy készlet null', () => K.saveTargets());
  fillT(p, S4, SCHED);
  await step('célok: mind kitöltve', () => K.saveTargets());
  await step('vissza a heti rendhez', () => K.setDay('auto'));
  await step('evés célok mellett', () => K.eat({code: '8004030341234', grams: 120}));
  await step('kamra-tétel eltávolítása', () => K.pantryRemove(pk));
  const puts = w.puts();
  must(puts.length >= 22 && puts.every(c => c.status === 200), `${puts.length} írás, állapotok: ${puts.map(c => c.status)}`);
  puts.forEach((c, i) => must(c.sent.rev === i && c.body.ok === true && c.body.rev === i + 1, `${i + 1}. írás: küldött rev ${c.sent.rev}, válasz ${JSON.stringify(c.body)}`));
  must(w.stored().rev === puts.length && K.doc().rev === puts.length, `végső rev: ${w.stored().rev} / ${K.doc().rev} (${puts.length} írás)`);
  // az ál-szerver ellenőrzője ugyanazt mondja-e, mint a valódi: amit a valódi elfogadott, azt az is fogadja el
  const disagree = puts.map(c => invalidDoc(c.sent)).filter(e => e.length);
  must(!disagree.length, `a teszt saját ellenőrzője szigorúbb a valódi Workernél: ${disagree[0] && disagree[0][0]}`);
});
check('valódi Worker: az üres naplónap ([]) és a törölt nap is elfogadott; az ál-szerver ellenőrzője ugyanott utasít el, ahol a valódi', async () => {
  const rw = await realWorker();
  if (rw.skip) return rw.skip;
  const send = async doc => {
    const w = workerWorld(rw.worker);
    const r = await w.fetch(`${API}/nutrition`, {method: 'PUT', headers: {Authorization: `Bearer ${NKEY}`, 'Content-Type': 'application/json'}, body: JSON.stringify(doc)});
    return r.status;
  };
  must(await send({...emptyDoc(), log: {[KDAY]: []}}) === 200, 'az üres naplónapot ([]) a valódi Worker elutasítja');
  must(await send(emptyDoc()) === 200, 'az üres alapdokumentumot a valódi Worker elutasítja');
  const E = {id: 'l_1', code: null, name: 'X', grams: 10, kcal: null, protein: null, carbs: null, fat: null, time: '12:00'};
  const P = {id: 'p_1', code: null, name: 'X', qty: 1, unit: 'pack', added: KDAY};
  const cases = {
    'jó napló- és kamra-tétel': {...emptyDoc(), log: {[KDAY]: [E]}, pantry: [P]},
    'hiányzó days': (({days, ...r}) => r)(emptyDoc()),
    'ismeretlen kulcs': {...emptyDoc(), extra: 1},
    'grams 0': {...emptyDoc(), log: {[KDAY]: [{...E, grams: 0}]}},
    'qty 0': {...emptyDoc(), pantry: [{...P, qty: 0}]},
    'rossz napló-azonosító': {...emptyDoc(), log: {[KDAY]: [{...E, id: 'x1'}]}},
    'rossz idő': {...emptyDoc(), log: {[KDAY]: [{...E, time: '24:00'}]}},
    'nem létező nap': {...emptyDoc(), log: {'2026-02-30': []}},
    'hiányzó code kulcs': {...emptyDoc(), pantry: [(({code, ...r}) => r)(P)]},
    'rossz kézi termékkód': {...emptyDoc(), products: {'m_x': TUNA}},
    'hiányzó brand': {...emptyDoc(), products: {'111111': (({brand, ...r}) => r)(TUNA)}},
    'sets-ből hiányzó típus': {...emptyDoc(), targets: {sets: {strength: null, hyrox: null, rest: null}, schedule: SCHED, updated: KDAY}},
    'ismeretlen naptípus': {...emptyDoc(), days: {[KDAY]: 'cheat'}},
    'jó célok null készletekkel': {...emptyDoc(), targets: {sets: {strength: null, hyrox: null, rest: null, maintenance: null}, schedule: SCHED, updated: KDAY}},
    'túl nagy szám': {...emptyDoc(), log: {[KDAY]: [{...E, kcal: 100001}]}},
  };
  for (const [nev, doc] of Object.entries(cases)) {
    const real = await send(doc), mock = invalidDoc(doc).length ? 400 : 200;
    must(real === mock, `${nev}: a valódi Worker ${real}, a teszt ellenőrzője ${mock}`);
  }
});
check('valódi Worker: a hibaválaszai úgy érkeznek, ahogy a lap kezeli — 429 gap (Retry-After), 429 day, 409, 401, 503', async () => {
  const rw = await realWorker();
  if (rw.skip) return rw.skip;
  const seed = {...emptyDoc(), products: {'111111': TUNA}};
  const boot = async o => { const x = await kamraOnWorker(rw.worker, o); await x.K.setDay('rest'); return x; };   // 1. írás: rev 0 → 1
  // 429 gap: két írás 2 s-en belül → a lap a Retry-After szerint vár, és egyszer újrapróbál
  const a = await boot({autoAdvance: false});
  const okA = await a.K.setDay('hyrox');
  const sa = a.w.puts().map(c => c.status);
  must(JSON.stringify(sa) === '[200,429,200]' && okA === true, `gap: ${sa}, eredmény: ${okA}`);
  must(a.w.puts()[1].body.error === 'rate_limited' && a.w.puts()[1].body.scope === 'gap' && /^\d+$/.test(a.w.puts()[1].retryAfter), `a 429 alakja: ${JSON.stringify(a.w.puts()[1])}`);
  // 429 day: a napi keret elfogyott → nincs újrapróba, a lépés "nincs mentve"
  const b = await boot();
  await b.w.cache.put(new Request('https://nw.invalid/day'), new Response(`150:${Math.floor(Date.now() / 1000)}`, {headers: {'Cache-Control': 'max-age=86400'}}));
  const okB = await b.K.setDay('hyrox');
  const sb = b.w.puts().map(c => c.status);
  must(JSON.stringify(sb) === '[200,429]' && okB === false && b.w.puts()[1].body.scope === 'day', `day: ${sb} ${JSON.stringify(b.w.puts()[1].body)}`);
  must(b.p.el('unsavedBox').hidden === false && /mai írási keret elfogyott/.test(b.txt('msg')), `day üzenet: ${b.txt('msg')}`);
  // 409: közben egy másik eszköz írt → újratöltés, újra-alkalmazás, egy újrapróba
  const c = await boot();
  const other = c.w.stored(); other.days['2026-01-05'] = 'strength'; other.rev = 2; c.w.store.set('nutrition', JSON.stringify(other));
  const okC = await c.K.setDay('hyrox');
  const sc = c.w.puts().map(x => x.status);
  must(JSON.stringify(sc) === '[200,409,200]' && okC === true && c.w.stored().days['2026-01-05'] === 'strength' && c.w.stored().days[KDAY] === 'hyrox' && c.w.stored().rev === 3,
       `409: ${sc}, tárolt: ${JSON.stringify(c.w.stored().days)} rev ${c.w.stored().rev}`);
  // 401: rossz írókulcs → a lépés visszavonva
  const d = await kamraOnWorker(rw.worker, {nkey: 'egy-masik-irokulcs-nem-titok'});
  const okD = await d.K.setDay('rest');
  must(okD === false && d.w.puts().length === 1 && d.w.puts()[0].status === 401 && /írókulcs/i.test(d.txt('msg')) && !d.w.store.has('nutrition'), `401: ${d.w.puts().map(x => x.status)} — ${d.txt('msg')}`);
  // 503: a KV egyszer nem írható → egy újrapróba, siker
  const e = await boot();
  e.w.kv.failPuts = 1;
  const okE = await e.K.setDay('hyrox');
  const se = e.w.puts().map(x => x.status);
  must(JSON.stringify(se) === '[200,503,200]' && okE === true && e.w.stored().days[KDAY] === 'hyrox', `503: ${se}, eredmény: ${okE}`);
  // …és ezért a lap 503 utáni várakozásának HOSSZABBNAK kell lennie a Worker írás-szüneténél:
  const gapMs = Number(a.w.puts()[1].retryAfter) * 1000, def = page('kamra.html', {storage: WPAIRED}).run('Kamra').timing.retry;
  must(def > gapMs, `a lap 503 utáni várakozása (${def} ms) nem hosszabb a Worker írás-szüneténél (${gapMs} ms)`);
  const f = await boot({after503: 0});                              // a szünetnél rövidebb várakozás: 429 jönne — a lépés ekkor sem vész el
  f.w.kv.failPuts = 1;
  const okF = await f.K.setDay('hyrox');
  must(okF === false && f.p.el('unsavedBox').hidden === false && f.txt('todayBody').includes('HYROX'), `503 → 429: a lépés elveszett (${f.w.puts().map(x => x.status)})`);
});

// Böngészőben mérve (375 px-es keret, demó adat): a kamra-linkkel a fejléc scrollWidth-je
// 375 → 388 lett — a .topnav és a .nav-right egy sorba kényszerítette az öt elemet.
check('kamra-link (index) 375 px: a fejléc törhet (.topnav és .nav-right flex-wrap), nem tolja ki a lapot', () => {
  const css = read('index.html');
  const rule = sel => (new RegExp(sel.replace('.', '\\.') + '\\{([^}]*)\\}').exec(css) || [])[1] || '';
  must(/flex-wrap:wrap/.test(rule('.topnav')) && /flex-wrap:wrap/.test(rule('.nav-right')), `.topnav{${rule('.topnav')}} .nav-right{${rule('.nav-right')}}`);
});

// ── futtatás ────────────────────────────────────────────────────────────────────
module.exports = {page, settle, demo, json};   // egyedi próbákhoz: require('./page_checks')
if (require.main === module) (async () => {
  const only = process.argv[2];
  let bad = 0, ran = 0, skipped = 0;
  for (const c of checks) {
    if (only && !c.name.includes(only)) continue;
    ran++;
    try {
      // Egy ellenőrzés KIHAGYHATJA magát ('SKIP: ok' visszatérő értékkel) — ez látszik a
      // kimenetben és az összesítőben is: sem csendben zöld, sem csendben piros.
      const r = await c.fn();
      if (typeof r === 'string' && r.startsWith('SKIP')) { skipped++; ran--; console.log(`  ⊘ ${c.name}\n      KIHAGYVA — ${r.replace(/^SKIP:?\s*/, '')}`); }
      else console.log(`  ✓ ${c.name}`);
    }
    catch (e) { bad++; console.log(`  ✗ ${c.name}\n      ${String(e && e.stack || e).split('\n').slice(0, 3).join('\n      ')}`); }
  }
  console.log((bad ? `BUKÓ: ${bad}/${ran}` : `OK: ${ran}/${ran}`) + (skipped ? ` · KIHAGYVA: ${skipped}` : ''));
  process.exit(bad ? 1 : 0);
})();
