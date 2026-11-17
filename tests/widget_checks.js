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
  class Color { constructor(hex) { this.hex = hex; } static dynamic(l, d) { return {light: l.hex, dark: d.hex}; } }
  const Font = new Proxy({}, {get: (_, name) => size => ({name, size})});
  class Elem {
    constructor(kind) { this.kind = kind; this.children = []; }
    addText(t) { const x = {kind: 'text', text: String(t)}; this.children.push(x); return x; }
    addStack() { const s = new Elem('stack'); this.children.push(s); return s; }
    addSpacer(n) { this.children.push({kind: 'spacer', n}); }
    layoutHorizontally() { this.dir = 'h'; } layoutVertically() { this.dir = 'v'; }
    setPadding() {} centerAlignContent() {}
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
    Color, Font, ListWidget, Request, Notification, Alert, console,
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

async function load(opt) {
  const {ctx, rec} = env(opt);
  const api = await vm.runInContext(`(async () => {\n${SRC}\nreturn {model, reggeliUzenet, parseLink, teendok, esemenyek, frissesseg, widget, main, kimondIdo};\n})()`,
                                    ctx, {filename: 'widget/egeszseg.js'});
  return {api, rec, ctx};
}

const szovegek = node => (node.kind === 'text' ? [node.text] : (node.children || []).flatMap(szovegek));
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
  must(/READINESS \| 74 \| Közepes \| Könnyű edzés/.test(kicsi), `kicsi: ${kicsi}`);
  const kov = s('small', 'kovetkezo');
  must(/KÖVETKEZŐ \| 10:00 \| Meeting \| Első teendő \| Könyvtári könyv/.test(kov), `következő: ${kov}`);
  const koz = s('medium');
  must(koz.includes('MA · NOV. 17., KEDD | frissült 07:02') && koz.includes('Közepes nap: könnyű edzés') &&
       koz.includes('10:00 Meeting') && koz.includes('3 teendő · 1 lejárt'), `közepes: ${koz}`);
  const nagy = s('large');
  must(nagy.includes('TEENDŐK | lejárt | Könyvtári könyv | Google') && nagy.includes('NAPTÁR | 10:00 | Meeting | 17:30 | Edzőterem'), `nagy: ${nagy}`);
  must(s('accessoryRectangular') === '74 · Könnyű edzés', `zárképernyő: ${s('accessoryRectangular')}`);
  const esti = api.model(adat({synced_at: '2026-11-17 20:02', garmin: {bb_current: 32, steps: 5}}), at(2026, 11, 17, 21, 0));
  const estiNagy = szovegek(api.widget(esti, 'large')).join(' | ');
  // Az egész napos esemény elöl, mint az iPhone naptárában.
  must(estiNagy.includes('HOLNAP | egész nap | Születésnap | 07:30 | Edzés'), `esti nagy: ${estiNagy}`);
  must(szovegek(api.widget(esti, 'small', 'kovetkezo')).join(' | ').startsWith('HOLNAP | 07:30 | Edzés | Még ma'), 'esti kicsi');
  const ures = api.model(adat({tasks: null, calendar: []}), MA);
  must(szovegek(api.widget(ures, 'large')).join(' | ').includes('A teendők most nem olvashatók.'), 'ismeretlen teendők a nagyban');
  must(szovegek(api.widget(ures, 'medium')).join(' | ').includes('teendők: ismeretlen'), 'ismeretlen teendők a közepesben');
});

// ── A főprogram ──────────────────────────────────────────────────────────────
const PAROSITVA = {'healthcentre.api': API, 'healthcentre.key': KEY};
const jo = (d = adat()) => ({status: 200, body: d});

check('widgetként: a végpontról olvas (Bearer kulcs), ment, és kirajzol', async () => {
  const {api, rec} = await load({now: +MA, keychain: PAROSITVA, fetch: jo(), config: {runsInWidget: true, widgetFamily: 'medium'}});
  await api.main();
  must(rec.requests.length === 1 && rec.requests[0].url === `${API}/data`, `kérés: ${rec.requests.map(r => r.url)}`);
  must(rec.requests[0].headers.Authorization === `Bearer ${KEY}` && rec.requests[0].timeoutInterval > 0, 'fejléc vagy timeout');
  must(rec.set && szovegek(rec.set).join(' | ').includes('Közepes nap'), 'nem rajzolt');
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

check('az appban: menü — előnézet minden méretben, értesítés-próba', async () => {
  for (const [pont, meret, szoveg] of [['Kicsi — következő', 'small', 'KÖVETKEZŐ'], ['Nagy', 'large', 'TEENDŐK'], ['Közepes', 'medium', 'Közepes nap']]) {
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

// ── Futtatás ─────────────────────────────────────────────────────────────────
(async () => {
  const szuro = process.argv[2] || '';
  let jo = 0, rossz = 0;
  for (const c of checks.filter(c => c.name.includes(szuro))) {
    try { await c.fn(); jo++; console.log(`  ✓ ${c.name}`); }
    catch (e) { rossz++; console.log(`  ✗ ${c.name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e}`); }
  }
  console.log(rossz ? `BUKÓ: ${rossz}/${jo + rossz}` : `OK: ${jo}/${jo + rossz}`);
  process.exit(rossz ? 1 : 0);
})();
