// Health Centre — iPhone-widget és reggeli értesítés (Scriptable-szkript)
//
// Mit tud:
//  • widget a kezdőképernyőn: kicsi („allapot” vagy „kovetkezo” paraméterrel), közepes, nagy;
//  • reggeli értesítés + felolvasás szövege: a Parancsok app „Run Script” lépése hívja
//    „ertesites” paraméterrel (lásd a README „iPhone-widget” részét).
//
// Az adat a privát végpontról jön (ugyanaz, amit a dashboard olvas). A cím és az olvasókulcs a
// telefon kulcskarikájában (Keychain) van — a szkriptben NINCS titok, ezért lehet nyilvános.
// Párosítás: az első futáskor az appban bemásolod ugyanazt a linket, amivel a Safarit
// párosítottad: …/health/#api=…&key=…
//
// Reggeli vagy esti nézet: az ADAT ideje dönti el (a 20:00-s sync után esti), nem a telefon
// órája — így régi adat sosem látszik frissnek. Ha az adat nem mai, a widget és az értesítés
// ezt mondja, és nem ad régi számokból tanácsot.
//
// A tiszta függvényeket a tests/widget_checks.js Node-ban, hamis Scriptable-környezettel futtatja.

const KC_API = 'healthcentre.api';
const KC_KEY = 'healthcentre.key';
const CACHE_FILE = 'healthcentre-utolso.json';
const ESTI_ORA = 17;                     // ennél későbbi (mai) adat → esti nézet

const NAPOK = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'];
const HONAPOK = ['jan.', 'febr.', 'márc.', 'ápr.', 'máj.', 'jún.', 'júl.', 'aug.', 'szept.', 'okt.', 'nov.', 'dec.'];

// ── Tiszta függvények ────────────────────────────────────────────────────────

