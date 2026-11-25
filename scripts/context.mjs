// Umfeld-Faktoren (seit 2026-11-25, Wunsch des Nutzers): nicht die Aktie
// selbst, sondern die UMSTAENDE am Aufnahmetag — Zinstermine, Wahlen,
// Marktstimmung (Fear & Greed, VIX), Marktstabilitaet, Geopolitik,
// politische Stabilitaet des Heimatlandes, Lage von Region und Sektor.
//
// Aufruf: node scripts/context.mjs <datei.json> [...]
//   Jede Datei mit `entries` (Liste oder Objekt) bekommt je Eintrag die
//   Felder ctx*, NUR wenn sie noch fehlen (einmal gesetzt = eingefroren, wie
//   die uebrigen Aufnahme-Kennzahlen). So werden auch alle ALTEN Eintraege
//   nachtraeglich ergaenzt — die Werte stammen aus den Kursreihen bis zum
//   jeweiligen Tag, nie aus der Zeit danach:
//     Atlas  (`sd` = Kurs-Tag 0): Stand am Schluss von sd.
//     Argus  (nur `seen`):        Stand am Schluss des Vortags (Argus nimmt
//                                 auch tagsueber auf, vor dem US-Schluss).
//
// Fehlt eine Quelle (Yahoo/CNN/Worker nicht erreichbar), bleiben die Felder
// leer und werden beim naechsten Lauf gefuellt. Das Skript bricht NIE einen
// Lauf ab (Exit 0), es schreibt nur, wenn es etwas ergaenzt hat.
import fs from 'node:fs';

const DAY = 86400000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const WORKER = 'https://portfolio-cors-proxy.daniel-gerner06.workers.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// ── Feste Kalender (recherchiert 2026-11-25) ─────────────────────────────
// Zinsentscheide = Tag der Bekanntgabe (Fed: zweiter Sitzungstag).
export const FOMC = ['2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18',
  '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29',
  '2026-09-16', '2026-10-28', '2026-12-09',
  '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28',
  '2027-09-15', '2027-10-27', '2027-12-08'];
export const ECB = ['2025-01-30', '2025-03-06', '2025-04-17', '2025-06-05',
  '2025-07-24', '2025-09-11', '2025-10-30', '2025-12-18',
  '2026-02-05', '2026-03-19', '2026-04-30', '2026-06-11', '2026-07-23',
  '2026-09-10', '2026-10-29', '2026-12-17',
  '2027-02-04', '2027-03-18', '2027-04-29', '2027-06-10', '2027-07-22',
  '2027-09-09', '2027-10-28', '2027-12-16'];
// Nationale Wahlen (Parlament/Praesident, Stichwahlen) je Land, ISO-2.
// „bis“-Termine (Italien) mit dem spaetesten Tag. Neue Termine HINTEN
// ergaenzen; fehlt ein Land, gibt es fuer seine Aktien keinen Wert.
export const ELECTIONS = {
  US: ['2024-11-05', '2026-11-03', '2028-11-07'],
  DE: ['2025-02-23', '2029-09-30'],
  FR: ['2024-07-07', '2027-04-18', '2027-05-02'],
  NL: ['2025-10-29'],
  IT: ['2022-09-25', '2027-12-22'],
  ES: ['2023-07-23', '2026-11-29'],
  GB: ['2024-07-04', '2029-08-15'],
  CH: ['2023-10-22', '2027-10-24'],
  SE: ['2022-09-11', '2026-09-13'],
  NO: ['2025-09-08', '2029-09-10'],
  DK: ['2022-11-01', '2026-03-24'],
  FI: ['2023-04-02', '2027-04-18'],
  IE: ['2024-11-29', '2025-10-24'],
  BE: ['2024-06-09', '2029-06-10'],
  AT: ['2024-09-29', '2029-09-30'],
  PT: ['2025-05-18', '2026-01-18', '2026-02-08'],
  JP: ['2025-07-20', '2026-02-08'],
  KR: ['2025-06-03', '2026-06-03'],
  TW: ['2024-01-13', '2026-11-28', '2028-01-15'],
  HK: ['2025-12-07'],
  AU: ['2025-05-03', '2028-05-06'],
  CA: ['2025-04-28', '2029-10-15'],
  SG: ['2025-05-03'],
  IN: ['2024-06-04', '2029-05-15'],
  BR: ['2022-10-30', '2026-10-04', '2026-10-25'],
  HU: ['2022-04-03', '2026-04-12'],
  CN: [],
};
// Politische Stabilitaet und Abwesenheit von Gewalt/Terror, Weltbank (WGI),
// Perzentil 0–100, Stand 2023. Wird im Lauf von der Weltbank-API frisch
// geholt (vom GitHub-Rechner bisher ohne Antwort); diese Werte sind der
// Rueckfall, recherchiert 2026-11-25 (WGI 2023, Trading Economics/Macrovedia/
// World Population Review). Taiwan nur eine Quelle.
const WGI_FALLBACK = {
  US: 47.4, DE: 66.4, FR: 55.9, NL: 68.7, IT: 64.9, ES: 55.0, GB: 62.1,
  CH: 88.6, SE: 73.5, NO: 77.7, DK: 76.8, FI: 71.1, IE: 78.7, BE: 58.3,
  AT: 71.6, PT: 70.6, PL: 64.0, HU: 72.0, JP: 81.5, HK: 69.7, CN: 25.1,
  KR: 68.3, TW: 74.4, AU: 79.6, IN: 21.3, CA: 76.3, SG: 97.2, TH: 36.0,
  BR: 28.4, MX: 22.8, ZA: 20.9, NZ: 96.2, AE: 70.1 };

