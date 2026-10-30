// Kursdaten über Yahoo-Finance-Chart-API (kostenlos, kein Key).
//  - Sektor-Performance je ETF: perf30 (aktuell ~30 Handelstage), avg30 (Ø rollierende
//    30T-Returns über ~360 Tage), perf6m (~126 Handelstage).
//  - Einzelaktien-Performance (6 Monate) für die Sortierung der Analysten-Perlen.
//
// Robust gegen Yahoo-Ausreißer: End-/Startkurs = Median über ein kleines Fenster,
// damit ein einzelner fehlerhafter Tageskurs die Prozentwerte nicht verfälscht.
import { SECTORS, REGIONS } from './sectors.mjs';

const W30 = 21;    // ~30 Kalendertage
const W6M = 126;   // ~6 Monate

function median(a) {
  const x = a.filter(v => typeof v === 'number' && isFinite(v)).sort((m, n) => m - n);
  if (!x.length) return null;
  const mid = Math.floor(x.length / 2);
  return x.length % 2 ? x[mid] : (x[mid - 1] + x[mid]) / 2;
}
// Median der k Werte ENDEND bei Index i (trailing) — robust am Rand gegen Ausreißer.
// Yahoos jeweils letzter Tageskurs ist oft ein Intraday-Spike; der 3-Tage-Median
// trifft die offiziellen Monatswerte (validiert gegen etfdb/NAV).
function trailMed(arr, i, k = 3) {
  const lo = Math.max(0, i - k + 1);
  return median(arr.slice(lo, i + 1));
}
function pctBack(c, win) {
  if (c.length <= win + 2) return null;
  const last = trailMed(c, c.length - 1);
  const ref = trailMed(c, c.length - 1 - win);
  if (!last || !ref) return null;
  return +(((last - ref) / ref) * 100).toFixed(2);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function closes(symbol, range = '1y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('Yahoo HTTP ' + res.status + ' (' + symbol + ')');
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  const arr = r?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(arr)) throw new Error('keine Kursdaten für ' + symbol);
  return arr.filter(x => typeof x === 'number' && isFinite(x));
}

/* ---------- Historische Kurse (für Backtest seit Aufnahme) ----------
   Holt {ts[], close[]} in einem Datumsbereich. */
async function history(symbol, fromMs, toMs) {
  const p1 = Math.floor(fromMs / 1000), p2 = Math.floor(toMs / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
  const r = (await res.json())?.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const cl = r?.indicators?.quote?.[0]?.close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) if (typeof cl[i] === 'number' && isFinite(cl[i])) out.push({ t: ts[i] * 1000, c: cl[i] });
  return out;
}

// Robuster Kurs am/nahe einem Datum: MEDIAN der ~3 Handelstage um das Zieldatum,
// damit ein einzelner Yahoo-Ausreißer (Intraday-Spike) den Wert nicht verfälscht.
// Gleiche Robustheit wie die 6M-Berechnung (trailMed). ±7 Tage Suchfenster.
export async function priceAtDate(symbol, dateMs) {
  try {
    const data = await history(symbol, dateMs - 5 * 86400000, dateMs + 9 * 86400000);
    if (!data.length) return null;
    // Index des ersten Kurses ab dateMs (sonst letzter davor)
    let idx = data.findIndex(d => d.t >= dateMs);
    if (idx < 0) idx = data.length - 1;
    // Median über den Zieltag + 2 Nachbartage (zentriert), robust gegen Spikes
    const lo = Math.max(0, idx - 1), hi = Math.min(data.length, idx + 2);
    const m = median(data.slice(lo, hi).map(d => d.c));
    return m != null ? m : data[idx].c;
  } catch { return null; }
}

// Performance (%) zwischen zwei Daten für ein Symbol; null wenn Daten fehlen.
export async function perfBetween(symbol, fromMs, toMs) {
  try {
    const start = await priceAtDate(symbol, fromMs);
    const end = await priceAtDate(symbol, toMs);
    if (start == null || end == null || start === 0) return null;
    return +(((end - start) / start) * 100).toFixed(2);
  } catch { return null; }
}

/* ---------- Yahoo quoteSummary (Kursziel, KGV, EPS) ----------
   Braucht Cookie + Crumb. Beides einmal holen und cachen.                       */
