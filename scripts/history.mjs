// Backtest-Historie: für jede je aufgenommene Perle ein Snapshot der Kennzahlen
// beim Hinzufügen + monatliche Kursperformance seit Aufnahme (perf[0..11] = Monat 1..12,
// jeweils kumuliert seit dem Aufnahmetag). Bleibt 1 Jahr, auch wenn die Aktie nicht mehr
// in den aktuellen Perlen ist.
import fs from 'node:fs';
import { priceAtDate, perfBetween } from './prices.mjs';
import { chartRows, historyFactors } from './histfactors.mjs';

// Median der drei Handelstage um ein Datum — dieselbe Regel wie priceAtDate
// in prices.mjs, hier auf einer schon geholten Kursreihe.
function medianAt(rows, dateMs) {
  let idx = rows.findIndex(r => r.t >= dateMs);
  if (idx < 0) idx = rows.length - 1;
  const v = rows.slice(Math.max(0, idx - 1), Math.min(rows.length, idx + 2))
    .map(r => r.c).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const FILE = 'history.json';
const MS_DAY = 86400000;
const MONTHS = 12;

export function loadHistory() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { entries: {} }; }
}
export function saveHistory(h) { fs.writeFileSync(FILE, JSON.stringify(h, null, 2)); }

const dayMs = d => new Date(d + 'T00:00:00Z').getTime();
const todayStr = () => new Date().toISOString().slice(0, 10);

// Grobe Region aus dem Yahoo-Börsensuffix (US ohne Suffix).
function regionOf(sym) {
  if (!sym) return null;
  const suf = sym.includes('.') ? sym.split('.').pop() : '';
  const map = { DE: 'europe', PA: 'europe', AS: 'europe', MI: 'europe', L: 'europe', SW: 'europe', ST: 'europe', HE: 'europe', BR: 'europe', VI: 'europe', MC: 'europe',
    T: 'japan', HK: 'china', SS: 'china', SZ: 'china', KS: 'apac', TW: 'apac', NS: 'india', BO: 'india', AX: 'apac', SA: 'latam', MX: 'latam' };
  return suf ? (map[suf] || 'world') : 'usa';
}

// gemeinsame Kennzahlen-Felder aus einer aktuellen Perle übernehmen
// Reine Identitaetsfelder — die duerfen mitwandern (Umbenennung, Sektorwechsel).
function identityFrom(s, sym) {
  return { ticker: s.ticker, name: s.name, yahoo: sym, sector: s.sector, region: regionOf(sym) };
}

// Kennzahlen zum Zeitpunkt der Aufnahme. Werden EINMALIG geschrieben und
// danach nie wieder ueberschrieben — sonst korreliert die Analyse spaeter die
// HEUTIGEN Kennzahlen mit der VERGANGENEN Rendite, und das Ergebnis ist wertlos.
function factorsFrom(s) {
  return {
    buyPct: s.buyPct ?? null, strongBuyPct: s.strongBuyPct ?? null,
    upside: s.upside ?? null, pe: s.pe ?? null, perf6mAtAdd: s.perf6m ?? null,
    perf1mBefore: s.perf1mBefore ?? null, sektorPsiAtAdd: s.sektorPsiAtAdd ?? null,
    sektorHitAtAdd: s.sektorHitAtAdd ?? null,
    analysts: s.analysts ?? null, div: s.div ?? null,
    ...(s.factors || {}),   // die breiten Yahoo-Faktoren aus enrichStock
  };
}

function metaFrom(s, sym) {
  return { ...identityFrom(s, sym), ...factorsFrom(s) };
}

// Fuellt NUR Felder, die noch fehlen (null/undefined). Bestehende Werte bleiben
// stehen — so bekommen alte Eintraege neu eingefuehrte Faktoren nachtraeglich,
// ohne dass der Aufnahme-Stand der alten Faktoren verfaelscht wird.
function fillMissing(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v == null) continue;
    if (target[k] == null) target[k] = v;
  }
}

