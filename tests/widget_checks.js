#!/usr/bin/env node
// tests/widget_checks.js — a Scriptable-widget (widget/egeszseg.js) ellenőrzése egy hamis
// Scriptable-környezetben (node:vm). Nincs függőség és nincs hálózat: a Request ál-választ ad,
// a végpont és a kulcs kitalált. Futtatás: node tests/widget_checks.js [szűrő]
// Kilépési kód: 0 = minden zöld · 1 = van bukó ellenőrzés.
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'widget/egeszseg.js'), 'utf8');
const API = 'https://adat.pelda.example', KEY = 'a'.repeat(64);
const LINK = `https://somogyif.github.io/health/#api=${API}&key=${KEY}`;

const checks = [];
const check = (name, fn) => checks.push({name, fn});
const must = (c, msg) => { if (!c) throw new Error(msg); };

// ── A hamis Scriptable ───────────────────────────────────────────────────────
function env(opt = {}) {
  const rec = {widgets: [], set: null, notes: [], output: undefined, completed: 0, presented: [],
               kc: new Map(Object.entries(opt.keychain || {})), files: new Map(Object.entries(opt.files || {})),
               requests: [], alerts: []};
  class Color { constructor(hex, alpha = 1) { this.hex = hex; this.alpha = alpha; } static dynamic(l, d) { return {light: l.hex, dark: d.hex}; } }
  class LinearGradient { constructor() { this.colors = []; } }
  class Point { constructor(x, y) { this.x = x; this.y = y; } }
  class Size { constructor(w, h) { this.w = w; this.h = h; } }
  const SFSymbol = {named: n => (opt.noSymbols ? null : {image: {sf: n}})};
  const Font = new Proxy({}, {get: (_, name) => size => ({name, size})});
  class Elem {
    constructor(kind) { this.kind = kind; this.children = []; }
    addText(t) { const x = {kind: 'text', text: String(t)}; this.children.push(x); return x; }
    addStack() { const s = new Elem('stack'); this.children.push(s); return s; }
    addSpacer(n) { this.children.push({kind: 'spacer', n}); }
    addImage(img) { const x = {kind: 'image', img}; this.children.push(x); return x; }
    layoutHorizontally() { this.dir = 'h'; } layoutVertically() { this.dir = 'v'; }
    setPadding() {} centerAlignContent() {} bottomAlignContent() {}
  }
  class ListWidget extends Elem {
    constructor() { super('widget'); rec.widgets.push(this); }
    async presentSmall() { rec.presented.push(['small', this]); }
    async presentMedium() { rec.presented.push(['medium', this]); }
    async presentLarge() { rec.presented.push(['large', this]); }
  }
  class Request {
    constructor(url) { this.url = url; rec.requests.push(this); }
    async loadJSON() {
      const r = typeof opt.fetch === 'function' ? opt.fetch(this) : opt.fetch;
      if (!r || r instanceof Error) throw (r || new Error('nincs hálózat'));
      this.response = {statusCode: r.status};
      return r.body;
    }
  }
  class Notification { schedule() { rec.notes.push({title: this.title, body: this.body}); return Promise.resolve(); } }
  class Alert {
    constructor() { this.fields = []; this.actions = []; rec.alerts.push(this); }
    addTextField(ph, v) { this.fields.push(v || ''); } addAction(t) { this.actions.push(t); } addCancelAction(t) { this.cancel = t; }
    async presentAlert() { return opt.alert ? opt.alert(this) : -1; }
    async presentSheet() { return opt.sheet ? opt.sheet(this) : -1; }
    textFieldValue(i) { return this.answer != null ? this.answer : this.fields[i]; }
  }
  const ctx = {
    Color, Font, ListWidget, Request, Notification, Alert, console, LinearGradient, Point, Size, SFSymbol,
    Keychain: {contains: k => rec.kc.has(k), get: k => rec.kc.get(k), set: (k, v) => rec.kc.set(k, v), remove: k => rec.kc.delete(k)},
    Script: {setWidget: w => { rec.set = w; }, complete: () => { rec.completed++; }, setShortcutOutput: v => { rec.output = v; }},
    FileManager: {local: () => ({documentsDirectory: () => '/docs', joinPath: (a, b) => `${a}/${b}`,
      fileExists: p => rec.files.has(p), readString: p => rec.files.get(p), writeString: (p, s) => rec.files.set(p, s)})},
    Pasteboard: {pasteString: () => opt.paste || ''},
    Device: {isUsingDarkAppearance: () => false},
    config: Object.assign({runsInWidget: false, runsInApp: false, widgetFamily: undefined}, opt.config),
    args: Object.assign({widgetParameter: null, shortcutParameter: null}, opt.args),
    __WIDGET_TEST__: true,
  };
  vm.createContext(ctx);
  if (opt.now) vm.runInContext(`(() => { const R = Date, NOW = ${Number(opt.now)};
    globalThis.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } };
  })()`, ctx);
  return {ctx, rec};
}

// A szkript tesztelt függvényei. A hiányzó név undefined lesz (nem ReferenceError), így egy
// hiányzó függvény csak a saját ellenőrzéseit buktatja, nem az összeset.
const EXPORTS = ['model', 'reggeliUzenet', 'parseLink', 'teendok', 'esemenyek', 'frissesseg', 'widget', 'main', 'kimondIdo',
                 'lejarok', 'kamraSor', 'ertesites'];