// Yahoo-Endung → Land (ISO-2).
const SUFFIX_COUNTRY = { '': 'US', DE: 'DE', F: 'DE', PA: 'FR', AS: 'NL',
  MI: 'IT', MC: 'ES', L: 'GB', SW: 'CH', ST: 'SE', OL: 'NO', CO: 'DK',
  HE: 'FI', IR: 'IE', BR: 'BE', VI: 'AT', LS: 'PT', T: 'JP', HK: 'HK',
  SS: 'CN', SZ: 'CN', KS: 'KR', KQ: 'KR', TW: 'TW', TWO: 'TW', AX: 'AU',
  NS: 'IN', BO: 'IN', TO: 'CA', V: 'CA', SI: 'SG', BK: 'TH', SA: 'BR',
  MX: 'MX', JO: 'ZA', NZ: 'NZ', WA: 'PL', IS: 'TR', KL: 'MY', JK: 'ID' };
const ISO3 = { US: 'USA', DE: 'DEU', FR: 'FRA', NL: 'NLD', IT: 'ITA',
  ES: 'ESP', GB: 'GBR', CH: 'CHE', SE: 'SWE', NO: 'NOR', DK: 'DNK',
  FI: 'FIN', IE: 'IRL', BE: 'BEL', AT: 'AUT', PT: 'PRT', JP: 'JPN',
  HK: 'HKG', CN: 'CHN', KR: 'KOR', TW: 'TWN', AU: 'AUS', IN: 'IND',
  CA: 'CAN', SG: 'SGP', TH: 'THA', BR: 'BRA', MX: 'MEX', ZA: 'ZAF',
  NZ: 'NZL', PL: 'POL', TR: 'TUR', MY: 'MYS', ID: 'IDN', HU: 'HUN', AE: 'ARE' };
// Heimat-Index je Land; Rueckfall je Argus-Region.
const COUNTRY_INDEX = { US: '^GSPC', DE: '^GDAXI', FR: '^FCHI', NL: '^AEX',
  IT: 'FTSEMIB.MI', ES: '^IBEX', GB: '^FTSE', CH: '^SSMI', SE: '^OMX',
  BE: '^BFX', AT: '^ATX', JP: '^N225', HK: '^HSI', CN: '000001.SS',
  KR: '^KS11', TW: '^TWII', AU: '^AXJO', IN: '^NSEI', CA: '^GSPTSE',
  SG: '^STI', BR: '^BVSP', MX: '^MXX' };
const REGION_INDEX = { usa: '^GSPC', europe: '^STOXX', japan: '^N225',
  china: '^HSI', india: '^NSEI', apac: '^AXJO', latam: '^BVSP', world: 'URTH' };
// Sektor → US-Branchen-ETF (globaler Branchentrend).
const SECTOR_ETF = { health: 'XLV', comm: 'XLC', industrial: 'XLI',
  energy: 'XLE', cons_cycl: 'XLY', cons_def: 'XLP', hardware: 'XLK',
  ai_semi: 'SMH', software: 'IGV', finance: 'XLF', utilities: 'XLU',
  realestate: 'XLRE', materials: 'XLB' };
const MARKET = ['^VIX', '^GSPC', '^TNX', '^IRX', 'GC=F', 'CL=F', 'DX-Y.NYB',
  'HYG', 'IEF'];