// Snapshot je aktueller Perle anlegen/auffrischen (mit Aufnahmekurs + leerem perf-Array).
export async function snapshotStocks(hist, topStocks, budget = 30) {
  const e = hist.entries;
  let added = 0;
  for (const s of topStocks) {
    if (e[s.ticker]) {
      const x = e[s.ticker];
      // Identitaet darf sich aendern, Kennzahlen NICHT — die sind der
      // Aufnahme-Snapshot. Neue Faktor-Felder werden nur nachgefuellt.
      Object.assign(x, identityFrom(s, x.yahoo || s.yahoo || s.ticker));
      fillMissing(x, factorsFrom(s));
      continue;
    }
    if (added >= budget) continue;
    const seenStr = s.seen || todayStr();
    const sym = s.yahoo || s.ticker;
    const startMs = dayMs(seenStr);
    const startPrice = await priceAtDate(sym, startMs);
    if (startPrice == null) continue;
    // Vorgeschichte der Aktie EINMALIG beim Aufnehmen festhalten — danach
    // aendert sie sich nie wieder, denn sie liegt vor dem Aufnahmetag.
    let hist = null;
    try {
      const DAY = 86400000;
      const rows = await chartRows(sym, startMs - 1200 * DAY, startMs + 2 * DAY);
      if (rows) hist = historyFactors(rows, startMs);
    } catch { /* ohne Vorgeschichte ist die Perle trotzdem brauchbar */ }
    e[s.ticker] = {
      ...metaFrom(s, sym), ...(hist || {}),
      seen: seenStr, seenMs: startMs, startPrice, perf: [],
    };
    added++;
  }
  return added;
}

// Fällige Monats-Messpunkte berechnen: für jeden vergangenen Monat seit Aufnahme die
// kumulierte Performance (Aufnahmekurs -> Kurs nach m Monaten), einmalig & fix gespeichert.
export async function measureMilestones(hist, budget = 30) {
  const now = Date.now();
  let measured = 0;
  for (const x of Object.values(hist.entries)) {
    if (measured >= budget) break;
    if (x.startPrice == null || !x.seenMs) continue;
    x.perf = x.perf || [];
    for (let m = 1; m <= MONTHS; m++) {
      if (x.perf[m - 1] != null && !(x.prov && m === 1)) continue;   // schon fix gemessen
      const dueMs = x.seenMs + m * 30 * MS_DAY;
      if (now < dueMs) break;                                        // noch nicht fällig (spätere auch nicht)
      const v = await perfBetween(x.yahoo || x.ticker, x.seenMs, dueMs);
      if (v != null) { x.perf[m - 1] = v; if (m === 1) x.prov = false; measured++; }
      if (measured >= budget) break;
    }
  }
  return measured;
}

/* Hoechststaende + Kursziel-Treffer.

   `perf[]` haelt nur den Stand AM Monatsstichtag fest. Eine Perle, die ihr
   Ziel zwischendurch erreicht und wieder abgibt, sieht darin aus, als haette
   sie es nie geschafft — bei der ersten Auswertung war das jeder DRITTE
   Treffer. Deshalb hier gegen JEDEN Tagesabschluss:

     perfHigh[m-1]   hoechster Tagesabschluss bis Monatsende, in %
     targetHitMonth  erster Monat mit einem Abschluss auf/ueber dem Kursziel
     targetHitDay    der Tag dazu
     highAt          wann zuletzt gemessen (fuer die Reihum-Auswahl)

   Basis ist der Kurs bei Aufnahme AUS DERSELBEN Reihe, nicht das gespeicherte
   startPrice: Yahoo passt Kurse rueckwirkend an (Dividenden, Splits), und ein
   Hoechststand von heute gegen einen Aufnahmekurs von damals waere ein
   Vergleich zweier verschiedener Kursreihen. */
