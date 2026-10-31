// Atlas — Argus fuer ALLE Aktien (seit 2026-10-30).
//
// Argus nimmt nur Perlen auf (100 % Kaufempfehlung). Ob seine Faktoren auch
// sonst gelten, laesst sich so nicht pruefen. Atlas zieht deshalb reihum
// Aktien aus dem ganzen Markt (die ~5.000 groessten weltweit), friert beim
// Aufnehmen DIESELBEN Kennzahlen ein wie history.json und fuehrt danach den
// Kursverlauf Tag fuer Tag weiter — ohne KI, ohne Finnhub, ohne Worker:
// nur Yahoo, direkt von diesem GitHub-Rechner (oeffentliches Repo = keine
// Minutenkosten).
//
// Ablauf je Lauf (Werktags, nach Boersenschluss):
//   1. faellige Kursverlaeufe nachziehen (Alter 8/22/45/95/185 Tage)
//   2. neue Aufnahmen aus dem Zyklus (Universum gemischt, reihum)
//   3. Aktien mit 100 % Kaufempfehlung → Vorschlag an Argus (suggest[])
//
// Yahoo nicht reizen: ein Abruf nach dem anderen, 2–4 s Pause, hoechstens
// ATLAS_MAX_REQ je Lauf; bei 429/5xx eine lange Pause, beim zweiten Mal Ende
// des Laufs (der Fortschritt bleibt gespeichert, der naechste Lauf macht
// weiter).
//
// Dateien (Zweig `atlas`, ein Commit, wird ueberschrieben):
//   atlas.json            alles, was die App braucht (letzte ~185 Tage)
//   atlas_archive.json    aeltere Aufnahmen mit fertigem Verlauf
//   atlas_universe.json   Universum + Zyklus-Stand
import fs from 'node:fs';
import { quoteSummaryRaw, stockFromSummary, yahooAuth } from './prices.mjs';
import { historyFactors } from './histfactors.mjs';
import { sectorForFinnhub } from './sectors.mjs';
import { regionOf } from './history.mjs';

const FILE = 'atlas.json';
const ARCHIVE = 'atlas_archive.json';
const UNIV = 'atlas_universe.json';

const NEW_PER_RUN = Number(process.env.ATLAS_NEW || 50);
const MAX_REQ = Number(process.env.ATLAS_MAX_REQ || 420);
// Probe: nur das Universum bauen und auswerten, nichts speichern.
const DRY = process.env.ATLAS_DRY === '1';
const KEEP_DAYS = 185;                 // so lange bleibt eine Aufnahme in atlas.json
const SERIES_DAYS = 126;               // Boersentage Verlauf je Aufnahme (≈ 6 Monate)
const REFRESH_AT = [8, 22, 45, 95, 185];   // Kalendertage: dann Verlauf nachziehen
const UNIVERSE_TARGET = 5000;
const DAY = 86400000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// ── sanfter Takt ─────────────────────────────────────────────────────────
let requests = 0, throttled = 0, stopped = false;
class Stop extends Error {}
async function polite(fn) {
  if (stopped) throw new Stop();
  if (requests >= MAX_REQ) { stopped = true; throw new Stop(); }
  for (let attempt = 0; attempt < 2; attempt++) {
    await sleep(2000 + Math.random() * 2000);
    requests++;
    try {
      return await fn();
    } catch (e) {
      const st = e?.status || 0;
      if (st === 429 || st >= 500) {
        throttled++;
        console.log(`Yahoo bremst (${st}) — 90 s Pause.`);
        if (attempt === 0) { await sleep(90000); continue; }
        stopped = true;
        throw new Stop();
      }
      throw e;
    }
  }
}