// ── Abruf ────────────────────────────────────────────────────────────────
async function getJson(url, headers = {}) {
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
    } catch { /* nochmal */ }
    await sleep(3000 * (a + 1));
  }
  return null;
}

async function yahoo(sym, fromMs) {
  await sleep(800 + Math.random() * 700);
  for (const host of ['query1', 'query2']) {
    const j = await getJson(`https://${host}.finance.yahoo.com/v8/finance/chart/`
      + `${encodeURIComponent(sym)}?period1=${Math.floor(fromMs / 1000)}`
      + `&period2=${Math.floor(Date.now() / 1000)}&interval=1d`);
    const q = j?.chart?.result?.[0];
    const ts = q?.timestamp || [], cl = q?.indicators?.quote?.[0]?.close || [];
    const off = (q?.meta?.gmtoffset || 0) * 1000;
    const rows = [];
    for (let i = 0; i < ts.length; i++) {
      if (cl[i] != null && cl[i] > 0) rows.push({ d: iso(ts[i] * 1000 + off), c: cl[i] });
    }
    if (rows.length > 30) return dedupe(rows);
  }
  return null;
}
const dedupe = (rows) => {
  const m = new Map();
  for (const r of rows) m.set(r.d, r.c);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, c]) => ({ d, c }));
};

async function fearGreed(fromDay) {
  const url = `https://production.dataviz.cnn.io/index/fearandgreed/graphdata/${fromDay}`;
  let j = await getJson(url, { Referer: 'https://edition.cnn.com/', Accept: 'application/json' });
  if (!j) j = await getJson(`${WORKER}/?url=${encodeURIComponent(url)}`);
  const data = j?.fear_and_greed_historical?.data || [];
  const rows = data.filter((p) => p && p.y != null).map((p) => ({ d: iso(p.x), c: p.y }));
  return rows.length ? dedupe(rows) : null;
}

async function gpr() {
  const j = await getJson(`${WORKER}/gpr`);
  const rows = (j?.history || []).filter((p) => p.value != null).map((p) => ({ d: p.date, c: p.value }));
  return rows.length ? dedupe(rows) : null;
}

async function wgi() {
  const out = { ...WGI_FALLBACK };
  const back = Object.fromEntries(Object.entries(ISO3).map(([a, b]) => [b, a]));
  // Die Weltbank fuehrt den Wert unter zwei Kennungen (WGI-Quelle 3 bzw.
  // WDI); je Land einzeln abgefragt geht keine Liste an einem Land kaputt.
  const variants = (c) => [
    `https://api.worldbank.org/v2/country/${c}/indicator/GOV_WGI_PV.PER.RNK?source=3&format=json&per_page=60`,
    `https://api.worldbank.org/v2/country/${c}/indicator/PV.PER.RNK?format=json&per_page=60`,
    `https://api.worldbank.org/v2/country/${c}/indicator/PV.PER.RNK?source=3&format=json&per_page=60`,
  ];
  let got = 0;
  for (const [cc, c3] of Object.entries(ISO3)) {
    for (const url of variants(c3)) {
      const j = await getJson(url);
      const rows = (Array.isArray(j) ? j[1] : null) || [];
      const row = rows.filter((r) => r?.value != null)
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
      if (row && back[row.countryiso3code || c3]) {
        out[cc] = +(+row.value).toFixed(1);
        got++;
        break;
      }
    }
  }
  console.log(`Umfeld: politische Stabilitaet fuer ${got} von ${Object.keys(ISO3).length} Laendern von der Weltbank.`);
  return out;
}