export async function measureHighs(hist, budget = 60) {
  const now = Date.now();
  const list = Object.values(hist.entries)
    .filter(x => x.seenMs)
    .sort((a, b) => (a.highAt || '').localeCompare(b.highAt || ''));
  let done = 0;
  for (const x of list) {
    if (done >= budget) break;
    const sym = x.yahoo || x.ticker;
    let rows = null;
    try { rows = await chartRows(sym, x.seenMs - 6 * MS_DAY, now); } catch { rows = null; }
    if (!rows || rows.length < 3) continue;
    const base = medianAt(rows, x.seenMs);
    if (!base) continue;

    const high = [];
    for (let m = 1; m <= MONTHS; m++) {
      const dueMs = x.seenMs + m * 30 * MS_DAY;
      if (now < dueMs) break;
      const win = rows.filter(r => r.t >= x.seenMs && r.t <= dueMs);
      if (!win.length) { high.push(null); continue; }
      const hi = Math.max(...win.map(r => r.c));
      high.push(+(((hi - base) / base) * 100).toFixed(2));
    }
    for (let i = 1; i < high.length; i++) {
      if (high[i] != null && high[i - 1] != null && high[i] < high[i - 1]) high[i] = high[i - 1];
    }
    if (high.length) x.perfHigh = high;

    // Der Gipfel MIT seinem Tag. Ohne den Tag laesst sich die Marke im
    // Diagramm nur auf einen Monatsstichtag setzen — und dort lag der Gipfel
    // so gut wie nie.
    {
      let bestC = -1e18, bestT = null;
      for (const r of rows) {
        if (r.t < x.seenMs) continue;
        if (r.c > bestC) { bestC = r.c; bestT = r.t; }
      }
      if (bestT != null) {
        x.peakPerf = +(((bestC - base) / base) * 100).toFixed(2);
        x.peakDay = new Date(bestT).toISOString().slice(0, 10);
        x.peakMs = bestT;
      }
    }

    // Ziel-Treffer ueber die ganze Reihe bis heute, nicht nur ueber volle
    // Monate — sonst faellt ein Treffer im laufenden Monat hinten runter.
    if (x.upside != null && x.upside > 0) {
      const target = base * (1 + x.upside / 100);
      let hitMs = null;
      for (const r of rows) {
        if (r.t < x.seenMs) continue;
        if (r.c >= target) { hitMs = r.t; break; }
      }
      if (hitMs != null) {
        x.targetHitMonth = Math.max(1, Math.ceil((hitMs - x.seenMs) / (30 * MS_DAY)));
        x.targetHitDay = new Date(hitMs).toISOString().slice(0, 10);
      } else {
        delete x.targetHitMonth; delete x.targetHitDay;
      }
    }
    x.highAt = todayStr();
    done++;
  }
  return done;
}

// Provisorischer 1-Monats-Punkt JETZT: tut so, als wäre die Perle vor 1 Monat gefunden
// worden, und berechnet die echte 1M-Performance (vor 1M -> heute) aus Yahoo. Nur wenn
// noch kein echter perf[0] da ist. prov:true -> wird durch echten Wert ersetzt.
export async function seedBacktest1m(hist, topStocks, budget = 60) {
  const e = hist.entries;
  const now = Date.now();
  const startMs = now - 30 * MS_DAY;
  let done = 0;
  for (const s of topStocks) {
    if (done >= budget) break;
    const ex = e[s.ticker];
    if (ex && ex.perf && ex.perf[0] != null && !ex.prov) continue;        // echter 1M-Wert existiert
    if (ex && ex.prov && ex.provDay === todayStr()) continue;             // heute schon gerechnet
    const sym = s.yahoo || s.ticker;
    const v = await perfBetween(sym, startMs, now);
    if (v == null) continue;
    const base = ex || { ...metaFrom(s, sym), seen: new Date(startMs).toISOString().slice(0, 10), seenMs: startMs, startPrice: null, perf: [] };
    Object.assign(base, metaFrom(s, sym));
    base.perf = base.perf || [];
    base.perf[0] = v;                  // Monat 1 (provisorisch)
    base.prov = true; base.provDay = todayStr();
    e[s.ticker] = base;
    done++;
  }
  return done;
}

