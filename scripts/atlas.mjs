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
const UNIV_VERSION = 3;
// US-Freiverkehr (Pink Sheets, OTCQX …): dort stehen vor allem ADRs
// auslaendischer Firmen ohne eigene Analysten (BPER als BPXXY). Weil die
// USA zuerst laufen, verdraengten sie sonst die Heimatnotierung.
const OTC = new Set(['PNK', 'OQB', 'OQX', 'OEM', 'OBB', 'OTC', 'OGM']);
const REGION_QUOTA = {
  us: 2000, ca: 200, gb: 280, de: 280, fr: 200, ch: 140, nl: 90, it: 110,
  es: 90, se: 150, dk: 60, no: 70, fi: 60, be: 50, at: 30, ie: 20,
  jp: 450, hk: 280, kr: 180, tw: 180, au: 180, in: 180, sg: 40,
};

async function screenerPage(region, offset, size, auth) {
  const body = {
    size, offset, sortField: 'intradaymarketcap', sortType: 'DESC',
    quoteType: 'EQUITY',
    query: { operator: 'AND', operands: [{ operator: 'EQ', operands: ['region', region] }] },
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

async function buildUniverse() {
  const auth = await yahooAuth();
  const out = new Map();
  // Dieselbe Firma steht oft an mehreren Boersen (Intel auch in Wien als
  // INTC.VI, ohne Analysten). Die Regionen laufen Heimatmarkt zuerst (USA
  // vorn), also gewinnt die erste Notierung; Namensschluessel ohne Rechtsform.
  const names = new Set();
  const nameKey = (n) => String(n || '').toLowerCase()
    .replace(/[.,()&'\-]/g, ' ')
    .replace(/\b(aktiengesellschaft|ag|se|sa|spa|plc|nv|oyj|ab|asa|inc|corp|corporation|co|ltd|limited|holdings?|group|company|kgaa|class [a-z]|the)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  for (const [region, quota] of Object.entries(REGION_QUOTA)) {
    let got = 0;
    for (let off = 0; got < quota && off < quota * 2 + 250; off += 250) {
      let quotes = [];
      try { quotes = await screenerPage(region, off, Math.min(250, quota - got), auth); }
      catch (e) { if (e instanceof Stop) throw e; console.log(`Screener ${region}: ${e.message}`); break; }
      if (!quotes.length) break;
      for (const q of quotes) {
        if (q.quoteType && q.quoteType !== 'EQUITY') continue;
        if (OTC.has(q.exchange) || /OTC|Pink/i.test(q.fullExchangeName || '')) continue;
        if (!q.symbol || out.has(q.symbol)) continue;
        const nk = nameKey(q.longName || q.shortName);
        if (nk && names.has(nk)) continue;
        if (nk) names.add(nk);
        out.set(q.symbol, { s: q.symbol, n: q.longName || q.shortName || q.symbol, r: region });
        got++;
      }
      if (quotes.length < 250) break;
    }
    console.log(`Universum ${region}: ${got}`);
  }
  return [...out.values()];
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
    region: regionOf(u.s) || '',
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

// ── Hauptlauf ────────────────────────────────────────────────────────────
async function main() {
  const nowMs = Date.now();
  const data = readJson(FILE, { v: 1, entries: [], suggest: [] });
  const archive = readJson(ARCHIVE, { v: 1, entries: [] });
  let uni = readJson(UNIV, null);

  try {
    // Universum zu Beginn eines Zyklus neu bauen (Mitglieder bleiben im Zyklus fest).
    // uv 2: Zweitnotierungen entfernt — ein Universum aelterer Fassung wird
    // einmal neu gebaut (gleiche Zyklusnummer, von vorn).
    const stale = uni && uni.uv !== UNIV_VERSION;
    if (stale) uni = { ...uni, cycle: (uni.cycle || 1) - 1 };
    if (stale || !uni || !Array.isArray(uni.order) || uni.pos >= uni.order.length) {
      const list = await buildUniverse();
      if (list.length < 500) throw new Error(`Universum zu klein (${list.length})`);
      const n = (uni?.cycle || 0) + 1;
      uni = { cycle: n, startedAt: today(), pos: 0, size: list.length,
              order: shuffled(list, n * 7919 + list.length), builtAt: today(), uv: UNIV_VERSION };
      console.log(`Zyklus ${n}: ${list.length} Aktien.`);
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
    let added = 0, skipped = 0;
    while (added < NEW_PER_RUN && uni.pos < uni.order.length) {
      const u = uni.order[uni.pos];
      let e = null;
      try { e = await observe(u, nowMs); }
      catch (err) { if (err instanceof Stop) throw err; console.log(`${u.s}: ${err.message}`); }
      uni.pos++;
      if (!e) { skipped++; continue; }
      applySeries(e, [{ t: Date.parse(e.sd + 'T00:00:00Z'), c: e.startPrice }]);
      e.rk = -1;
      data.entries.push(e);
      added++;
      // 3) 100 % Kaufempfehlung (mind. 3 Analysten) → Argus prueft sie als Perle.
      if (e.buyPct === 100 && (e.analysts || 0) >= 3) {
        data.suggest = (data.suggest || []).filter((s) => s.yahoo !== e.yahoo);
        data.suggest.unshift({ name: e.name, yahoo: e.yahoo, at: new Date(nowMs).toISOString() });
        data.suggest = data.suggest.slice(0, 200);
      }
    }
    console.log(`Neu aufgenommen: ${added} (${skipped} ohne Daten), Zyklus ${uni.cycle}: ${uni.pos}/${uni.order.length}.`);
  } catch (e) {
    if (!(e instanceof Stop)) console.error('Atlas-Lauf abgebrochen:', e.message);
    else console.log('Lauf beendet (Budget/Drosselung) — Fortschritt bleibt.');
  }

  // Aelteres ins Archiv (mit fertigem Verlauf).
  const keep = [], old = [];
  for (const e of data.entries) ((nowMs - e.seenMs) / DAY > KEEP_DAYS + 10 ? old : keep).push(e);
  if (old.length) archive.entries.push(...old);
  data.entries = keep;
  data.updated = new Date(nowMs).toISOString();
  data.cycle = uni ? { n: uni.cycle, pos: uni.pos, size: uni.order?.length || 0, startedAt: uni.startedAt } : null;
  data.stats = { requests, throttled, total: keep.length + archive.entries.length };

  fs.writeFileSync(FILE, JSON.stringify(data));
  fs.writeFileSync(ARCHIVE, JSON.stringify(archive));
  if (uni) fs.writeFileSync(UNIV, JSON.stringify(uni));
  console.log(`Gespeichert: ${keep.length} aktiv, ${archive.entries.length} im Archiv, ${requests} Yahoo-Abrufe, ${throttled}× gebremst.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