// Wie chartRows (histfactors.mjs), aber mit Status, damit polite() bei 429 bremst.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
async function chart(sym, fromMs, toMs) {
  return polite(async () => {
    const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}`
      + `?period1=${Math.floor(fromMs / 1000)}&period2=${Math.floor(toMs / 1000)}&interval=1d`;
    const res = await fetch(u, { headers: { 'User-Agent': UA } });
    if (res.status === 404) return null;
    if (!res.ok) { const e = new Error('Chart HTTP ' + res.status); e.status = res.status; throw e; }
    const q = (await res.json())?.chart?.result?.[0];
    const ts = q?.timestamp || [], cl = q?.indicators?.quote?.[0]?.close || [];
    const rows = [];
    for (let i = 0; i < ts.length; i++) if (cl[i] != null) rows.push({ t: ts[i] * 1000, c: cl[i] });
    return rows.length ? rows : null;
  });
}

// ── Universum: die groessten Aktien je Region (Yahoo-Screener) ───────────
// uv 4 (2026-10-30, Pruefung): nur noch die HEIMATBOERSE je Land. Vorher
// lieferte die Region „de“ vor allem Frankfurt-Zweitnotierungen fremder
// Firmen (AXA.F, BNP.F, 1520.F …), „at“ Intel in Wien (INTC.VI), und die USA
// (zuerst gelaufen) schnappten per Namensabgleich die Heimatnotierung von SAP,
// ASML, TSMC, Toyota, Novo … als ADR weg (Region „usa“). Regeln:
//   - Kuerzel-Endung muss zur Heimatboerse passen (at → .VI, us → keine),
//   - Berichtswaehrung (financialCurrency) muss zum Land passen — so faellt
//     das SAP-ADR (berichtet EUR) aus den USA und Intel (USD) aus Wien,
//   - gleicher Firmenname an mehreren Boersen → die mit dem groessten
//     Handelsumsatz gewinnt (Heimatboerse; SAP sonst in Wien/Zuerich).
const UNIV_VERSION = 4;
// US-Freiverkehr (Pink Sheets, OTCQX …): dort stehen vor allem ADRs
// auslaendischer Firmen ohne eigene Analysten (BPER als BPXXY).
const OTC = new Set(['PNK', 'OQB', 'OQX', 'OEM', 'OBB', 'OTC', 'OGM']);
// Quote = Kandidaten je Land (ohne Zweitnotierung im selben Land). Wien
// fuehrt oben vor allem deutsche Aktien (ALV.VI …, die verlieren gegen
// Xetra) — deshalb dort mehr Kandidaten, sonst kaeme Erste/OMV nie dran.
const REGION_QUOTA = {
  us: 2000, ca: 200, jp: 450, hk: 280, kr: 180, tw: 180, au: 180, in: 180,
  sg: 40, fr: 200, nl: 90, it: 110, es: 90, fi: 60, be: 50, at: 150, ie: 20,
  se: 150, dk: 60, no: 70, gb: 280, ch: 140, de: 280,
};
// Heimatboerse je Region: erlaubte Endungen ('' = keine Endung, USA).
const HOME_SUFFIX = {
  us: [''], ca: ['TO', 'V'], jp: ['T'], hk: ['HK'], kr: ['KS', 'KQ'],
  tw: ['TW', 'TWO'], au: ['AX'], in: ['NS', 'BO'], sg: ['SI'], fr: ['PA'],
  nl: ['AS'], it: ['MI'], es: ['MC'], fi: ['HE'], be: ['BR'], at: ['VI'],
  ie: ['IR'], se: ['ST'], dk: ['CO'], no: ['OL'], gb: ['L'], ch: ['SW'],
  // Deutschland: Yahoos Region „de“ fuehrt viele deutsche Aktien nur unter
  // Frankfurt (SIE.F, ALV.F) — mit .DE allein blieben 5 uebrig. Fremde Firmen
  // in Frankfurt fallen ueber Berichtswaehrung (EUR) und Namensabgleich
  // (Euro-Laender laufen vorher) heraus.
  de: ['DE', 'F'],
};
// Berichtswaehrungen, die zu einer Heimatnotierung passen.
const EUR = ['EUR'];
const HOME_CUR = {
  us: ['USD'], ca: ['CAD', 'USD'], jp: ['JPY'], hk: ['HKD', 'CNY', 'USD'],
  kr: ['KRW'], tw: ['TWD'], au: ['AUD', 'USD'], in: ['INR'], sg: ['SGD', 'USD'],
  fr: EUR, nl: ['EUR', 'USD'], it: EUR, es: EUR, fi: EUR, be: EUR, at: EUR,
  ie: ['EUR', 'USD'], se: ['SEK', 'EUR'], dk: ['DKK', 'EUR'],
  no: ['NOK', 'USD', 'EUR'], gb: ['GBP', 'USD', 'EUR'], ch: ['CHF', 'USD', 'EUR'],
  de: EUR,
};
const suffixOf = (sym) => (sym.includes('.') ? sym.split('.').pop() : '');

/// Passt eine Screener-Zeile zur Heimatboerse ihrer Region?
export function homeListing(q, region) {
  if (!q?.symbol) return false;
  if (OTC.has(q.exchange) || /OTC|Pink/i.test(q.fullExchangeName || '')) return false;
  if (!(HOME_SUFFIX[region] || []).includes(suffixOf(q.symbol))) return false;
  const fc = q.financialCurrency;
  return !fc || (HOME_CUR[region] || []).includes(fc);
}

// Region einer Aufnahme (Kennungen wie Argus). regionOf (history.mjs) kennt
// Kopenhagen, Oslo, Dublin, Kosdaq, Singapur, Taipeh-OTC nicht (→ „world“).
const ATLAS_REGION = {
  us: 'usa', de: 'europe', jp: 'japan', hk: 'china', in: 'india',
  kr: 'apac', tw: 'apac', au: 'apac', sg: 'apac', ca: 'world',
  fr: 'europe', nl: 'europe', it: 'europe', es: 'europe', fi: 'europe',
  be: 'europe', at: 'europe', ie: 'europe', se: 'europe', dk: 'europe',
  no: 'europe', gb: 'europe', ch: 'europe',
};

// Regionen, deren Screener-Liste oben von Fremdnotierungen verstopft ist
// (Deutschland: Apple, NVIDIA … je zwei- bis dreimal in Frankfurt/Xetra):
// nur diese Boerse abfragen und mehr Seiten erlauben.
const EXCHANGE = { de: 'GER' };
const MAX_PAGES = { de: 20 };

async function screenerPage(region, offset, size, auth, exchange) {
  const operands = [{ operator: 'EQ', operands: ['region', region] }];
  if (exchange) operands.push({ operator: 'EQ', operands: ['exchange', exchange] });
  const body = {
    size, offset, sortField: 'intradaymarketcap', sortType: 'DESC',
    quoteType: 'EQUITY',
    query: { operator: 'AND', operands },
    userId: '', userIdType: 'guid',
  };
  return polite(async () => {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/screener?crumb=${encodeURIComponent(auth.crumb)}&lang=en-US&region=US&formatted=false`,
      { method: 'POST', headers: { 'User-Agent': auth.ua, Cookie: auth.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { const e = new Error('Screener HTTP ' + res.status); e.status = res.status; throw e; }
    const j = await res.json();
    return j?.finance?.result?.[0]?.quotes || [];
  });
}

const PAGE = 250;
// Grobe Umrechnung in Dollar — nur um Handelsumsaetze verschiedener Boersen
// derselben Firma zu vergleichen (die Heimatboerse liegt um ein Vielfaches vorn).
const FX_USD = { USD: 1, EUR: 1.1, CHF: 1.15, GBP: 1.3, GBp: 0.013, GBX: 0.013,
  CAD: 0.73, SEK: 0.095, DKK: 0.15, NOK: 0.095, JPY: 0.0067, HKD: 0.13,
  KRW: 0.0007, TWD: 0.031, AUD: 0.66, INR: 0.012, SGD: 0.75, CNY: 0.14 };
const turnover = (q) => (q.averageDailyVolume3Month || q.regularMarketVolume || 0)
  * (q.regularMarketPrice || 0) * (FX_USD[q.currency] ?? 0);

async function buildUniverse() {
  const auth = await yahooAuth();
  // Dieselbe Firma steht oft an mehreren Boersen in derselben Waehrung (SAP in
  // Frankfurt, Wien, Zuerich). Bei gleichem Namen gewinnt die Notierung mit
  // dem groessten Handelsumsatz — das ist die Heimatboerse. (Vorher gewann die
  // zuerst gelaufene Region: SAP, Siemens, Allianz landeten in Wien/Zuerich.)
  const nameKey = (n) => String(n || '').toLowerCase()
    .replace(/[.,()&'\-\/]/g, ' ')
    .replace(/\b(aktiengesellschaft|ag|se|sa|spa|plc|nv|oyj|ab|asa|as|a s|inc|corp|corporation|co|ltd|limited|holdings?|group|company|kgaa|class [a-z]|the)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const best = new Map();   // Name → { u, t }
  let noFc = 0, seen = 0, rejected = 0;
  for (const [region, quota] of Object.entries(REGION_QUOTA)) {
    let got = 0, pages = 0;
    const local = new Set();
    let exchange = EXCHANGE[region];
    const maxPages = MAX_PAGES[region] || Math.ceil(quota / PAGE) * 3 + 1;
    // Immer volle Seiten holen und selbst filtern — vorher wurde nur
    // `quota − got` angefragt und bei < 250 Treffern aufgehoert: Regionen mit
    // kleiner Quote sahen nur ihre ersten 30–200 Zeilen (Oesterreich: 0).
    for (let off = 0; got < quota && pages < maxPages; off += PAGE) {
      let quotes = [];
      try { quotes = await screenerPage(region, off, PAGE, auth, exchange); }
      catch (e) { if (e instanceof Stop) throw e; console.log(`Screener ${region}: ${e.message}`); quotes = null; }
      // Boersen-Filter unbekannt/leer → einmal ohne (alte Abfrage).
      if (exchange && off === 0 && !quotes?.length) {
        console.log(`Screener ${region}: Boersen-Filter ${exchange} ohne Treffer — ohne Filter.`);
        exchange = null;
        off -= PAGE;
        continue;
      }
      if (quotes == null) break;
      pages++;
      for (const q of quotes) {
        if (got >= quota) break;
        seen++;
        if (!q.financialCurrency) noFc++;
        if (q.quoteType && q.quoteType !== 'EQUITY') continue;
        if (!homeListing(q, region)) {
          if (DRY && region === 'de' && rejected++ < 5) {
            console.log(`  de abgelehnt: ${q.symbol} ${q.exchange} fc=${q.financialCurrency} ${q.longName || q.shortName}`);
          }
          continue;
        }
        const nk = nameKey(q.longName || q.shortName) || q.symbol;
        if (local.has(nk)) continue;   // zweite Notierung im selben Land
        local.add(nk);
        got++;
        const u = { s: q.symbol, n: q.longName || q.shortName || q.symbol, r: region };
        const t = turnover(q), prev = best.get(nk);
        if (!prev || t > prev.t) best.set(nk, { u, t });
      }
      if (quotes.length < PAGE) break;
    }
    console.log(`Universum ${region}: ${got} Kandidaten (${pages} Seiten)`);
  }
  console.log(`Screener-Zeilen ohne financialCurrency: ${noFc} von ${seen}.`);
  return [...best.values()].map((b) => b.u);
}

// Park-Miller: dieselbe Mischung auf jedem Rechner (Zyklus reproduzierbar).
function shuffled(list, seed) {
  let x = (seed % 2147483646) + 1;
  const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Kennzahlen beim Aufnehmen (wie history.json) ─────────────────────────
function median(a) {
  const x = a.filter((v) => Number.isFinite(v)).sort((m, n) => m - n);
  if (!x.length) return null;
  const m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
}
const med3 = (c, i) => median(c.slice(Math.max(0, i - 2), i + 1));

function priceFactors(rows, nowMs) {
  const upto = rows.filter((r) => r.t <= nowMs);
  if (upto.length < 30) return {};
  const c = upto.map((r) => r.c);
  const last = c.length - 1;
  // 6 Monate (~126 Handelstage) und 1 Monat (~21) — wie fetchStockPerf6m/30.
  const i6 = Math.max(0, last - 125);
  const a6 = median(c.slice(i6, i6 + 3)), e = med3(c, last);
  const ref1 = last >= 23 ? med3(c, last - 21) : null;
  return {
    perf6mAtAdd: a6 && e ? r2((e / a6 - 1) * 100) : null,
    perf1mBefore: ref1 && e ? r2((e / ref1 - 1) * 100) : null,
    ...(historyFactors(rows, nowMs) || {}),
  };
}

function ratingsOf(r) {
  const trend = r?.recommendationTrend?.trend;
  if (!Array.isArray(trend) || !trend.length) return null;
  const t = trend.find((x) => x.period === '0m') || trend[0];
  const sb = t.strongBuy || 0, b = t.buy || 0, h = t.hold || 0, s = t.sell || 0, ss = t.strongSell || 0;
  const n = sb + b + h + s + ss;
  if (n <= 0) return null;
  return { buyPct: r2(((sb + b) / n) * 100), strongBuyPct: r2((sb / n) * 100), analysts: n,
           counts: { strongBuy: sb, buy: b, hold: h, sell: s, strongSell: ss } };
}

async function observe(u, nowMs) {
  const r = await polite(() => quoteSummaryRaw(u.s,
    'financialData,summaryDetail,price,defaultKeyStatistics,recommendationTrend,assetProfile'));
  if (!r) return null;
  if (r.price?.quoteType && r.price.quoteType !== 'EQUITY') return null;
  const st = await stockFromSummary(r);
  if (!st || !st.price) return null;
  const rows = await chart(u.s, nowMs - 3.2 * 365 * DAY, nowMs + DAY);
  if (!rows || rows.length < 30) return null;
  const startRow = rows.filter((x) => x.t <= nowMs).pop();
  if (!startRow) return null;
  const rt = ratingsOf(r);
  const prof = r.assetProfile || {};
  const day = today();
  return {
    ticker: `${u.s}@${day}`,                 // eindeutig je Aufnahme
    yahoo: u.s,
    name: r.price?.longName || r.price?.shortName || u.n,
    sector: sectorForFinnhub(prof.industry) || sectorForFinnhub(prof.sector) || '',
    ysector: prof.sector || '',
    industry: prof.industry || '',
    region: ATLAS_REGION[u.r] || regionOf(u.s) || '',
    cur: r.price?.currency || '',
    seen: day, seenMs: nowMs,
    sd: new Date(startRow.t).toISOString().slice(0, 10),   // Kurs-Tag 0
    startPrice: startRow.c,
    buyPct: rt?.buyPct ?? null, strongBuyPct: rt?.strongBuyPct ?? null,
    analysts: rt?.analysts ?? st.analysts ?? null,
    ratingCounts: rt?.counts ?? null,
    upside: st.upside, pe: st.pe, div: st.divYield,
    ...st.factors,
    ...priceFactors(rows, nowMs),
    perf: [], perfHigh: [], r: [0], rk: -1,
  };
}

// ── Kursverlauf nachziehen ───────────────────────────────────────────────
function applySeries(e, rows) {
  const t0 = Date.parse(e.sd + 'T00:00:00Z');
  const i0 = rows.findIndex((x) => x.t >= t0);
  if (i0 < 0) return false;
  const base = rows[i0].c;
  if (!(base > 0)) return false;
  const pct = rows.slice(i0, i0 + SERIES_DAYS + 1).map((x) => (x.c / base - 1) * 100);
  e.r = pct.map((v) => Math.round(v * 10));          // 0,1-%-Schritte als ganze Zahlen
  // Monatswerte wie history.json (21 Boersentage = 1 Monat), fuer die
  // Teile der Argus-Analyse, die noch in Monaten rechnen.
  e.perf = []; e.perfHigh = [];
  let peak = -Infinity, peakDay = 0;
  for (let i = 0; i < pct.length; i++) if (pct[i] > peak) { peak = pct[i]; peakDay = i; }
  for (let m = 1; m * 21 < pct.length; m++) {
    e.perf.push(r2(pct[m * 21]));
    e.perfHigh.push(r2(Math.max(...pct.slice(0, m * 21 + 1))));
  }
  e.peakPerf = r2(peak);
  e.peakMs = rows[i0 + peakDay]?.t ?? null;
  return true;
}

async function refresh(e, nowMs) {
  const t0 = Date.parse(e.sd + 'T00:00:00Z');
  const rows = await chart(e.yahoo, t0 - 5 * DAY, nowMs + DAY);
  if (rows) applySeries(e, rows);
}

function universeReport(list) {
  const by = {};
  for (const u of list) by[u.r] = (by[u.r] || 0) + 1;
  console.log('Probe je Region:', JSON.stringify(by), 'gesamt', list.length);
  const has = new Set(list.map((u) => u.s));
  const probe = ['SAP.DE', 'SAP.F', 'SAP', 'SIE.F', 'ALV.F', 'AXA.F', 'BNP.F', 'ASML.AS', 'ASML', '2330.TW', 'TSM', '7203.T', 'TM',
    'NOVO-B.CO', 'NVO', 'SIE.DE', 'ALV.DE', 'INTC', 'INTC.VI', 'EBS.VI', 'OMV.VI',
    'RY.TO', 'RY', 'NESN.SW', 'SHEL.L', 'SHEL', '9988.HK', 'BABA', 'AAPL'];
  for (const n of ['SAP', 'Siemens', 'Allianz', 'ASML', 'Nestl']) {
    console.log(`Probe ${n}:`, list.filter((u) => u.n.startsWith(n)).map((u) => u.s).join(' '));
  }
  console.log('Probe Kuerzel:', probe.map((p) => `${p}=${has.has(p) ? 'ja' : 'nein'}`).join(' '));
}

// ── Hauptlauf ────────────────────────────────────────────────────────────
async function main() {
  const nowMs = Date.now();
  const data = readJson(FILE, { v: 1, entries: [], suggest: [] });
  const archive = readJson(ARCHIVE, { v: 1, entries: [] });
  let uni = readJson(UNIV, null);
  const totalBefore = (data.entries?.length || 0) + (archive.entries?.length || 0);
  let progress = 0, removedStale = 0;

  try {
    // Universum zu Beginn eines Zyklus neu bauen (Mitglieder bleiben im Zyklus fest).
    // Ein Universum aelterer Fassung (uv) wird einmal neu gebaut — gleiche
    // Zyklusnummer, von vorn. `uni` erst nach Erfolg ersetzen: vorher wurde
    // die Nummer schon vor dem Bau herabgesetzt und bei einem Abbruch so
    // gespeichert (jeder weitere Fehlversuch zaehlte sie weiter herunter).
    const stale = uni && uni.uv !== UNIV_VERSION;
    if (DRY || stale || !uni || !Array.isArray(uni.order) || uni.pos >= uni.order.length) {
      const list = await buildUniverse();
      if (DRY) { universeReport(list); return; }
      if (list.length < 500) throw new Error(`Universum zu klein (${list.length})`);
      const n = stale ? (uni.cycle || 1) : (uni?.cycle || 0) + 1;
      uni = { cycle: n, startedAt: today(), pos: 0, size: list.length,
              order: shuffled(list, n * 7919 + list.length), builtAt: today(), uv: UNIV_VERSION };
      console.log(`Zyklus ${n}: ${list.length} Aktien.`);
      if (stale) {
        // Aufnahmen aus einem fehlerhaften Universum (Freiverkehr,
        // Zweitnotierungen), die noch keinen Verlauf haben, fallen weg.
        const inUni = new Set(list.map((u) => u.s));
        const before = data.entries.length;
        data.entries = data.entries.filter((e) => inUni.has(e.yahoo) || (e.r || []).length > 1);
        console.log(`Aus altem Universum entfernt: ${before - data.entries.length}.`);
        removedStale += before - data.entries.length;
      }
    }

    // 1) Faellige Verlaeufe (aelteste zuerst).
    const due = [];
    for (const e of data.entries) {
      const age = (nowMs - e.seenMs) / DAY;
      let k = -1;
      for (let i = 0; i < REFRESH_AT.length; i++) if (age >= REFRESH_AT[i]) k = i;
      if (k > (e.rk ?? -1)) due.push([e, k]);
    }
    due.sort((a, b) => a[0].seenMs - b[0].seenMs);
    // Die Haelfte des Budgets fuer Verlaeufe, damit neue Aufnahmen nie ganz ausfallen.
    let refreshed = 0;
    for (const [e, k] of due) {
      if (requests >= MAX_REQ / 2) break;
      try { await refresh(e, nowMs); } catch (err) { if (err instanceof Stop) throw err; continue; }
      e.rk = k;
      refreshed++;
    }
    console.log(`Verlaeufe nachgezogen: ${refreshed} von ${due.length} faelligen.`);

    // 2) Neue Aufnahmen reihum.
    let added = 0, skipped = 0, errStreak = 0;
    while (added < NEW_PER_RUN && uni.pos < uni.order.length) {
      const u = uni.order[uni.pos];
      let e = null;
      try { e = await observe(u, nowMs); errStreak = 0; }
      catch (err) {
        if (err instanceof Stop) throw err;
        console.log(`${u.s}: ${err.message}`);
        // Viele Fehler am Stueck (Crumb kaputt, Yahoo umgebaut): nicht das
        // halbe Universum ueberspringen, sondern diese Aktien beim naechsten
        // Lauf noch einmal versuchen und aufhoeren (seit 2026-10-31).
        if (++errStreak >= 5) {
          uni.pos -= errStreak - 1;
          console.log('Fuenf Fehler am Stueck — Lauf beendet, die Aktien kommen beim naechsten Mal wieder dran.');
          break;
        }
      }
      uni.pos++;
      if (!e) { skipped++; continue; }
      // Dieselbe Aktie am selben Tag nur einmal (z. B. zweiter Lauf nach
      // einem Neubau des Universums) — das Kuerzel ist der Schluessel der App.
      if (data.entries.some((x) => x.ticker === e.ticker)) { skipped++; continue; }
      applySeries(e, [{ t: Date.parse(e.sd + 'T00:00:00Z'), c: e.startPrice }]);
      e.rk = -1;
      data.entries.push(e);
      added++;
      // 3) 100 % Kaufempfehlung → Argus prueft sie als Perle. Keine
      // Mindestzahl an Analysten: Argus prueft ohnehin selbst noch einmal
      // (Wunsch des Nutzers, 2026-10-30).
      if (e.buyPct === 100 && (e.analysts || 0) >= 1) {
        data.suggest = (data.suggest || []).filter((s) => s.yahoo !== e.yahoo);
        data.suggest.unshift({ name: e.name, yahoo: e.yahoo, at: new Date(nowMs).toISOString() });
        data.suggest = data.suggest.slice(0, 200);
      }
    }
    console.log(`Neu aufgenommen: ${added} (${skipped} ohne Daten), Zyklus ${uni.cycle}: ${uni.pos}/${uni.order.length}.`);
    progress = added + refreshed;
  } catch (e) {
    if (!(e instanceof Stop)) console.error('Atlas-Lauf abgebrochen:', e.message);
    else console.log('Lauf beendet (Budget/Drosselung) — Fortschritt bleibt.');
  }

  if (DRY) return;

  // Aelteres ins Archiv (mit fertigem Verlauf).
  const keep = [], old = [];
  for (const e of data.entries) ((nowMs - e.seenMs) / DAY > KEEP_DAYS + 10 ? old : keep).push(e);
  if (old.length) archive.entries.push(...old);
  data.entries = keep;
  data.updated = new Date(nowMs).toISOString();
  data.cycle = uni ? { n: uni.cycle, pos: uni.pos, size: uni.order?.length || 0, startedAt: uni.startedAt } : null;
  data.stats = { requests, throttled, total: keep.length + archive.entries.length };

  // Waechter (seit 2026-10-31): Aufnahmen verschwinden nie. Sind es weniger
  // als vorher (Stand nicht gelesen, Datei kaputt), NICHT schreiben — der
  // Lauf wird rot, GitHub schickt eine Mail, der alte Stand bleibt.
  if (data.stats.total < totalBefore - removedStale) {
    console.error(`Weniger Aufnahmen als vorher (${data.stats.total} < ${totalBefore}) — nichts gespeichert.`);
    process.exit(1);
  }
  fs.writeFileSync(FILE, JSON.stringify(data));
  fs.writeFileSync(ARCHIVE, JSON.stringify(archive));
  if (uni) fs.writeFileSync(UNIV, JSON.stringify(uni));
  console.log(`Gespeichert: ${keep.length} aktiv, ${archive.entries.length} im Archiv, ${requests} Yahoo-Abrufe, ${throttled}× gebremst.`);
  // Werktagslauf ohne jeden Fortschritt (weder neu noch nachgezogen) = etwas
  // ist kaputt (Yahoo, Crumb, Universum). Rot, damit GitHub eine Mail
  // schickt — vorher blieb der Lauf gruen und Atlas stand still.
  if (NEW_PER_RUN > 0 && progress === 0) {
    console.error('Kein Fortschritt in diesem Lauf (Yahoo/Crumb/Universum pruefen).');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