const ket = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${ket(d.getMonth() + 1)}-${ket(d.getDate())}`;
const hm = d => `${ket(d.getHours())}:${ket(d.getMinutes())}`;
const plusNap = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const nagybetu = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// "YYYY-MM-DD HH:MM" (a synced_at alakja) → helyi Date, vagy null.
function parseStamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s == null ? '' : s));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return isNaN(d) || d.getMonth() !== +m[2] - 1 ? null : d;
}

// A Safari-párosító link (…/health/#api=…&key=…) → {api, key}, vagy null.
function parseLink(text) {
  const s = String(text == null ? '' : text).trim();
  const i = s.indexOf('#');
  if (i < 0) return null;
  const p = {};
  for (const part of s.slice(i + 1).split('&')) {
    const j = part.indexOf('=');
    if (j < 0) continue;
    try { p[part.slice(0, j)] = decodeURIComponent(part.slice(j + 1)); } catch (e) { return null; }
  }
  const api = String(p.api || '').replace(/\/+$/, '');
  const key = String(p.key || '');
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(api)) return null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return null;
  return {api, key};
}

const szam = v => (typeof v === 'number' && isFinite(v) ? v : null);
const kiir = v => (v == null ? '—' : String(v));

function alvas(h) {
  const v = szam(h);
  return v == null || v < 1 ? '—' : `${(Math.round(v * 10) / 10).toFixed(1)} ó`;
}

function napCimke(d) {
  return `${HONAPOK[d.getMonth()]} ${d.getDate()}., ${NAPOK[d.getDay()]}`;
}

// A sync napi terve (day_plan.today.recovery) → szó és hangulat. Az ismeretlen ismeretlen marad.
function szint(recovery) {
  return {high: {szo: 'Jó', tonus: 'jo'}, moderate: {szo: 'Közepes', tonus: 'figyel'},
          low: {szo: 'Pihenős', tonus: 'rossz'}}[recovery] || {szo: 'Ismeretlen', tonus: 'semleges'};
}
function edzes(recovery) {
  return {high: 'a kemény edzés is mehet', moderate: 'könnyű edzés', low: 'pihenőnap'}[recovery] || null;
}

// A teendő-összegző (tasks) a widgetnek. null (a Things nem olvasható) → ismeretlen, nem nulla.
function teendok(tasks) {
  if (!tasks || typeof tasks !== 'object') return {ismert: false, ma: null, lejart: null, nyitott: null, elso: null, lista: []};
  const tetelek = v => (tasks[v] && Array.isArray(tasks[v].tasks) ? tasks[v].tasks.filter(t => t && typeof t === 'object' && t.name) : []);
  const forras = t => ({things: 'Things', google: 'Google'})[t.source] || '';
  const lista = tetelek('overdue').map(t => ({nev: String(t.name), mikor: 'lejárt', forras: forras(t)}))
    .concat(tetelek('today').map(t => ({nev: String(t.name), mikor: 'ma', forras: forras(t)})));
  const db = v => (tasks[v] && szam(tasks[v].count) != null ? tasks[v].count : tetelek(v).length);
  return {ismert: true, ma: db('today'), lejart: db('overdue'), nyitott: db('today') + db('overdue'),
          elso: lista[0] || null, lista: lista.slice(0, 3)};
}

// A naptár (calendar[]) → időrendben, Date-tel; az egész napos esemény kezdete null.
function esemenyek(calendar) {
  const out = [];
  for (const e of Array.isArray(calendar) ? calendar : []) {
    if (!e || typeof e !== 'object' || typeof e.start_date !== 'string') continue;
    const datum = e.start_date.slice(0, 10), ido = /^\d{2}:\d{2}$/.test(e.time || '') ? e.time : '';
    const start = ido ? parseStamp(`${datum} ${ido}`) : null;
    if (ido && !start) continue;
    out.push({datum, ido, cim: String(e.title || '').trim() || 'Esemény', start, egeszNap: !ido});
  }
  return out.sort((a, b) => (a.datum + (a.ido || '00:00')).localeCompare(b.datum + (b.ido || '00:00')));
}
const kovetkezo = (ev, most) => ev.find(e => e.start && e.datum === ymd(most) && e.start >= most) || null;
const elsoAznap = (ev, datum) => ev.find(e => e.start && e.datum === datum) || null;

// Az adat frissessége a néző mostjához mérve.
function frissesseg(d, most) {
  const t = parseStamp(d && d.synced_at);
  if (!t) return {t: null, maiAdat: false, cimke: 'frissítés ideje ismeretlen'};
  const maiAdat = ymd(t) === ymd(most);
  const tegnap = ymd(t) === ymd(plusNap(most, -1));
  const cimke = 'frissült ' + (maiAdat ? hm(t) : tegnap ? `tegnap ${hm(t)}` : `${HONAPOK[t.getMonth()]} ${t.getDate()}. ${hm(t)}`);
  return {t, maiAdat, cimke};
}

// A widgetek és az értesítés közös nézet-modellje.
function model(d, most) {
  d = d && typeof d === 'object' ? d : {};
  const g = d.garmin || {}, fr = frissesseg(d, most), tk = teendok(d.tasks), ev = esemenyek(d.calendar);
  const recovery = ((d.day_plan || {}).today || {}).recovery;
  const este = fr.maiAdat && fr.t.getHours() >= ESTI_ORA;
  if (este) {
    const bb = szam(g.bb_current), holnap = elsoAznap(ev, ymd(plusNap(most, 1)));
    const sz = bb == null ? {szo: 'Ismeretlen', tonus: 'semleges'} : bb < 35 ? {szo: 'Alacsony', tonus: 'figyel'} : {szo: 'Rendben', tonus: 'jo'};
    const tanacs = bb != null && bb < 35
      ? `Lassíts: feküdj le időben${holnap ? ` — holnap ${holnap.ido}-kor ${holnap.cim}` : ''}.`
      : holnap && holnap.ido < '09:00' ? `Holnap korán kezdesz: ${holnap.ido} ${holnap.cim}.`
      : holnap ? `Holnap az első esemény: ${holnap.ido} ${holnap.cim}.` : 'Holnapra nincs időpontos esemény.';
    return {
      este: true, fr, cimke: `Ma este · ${NAPOK[most.getDay()]}`,
      statok: [{ertek: kiir(bb), nev: 'body battery'},
               {ertek: szam(g.steps) == null ? '—' : String(g.steps).replace(/\B(?=(\d{3})+(?!\d))/g, ' '), nev: 'lépés'},
               {ertek: kiir(tk.nyitott), nev: 'nyitott teendő'}],
      szint: sz, tanacs, rovid: bb != null && bb < 35 ? 'Korán ágyba' : bb == null ? '—' : 'Rendben vagy',
      nagySzam: {cimke: 'Body battery', ertek: kiir(bb)},
      kov: {cimke: 'Holnap', esemeny: holnap, ures: 'Nincs időpontos esemény', teendoCimke: 'Még ma'},
      also: holnap ? `Holnap ${holnap.ido} ${holnap.cim}` : 'Holnap nincs időpontos esemény',
      tk, naptar: ev.filter(e => e.datum === ymd(plusNap(most, 1))).slice(0, 3), naptarCim: 'Holnap',
    };
  }
  const sz = fr.maiAdat ? szint(recovery) : {szo: 'Ismeretlen', tonus: 'semleges'};
  const ed = fr.maiAdat ? edzes(recovery) : null;
  const teendoResz = !tk.ismert ? null : tk.lejart > 0 ? 'kezdd a lejárt teendővel'
    : tk.ma > 0 ? `${tk.ma} mai teendő vár` : 'nincs határidős teendőd';
  const tanacs = !fr.maiAdat ? 'A mai adat még nem jött meg — 7:00 után frissül.'
    : ed == null ? `Az óra adata ma hiányzik${teendoResz ? `; ${teendoResz}` : ''}.`
    : `${sz.szo} nap: ${ed}${teendoResz ? `, és ${teendoResz}` : ''}.`;
  const kov = kovetkezo(ev, most);
  return {
    este: false, fr, cimke: `Ma · ${napCimke(most)}`,
    statok: [{ertek: fr.maiAdat ? kiir(szam(g.readiness_score)) : '—', nev: 'readiness'},
             {ertek: fr.maiAdat ? alvas(g.sleep_hours) : '—', nev: 'alvás'},
             {ertek: fr.maiAdat ? kiir(szam(g.bb_current)) : '—', nev: 'body battery'}],
    szint: sz, tanacs, rovid: ed ? nagybetu(ed) : '—',
    nagySzam: {cimke: 'Readiness', ertek: fr.maiAdat ? kiir(szam(g.readiness_score)) : '—'},
    kov: {cimke: 'Következő', esemeny: kov, ures: 'Ma nincs több esemény', teendoCimke: 'Első teendő'},
    also: kov ? `${kov.ido} ${kov.cim}` : 'Ma nincs több esemény',
    tk, naptar: ev.filter(e => e.datum === ymd(most) && (!e.start || e.start >= most)).slice(0, 3), naptarCim: 'Naptár',
  };
}

function teendoSor(tk) {
  if (!tk.ismert) return 'teendők: ismeretlen';
  return `${tk.nyitott} teendő` + (tk.lejart > 0 ? ` · ${tk.lejart} lejárt` : '');
}

// Kimondható idő: "10:00" → "10 órakor", "07:30" → "7 óra 30-kor".
function kimondIdo(ido) {
  const [h, m] = ido.split(':');
  return m === '00' ? `${+h} órakor` : `${+h} óra ${m}-kor`;
}

// A reggeli értesítés: cím, szöveg és felolvasható változat.
function reggeliUzenet(d, most) {
  const m = model(d, most);
  if (!m.fr.maiAdat) {
    const uzenet = `A reggeli adat még nem frissült (${m.fr.cimke}). Nézd meg később a widgeten.`;
    return {cim: 'Reggeli állapot — még nincs mai adat', szoveg: uzenet, beszed: uzenet};
  }
  if (m.este) {
    // Este futtatva (kézzel): az esti állapot, nem a reggeli címkékkel az esti számok.
    const [bbE, , nyitott] = m.statok.map(s => s.ertek);
    const szoveg = `Body battery ${bbE} · ${nyitott} nyitott teendő. ${m.tanacs}`;
    return {cim: 'Esti állapot', szoveg, beszed: szoveg.replace(/ · /g, ', ').replace(/—/g, 'ismeretlen')};
  }
  const [r, a, bb] = m.statok.map(s => s.ertek);
  const kov = kovetkezo(esemenyek(d.calendar), most);
  const cim = m.szint.szo === 'Ismeretlen' ? 'Jó reggelt' : `Jó reggelt — ${m.szint.szo.toLowerCase()} nap`;
  const szoveg = `Readiness ${r} · alvás ${a === '—' ? '—' : a.replace(' ó', ' óra')} · body battery ${bb}. ${m.tanacs}` +
    (kov ? ` Első esemény: ${kov.ido} ${kov.cim}.` : '');
  const beszed = `Jó reggelt! Readiness ${r}, alvás ${a === '—' ? 'ismeretlen' : a.replace(' ó', ' óra').replace('.', ',')}, ` +
    `body battery ${bb}. ${m.tanacs}` + (kov ? ` Első esemény ${kimondIdo(kov.ido)}: ${kov.cim}.` : '');
  return {cim, szoveg, beszed: beszed.replace(/—/g, 'ismeretlen')};
}

// ── Scriptable-réteg ─────────────────────────────────────────────────────────

function szin(vilagos, sotet) {
  const v = new Color(vilagos), s = new Color(sotet);
  return typeof Color.dynamic === 'function' ? Color.dynamic(v, s) : (Device.isUsingDarkAppearance() ? s : v);
}
function szinek() {
  return {szoveg: szin('#1c1c1e', '#f2f2f7'), masod: szin('#5f5f64', '#aeaeb2'), hatter: szin('#ffffff', '#1c1c1e'),
          jo: szin('#1a6f57', '#4cd08a'), figyel: szin('#a14d07', '#ffb340'), rossz: szin('#b42318', '#ff6b6b'),
          semleges: szin('#5f5f64', '#aeaeb2'), vonal: szin('#e5e5ea', '#38383a')};
}

function szovegbe(hol, szoveg, betu, szinErtek, sorok) {
  const t = hol.addText(String(szoveg));
  t.font = betu;
  t.textColor = szinErtek;
  if (sorok) t.lineLimit = sorok;
  t.minimumScaleFactor = 0.75;
  return t;
}

function fejlec(hol, m, C) {
  const s = hol.addStack();
  s.layoutHorizontally();
  szovegbe(s, m.cimke.toUpperCase(), Font.semiboldSystemFont(11), C.masod, 1);
  s.addSpacer();
  szovegbe(s, m.fr.cimke, Font.systemFont(11), C.masod, 1);
}

function statSor(hol, m, C) {
  const s = hol.addStack();
  s.layoutHorizontally();
  s.spacing = 20;
  for (const st of m.statok) {
    const o = s.addStack();
    o.layoutVertically();
    szovegbe(o, st.ertek, Font.semiboldSystemFont(24), C.szoveg, 1);
    szovegbe(o, st.nev, Font.systemFont(12), C.masod, 1);
  }
}

function kozepes(w, m, C) {
  fejlec(w, m, C);
  w.addSpacer(8);
  statSor(w, m, C);
  w.addSpacer(8);
  szovegbe(w, m.tanacs, Font.semiboldSystemFont(15), C.szoveg, 2);
  w.addSpacer();
  const also = w.addStack();
  also.layoutHorizontally();
  szovegbe(also, m.also, Font.systemFont(13), C.masod, 1);
  also.addSpacer();
  szovegbe(also, teendoSor(m.tk), Font.semiboldSystemFont(13), m.tk.lejart > 0 ? C.figyel : C.masod, 1);
}

function kicsiAllapot(w, m, C) {
  szovegbe(w, m.nagySzam.cimke.toUpperCase(), Font.semiboldSystemFont(11), C.masod, 1);
  w.addSpacer();
  szovegbe(w, m.nagySzam.ertek, Font.semiboldSystemFont(46), C.szoveg, 1);
  w.addSpacer();
  szovegbe(w, m.szint.szo, Font.semiboldSystemFont(14), C[m.szint.tonus] || C.masod, 1);
  szovegbe(w, m.rovid, Font.systemFont(13), C.masod, 2);
}

function kicsiKovetkezo(w, m, C) {
  szovegbe(w, m.kov.cimke.toUpperCase(), Font.semiboldSystemFont(11), C.masod, 1);
  w.addSpacer();
  if (m.kov.esemeny) {
    szovegbe(w, m.kov.esemeny.ido, Font.semiboldSystemFont(24), C.szoveg, 1);
    szovegbe(w, m.kov.esemeny.cim, Font.semiboldSystemFont(14), C.szoveg, 2);
  } else {
    szovegbe(w, m.kov.ures, Font.semiboldSystemFont(14), C.szoveg, 2);
  }
  w.addSpacer();
  szovegbe(w, m.kov.teendoCimke, Font.systemFont(12), C.masod, 1);
  szovegbe(w, m.tk.elso ? m.tk.elso.nev : (m.tk.ismert ? 'nincs' : 'ismeretlen'), Font.semiboldSystemFont(13), C.szoveg, 2);
}

function nagy(w, m, C) {
  fejlec(w, m, C);
  w.addSpacer(8);
  statSor(w, m, C);
  w.addSpacer(8);
  szovegbe(w, m.tanacs, Font.semiboldSystemFont(15), C.szoveg, 2);
  w.addSpacer(10);
  szovegbe(w, 'TEENDŐK', Font.semiboldSystemFont(11), C.masod, 1);
  if (!m.tk.ismert) szovegbe(w, 'A teendők most nem olvashatók.', Font.systemFont(14), C.masod, 1);
  else if (!m.tk.lista.length) szovegbe(w, 'Nincs határidős teendő.', Font.systemFont(14), C.masod, 1);
  for (const t of m.tk.lista) {
    const s = w.addStack();
    s.layoutHorizontally();
    s.spacing = 8;
    szovegbe(s, t.mikor, Font.semiboldSystemFont(14), t.mikor === 'lejárt' ? C.figyel : C.masod, 1);
    szovegbe(s, t.nev, Font.systemFont(14), C.szoveg, 1);
    s.addSpacer();
    if (t.forras) szovegbe(s, t.forras, Font.systemFont(12), C.masod, 1);
  }
  w.addSpacer(10);
  szovegbe(w, m.naptarCim.toUpperCase(), Font.semiboldSystemFont(11), C.masod, 1);
  if (!m.naptar.length) szovegbe(w, m.este ? 'Holnapra nincs esemény.' : 'Ma nincs több esemény.', Font.systemFont(14), C.masod, 1);
  for (const e of m.naptar) {
    const s = w.addStack();
    s.layoutHorizontally();
    s.spacing = 10;
    szovegbe(s, e.ido || 'egész nap', Font.semiboldSystemFont(14), C.szoveg, 1);
    szovegbe(s, e.cim, Font.systemFont(14), C.szoveg, 1);
  }
  w.addSpacer();
}

function widget(m, csalad, parameter) {
  const C = szinek(), w = new ListWidget();
  w.backgroundColor = C.hatter;
  w.setPadding(14, 16, 14, 16);
  if (csalad === 'small') (String(parameter || '').trim() === 'kovetkezo' ? kicsiKovetkezo : kicsiAllapot)(w, m, C);
  else if (csalad === 'large' || csalad === 'extraLarge') nagy(w, m, C);
  else if (String(csalad || '').startsWith('accessory')) szovegbe(w, `${m.statok[0].ertek} · ${m.rovid}`, Font.semiboldSystemFont(12), C.szoveg, 2);
  else kozepes(w, m, C);
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  return w;
}

function uzenetWidget(cim, szoveg) {
  const C = szinek(), w = new ListWidget();
  w.backgroundColor = C.hatter;
  w.setPadding(14, 16, 14, 16);
  szovegbe(w, cim, Font.semiboldSystemFont(14), C.szoveg, 2);
  w.addSpacer(6);
  szovegbe(w, szoveg, Font.systemFont(12), C.masod, 4);
  return w;
}

function beallitas() {
  if (!Keychain.contains(KC_API) || !Keychain.contains(KC_KEY)) return null;
  return {api: Keychain.get(KC_API), key: Keychain.get(KC_KEY)};
}

async function parositas() {
  const a = new Alert();
  a.title = 'Párosítás';
  a.message = 'Másold be ugyanazt a linket, amivel a Safarit párosítottad (…/health/#api=…&key=…).';
  let link = '';
  try { link = Pasteboard.pasteString() || ''; } catch (e) { link = ''; }
  a.addTextField('https://…/health/#api=…&key=…', parseLink(link) ? link : '');
  a.addAction('Mentés');
  a.addCancelAction('Mégse');
  if ((await a.presentAlert()) < 0) return null;
  const cfg = parseLink(a.textFieldValue(0));
  if (!cfg) {
    const h = new Alert();
    h.title = 'Ez nem párosító link';
    h.message = 'A helyes forma: https://…/health/#api=https://…&key=… — semmi nem lett elmentve.';
    h.addAction('Rendben');
    await h.presentAlert();
    return null;
  }
  Keychain.set(KC_API, cfg.api);
  Keychain.set(KC_KEY, cfg.key);
  return cfg;
}

function cacheUt() {
  const fm = FileManager.local();
  return {fm, ut: fm.joinPath(fm.documentsDirectory(), CACHE_FILE)};
}

// Friss adat a végpontról; hiba esetén a legutóbbi helyben mentett (a widget kiírja a korát).
async function adat(cfg) {
  const {fm, ut} = cacheUt();
  try {
    const r = new Request(`${cfg.api}/data`);
    r.headers = {Authorization: `Bearer ${cfg.key}`};
    r.timeoutInterval = 20;
    const d = await r.loadJSON();
    if (!r.response || r.response.statusCode !== 200 || !d || typeof d !== 'object' || !d.synced_at) {
      throw new Error(`a végpont ${r.response ? r.response.statusCode : '?'} választ adott`);
    }
    try { fm.writeString(ut, JSON.stringify(d)); } catch (e) { /* a mentés kiegészítés */ }
    return {d, hiba: null};
  } catch (e) {
    let d = null;
    try { if (fm.fileExists(ut)) d = JSON.parse(fm.readString(ut)); } catch (e2) { d = null; }
    return {d, hiba: (e && e.message) || String(e)};
  }
}

async function main() {
  const most = new Date();
  let cfg = beallitas();
  if (!cfg && config.runsInApp) cfg = await parositas();
  if (!cfg) {
    const w = uzenetWidget('Párosítás kell', 'Nyisd meg ezt a szkriptet a Scriptable appban, és másold be a párosító linket.');
    if (config.runsInWidget) Script.setWidget(w); else if (args.shortcutParameter) Script.setShortcutOutput('A widget még nincs párosítva.');
    Script.complete();
    return;
  }
  const {d, hiba} = await adat(cfg);
  if (String(args.shortcutParameter || '').trim() === 'ertesites') {
    const u = d ? reggeliUzenet(d, most) : {cim: 'Reggeli állapot', szoveg: `Az adat most nem érhető el (${hiba}).`, beszed: 'Az egészség-adat most nem érhető el.'};
    const n = new Notification();
    n.title = u.cim;
    n.body = u.szoveg;
    n.threadIdentifier = 'healthcentre';
    await n.schedule();
    Script.setShortcutOutput(u.beszed);
    Script.complete();
    return;
  }
  if (config.runsInWidget) {
    Script.setWidget(d ? widget(model(d, most), config.widgetFamily, args.widgetParameter)
                       : uzenetWidget('Nincs adat', `A végpont most nem válaszolt (${hiba}).`));
    Script.complete();
    return;
  }
  await appMenu(d, hiba, most);
  Script.complete();
}

// Az appban futtatva: előnézet minden méretben, értesítés-próba, újrapárosítás.
async function appMenu(d, hiba, most) {
  const menu = new Alert();
  menu.title = 'Health Centre widget';
  menu.message = d ? `${frissesseg(d, most).cimke}${hiba ? ` · a frissítés most nem sikerült (${hiba})` : ''}` : `Nincs adat: ${hiba}`;
  const pontok = ['Közepes', 'Kicsi — állapot', 'Kicsi — következő', 'Nagy', 'Értesítés próba', 'Párosítás újra'];
  pontok.forEach(p => menu.addAction(p));
  menu.addCancelAction('Kész');
  const i = await menu.presentSheet();
  if (i < 0) return;
  if (pontok[i] === 'Párosítás újra') { await parositas(); return; }
  if (!d) return;
  if (pontok[i] === 'Értesítés próba') {
    const u = reggeliUzenet(d, most), n = new Notification();
    n.title = u.cim;
    n.body = u.szoveg;
    n.threadIdentifier = 'healthcentre';
    await n.schedule();
    return;
  }
  const m = model(d, most);
  if (pontok[i] === 'Közepes') await widget(m, 'medium').presentMedium();
  else if (pontok[i] === 'Nagy') await widget(m, 'large').presentLarge();
  else await widget(m, 'small', pontok[i].endsWith('következő') ? 'kovetkezo' : 'allapot').presentSmall();
}

// A tesztkörnyezet (tests/widget_checks.js) a főprogram nélkül tölti be.
if (typeof __WIDGET_TEST__ === 'undefined') await main();