async function load(opt) {
  const {ctx, rec} = env(opt);
  const ki = EXPORTS.map(n => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ');
  const api = await vm.runInContext(`(async () => {\n${SRC}\nreturn {${ki}};\n})()`, ctx, {filename: 'widget/egeszseg.js'});
  return {api, rec, ctx};
}

const szovegek = node => (node.kind === 'text' ? [node.text] : (node.children || []).flatMap(szovegek));
const keres = (node, f) => (f(node) ? [node] : []).concat((node.children || []).flatMap(c => keres(c, f)));
const luminancia = hex => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255].map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
};
const kontraszt = (a, b) => { const x = luminancia(a), y = luminancia(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const MA = at(2026, 11, 17, 7, 15);        // kedd

function adat(over = {}) {
  return Object.assign({
    synced_at: '2026-11-17 07:02',
    garmin: {readiness_score: 74, sleep_hours: 7.8, bb_current: 71, steps: 8412},
    day_plan: {today: {recovery: 'moderate'}},
    tasks: {today: {tasks: [{name: 'Labor jelentés', source: 'things'}, {name: 'Fogorvos', source: 'google'}], count: 2},
            tomorrow: {tasks: [], count: 0},
            overdue: {tasks: [{name: 'Könyvtári könyv', source: 'google', overdue: true}], count: 1}},
    calendar: [{start_date: '2026-11-17', time: '06:30', title: 'Futás'},
               {start_date: '2026-11-17', time: '10:00', title: 'Meeting'},
               {start_date: '2026-11-17', time: '17:30', title: 'Edzőterem'},
               {start_date: '2026-11-18', time: '07:30', title: 'Edzés'},
               {start_date: '2026-11-18', time: '', title: 'Születésnap', all_day: true}],
  }, over);
}

// ── Tiszta függvények ────────────────────────────────────────────────────────
check('párosító link: a Safari-link működik, minden más elutasítva', async () => {
  const {api} = await load();
  const ok = api.parseLink(LINK);
  must(ok && ok.api === API && ok.key === KEY, `jó link: ${JSON.stringify(ok)}`);
  must(api.parseLink(LINK.replace('#api=' + API, '#api=' + API + '/')).api === API, 'a záró perjel nem törlődött');
  for (const rossz of ['', 'szöveg', LINK.replace('#', '?'), LINK.replace('https://adat', 'http://adat'),
                       LINK.replace(KEY, 'rovid'), `${LINK.split('&')[0]}`, LINK.replace(API, `${API}/data`),
                       LINK.replace(KEY, 'a b c'.repeat(8))])
    must(api.parseLink(rossz) === null, `elfogadta: ${rossz.slice(0, 60)}`);
});

check('reggel, friss adat: három szám, egy mondat javaslat, a következő esemény', async () => {
  const {api} = await load();
  const m = api.model(adat(), MA);
  must(!m.este && m.cimke === 'Ma · nov. 17., kedd', `címke: ${m.cimke}`);
  must(m.statok.map(s => s.ertek).join('|') === '74|7.8 ó|71', `számok: ${m.statok.map(s => s.ertek)}`);
  must(m.tanacs === 'Közepes nap: könnyű edzés, és kezdd a lejárt teendővel.', `tanács: ${m.tanacs}`);
  must(m.also === '10:00 Meeting', `a következő esemény (a 06:30-as már elmúlt): ${m.also}`);
  must(m.fr.cimke === 'frissült 07:02', m.fr.cimke);
  must(m.rovid === 'Könnyű edzés' && m.szint.tonus === 'figyel', `${m.rovid} / ${m.szint.tonus}`);
});

check('reggel: a tanács a napi tervből és a teendőkből — ismeretlenre nem talál ki', async () => {
  const {api} = await load();
  const t = (rec, tasks) => api.model(adat({day_plan: {today: {recovery: rec}}, ...(tasks === undefined ? {} : {tasks})}), MA).tanacs;
  must(t('high') === 'Jó nap: a kemény edzés is mehet, és kezdd a lejárt teendővel.', t('high'));
  must(t('low', {today: {tasks: [{name: 'X'}], count: 1}, overdue: {tasks: [], count: 0}}) === 'Pihenős nap: pihenőnap, és 1 mai teendő vár.', t('low'));
  must(t('moderate', {today: {tasks: [], count: 0}, overdue: {tasks: [], count: 0}}) === 'Közepes nap: könnyű edzés, és nincs határidős teendőd.', 'üres lista');
  must(t('unknown') === 'Az óra adata ma hiányzik; kezdd a lejárt teendővel.', `ismeretlen: ${t('unknown')}`);
  must(t('moderate', null) === 'Közepes nap: könnyű edzés.', `ismeretlen teendők: ${t('moderate', null)}`);
  const ures = api.model(adat({garmin: {}, tasks: null}), MA);
  must(ures.statok.every(s => s.ertek === '—'), `hiányzó Garmin-adatra kitalált szám: ${ures.statok.map(s => s.ertek)}`);
  must(api.model(adat({garmin: {sleep_hours: 0.0}}), MA).statok[1].ertek === '—', 'a 0 óra alvás nem mérés');
});

check('régi adat (hajnalban a tegnap esti): nem ad régi számokból tanácsot, és megmondja, mikori', async () => {
  const {api} = await load();
  const m = api.model(adat({synced_at: '2026-11-16 20:02'}), at(2026, 11, 17, 6, 30));
  must(!m.este, 'a tegnap esti adat ma reggel esti nézetet adott');
  must(m.statok.every(s => s.ertek === '—') && m.szint.szo === 'Ismeretlen', `számok: ${m.statok.map(s => s.ertek)}`);
  must(m.tanacs === 'A mai adat még nem jött meg — 7:00 után frissül.', m.tanacs);
  must(m.fr.cimke === 'frissült tegnap 20:02', m.fr.cimke);
  must(api.model(adat({synced_at: '2026-11-12 12:00'}), MA).fr.cimke === 'frissült nov. 12. 12:00', 'régebbi dátum');
  must(api.model(adat({synced_at: 'nem dátum'}), MA).tanacs.startsWith('A mai adat még nem jött meg'), 'hibás bélyeg');
});

check('este (a 20:00-s sync után): body battery, lépés, nyitott teendők; a holnapi első esemény', async () => {
  const {api} = await load();
  const este = (bb, cal) => api.model(adat({synced_at: '2026-11-17 20:02', garmin: {bb_current: bb, steps: 8412},
                                            ...(cal ? {calendar: cal} : {})}), at(2026, 11, 17, 21, 0));
  const m = este(32);
  must(m.este && m.cimke === 'Ma este · kedd', m.cimke);
  must(m.statok.map(s => s.ertek).join('|') === '32|8 412|3', `számok: ${m.statok.map(s => s.ertek)}`);
  must(m.tanacs === 'Lassíts: feküdj le időben — holnap 07:30-kor Edzés.', m.tanacs);
  must(m.szint.szo === 'Alacsony' && m.rovid === 'Korán ágyba', `${m.szint.szo} / ${m.rovid}`);
  must(este(60).tanacs === 'Holnap korán kezdesz: 07:30 Edzés.', este(60).tanacs);
  must(este(60, [{start_date: '2026-11-18', time: '11:00', title: 'Óra'}]).tanacs === 'Holnap az első esemény: 11:00 Óra.', 'késői első esemény');
  must(este(60, []).tanacs === 'Holnapra nincs időpontos esemény.', 'üres holnap');
  must(este(null).szint.szo === 'Ismeretlen' && este(null).statok[0].ertek === '—', 'ismeretlen akku');
  must(api.model(adat({synced_at: '2026-11-17 12:01'}), at(2026, 11, 17, 21, 0)).este === false,
       'a déli adat este esti nézetet adott (régi akkuval)');
});

check('teendők: ismeretlen ≠ nulla; a lejártak előre; a forrás neve', async () => {
  const {api} = await load();
  const x = api.teendok(null);
  must(!x.ismert && x.nyitott === null, 'a hiányzó lista nullának számított');
  const t = api.teendok(adat().tasks);
  must(t.nyitott === 3 && t.lejart === 1 && t.ma === 2, `számok: ${t.nyitott}/${t.lejart}/${t.ma}`);
  must(t.lista.map(i => `${i.mikor}:${i.nev}:${i.forras}`).join(',') === 'lejárt:Könyvtári könyv:Google,ma:Labor jelentés:Things,ma:Fogorvos:Google', JSON.stringify(t.lista));
});

check('reggeli értesítés: cím, szöveg, felolvasható változat; régi adatnál és este őszinte', async () => {
  const {api} = await load();
  const u = api.reggeliUzenet(adat(), MA);
  must(u.cim === 'Jó reggelt — közepes nap', u.cim);
  must(u.szoveg === 'Readiness 74 · alvás 7.8 óra · body battery 71. Közepes nap: könnyű edzés, és kezdd a lejárt teendővel. Első esemény: 10:00 Meeting.', u.szoveg);
  must(u.beszed.includes('alvás 7,8 óra') && u.beszed.includes('Első esemény 10 órakor: Meeting.'), u.beszed);
  must(api.kimondIdo('07:30') === '7 óra 30-kor', api.kimondIdo('07:30'));
  const regi = api.reggeliUzenet(adat({synced_at: '2026-11-16 20:02'}), MA);
  must(regi.cim === 'Reggeli állapot — még nincs mai adat' && regi.szoveg.includes('frissült tegnap 20:02'), regi.szoveg);
  const este = api.reggeliUzenet(adat({synced_at: '2026-11-17 20:02', garmin: {bb_current: 32, steps: 1}}), at(2026, 11, 17, 21, 0));
  must(este.cim === 'Esti állapot' && este.szoveg.startsWith('Body battery 32 · 3 nyitott teendő.') && !/Readiness/.test(este.szoveg),
       `este a reggeli címkékkel: ${este.szoveg}`);
  must(!/—/.test(api.reggeliUzenet(adat({garmin: {}}), MA).beszed), 'a felolvasott szövegben gondolatjel-„érték” maradt');
});

// ── A rajzolás ───────────────────────────────────────────────────────────────
check('widgetek: kicsi (állapot / következő), közepes, nagy, zárképernyő — a helyes tartalommal', async () => {
  const {api} = await load();
  const m = api.model(adat(), MA);
  const s = (fam, par) => szovegek(api.widget(m, fam, par)).join(' | ');
  const kicsi = s('small');
  must(kicsi === 'READINESS | 74 | Közepes nap | Könnyű edzés', `kicsi: ${kicsi}`);
  const kov = s('small', 'kovetkezo');
  must(kov === 'KÖVETKEZŐ | 10:00 | Meeting | lejárt | Könyvtári könyv', `következő: ${kov}`);
  const koz = s('medium');
  must(koz === 'MA · KEDD | frissült 07:02 | 74 | Közepes\nnap | Könnyű edzés, és kezdd a lejárt teendővel. | 7.8 ó | 71 | 3 · 1 lejárt',
       `közepes: ${koz}`);
  const nagy = s('large');
  must(nagy.startsWith('MA · NOV. 17., KEDD | MA · KEDD') && nagy.includes('TEENDŐK | lejárt | Könyvtári könyv | Google') &&
       nagy.includes('NAPTÁR | 10:00 | Meeting | 17:30 | Edzőterem'), `nagy: ${nagy}`);
  must(s('accessoryRectangular') === '74 · Könnyű edzés', `zárképernyő: ${s('accessoryRectangular')}`);
  const esti = api.model(adat({synced_at: '2026-11-17 20:02', garmin: {bb_current: 32, steps: 5}}), at(2026, 11, 17, 21, 0));
  const estiKoz = szovegek(api.widget(esti, 'medium')).join(' | ');
  must(estiKoz === 'MA ESTE · KEDD | frissült 20:02 | 32 | Alacsony\nakku | Lassíts: feküdj le időben — holnap 07:30-kor Edzés. | 5 | 3 nyitott | holnap 07:30',
       `esti közepes: ${estiKoz}`);
  const estiNagy = szovegek(api.widget(esti, 'large')).join(' | ');
  // Az egész napos esemény elöl, mint az iPhone naptárában.
  must(estiNagy.includes('HOLNAP | egész nap | Születésnap | 07:30 | Edzés'), `esti nagy: ${estiNagy}`);
  must(szovegek(api.widget(esti, 'small', 'kovetkezo')).join(' | ') === 'HOLNAP | 07:30 | Edzés | lejárt | Könyvtári könyv', 'esti kicsi');
  const ures = api.model(adat({tasks: null, calendar: []}), MA);
  must(szovegek(api.widget(ures, 'large')).join(' | ').includes('A teendők most nem olvashatók.'), 'ismeretlen teendők a nagyban');
  must(szovegek(api.widget(ures, 'medium')).join(' | ').endsWith('| ismeretlen'), 'ismeretlen teendők a közepesben');
  must(szovegek(api.widget(ures, 'small', 'kovetkezo')).join(' | ').endsWith('Teendők: ismeretlen'), 'ismeretlen teendők a kicsiben');
});

check('hangulat-szín: a háttér a nap állapota (jó / közepes / pihenős / nincs mai adat / este)', async () => {
  const {api} = await load();
  const bg = m => { const g = api.widget(m, 'medium').backgroundGradient; return g ? g.colors.map(c => c.hex).join('>') : 'nincs'; };
  const reggel = rec => api.model(adat({day_plan: {today: {recovery: rec}}}), MA);
  must(bg(reggel('high')) === '#15803d>#166534', `jó: ${bg(reggel('high'))}`);
  must(bg(reggel('moderate')) === '#c2410c>#9a3412', `közepes: ${bg(reggel('moderate'))}`);
  must(bg(reggel('low')) === '#4338ca>#3730a3', `pihenős: ${bg(reggel('low'))}`);
  must(bg(reggel('unknown')) === '#475569>#334155', `ismeretlen: ${bg(reggel('unknown'))}`);
  must(bg(api.model(adat({synced_at: '2026-11-16 20:02'}), MA)) === '#475569>#334155', 'a régi adat színes állapotot kapott');
  const este = bb => api.model(adat({synced_at: '2026-11-17 20:02', garmin: {bb_current: bb, steps: 1}}), at(2026, 11, 17, 21));
  must(bg(este(60)) === '#1e40af>#1e3a8a' && bg(este(20)) === '#4338ca>#3730a3' && bg(este(null)) === '#475569>#334155',
       `este: ${bg(este(60))} / ${bg(este(20))} / ${bg(este(null))}`);
});

check('hangulat-szín: minden háttérszínen a fehér szöveg legalább 4.5:1', async () => {
  const blokk = /const PALETTAK = \{([\s\S]*?)\};/.exec(SRC);
  must(blokk, 'nincs PALETTAK (nem bizonyít)');
  const hexek = [...blokk[1].matchAll(/#[0-9a-f]{6}/gi)].map(x => x[0]);
  must(hexek.length >= 12, `kevés szín (nem bizonyít): ${hexek}`);
  for (const h of hexek) must(kontraszt('#ffffff', h) >= 4.5, `${h}: fehérrel csak ${kontraszt('#ffffff', h).toFixed(2)}:1`);
});

check('alvás-oszlopok: az utolsó 7 éjszaka, a mai teli fehér; adat nélkül nincs oszlop', async () => {
  const {api} = await load();
  const het = [70, 82, 64, 90, 75, 80, 88].map((score, i) => ({date: `2026-11-${10 + i}`, score}));
  const g = Object.assign({}, adat().garmin, {sleep_week: [{date: 'régi', score: 50}].concat(het, [{date: 'x', score: null}])});
  const m = api.model(adat({garmin: g}), MA);
  must(m.het.join(',') === '70,82,64,90,75,80,88', `az utolsó 7 éjszaka: ${m.het}`);
  const o = keres(api.widget(m, 'medium'), n => n.kind === 'stack' && n.cornerRadius === 3 && n.size);
  must(o.length === 7, `${o.length} oszlop`);
  must(o[6].backgroundColor.alpha === 1 && o[0].backgroundColor.alpha < 1, 'a mai oszlop nem emelkedik ki');
  must(o[3].size.h > o[2].size.h && o.every(x => x.size.h >= 4 && x.size.h <= 26), `magasságok: ${o.map(x => x.size.h)}`);
  must(keres(api.widget(api.model(adat(), MA), 'medium'), n => n.cornerRadius === 3).length === 0, 'adat nélkül is rajzolt oszlopot');
});

check('ikonok: SF Symbols a sorok előtt; ha egy jel hiányzik, a widget akkor is kirajzol', async () => {
  const {api} = await load();
  const kepek = keres(api.widget(api.model(adat(), MA), 'medium'), n => n.kind === 'image').map(n => n.img.sf);
  must(kepek.join(',') === 'sun.max.fill,moon.fill,battery.75,checklist', `ikonok: ${kepek}`);
  const {api: api2} = await load({noSymbols: true});
  const t = szovegek(api2.widget(api2.model(adat(), MA), 'medium')).join(' | ');
  must(t.includes('7.8 ó') && t.includes('Könnyű edzés'), `ikonok nélkül: ${t}`);
});

// ── A főprogram ──────────────────────────────────────────────────────────────
const PAROSITVA = {'healthcentre.api': API, 'healthcentre.key': KEY};
const jo = (d = adat()) => ({status: 200, body: d});

check('widgetként: a végpontról olvas (Bearer kulcs), ment, és kirajzol', async () => {
  const {api, rec} = await load({now: +MA, keychain: PAROSITVA, fetch: jo(), config: {runsInWidget: true, widgetFamily: 'medium'}});
  await api.main();
  must(rec.requests.length === 1 && rec.requests[0].url === `${API}/data`, `kérés: ${rec.requests.map(r => r.url)}`);
  must(rec.requests[0].headers.Authorization === `Bearer ${KEY}` && rec.requests[0].timeoutInterval > 0, 'fejléc vagy timeout');
  must(rec.set && szovegek(rec.set).join(' | ').includes('Könnyű edzés, és kezdd a lejárt teendővel.'), 'nem rajzolt');
  must(rec.files.has('/docs/healthcentre-utolso.json') && rec.completed === 1, 'nem mentette a legutóbbi adatot');
});

check('hálózati hiba: a legutóbbi mentett adat a korával; ha nincs, „Nincs adat”; a 401 is hiba', async () => {
  const mentett = {'/docs/healthcentre-utolso.json': JSON.stringify(adat({synced_at: '2026-11-16 20:02'}))};
  let x = await load({now: +MA, keychain: PAROSITVA, fetch: new Error('offline'), files: mentett, config: {runsInWidget: true, widgetFamily: 'medium'}});
  await x.api.main();
  must(szovegek(x.rec.set).join(' | ').includes('frissült tegnap 20:02'), `a mentett adat kora nem látszik: ${szovegek(x.rec.set)}`);
  x = await load({now: +MA, keychain: PAROSITVA, fetch: new Error('offline'), config: {runsInWidget: true, widgetFamily: 'small'}});
  await x.api.main();
  must(szovegek(x.rec.set).join(' | ').startsWith('Nincs adat'), 'mentés nélkül sem jelezte');
  x = await load({now: +MA, keychain: PAROSITVA, fetch: {status: 401, body: {error: 'unauthorized'}}, config: {runsInWidget: true}});
  await x.api.main();
  must(szovegek(x.rec.set).join(' | ').includes('401'), 'a 401-et adatként kezelte');
  must(!x.rec.files.size, 'hibás választ mentett el');
});

check('párosítás: widgetként kéri; az appban a link a kulcskarikába kerül; rossz linket nem ment', async () => {
  let x = await load({now: +MA, config: {runsInWidget: true}});
  await x.api.main();
  must(szovegek(x.rec.set).join(' | ').startsWith('Párosítás kell') && !x.rec.requests.length, 'párosítás nélkül is kért');
  x = await load({now: +MA, paste: LINK, fetch: jo(), config: {runsInApp: true}, alert: a => (a.fields.length ? 0 : -1)});
  await x.api.main();
  must(x.rec.kc.get('healthcentre.api') === API && x.rec.kc.get('healthcentre.key') === KEY, 'nem mentette a párosítást');
  must(x.rec.alerts[0].fields[0] === LINK, 'a vágólapról nem ajánlotta fel a linket');
  x = await load({now: +MA, config: {runsInApp: true}, alert: a => { if (a.fields.length) a.answer = 'nem link'; return 0; }});
  await x.api.main();
  must(!x.rec.kc.size && x.rec.alerts.some(a => a.title === 'Ez nem párosító link'), 'rossz linkre nem szólt, vagy mentett');
});

check('Parancsok, „ertesites”: értesítés a mai állapotról, és a felolvasandó szöveg vissza', async () => {
  const {api, rec} = await load({now: +MA, keychain: PAROSITVA, fetch: jo(), args: {shortcutParameter: 'ertesites'}});
  await api.main();
  must(rec.notes.length === 1 && rec.notes[0].title === 'Jó reggelt — közepes nap', JSON.stringify(rec.notes));
  must(typeof rec.output === 'string' && rec.output.startsWith('Jó reggelt! Readiness 74'), `kimenet: ${rec.output}`);
  must(!rec.set && !rec.presented.length, 'értesítés helyett widgetet rajzolt');
});

check('Parancsok paraméter nélkül (az újabb iOS csak fájlt enged a mezőbe): magától értesít', async () => {
  const {api, rec} = await load({now: +MA, keychain: PAROSITVA, fetch: jo(), config: {runsInWidget: false, runsInApp: false}});
  await api.main();
  must(rec.notes.length === 1 && rec.notes[0].title === 'Jó reggelt — közepes nap', `értesítés: ${JSON.stringify(rec.notes)}`);
  must(typeof rec.output === 'string' && rec.output.startsWith('Jó reggelt!'), `kimenet: ${rec.output}`);
  must(!rec.set && !rec.presented.length && !rec.alerts.length, 'menüt vagy widgetet rajzolt a Parancsokban');
});

check('az appban: menü — előnézet minden méretben, értesítés-próba', async () => {
  for (const [pont, meret, szoveg] of [['Kicsi — következő', 'small', 'KÖVETKEZŐ'], ['Nagy', 'large', 'TEENDŐK'], ['Közepes', 'medium', 'Könnyű edzés']]) {
    const {api, rec} = await load({now: +MA, keychain: PAROSITVA, fetch: jo(), config: {runsInApp: true},
                                    sheet: a => a.actions.indexOf(pont)});
    await api.main();
    must(rec.presented.length === 1 && rec.presented[0][0] === meret && szovegek(rec.presented[0][1]).join(' ').includes(szoveg),
         `${pont}: ${rec.presented.map(p => p[0])}`);
  }
  const {api, rec} = await load({now: +MA, keychain: PAROSITVA, fetch: jo(), config: {runsInApp: true},
                                  sheet: a => a.actions.indexOf('Értesítés próba')});
  await api.main();
  must(rec.notes.length === 1, 'az értesítés-próba nem küldött');
});

// ── Kamra a reggeli értesítésben ─────────────────────────────────────────────
// A 7:15-ös értesítés végén egy sor: a 3 napon belül lejáró és a már lejárt kamra-tételek —
// ugyanazzal a szabállyal, mint a kamra.html „Hamarosan lejár”-ja (a kettőt a
// tests/page_checks.js veti össze). A widget képe NEM változik.
const termek = (name, extra = {}) => Object.assign({name, brand: null, per100: {kcal: null, protein: null, carbs: null, fat: null},
  pack_g: null, serving_g: null, source: 'off', added: '2026-11-10'}, extra);
const tetel = (name, code, extra = {}) => Object.assign({id: `p_${name}`, code, name, qty: 1, unit: 'pack', added: '2026-11-10'}, extra);
const TERMEKEK = {
  tej: termek('Friss tej 2,8%'),                         // a neve szerint friss tej: felbontva 3 nap
  joghurt: termek('Valami', {kind: 'yogurt'}),           // a tárolt fajta szerint: 3 nap
  rejtely: termek('Rejtély'),                            // ismeretlen fajta: nincs általános szám
  felirat: termek('Rejtély szósz', {open_days: 1}),      // a csomag felirata: 1 nap
  pend: termek('Ismeretlen termék', {source: 'pending'}),
};
const kamraDoc = (pantry, products = TERMEKEK) => ({version: 1, rev: 4, targets: null, products, pantry, log: {}, days: {}});
const NEGY = [   // MA = 2026-11-17: −2, 0, +1 (felbontva, a felirat szerint), +3 — és ami NEM kerül be
  tetel('Távoli', 'tej', {expires: '2026-11-21'}),
  tetel('Harmadnapi', 'tej', {expires: '2026-11-20'}),
  tetel('Mai', 'tej', {expires: '2026-11-17'}),
  tetel('Bontott rejtély', 'rejtely', {opened: '2026-11-01'}),
  tetel('Régi', 'tej', {expires: '2026-11-15'}),
  tetel('Feliratos', 'felirat', {opened: '2026-11-17', expires: '2026-11-30'}),
  tetel('Rossz dátum', 'tej', {expires: '2026-02-30'}),
  tetel('Dátum nélkül', 'tej'),
  null, 'szöveg', {id: 'x'},
];
const KAMRA_SZOVEG = 'Kamra — lejárt: Régi (2 napja); hamarosan lejár: Mai (ma), Feliratos (holnap, felbontva), Harmadnapi (3 nap múlva).';
const KAMRA_BESZED = 'A kamrában lejárt: Régi. Hamarosan lejár: Mai ma, Feliratos holnap, Harmadnapi 3 nap múlva.';
const REGGEL_SZOVEG = 'Readiness 74 · alvás 7.8 óra · body battery 71. Közepes nap: könnyű edzés, és kezdd a lejárt teendővel. Első esemény: 10:00 Meeting.';
const KAMRA_OK = {status: 200, body: kamraDoc(NEGY)};
const utvonal = (data, nutr) => req => (req.url.endsWith('/nutrition') ? nutr : data);

check('kamra-sor: a 3 napon belül lejáró és a már lejárt tételek, dátum szerint — a lap szabályával', async () => {
  const {api} = await load();
  const l = api.lejarok(kamraDoc(NEGY), MA);
  must(l.map(x => `${x.nev}|${x.datum}|${x.n}|${x.felbontva}`).join(',') ===
       'Régi|2026-11-15|-2|false,Mai|2026-11-17|0|false,Feliratos|2026-11-18|1|true,Harmadnapi|2026-11-20|3|false', JSON.stringify(l));
  // felbontás + irányelv (a név, ill. a tárolt fajta szerint); a felirat felülír; a korábbi dátum nyer
  const egy = it => api.lejarok(kamraDoc([it]), MA).map(x => `${x.datum}|${x.felbontva}`).join();
  must(egy(tetel('B', 'tej', {opened: '2026-11-16'})) === '2026-11-19|true', `bontott tej: ${egy(tetel('B', 'tej', {opened: '2026-11-16'}))}`);
  must(egy(tetel('B', 'joghurt', {opened: '2026-11-15'})) === '2026-11-18|true', 'a tárolt fajta nem számított');
  must(egy(tetel('B', 'joghurt', {opened: '2026-11-10', expires: '2026-11-25'})) === '2026-11-13|true', 'a lejárt bontott joghurt kimaradt');
  must(egy(tetel('B', 'tej', {opened: '2026-11-16', expires: '2026-11-18'})) === '2026-11-18|false', 'a korábbi csomag-dátum nem nyert');
  must(egy(tetel('B', 'pend', {expires: '2026-11-18'})) === '2026-11-18|false', 'a Rendezendő tétel kimaradt');
  must(egy(tetel('B', 'nincs_ilyen', {expires: '2026-11-18'})) === '2026-11-18|false', 'termék nélküli tétel: a csomag dátuma számít');
  must(egy(tetel('B', 'nincs_ilyen', {opened: '2026-11-17'})) === '', 'termék nélkül kitalált felbontási napot');
  must(api.lejarok(kamraDoc([]), MA).length === 0 && api.lejarok({}, MA).length === 0, 'üres dokumentum');
});

check('kamra-sor: szöveg és felolvasás; sok tételnél az első 4 és „és még N”; a hosszú név szóhatáron rövidül', async () => {
  const {api} = await load();
  const s = api.kamraSor({doc: kamraDoc(NEGY), hiba: null}, MA);
  must(s && s.szoveg === KAMRA_SZOVEG, `szöveg: ${s && s.szoveg}`);
  must(s.beszed === KAMRA_BESZED, `felolvasás: ${s.beszed}`);
  const csakHamar = api.kamraSor({doc: kamraDoc([tetel('Mai', 'tej', {expires: '2026-11-17'})])}, MA);
  must(csakHamar.szoveg === 'Kamra — hamarosan lejár: Mai (ma).' && csakHamar.beszed === 'A kamrában hamarosan lejár: Mai ma.', JSON.stringify(csakHamar));
  const hat = ['A', 'B', 'C', 'D', 'E', 'F'].map((n, i) => tetel(n, 'tej', {expires: `2026-11-1${i}`}));   // 11-10 … 11-15: mind lejárt
  const sok = api.kamraSor({doc: kamraDoc(hat)}, MA);
  must(sok.szoveg === 'Kamra — lejárt: A (7 napja), B (6 napja), C (5 napja), D (4 napja) — és még 2 tétel.', sok.szoveg);
  must(sok.beszed === 'A kamrában lejárt: A, B, C, D. És még 2 tétel.', sok.beszed);
  const hosszu = api.kamraSor({doc: kamraDoc([tetel('Nagyon hosszú nevű\n bio  zabital barista kiadás 1 l', 'tej', {expires: '2026-11-18'})])}, MA);
  must(hosszu.szoveg === 'Kamra — hamarosan lejár: Nagyon hosszú nevű bio… (holnap).', hosszu.szoveg);
});

check('kamra-sor: ha a kamra nem olvasható, kimondja; ha semmi nem jár le, nincs sor (nem talál ki)', async () => {
  const {api} = await load();
  const h = api.kamraSor({doc: null, hiba: 'a végpont 503 választ adott'}, MA);
  must(h && h.szoveg === 'Kamra: most nem olvasható (a végpont 503 választ adott).' && h.beszed === 'A kamra most nem olvasható.', JSON.stringify(h));
  must(api.kamraSor({doc: kamraDoc([tetel('Távoli', 'tej', {expires: '2026-11-21'})])}, MA) === null, 'semmi nem jár le, mégis lett sor');
  must(api.kamraSor({doc: kamraDoc([])}, MA) === null && api.kamraSor(null, MA) === null, 'üres kamra / nem kért kamra');
});

check('7:15-ös értesítés: a /data és a /nutrition ugyanazzal a kulccsal; a kamra-sor a szöveg végén, új sorban, és a felolvasásban', async () => {
  const {api, rec} = await load({now: +MA, keychain: PAROSITVA, fetch: utvonal(jo(), KAMRA_OK)});
  await api.main();
  must(rec.requests.map(r => r.url).sort().join(',') === `${API}/data,${API}/nutrition`, `kérések: ${rec.requests.map(r => r.url)}`);
  must(rec.requests.every(r => r.headers && r.headers.Authorization === `Bearer ${KEY}` && r.timeoutInterval > 0 && r.timeoutInterval <= 20), 'fejléc vagy timeout');
  must(rec.notes.length === 1 && rec.notes[0].title === 'Jó reggelt — közepes nap', JSON.stringify(rec.notes));
  must(rec.notes[0].body === `${REGGEL_SZOVEG}\n${KAMRA_SZOVEG}`, `törzs: ${rec.notes[0].body}`);
  must(typeof rec.output === 'string' && rec.output.startsWith('Jó reggelt! Readiness 74') && rec.output.endsWith(` ${KAMRA_BESZED}`), `felolvasás: ${rec.output}`);
});

check('7:15-ös értesítés: ha a kamra nem olvasható (hálózat, 401, hibás dokumentum), kiírja — a reggeli rész ettől még megy', async () => {
  for (const [nutr, miert] of [[new Error('offline'), 'offline'], [{status: 401, body: {error: 'unauthorized'}}, 'a végpont 401 választ adott'],
                               [{status: 200, body: {version: 2, rev: 1}}, 'hibás kamra-dokumentum'], [{status: 200, body: adat()}, 'hibás kamra-dokumentum'],
                               [{status: 200, body: {...kamraDoc([]), pantry: 'x'}}, 'hibás kamra-dokumentum']]) {
    const {api, rec} = await load({now: +MA, keychain: PAROSITVA, fetch: utvonal(jo(), nutr)});
    await api.main();
    const b = rec.notes.length ? rec.notes[0].body : '';
    must(b === `${REGGEL_SZOVEG}\nKamra: most nem olvasható (${miert}).`, `${miert}: ${b}`);
    must(String(rec.output).endsWith(' A kamra most nem olvasható.'), `felolvasás: ${rec.output}`);
  }
  // a /data nem jön, a kamra igen: a kamra-sor akkor is ott van
  const {api, rec} = await load({now: +MA, keychain: PAROSITVA, fetch: utvonal(new Error('offline'), KAMRA_OK)});
  await api.main();
  must(rec.notes.length === 1 && rec.notes[0].body === `Az adat most nem érhető el (offline).\n${KAMRA_SZOVEG}`, `törzs: ${JSON.stringify(rec.notes)}`);
});

check('7:15-ös értesítés: ha semmi nem jár le, nincs kamra-sor (a szöveg a régi)', async () => {
  const {api, rec} = await load({now: +MA, keychain: PAROSITVA, fetch: utvonal(jo(), {status: 200, body: kamraDoc([tetel('Távoli', 'tej', {expires: '2026-11-21'})])})});
  await api.main();
  must(rec.notes.length === 1 && rec.notes[0].body === REGGEL_SZOVEG, `törzs: ${JSON.stringify(rec.notes)}`);
  must(!/[Kk]amr/.test(String(rec.output)), `felolvasás: ${rec.output}`);
});

check('a widget képe NEM változik: widgetként nem kéri a /nutrition-t, és nincs rajta kamra-sor', async () => {
  for (const fam of ['small', 'medium', 'large', 'accessoryRectangular']) {
    const {api, rec} = await load({now: +MA, keychain: PAROSITVA, fetch: utvonal(jo(), KAMRA_OK), config: {runsInWidget: true, widgetFamily: fam}});
    await api.main();
    must(rec.requests.length === 1 && rec.requests[0].url === `${API}/data`, `${fam}: kérések: ${rec.requests.map(r => r.url)}`);
    must(rec.set && !/Kamra|lejár:|Régi/.test(szovegek(rec.set).join(' | ')) && !rec.notes.length, `${fam}: kamra a widgeten`);
  }
});

check('az appban az „Értesítés próba” ugyanazt küldi, mint a 7:15-ös (a kamra-sorral együtt)', async () => {
  const {api, rec} = await load({now: +MA, keychain: PAROSITVA, fetch: utvonal(jo(), KAMRA_OK), config: {runsInApp: true},
                                  sheet: a => a.actions.indexOf('Értesítés próba')});
  await api.main();
  must(rec.notes.length === 1 && rec.notes[0].body === `${REGGEL_SZOVEG}\n${KAMRA_SZOVEG}`, JSON.stringify(rec.notes));
  must(rec.requests.some(r => r.url === `${API}/nutrition`), 'az értesítés-próba nem kérte a kamrát');
});

check('a szkriptben nincs titok és nincs végpont-cím (nyilvános repóban él)', async () => {
  must(!/workers\.dev|[0-9a-f]{32,}|Bearer [A-Za-z0-9]/.test(SRC.replace('Bearer ${cfg.key}', '')), 'titok-gyanús szöveg a szkriptben');
  must(/Keychain\.get\(KC_KEY\)/.test(SRC), 'a kulcs nem a kulcskarikából jön');
});

check('a valódi adatalak (demo-data.json): minden méret hiba nélkül kirajzol, reggel és este', async () => {
  const {api} = await load();
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo-data.json'), 'utf8'));
  for (const [stamp, most] of [['2026-11-17 07:02', MA], ['2026-11-17 20:02', at(2026, 11, 17, 21)]]) {
    const m = api.model(Object.assign({}, d, {synced_at: stamp}), most);
    for (const [fam, par] of [['small'], ['small', 'kovetkezo'], ['medium'], ['large']]) {
      const t = szovegek(api.widget(m, fam, par)).join(' ');
      must(t.length > 20 && !/undefined|null|NaN|\[object/.test(t), `${stamp} ${fam} ${par || ''}: ${t.slice(0, 160)}`);
    }
  }
});

// ── Nincs mai adat: a helyőrző és a tanács (2026-11-18) ──────────────────────
// 2026-11-18 reggel az óra két napja nem szinkronizált. A widget a nagy szám helyén egy hosszú
// fehér csíkot mutatott (a 46-os, kövér „—”), a tanács pedig 7:00 után is azt, hogy „7:00 után
// frissül”. 7:30-tól — ha a telefon elérte a szervert, és ott sincs mai adat — az órát nevezi meg.
const TEGNAPI = () => adat({synced_at: '2026-11-16 23:58'});            // MA-hoz (11-17) képest tegnapi
const ORA_SZOVEG = 'Az óra ma még nem küldött adatot — szinkronizáld a Garmin Connectben.';
const KORAI_SZOVEG = 'A mai adat még nem jött meg — 7:00 után frissül.';
const DELELOTT = at(2026, 11, 17, 9, 5);

check('nincs mai adat: 7:30-tól a tanács az órát nevezi meg; előtte a régi szöveg marad', async () => {
  const {api} = await load();
  const t = (h, mi) => api.model(TEGNAPI(), at(2026, 11, 17, h, mi)).tanacs;
  for (const [h, mi] of [[0, 30], [6, 30], [7, 0], [7, 29]]) must(t(h, mi) === KORAI_SZOVEG, `${h}:${mi}: ${t(h, mi)}`);
  for (const [h, mi] of [[7, 30], [9, 5], [21, 0], [23, 59]]) must(t(h, mi) === ORA_SZOVEG, `${h}:${mi}: ${t(h, mi)}`);
  const m = api.model(TEGNAPI(), DELELOTT);
  must(m.tanacsWidget === ORA_SZOVEG && m.szintFelirat === 'Nincs mai\nadat', `widget: ${m.tanacsWidget} / ${m.szintFelirat}`);
  // a hosszabb mondat a közepes widgeten egy sorral többet kap (a kisebb helyőrző mellett elfér)
  for (const fam of ['medium', 'large']) {
    const sor = keres(api.widget(m, fam), n => n.kind === 'text' && n.text === ORA_SZOVEG)[0];
    must(sor && sor.lineLimit >= 3, `${fam}: a tanács ${sor ? `${sor.lineLimit} sorban` : 'nincs a widgeten'}`);
  }
  // ha van mai adat, minden a régi (a tanácssor két sor marad)
  const sor = keres(api.widget(api.model(adat(), DELELOTT), 'medium'), n => n.kind === 'text' && n.text.startsWith('Könnyű edzés'))[0];
  must(sor && sor.lineLimit === 2, `mai adat: ${sor && sor.lineLimit}`);
});

check('nincs mai adat: a nagy szám helyén kisebb, halvány „—” (a 46-os kövér jel hosszú fehér csík volt)', async () => {
  const {api} = await load();
  const nagyBetus = w => keres(w, n => n.kind === 'text' && n.font && n.font.size >= 40).map(n => n.text);
  const helyorzo = w => keres(w, n => n.kind === 'text' && n.text === '—' && n.font && /Rounded/.test(n.font.name));
  const van = api.model(adat(), MA);
  for (const fam of ['medium', 'small', 'large']) {
    must(nagyBetus(api.widget(van, fam)).join() === '74', `van adat, ${fam}: ${nagyBetus(api.widget(van, fam))}`);
    must(!helyorzo(api.widget(van, fam)).length, `van adat, ${fam}: helyőrző is van`);
  }
  const esetek = [['nincs mai adat', api.model(TEGNAPI(), DELELOTT)],
                  ['este, akku nélkül', api.model(adat({synced_at: '2026-11-17 20:02', garmin: {steps: 5}}), at(2026, 11, 17, 21))],
                  ['mai adat, readiness nélkül', api.model(adat({garmin: {sleep_hours: 7.1}}), MA)]];
  for (const [nev, m] of esetek) {
    for (const fam of ['medium', 'small', 'large']) {
      const w = api.widget(m, fam), h = helyorzo(w);
      must(!nagyBetus(w).length, `${nev}, ${fam}: nagy betűvel: ${nagyBetus(w)}`);
      must(h.length === 1 && h[0].font.size <= 26 && h[0].textColor.alpha < 1,
           `${nev}, ${fam}: helyőrző: ${JSON.stringify(h.map(x => [x.font, x.textColor && x.textColor.alpha]))}`);
    }
  }
});

check('nincs mai adat, de a telefon nem érte el a szervert (mentett adat): nem az órát hibáztatja', async () => {
  const mentett = {'/docs/healthcentre-utolso.json': JSON.stringify(TEGNAPI())};
  const widgetkent = {runsInWidget: true, widgetFamily: 'medium'};
  let x = await load({now: +DELELOTT, keychain: PAROSITVA, fetch: new Error('offline'), files: mentett, config: widgetkent});
  await x.api.main();
  let t = szovegek(x.rec.set);
  must(!t.some(s => /szinkronizáld|óra ma/.test(s)), `hálózati hibánál az órát hibáztatta: ${t.join(' | ')}`);
  must(t.includes('A mai adat még nem jött meg.') && t.includes('frissült tegnap 23:58'), `szöveg: ${t.join(' | ')}`);
  // ha a letöltés sikerült, és a szerveren is a tegnapi adat van: az óra a gyanús
  x = await load({now: +DELELOTT, keychain: PAROSITVA, fetch: jo(TEGNAPI()), config: widgetkent});
  await x.api.main();
  t = szovegek(x.rec.set);
  must(t.includes(ORA_SZOVEG), `sikeres letöltés: ${t.join(' | ')}`);
  // az app előnézete ugyanezt mutatja
  x = await load({now: +DELELOTT, keychain: PAROSITVA, fetch: new Error('offline'), files: mentett, config: {runsInApp: true},
                  sheet: a => a.actions.indexOf('Közepes')});
  await x.api.main();
  must(x.rec.presented.length === 1 && !szovegek(x.rec.presented[0][1]).some(s => /szinkronizáld/.test(s)), 'az app előnézete az órát hibáztatta');
});

check('értesítés, nincs mai adat: 7:30 előtt a régi szöveg; utána az óra; hálózati hibánál nem az óra', async () => {
  const {api} = await load();
  const u = (h, mi, hiba) => api.reggeliUzenet(TEGNAPI(), at(2026, 11, 17, h, mi), hiba);
  const REGI = 'A reggeli adat még nem frissült (frissült tegnap 23:58). Nézd meg később a widgeten.';
  must(u(7, 15).szoveg === REGI && u(7, 29).szoveg === REGI && u(7, 15).cim === 'Reggeli állapot — még nincs mai adat', u(7, 15).szoveg);
  const ora = u(7, 30);
  must(ora.cim === 'Reggeli állapot — még nincs mai adat', ora.cim);
  must(ora.szoveg === `${ORA_SZOVEG} A legutóbbi adat: frissült tegnap 23:58.`, `szöveg: ${ora.szoveg}`);
  must(ora.beszed === 'Az óra ma még nem küldött adatot. Szinkronizáld a Garmin Connectben.', `felolvasás: ${ora.beszed}`);
  must(u(9, 5, 'offline').szoveg === REGI && u(9, 5, 'offline').beszed === REGI, `hálózati hiba: ${u(9, 5, 'offline').szoveg}`);
  // a főprogramon át: a Parancsok 9:05-kor — sikeres letöltés vs. hálózati hiba mentett adattal
  let x = await load({now: +DELELOTT, keychain: PAROSITVA, fetch: utvonal(jo(TEGNAPI()), {status: 200, body: kamraDoc([])})});
  await x.api.main();
  must(x.rec.notes.length === 1 && x.rec.notes[0].body === ora.szoveg && x.rec.output === ora.beszed, `értesítés: ${JSON.stringify(x.rec.notes)}`);
  x = await load({now: +DELELOTT, keychain: PAROSITVA, fetch: utvonal(new Error('offline'), {status: 200, body: kamraDoc([])}),
                  files: {'/docs/healthcentre-utolso.json': JSON.stringify(TEGNAPI())}});
  await x.api.main();
  must(x.rec.notes.length === 1 && x.rec.notes[0].body === REGI, `hálózati hiba: ${JSON.stringify(x.rec.notes)}`);
});

// ── Futtatás ─────────────────────────────────────────────────────────────────
(async () => {
  // Ha egy ellenőrzés Promise-a sosem dől el, a Node az összesítő NÉLKÜL, 0-val lépne ki —
  // ez csendes zöld lenne. Ezért: aki nem ért a végére, az piros.
  let kesz = false;
  process.on('exit', () => {
    if (kesz) return;
    console.log('BEFEJEZETLEN: egy ellenőrzés nem tért vissza (függő Promise) — ez hiba, nem zöld.');
    process.exitCode = 1;
  });
  const szuro = process.argv[2] || '';
  let jo = 0, rossz = 0;
  for (const c of checks.filter(c => c.name.includes(szuro))) {
    try { await c.fn(); jo++; console.log(`  ✓ ${c.name}`); }
    catch (e) { rossz++; console.log(`  ✗ ${c.name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e}`); }
  }
  console.log(rossz ? `BUKÓ: ${rossz}/${jo + rossz}` : `OK: ${jo}/${jo + rossz}`);
  kesz = true;
  process.exit(rossz ? 1 : 0);
})();
