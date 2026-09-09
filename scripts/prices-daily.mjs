// Tagesschlusskurse aller je gefundenen Aktien — ein Jahr rueckwaerts.
//
// WOZU: die Perlen-Detailkarte zeichnete den Renditeverlauf aus zwoelf
// Monatspunkten. Zwischen zwei Punkten ist alles moeglich: ein Gipfel, ein
// Einbruch, eine Erholung — sichtbar war davon nichts. Mit den Tageswerten
// steht da die echte Kurve.
//
// WO: NICHT in history.json und NICHT im main-Zweig. Die Datei wiegt rund
// 1 MB und aendert sich jeden Handelstag komplett (jede Reihe bekommt einen
// Punkt). In der Git-Historie waeren das ueber 100 MB im Jahr, fuer Daten,
// deren alte Staende niemanden interessieren. Sie liegt deshalb im Zweig
// `prices`, der bei jedem Lauf mit EINEM Commit ueberschrieben wird — das
// Repository waechst dadurch einmalig um 1 MB und danach nicht mehr.
//
// FORMAT (eine Zeile je Ticker, damit Diffs lesbar bleiben):
//   "AAPL": {"f":"2025-09-10","b":301.5,"d":[0,1,4,...],"c":[306.31,...]}
//     f = erster Tag der Reihe        b = Kurs bei Aufnahme (Basis)
//     d = Tagesabstand zu f           c = Schlusskurse
//
// Die Basis ist derselbe Median der drei Handelstage um den Aufnahmetag, mit
// dem auch perf[] und perfHigh rechnen — sonst zeigte die Karte eine andere
// Rendite als die Statistik.
import fs from 'node:fs';

const FILE = 'prices.json';
const RAW = 'https://raw.githubusercontent.com/danielgerner06-bit/argus/prices/prices.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const MS_DAY = 86400000;
const YEAR = 366 * MS_DAY;

// Wie viele Reihen ein Lauf auffrischt. Bei vier Laeufen am Tag ist damit
// jede Aktie taeglich einmal dran, ohne dass ein Lauf 400 Abrufe braucht.
const BUDGET = Number(process.env.PRICES_BUDGET || 120);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chartRows(symbol, fromMs, toMs) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?period1=${Math.floor(fromMs / 1000)}&period2=${Math.floor(toMs / 1000)}&interval=1d`;
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  if (!r.ok) return null;
  const res = (await r.json())?.chart?.result?.[0];
  const ts = res?.timestamp || [];
  const cl = res?.indicators?.quote?.[0]?.close || [];
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    if (cl[i] != null && isFinite(cl[i])) rows.push({ t: ts[i] * 1000, c: cl[i] });
  }
  return rows.length ? rows : null;
}

/** Median der drei Handelstage um ein Datum — wie prices.mjs priceAtDate. */
function medianAt(rows, dateMs) {
  let idx = rows.findIndex((r) => r.t >= dateMs);
  if (idx < 0) idx = rows.length - 1;
  const v = rows.slice(Math.max(0, idx - 1), Math.min(rows.length, idx + 2))
    .map((r) => r.c).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

async function loadPrevious() {
  // Erst lokal (Nachlauf im selben Job), sonst aus dem prices-Zweig.
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* weiter */ }
  try {
    const r = await fetch(RAW, { headers: { 'User-Agent': UA } });
    if (r.ok) return await r.json();
  } catch { /* beim ersten Mal gibt es den Zweig noch nicht */ }
  return {};
}

function write(out) {
  // Eine Zeile je Ticker: so bleibt ein Diff lesbar und der Packer muss nicht
  // eine einzige Megabyte-Zeile vergleichen.
  const keys = Object.keys(out).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(out[k])}`)
    .join(',\n');
  fs.writeFileSync(FILE, `{\n${body}\n}\n`);
  const kb = (fs.statSync(FILE).size / 1024).toFixed(0);
  console.log(`prices.json: ${keys.length} Reihen, ${kb} KB`);
}

(async () => {
  const hist = JSON.parse(fs.readFileSync('history.json', 'utf8'));
  const entries = Object.values(hist.entries).filter((x) => x.seenMs);
  const out = await loadPrevious();
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);

  // Reihum: die am laengsten nicht aufgefrischten zuerst, neue Aktien vorweg.
  const todo = entries
    .map((x) => ({ x, at: out[x.ticker]?.u || '' }))
    .sort((a, b) => a.at.localeCompare(b.at));

  let done = 0, failed = 0;
  for (const { x, at } of todo) {
    if (done >= BUDGET) break;
    if (at === today) continue;              // heute schon geholt
    const sym = x.yahoo || x.ticker;
    // Ein Jahr rueckwaerts, mindestens aber bis kurz vor die Aufnahme: bei
    // aelteren Perlen soll die ganze Haltedauer drin sein.
    const from = Math.min(x.seenMs - 7 * MS_DAY, now - YEAR);
    let rows = null;
    try { rows = await chartRows(sym, from, now); } catch { rows = null; }
    await sleep(90);
    if (!rows || rows.length < 5) { failed++; continue; }

    const base = medianAt(rows, x.seenMs);
    if (!base) { failed++; continue; }
    const f = rows[0].t;
    out[x.ticker] = {
      f: new Date(f).toISOString().slice(0, 10),
      b: +base.toFixed(4),
      s: new Date(x.seenMs).toISOString().slice(0, 10),
      d: rows.map((r) => Math.round((r.t - f) / MS_DAY)),
      c: rows.map((r) => +r.c.toFixed(4)),
      u: today,
    };
    done++;
    if (done % 50 === 0) console.log(`  … ${done}/${Math.min(BUDGET, todo.length)}`);
  }

  // Aktien, die aus der Historie gefallen sind (aelter als ein Jahr), fliegen
  // auch hier raus — sonst waechst die Datei ewig weiter.
  const alive = new Set(entries.map((x) => x.ticker));
  for (const k of Object.keys(out)) if (!alive.has(k)) delete out[k];

  console.log(`aufgefrischt: ${done} · ohne Kurse: ${failed}`);
  write(out);
})();