// ── Rechnen auf einer Reihe (nur Werte bis einschliesslich `day`) ─────────
function idx(s, day) {
  if (!s) return -1;
  let lo = 0, hi = s.length - 1, k = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (s[m].d <= day) { k = m; lo = m + 1; } else hi = m - 1;
  }
  // Reihe zu alt (> 7 Tage Luecke) = kein Wert.
  if (k >= 0 && (Date.parse(day) - Date.parse(s[k].d)) / DAY > 7) return -1;
  return k;
}
const level = (s, day) => { const i = idx(s, day); return i < 0 ? null : s[i].c; };
function ret(s, day, n) {
  const i = idx(s, day);
  return i < n ? null : (s[i].c / s[i - n].c - 1) * 100;
}
function chg(s, day, n) {
  const i = idx(s, day);
  return i < n ? null : s[i].c - s[i - n].c;
}
function distMa(s, day, n) {
  const i = idx(s, day);
  if (i < n - 1) return null;
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) sum += s[k].c;
  return (s[i].c / (sum / n) - 1) * 100;
}
function drawdown(s, day, n = 252) {
  const i = idx(s, day);
  if (i < 60) return null;
  let hi = 0;
  for (let k = Math.max(0, i - n + 1); k <= i; k++) hi = Math.max(hi, s[k].c);
  return (s[i].c / hi - 1) * 100;
}
function vol(s, day, n = 20) {
  const i = idx(s, day);
  if (i < n) return null;
  const r = [];
  for (let k = i - n + 1; k <= i; k++) r.push(Math.log(s[k].c / s[k - 1].c));
  const m = r.reduce((a, b) => a + b, 0) / n;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  return Math.sqrt(v * 252) * 100;
}
function badDays(s, day, n = 21, lim = -1.5) {
  const i = idx(s, day);
  if (i < n) return null;
  let c = 0;
  for (let k = i - n + 1; k <= i; k++) if ((s[k].c / s[k - 1].c - 1) * 100 <= lim) c++;
  return c;
}
function mean(s, day, n) {
  const i = idx(s, day);
  if (i < n - 1) return null;
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) sum += s[k].c;
  return sum / n;
}
function daysTo(list, day, forward) {
  const t = Date.parse(day);
  let best = null;
  for (const d of list) {
    const diff = (Date.parse(d) - t) / DAY;
    if (forward ? diff > 0 : diff <= 0) {
      const a = Math.abs(diff);
      if (best == null || a < best) best = a;
    }
  }
  return best == null ? null : Math.round(best);
}

// Tag, an dem der Umfeld-Stand eines Eintrags gemessen wird.
export function contextDay(e) {
  if (e.sd) return e.sd;
  if (!e.seen) return null;
  return iso(Date.parse(e.seen + 'T00:00:00Z') - DAY);
}
export function countryOf(e) {
  const sym = e.yahoo || String(e.ticker || '').split('@')[0];
  if (!sym) return null;
  const suf = sym.includes('.') ? sym.split('.').pop() : '';
  return SUFFIX_COUNTRY[suf] ?? null;
}

// Marktweite Werte eines Tages (fuer alle Eintraege gleich).
export function marketContext(S, day) {
  const spx = S['^GSPC'];
  const credit = S.HYG && S.IEF ? ratioSeries(S.HYG, S.IEF) : null;
  const etfs = Object.values(SECTOR_ETF).map((k) => S[k]).filter(Boolean);
  const above = etfs.map((s) => distMa(s, day, 50)).filter((v) => v != null);
  const tnx = level(S['^TNX'], day), irx = level(S['^IRX'], day);
  const g7 = mean(S.GPR, day, 7), g90 = mean(S.GPR, day, 90);
  const m = Number(day.slice(5, 7));
  const qStart = Date.UTC(Number(day.slice(0, 4)), Math.floor((m - 1) / 3) * 3, 1);
  return {
    ctxVix: r2(level(S['^VIX'], day)),
    ctxVixChg1m: r2(chg(S['^VIX'], day, 21)),
    ctxFearGreed: r2(level(S.FG, day)),
    ctxFearGreedChg1m: r2(chg(S.FG, day, 21)),
    ctxSpx1m: r2(ret(spx, day, 21)),
    ctxSpx200: r2(distMa(spx, day, 200)),
    ctxSpxDd: r2(drawdown(spx, day)),
    ctxSpxVol20: r2(vol(spx, day, 20)),
    ctxBadDays1m: badDays(spx, day),
    ctxBreadth: above.length >= 8 ? r2(above.filter((v) => v > 0).length / above.length * 100) : null,
    ctxUs10y: r2(tnx),
    ctxUs10yChg1m: r2(chg(S['^TNX'], day, 21)),
    ctxCurve: tnx != null && irx != null ? r2(tnx - irx) : null,
    ctxGold1m: r2(ret(S['GC=F'], day, 21)),
    ctxOil1m: r2(ret(S['CL=F'], day, 21)),
    ctxUsd1m: r2(ret(S['DX-Y.NYB'], day, 21)),
    ctxCredit1m: r2(ret(credit, day, 21)),
    ctxGpr: r2(g7),
    ctxGprChg: g7 != null && g90 != null ? r2(g7 - g90) : null,
    ctxFomcDays: daysTo(FOMC, day, true),
    ctxFomcSince: daysTo(FOMC, day, false),
    ctxEcbDays: daysTo(ECB, day, true),
    ctxQuarterDay: Math.round((Date.parse(day) - qStart) / DAY),
    ctxMonth: m,
  };
}
function ratioSeries(a, b) {
  const mb = new Map(b.map((r) => [r.d, r.c]));
  return a.filter((r) => mb.has(r.d)).map((r) => ({ d: r.d, c: r.c / mb.get(r.d) }));
}