let _cookie = null, _crumb = null;
async function ensureCrumb() {
  if (_crumb) return;
  // 1) Cookie holen
  const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA } });
  _cookie = (r1.headers.get('set-cookie') || '').split(';')[0] || '';
  // 2) Crumb mit Cookie holen
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': _cookie },
  });
  const c = await r2.text();
  if (c && !c.startsWith('{') && c.length < 40) _crumb = c;
  else throw new Error('kein Yahoo-Crumb');
}

// Cookie + Crumb fuer eigene Yahoo-Aufrufe (Atlas-Screener).
export async function yahooAuth() {
  await ensureCrumb();
  return { cookie: _cookie, crumb: _crumb, ua: UA };
}

// Wechselkurs in EUR, einmal je Waehrung und Lauf gecacht.
const _fx = { EUR: 1 };
async function fxToEur(cur) {
  if (!cur) return null;
  if (_fx[cur] !== undefined) return _fx[cur];
  try {
    const u = `https://query1.finance.yahoo.com/v8/finance/chart/${cur}EUR=X?range=5d&interval=1d`;
    const res = await fetch(u, { headers: { 'User-Agent': UA } });
    const j = await res.json();
    const cl = (j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(x => x != null);
    _fx[cur] = cl.length ? cl[cl.length - 1] : null;
  } catch { _fx[cur] = null; }
  return _fx[cur];
}

// Nur der Yahoo-Sektor/-Branche einer Aktie (für Trefferquoten-Zählung; kein Kontingent).
export async function fetchSectorOf(symbol) {
  try {
    await ensureCrumb();
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`
      + `?modules=assetProfile&crumb=${encodeURIComponent(_crumb)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Cookie': _cookie } });
    if (res.status === 401 || res.status === 403) { _crumb = null; return null; }
    if (!res.ok) return null;
    const a = (await res.json())?.quoteSummary?.result?.[0]?.assetProfile;
    if (!a) return null;
    return { sector: a.sector || null, industry: a.industry || null };
  } catch { return null; }
}

// Yahoo recommendationTrend: aktuellste Buy/Hold/Sell-Verteilung (echte Analysten, kostenlos).
// Skala: strongBuy, buy, hold, sell, strongSell. Rückgabe auf unserer Skala oder null.
export async function fetchYahooRatings(symbol) {
  try {
    await ensureCrumb();
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`
      + `?modules=recommendationTrend&crumb=${encodeURIComponent(_crumb)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Cookie': _cookie } });
    if (res.status === 401 || res.status === 403) { _crumb = null; return null; }
    if (!res.ok) return null;
    const trend = (await res.json())?.quoteSummary?.result?.[0]?.recommendationTrend?.trend;
    if (!Array.isArray(trend) || !trend.length) return null;
    const t = trend.find(x => x.period === '0m') || trend[0];   // aktuellster Zeitraum
    const sb = t.strongBuy || 0, b = t.buy || 0, h = t.hold || 0, s = t.sell || 0, ss = t.strongSell || 0;
    const analysts = sb + b + h + s + ss;
    if (analysts <= 0) return null;
    const neg = h + s + ss;   // alle nicht-Kauf-Stufen (Hold/Sell/StrongSell)
    // Buy = strongBuy, Outperform = buy
    return { buy: sb, outperform: b, hold: h, underperform: 0, sell: s + ss, neg, analysts, source: 'yahoo' };
  } catch { return null; }
}

// Liefert { price, target, upside, pe, eps, analysts } für ein Symbol (oder Teilwerte/null).
export async function enrichStock(symbol) {
  try {
    const r = await quoteSummaryRaw(symbol, 'financialData,summaryDetail,price,defaultKeyStatistics');
    if (!r) return null;
    return await stockFromSummary(r);
  } catch {
    return null;
  }
}

// Ein quoteSummary-Aufruf mit beliebigen Modulen (Cookie + Crumb). Wirft bei
// 429/5xx einen Fehler mit .status, damit Aufrufer (Atlas) bremsen koennen.
export async function quoteSummaryRaw(symbol, modules) {
  await ensureCrumb();
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`
    + `?modules=${modules}&crumb=${encodeURIComponent(_crumb)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Cookie': _cookie } });
  if (res.status === 401 || res.status === 403) { _crumb = null; const e = new Error('crumb abgelaufen'); e.status = res.status; throw e; }
  if (res.status === 404) return null;
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
  return (await res.json())?.quoteSummary?.result?.[0] || null;
}

// Kennzahlen aus einem quoteSummary-Ergebnis — EINE Rechnung fuer Argus
// (enrichStock) und Atlas (scripts/atlas.mjs), damit beide gleich messen.
export async function stockFromSummary(r) {
  const fd = r.financialData || {}, sd = r.summaryDetail || {}, pr = r.price || {}, ks = r.defaultKeyStatistics || {};
  const price = fd.currentPrice?.raw ?? pr.regularMarketPrice?.raw ?? null;
  const target = fd.targetMeanPrice?.raw ?? null;
  const upside = (price && target) ? Math.round((target / price - 1) * 100) : null;
  let pe = sd.trailingPE?.raw ?? fd.trailingPE?.raw ?? null;
  pe = (pe != null && isFinite(pe) && pe > 0 && pe <= 500) ? +pe.toFixed(1) : null;  // Verlust/absurd -> kein KGV
  const eps = ks.trailingEps?.raw ?? null;
  const analysts = fd.numberOfAnalystOpinions?.raw ?? null;
  // Dividendenrendite in % (Yahoo liefert Dezimal, z. B. 0.0258 -> 2.58)
  let divYield = sd.dividendYield?.raw ?? sd.trailingAnnualDividendYield?.raw ?? null;
  divYield = (divYield != null && isFinite(divYield) && divYield >= 0 && divYield < 1) ? +(divYield * 100).toFixed(2) : null;
  // ── Faktoren fuer die Trendscope-Analyse ────────────────────────────
  // Kommen aus DEMSELBEN Call, kosten also kein zusaetzliches Kontingent.
  // Werden in history.mjs EINMALIG beim Aufnehmen einer Perle eingefroren.
  const n = (x) => (x && typeof x.raw === 'number' && isFinite(x.raw) ? x.raw : null);
  const p2 = (x) => { const v = n(x); return v == null ? null : +(v * 100).toFixed(2); };
  const f2 = (x) => { const v = n(x); return v == null ? null : +v.toFixed(2); };
  const hi52 = n(sd.fiftyTwoWeekHigh), lo52 = n(sd.fiftyTwoWeekLow);
  const tH = n(fd.targetHighPrice), tL = n(fd.targetLowPrice), tM = n(fd.targetMeanPrice);
  const rel = (a, b) => (a != null && b) ? +(((a / b) - 1) * 100).toFixed(2) : null;
  // Marktkapitalisierung IMMER in EUR — Yahoo liefert sie in der
  // Notierungswaehrung, wodurch eine koreanische Aktie sonst mit dem
  // 1400-fachen einer deutschen dastand.
  const mcRaw = n(sd.marketCap) ?? n(pr.marketCap);
  const mcCur = pr.currency || fd.financialCurrency || null;
  const fx = mcRaw != null ? await fxToEur(mcCur) : null;
  const mcEur = (mcRaw != null && fx != null) ? Math.round(mcRaw * fx) : null;
  const factors = {
    forwardPe: f2(sd.forwardPE) ?? f2(ks.forwardPE),
    priceToBook: f2(ks.priceToBook),
    priceToSales: f2(sd.priceToSalesTrailing12Months),
    // Negatives EV/EBITDA entsteht bei negativem EBITDA und ist genauso
    // bedeutungslos wie ein negatives KGV — dann lieber kein Wert. Absurd
    // hohe Werte (> 200) kommen aus fast null EBITDA und sind ebenso Muell.
    evEbitda: (() => {
      const v = f2(ks.enterpriseToEbitda);
      return (v != null && v > 0 && v <= 200) ? v : null;
    })(),
    evRevenue: f2(ks.enterpriseToRevenue),
    grossMargin: p2(fd.grossMargins),
    operatingMargin: p2(fd.operatingMargins),
    profitMargin: p2(fd.profitMargins) ?? p2(ks.profitMargins),
    ebitdaMargin: p2(fd.ebitdaMargins),
    roe: p2(fd.returnOnEquity),
    roa: p2(fd.returnOnAssets),
    revenueGrowth: p2(fd.revenueGrowth),
    earningsGrowth: p2(fd.earningsGrowth),
    earningsQGrowth: p2(ks.earningsQuarterlyGrowth),
    debtToEquity: f2(fd.debtToEquity),
    currentRatio: f2(fd.currentRatio),
    quickRatio: f2(fd.quickRatio),
    payoutRatio: p2(sd.payoutRatio),
    heldInsiders: p2(ks.heldPercentInsiders),
    heldInstitutions: p2(ks.heldPercentInstitutions),
    marketCap: mcEur,
    beta: f2(sd.beta),
    distTo52High: rel(price, hi52),
    pos52Band: (price != null && hi52 != null && lo52 != null && hi52 > lo52)
      ? +(((price - lo52) / (hi52 - lo52)) * 100).toFixed(1) : null,
    distTo50dma: rel(price, n(sd.fiftyDayAverage)),
    distTo200dma: rel(price, n(sd.twoHundredDayAverage)),
    recMean: f2(fd.recommendationMean),
    targetSpread: (tH != null && tL != null && tM)
      ? +(((tH - tL) / tM) * 100).toFixed(1) : null,
  };

  return {
    price, target,
    // Kursziel-Potenzial plausibel begrenzen (extreme Werte = oft Datenfehler/Penny-Stocks)
    upside: (upside != null && upside >= -60 && upside <= 100) ? upside : null,
    pe, eps: (eps != null && isFinite(eps)) ? +eps.toFixed(2) : null,
    analysts: analysts || null,
    divYield,
    factors,
  };
}

// Performance für eine Liste von { id, etf } (Sektoren ODER Regionen).
async function fetchPerf(list) {
  const out = [];
  for (const s of list) {
    try {
      const c = await closes(s.etf, '1y');
      if (c.length <= W30 + 2) { out.push({ id: s.id, perf: 0, avg30: 0, perf6m: 0 }); continue; }
      const perf = pctBack(c, W30) ?? 0;
      const perf6m = pctBack(c, Math.min(W6M, c.length - 2)) ?? 0;

      // Ø der rollierenden 30T-Returns über die letzten ~252 Handelstage (geglättet).
      const lookback = Math.min(252, c.length - 1 - W30);
      let sum = 0, cnt = 0;
      for (let i = c.length - 1; i > c.length - 1 - lookback && i - W30 >= 0; i--) {
        const a = trailMed(c, i), b = trailMed(c, i - W30);
        if (a && b) { sum += ((a - b) / b) * 100; cnt++; }
      }
      const avg30 = cnt ? +(sum / cnt).toFixed(2) : perf;
      out.push({ id: s.id, perf, avg30, perf6m });
    } catch (e) {
      out.push({ id: s.id, perf: 0, avg30: 0, perf6m: 0 });
    }
  }
  return out;
}

export const fetchSectorPerformance = () => fetchPerf(SECTORS);
export const fetchRegionPerformance = () => fetchPerf(REGIONS);

// 6-Monats-Performance für eine einzelne Aktie (oder null bei Fehler).
// Der 6mo-Range liefert ~124 Handelstage -> Anfang (3er-Median) vs. Ende (3er-Median).
export async function fetchStockPerf6m(ticker) {
  try {
    const c = await closes(ticker, '6mo');
    if (c.length < 10) return null;
    const start = trailMed(c, 2);                 // Median der ersten 3 Tage
    const end = trailMed(c, c.length - 1);        // Median der letzten 3 Tage
    if (!start || !end) return null;
    return +(((end - start) / start) * 100).toFixed(2);
  } catch {
    return null;
  }
}

// 30-Tage-Kursperformance einer Aktie (~21 Handelstage), analog zur Sektor-30T-Performance.
// Für den Aktien-PSI (relative Kursposition der Aktie statt des Sektors).
export async function fetchStockPerf30(ticker) {
  try {
    const c = await closes(ticker, '3mo');
    if (c.length <= W30 + 2) return null;
    const end = trailMed(c, c.length - 1);
    const ref = trailMed(c, c.length - 1 - W30);
    if (!ref || !end) return null;
    return +(((end - ref) / ref) * 100).toFixed(2);
  } catch {
    return null;
  }
}