// Faktor-Befunde (für KI-Analyse): je Faktor beste/schlechteste Stufe nach Ø-Performance
// im jüngsten verfügbaren Monat + stärkste Zweier-Kombination.
export function computeFindings(hist) {
  const data = Object.values(hist.entries).map(x => ({ ...x, perfLast: lastPerf(x), months: monthsOf(x) })).filter(x => x.perfLast != null);
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const buckets = {
    KGV: s => s.pe == null ? null : s.pe < 15 ? '<15' : s.pe < 25 ? '15-25' : s.pe < 40 ? '25-40' : '40+',
    'Strong Buy': s => s.strongBuyPct == null ? null : s.strongBuyPct < 70 ? '<70%' : s.strongBuyPct < 85 ? '70-85%' : s.strongBuyPct < 95 ? '85-95%' : '95%+',
    Kursziel: s => s.upside == null ? null : s.upside < 10 ? '<10%' : s.upside < 25 ? '10-25%' : s.upside < 40 ? '25-40%' : '40%+',
    Dividende: s => s.div == null ? null : s.div === 0 ? 'keine' : s.div < 2 ? '<2%' : s.div < 4 ? '2-4%' : '4%+',
    Analysten: s => s.analysts == null ? null : s.analysts < 5 ? '1-4' : s.analysts < 15 ? '5-14' : '15+',
  };
  const factors = [];
  for (const [name, fn] of Object.entries(buckets)) {
    const g = {};
    data.forEach(s => { const k = fn(s), p = s.perfLast; if (k != null && p != null) (g[k] = g[k] || []).push(p); });
    const stages = Object.entries(g).filter(([, a]) => a.length >= 3).map(([k, a]) => ({ k, avg: +avg(a).toFixed(1), n: a.length }));
    if (stages.length < 2) continue;
    stages.sort((a, b) => b.avg - a.avg);
    factors.push({ name, spread: +(stages[0].avg - stages[stages.length - 1].avg).toFixed(1), best: stages[0], worst: stages[stages.length - 1] });
  }
  factors.sort((a, b) => b.spread - a.spread);
  let combo = null;
  if (factors.length >= 2) {
    const [f1, f2] = factors;
    const fn1 = buckets[f1.name], fn2 = buckets[f2.name];
    const sub = data.filter(s => fn1(s) === f1.best.k && fn2(s) === f2.best.k).map(s => s.perfLast).filter(p => p != null);
    if (sub.length >= 3) combo = { f1: f1.name + ' ' + f1.best.k, f2: f2.name + ' ' + f2.best.k, avg: +avg(sub).toFixed(1), n: sub.length };
  }
  // Reifegrad der Datenbasis: längster real gemessener Zeitraum + ob (noch) provisorisch.
  const maxMonths = data.length ? Math.max(...data.map(s => s.months || 0)) : 0;
  const allProvisional = data.length > 0 && Object.values(hist.entries).every(x => x.prov || lastPerf(x) == null);
  return { factors: factors.slice(0, 5), combo, sampleSize: data.length, maxMonths, provisional: allProvisional };
}
// jüngster vorhandener Monatswert einer Aktie
function lastPerf(x) { if (!x.perf || !x.perf.length) return null; for (let i = x.perf.length - 1; i >= 0; i--) if (x.perf[i] != null) return x.perf[i]; return null; }
// Anzahl real vorhandener Monatspunkte (höchster gesetzter Index + 1)
function monthsOf(x) { if (!x.perf || !x.perf.length) return 0; for (let i = x.perf.length - 1; i >= 0; i--) if (x.perf[i] != null) return i + 1; return 0; }

// Einträge älter als 1 Jahr + alte Voll-Fake-Aktien (Altbestand) entfernen.
export function pruneHistory(hist) {
  const cutoff = Date.now() - 366 * MS_DAY;
  let removed = 0;
  for (const [tk, x] of Object.entries(hist.entries)) {
    if ((x.seenMs && x.seenMs < cutoff) || x.fake) { delete hist.entries[tk]; removed++; }
  }
  return removed;
}