// Werte, die vom Eintrag abhaengen (Land, Region, Sektor).
export function entryContext(S, wgiMap, e, day) {
  const cc = countryOf(e);
  const idxSym = (cc && COUNTRY_INDEX[cc] && S[COUNTRY_INDEX[cc]]) ? COUNTRY_INDEX[cc]
    : REGION_INDEX[e.region];
  const home = idxSym ? S[idxSym] : null;
  const etf = SECTOR_ETF[e.sector] ? S[SECTOR_ETF[e.sector]] : null;
  const sec1m = ret(etf, day, 21), spx1m = ret(S['^GSPC'], day, 21);
  const el = cc && ELECTIONS[cc] ? daysTo(ELECTIONS[cc], day, true) : null;
  return {
    ctxRegion1m: r2(ret(home, day, 21)),
    ctxRegion200: r2(distMa(home, day, 200)),
    ctxSectorRel1m: sec1m != null && spx1m != null ? r2(sec1m - spx1m) : null,
    ctxSector200: r2(distMa(etf, day, 200)),
    ctxElectionDays: cc && ELECTIONS[cc] ? Math.min(el ?? 365, 365) : null,
    ctxCountryRisk: cc && wgiMap[cc] != null ? wgiMap[cc] : null,
  };
}

const entriesOf = (j) => (Array.isArray(j?.entries) ? j.entries
  : (j?.entries && typeof j.entries === 'object' ? Object.values(j.entries) : []));

export async function loadSeries(neededSyms, fromMs) {
  const S = {};
  for (const s of neededSyms) {
    S[s] = await yahoo(s, fromMs);
    if (!S[s]) console.log(`Umfeld: keine Reihe fuer ${s}`);
  }
  S.FG = await fearGreed(iso(fromMs));
  if (!S.FG) console.log('Umfeld: Fear & Greed nicht erreichbar');
  S.GPR = await gpr();
  if (!S.GPR) console.log('Umfeld: GPR nicht erreichbar');
  return S;
}

async function main(files) {
  const docs = files.map((f) => {
    try { return [f, JSON.parse(fs.readFileSync(f, 'utf8'))]; } catch { return [f, null]; }
  }).filter(([, j]) => j);
  const all = docs.flatMap(([, j]) => entriesOf(j));
  const days = all.map(contextDay).filter(Boolean).sort();
  if (!days.length) { console.log('Umfeld: keine Eintraege.'); return; }
  // 200 Boersentage + 52 Wochen Vorlauf vor dem aeltesten Tag.
  const fromMs = Date.parse(days[0]) - 420 * DAY;
  const syms = new Set(MARKET);
  for (const v of Object.values(SECTOR_ETF)) syms.add(v);
  for (const e of all) {
    const cc = countryOf(e);
    if (cc && COUNTRY_INDEX[cc]) syms.add(COUNTRY_INDEX[cc]);
    if (REGION_INDEX[e.region]) syms.add(REGION_INDEX[e.region]);
  }
  const S = await loadSeries([...syms], fromMs);
  const wgiMap = await wgi();
  const marketCache = new Map();
  let filled = 0;
  for (const e of all) {
    const day = contextDay(e);
    if (!day) continue;
    if (!marketCache.has(day)) marketCache.set(day, marketContext(S, day));
    const ctx = { ...marketCache.get(day), ...entryContext(S, wgiMap, e, day) };
    let any = false;
    for (const [k, v] of Object.entries(ctx)) {
      if (v == null || e[k] != null) continue;
      e[k] = v;
      any = true;
    }
    if (any) filled++;
  }
  for (const [f, j] of docs) fs.writeFileSync(f, JSON.stringify(j, null, f === 'history.json' ? 2 : 0));
  console.log(`Umfeld: ${filled} von ${all.length} Eintraegen ergaenzt (${marketCache.size} Tage).`);
}

if (process.argv[1] && process.argv[1].endsWith('context.mjs')) {
  main(process.argv.slice(2)).catch((e) => { console.error('Umfeld:', e.message); });
}
