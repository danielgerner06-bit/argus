// Analysten-Perlen via Gemini + Google-Search-Grounding.
//
// Zwei Funktionen:
//  (A) checkCandidates: prüft eine Handvoll Kandidaten-Aktien per Websuche auf das
//      Kriterium (Kaufempfehlungs-Anteil >= 80 %) und liefert Treffer mit Quelle.
//  (B) discoverNew: lässt Gemini NEUE, unbekannte Werte vorschlagen — bekommt dazu
//      die Liste bereits bekannter Namen, damit es nichts doppelt vorschlägt.
//
// Beide nutzen google_search-Grounding und liefern strukturierte Objekte.

import { sectorForFinnhub, SECTOR_IDS } from './sectors.mjs';

// flash-lite lieferte mit google_search-Grounding nicht-deterministisch LEERE Antworten
// (alles "thinking", kein Text — auch mit thinkingBudget:0). Das stärkere flash gibt mit
// Grounding zuverlässig strukturierten Text zurück. News läuft weiter günstig (eigenes Modell).
const MODEL0 = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// Google schaltet alte Modelle ab (dann 404). Einmal je Lauf auf den
// laufend gepflegten Namen wechseln statt still keine Texte mehr zu liefern
// (seit 2026-10-31). Fest waehlbar ueber die Umgebung GEMINI_MODEL.
const MODEL_FALLBACK = 'gemini-flash-latest';
let MODEL = MODEL0;
const modelUrl = (key) => `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
const modelGone = (res) => (res.status === 404 && MODEL !== MODEL_FALLBACK)
  ? (console.log(`Gemini-Modell ${MODEL} nicht mehr da — weiter mit ${MODEL_FALLBACK}.`), MODEL = MODEL_FALLBACK, true)
  : false;
const SECTOR_LIST = SECTOR_IDS.join(', ');

// Aufnahmekriterium: Kaufempfehlungs-Anteil (Buy + Strong Buy) = 100 %.
export const MIN_BUY_PCT = Number(process.env.MIN_BUY_PCT || 100);
const qualifies = r => !r.countsBad && isFinite(r.buyPct) && r.buyPct >= MIN_BUY_PCT;

// Firmenname auf vergleichbaren Kern reduzieren (Rechtsformen/Füllwörter weg, nur a-z0-9).
function nameKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(se|ag|nv|sa|corp|corporation|inc|incorporated|ltd|limited|plc|co|kgaa|group|holding|holdings|company|the|vz|vorzugsaktien|adr|spa|oyj|asa|ab|as)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

async function groundedJSON(key, prompt) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    // flash braucht ein kleines Thinking-Budget, um mit Grounding zuverlässig Text zu liefern
    // (thinkingBudget:0 ließ es bei flash-lite gar nicht mehr antworten). maxOutputTokens hoch.
    generationConfig: { temperature: 0.3, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 512 } },
  });
  let lastErr = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(modelUrl(key), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (modelGone(res)) continue;
    if (res.status === 429) {                        // RPM-Grounding-Limit -> warten & erneut versuchen
      lastErr = 'Gemini HTTP 429';
      await new Promise(r => setTimeout(r, 20000 * (attempt + 1)));   // 20s, 40s, 60s, 80s
      continue;
    }
    if (!res.ok) throw new Error('Gemini HTTP ' + res.status + ': ' + (await res.text()).slice(0, 250));
    const j = await res.json();
    const cand = j.candidates?.[0];
    const text = cand?.content?.parts?.map(p => p.text).filter(Boolean).join('').trim() || '';
    const sources = (cand?.groundingMetadata?.groundingChunks || [])
      .map(c => c.web?.title || c.web?.uri).filter(Boolean);
    // flash-lite liefert mit Grounding NICHT-DETERMINISTISCH mal eine leere Antwort
    // (finishReason=STOP, aber parts=undefined). Das ist transient -> kurz warten und erneut
    // versuchen, statt aufzugeben. Erst nach mehreren Leerläufen leer zurückgeben.
    if (!text) {
      if (process.env.GEMINI_DEBUG) {
        console.log(`  [groundedJSON LEER #${attempt + 1}] finishReason=${cand?.finishReason} usage=${JSON.stringify(j.usageMetadata)}`);
      }
      if (attempt < 4) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
    }
    return { text, sources };
  }
  return { text: '', sources: [] };   // alle Versuche leer -> leer zurück (kein harter Fehler)
}

// Extrahiert das erste JSON-Array/-Objekt aus einem Text (Grounding erlaubt kein responseMimeType=json).
function extractJSON(text) {
  if (!text) return null;
  let t = text.replace(/```json/gi, '```').replace(/```/g, '');
  const start = t.search(/[[{]/);
  if (start < 0) return null;
  // vom ersten Klammerzeichen bis zum passenden Ende grob schneiden
  const lastArr = t.lastIndexOf(']');
  const lastObj = t.lastIndexOf('}');
  const end = Math.max(lastArr, lastObj);
  if (end < start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

function normRating(o) {
  // Stufen: Buy, Outperform, Hold, Underperform, Sell (über mehrere durchsuchbare Quellen).
  // Kaufempfehlung = Buy + Outperform; Outperform-Wert = nur die Outperform-Stufe.
  // Kriterium 100%: NUR Buy/Outperform > 0, Hold/Underperform/Sell = 0.
  // WIR rechnen aus den Zählern. Der MarketScreener-Link ist OPTIONAL (Geminis IDs waren
  // unzuverlässig) — die Wahrheit sichert die unabhängige Gegenprüfung (verifyNoHold).
  const cnt = k => { const v = Number(o[k]); return isFinite(v) && v >= 0 ? Math.round(v) : null; };
  const buy = cnt('buy');
  const outp = cnt('outperform') ?? cnt('outperformCount') ?? cnt('accumulate');
  const hold = cnt('hold');
  const under = cnt('underperform') ?? 0;
  const sell = (cnt('sell') ?? 0) + (cnt('strongSell') ?? cnt('strong_sell') ?? 0);

  // MarketScreener-Link nur noch optional mitführen, falls vorhanden (kein Pflichtfeld mehr).
  const rawUrl = (o.url || o.sourceUrl || o.marketScreenerUrl || o.msUrl || '').toString().trim();
  const msMatch = /^https?:\/\/(www\.)?marketscreener\.com\/quote\/stock\/[^\/]+\//i.test(rawUrl);
  const link = msMatch ? (/consensus\/?$/i.test(rawUrl) ? rawUrl : rawUrl.replace(/\/+$/, '/') + 'consensus/') : null;

  let buyPct, strongBuyPct = null, analysts, countsBad = false;
  const haveCounts = [buy, outp, hold].some(x => x != null);
  if (!haveCounts) {
    countsBad = true;   // ohne Zähler -> raus
  } else {
    const BUY = buy ?? 0, OUTP = outp ?? 0, H = hold ?? 0, U = under ?? 0, S = sell ?? 0;
    const total = BUY + OUTP + H + U + S;
    const declared = Number(o.analysts ?? o.analystCount ?? o.anzahlAnalysten);
    // EXAKTER Ablauf: Hold/Underperform/Sell MÜSSEN alle 0 sein (sonst nicht 100% -> raus).
    // Gemini MUSS die Gesamtzahl separat nennen und sie muss EXAKT der Summe entsprechen.
    if (total <= 0) countsBad = true;
    else if (H > 0 || U > 0 || S > 0) countsBad = true;                         // kein 100%
    else if (!isFinite(declared) || declared <= 0 || declared !== total) countsBad = true;
    else {
      buyPct = 100;                                  // per Definition (alle Buy/Strong Buy)
      strongBuyPct = Math.round((BUY / total) * 100); // Anteil Strong Buy (extremeres Kauflevel)
      analysts = total;
    }
  }

  let upside = (o.upside != null && isFinite(Number(o.upside))) ? Math.round(Number(o.upside)) : null;
  if (upside != null && (upside < -50 || upside > 120)) upside = null;
  let pe = (o.pe ?? o.kgv ?? o.peRatio) != null ? +Number(o.pe ?? o.kgv ?? o.peRatio).toFixed(1) : null;
  if (pe != null && (!isFinite(pe) || pe <= 0 || pe > 500)) pe = null;
  let sector = o.sector;
  if (!SECTOR_IDS.includes(sector)) sector = sectorForFinnhub(o.industry || o.branche || sector) || null;
  const yahoo = (o.yahoo || o.yahooSymbol || '').toString().trim().toUpperCase() || null;
  const counts = (!countsBad) ? { buy: buy ?? 0, outperform: outp ?? 0, hold: hold ?? 0, underperform: under ?? 0, sell: sell ?? 0 } : null;
  return { buyPct, strongBuyPct, analysts, upside, pe, sector, yahoo, ratingCounts: counts, ratingSource: 'analysten-konsens', ratingUrl: link, countsBad };
}

// Ablauf: Analysten-Verteilung aus DURCHSUCHBAREM TEXT lesen (nicht aus dem MarketScreener-
// Diagramm — das ist ein Bild und die Seite ist gesperrt). Endgültig bestätigt wird später
// durch eine separate, strengere Mehrquellen-Gegenprüfung (verifyNoHold).
const RATING_RULES = `
GENAUER ABLAUF (sonst Aktie weglassen):
1) Finde über die Google-Suche die Verteilung der Empfehlungen ECHTER Sell-Side-Analysten
   (Investmentbanken/Broker). Sie steht als TEXT auf TipRanks (".../forecast"),
   MarketScreener-Consensus, Investing.com ("consensus-estimates") oder Yahoo Finance
   ("analysis") — in der Form "X Buy, Y Hold, Z Sell" bzw. Strong Buy / Buy / Hold / Sell.
   IGNORIERE algorithmische Rating-Dienste (Weiss Ratings, Wall Street Zen, Zacks Rank,
   StockInvest, Barchart Opinion, TipRanks Smart Score) — das sind KEINE Analysten.
2) Prüfe die Stufen Buy, Outperform(=Moderate/Accumulate), Hold, Underperform, Sell.
   -> Hold, Underperform und Sell MÜSSEN ALLE = 0 sein (echte Analysten).
3) Wenn ja: zähle Buy und Outperform und gib die Aktie aus.
   Wenn nein (irgendein Hold/Underperform/Sell > 0): Aktie NICHT ausgeben.

Sei ehrlich: KEINE geratenen Zahlen. Wenn du die Verteilung nicht als Text findest -> WEGLASSEN.
Erfinde KEINE URL. (Ein Link ist optional; nur angeben, wenn du ihn wirklich aus einem Suchtreffer hast.)
Pflichtfelder je ausgegebener Aktie:
 - analysts: Gesamtzahl (= Buy + Outperform, da Hold/Underperform/Sell = 0)
 - buy, outperform   (Anzahl je Stufe)
 - hold, underperform, sell  (müssen 0 sein)
 - ticker, name, land, yahoo (Yahoo-Symbol inkl. Suffix z.B. "KTN.DE","NVDA")
 - sector: GENAU eine dieser IDs: ${SECTOR_LIST}
 - upside (% oder null), pe (KGV-Zahl oder null bei Verlust)
 - url (OPTIONAL): nur eine echte, in einem Suchtreffer gesehene URL — sonst weglassen.
Summe der Stufen MUSS = analysts. Unsicher oder Aktie nicht eindeutig gefunden -> WEGLASSEN.`;

/* (A) Kandidaten prüfen ------------------------------------------------ */
export async function checkCandidates(key, names) {
  if (!names.length) return [];
  const prompt = `Du recherchierst Analysten-Empfehlungen für Aktien.
Prüfe GENAU diese Aktien: ${names.map(n => '"' + n + '"').join(', ')}.
${RATING_RULES}

Gib NUR ein JSON-Array zurück, ein Objekt je Aktie, die du sicher belegen konntest.
Kein Text außerhalb des JSON.`;

  const { text, sources } = await groundedJSON(key, prompt);
  const arr = extractJSON(text);
  if (process.env.GEMINI_DEBUG) console.log(`[checkCandidates] rohtext=${(text||'').length}z, extrahiert=${Array.isArray(arr)?arr.length:'KEIN-ARRAY'}, rohanfang=${JSON.stringify((text||'').slice(0,160))}`);
  if (!Array.isArray(arr)) return [];
  // Identitäts-Schutz: zurückgegebenes Objekt muss zu EINER angefragten Aktie passen
  // (Ticker ODER Firmenname-Kern), sonst hat Gemini eine ANDERE Firma erwischt -> verwerfen.
  const wantTickers = new Set(names.map(n => (n.match(/\(([^)]+)\)/) || [])[1]).filter(Boolean).map(t => t.toUpperCase()));
  const wantNameKeys = names.map(n => nameKey(n.replace(/\([^)]*\)/, ''))).filter(Boolean);
  const out = [];
  let dbgId = 0, dbgSec = 0, dbgQual = 0;
  for (const o of arr) {
    if (!o || !o.ticker) continue;
    const tk = String(o.ticker).toUpperCase();
    const nk = nameKey(o.name || '');
    const idOk = wantTickers.has(tk) || wantNameKeys.some(w => nk && (w.includes(nk) || nk.includes(w)));
    if (!idOk) { dbgId++; continue; }   // andere Firma als angefragt -> nicht übernehmen
    const r = normRating(o);
    if (!r.sector) { dbgSec++; continue; }
    if (!qualifies(r)) { dbgQual++; if (process.env.GEMINI_DEBUG) console.log(`  [verworfen] ${tk}: counts=${JSON.stringify(o.buy)}/${JSON.stringify(o.hold)}/${JSON.stringify(o.sell)} analysts=${JSON.stringify(o.analysts)} countsBad=${r.countsBad}`); continue; }
    if (qualifies(r)) {
      out.push({
        ticker: String(o.ticker).toUpperCase(),
        name: o.name || o.ticker,
        sector: r.sector,
        buyPct: r.buyPct, strongBuyPct: r.strongBuyPct,
        analysts: r.analysts, upside: r.upside, yahoo: r.yahoo, peGemini: r.pe,
        ratingCounts: r.ratingCounts, ratingSource: r.ratingSource, ratingUrl: r.ratingUrl,
        via: 'gemini', source: r.ratingSource,
        seen: new Date().toISOString().slice(0, 10),
      });
    }
  }
  if (process.env.GEMINI_DEBUG) console.log(`[checkCandidates] Treffer=${out.length} | verworfen: id=${dbgId} keinSektor=${dbgSec} nicht100%=${dbgQual}`);
  return out;
}

/* (A2) ZWEITE, UNABHÄNGIGE Verifizierung — "im Zweifel raus".
   Eine Perle wird nur behalten, wenn eine SKEPTISCHE Gegenprüfung bestätigt: KEIN
   einziger Hold/Underperform/Sell von ECHTEN Sell-Side-Analysten (Investmentbanken/Broker).
   WICHTIG: algorithmische Rating-Dienste (Weiss Ratings, Wall Street Zen, Zacks Rank,
   TipRanks Smart Score, StockInvest, Argus quant) zählen NICHT als Analysten — genau die
   erzeugen die Schein-Widersprüche (z.B. Ocugen: alle Bank-Analysten Buy, aber Weiss/WSZ
   "Sell"). MarketScreener & TipRanks zählen nur Bank-Analysten -> das ist die Wahrheit.
   Rückgabe: Set der Ticker, die die Gegenprüfung zweifelsfrei bestanden haben. */
export async function verifyNoHold(key, stocks) {
  if (!stocks.length) return new Set();
  const confirmed = new Set();
  // EINZELN prüfen (1 Aktie/Call): kurzer Prompt + simples Output -> zuverlässige Antwort.
  for (const s of stocks) {
    const prompt = `Prüfe die Analysten-Empfehlungen für die Aktie ${s.name} (${s.ticker}).
Zähle NUR ECHTE Sell-Side-Analysten von Investmentbanken/Brokern (z.B. Goldman Sachs, Morgan Stanley,
Oppenheimer, Berenberg, Canaccord, Hauck Aufhäuser, Warburg). IGNORIERE algorithmische Rating-Dienste
(Weiss Ratings, Wall Street Zen, Zacks Rank, StockInvest, Argus quant, TipRanks Smart Score, Barchart Opinion).

Schau auf MINDESTENS ZWEI unabhängige Quellen (MarketScreener "Analyst Consensus Detail", TipRanks
"Forecast", Investing.com, Yahoo Finance). Lies die Verteilung als TEXT.

Zähle besonders sorgfältig die Hold/Neutral- und Sell/Underperform-Empfehlungen — übersieh KEINE.

Antworte NUR mit einer Zeile JSON:
{"buy": <Zahl>, "hold": <Zahl>, "sell": <Zahl>, "quellen": <Anzahl unabhängiger Quellen>, "sicher": <true nur wenn du dir über mehrere übereinstimmende Quellen ganz sicher bist, sonst false>}`;
    let o;
    try { const { text } = await groundedJSON(key, prompt); o = extractJSON(text); }
    catch { o = null; }
    if (Array.isArray(o)) o = o[0];
    if (!o) continue;                                    // keine Antwort -> nicht bestätigen (im Zweifel raus)
    const hold = Number(o.hold), sell = Number(o.sell), src = Number(o.quellen);
    // STRENG bestätigen — "unsicher = raus":
    //  • Gemini muss explizit sicher=true melden,
    //  • 0 Hold UND 0 Sell,
    //  • mindestens 2 unabhängige Quellen geprüft (eine einzelne übersieht oft Holds).
    const ok = o.sicher === true
      && isFinite(hold) && hold === 0
      && isFinite(sell) && sell === 0
      && isFinite(src) && src >= 2;
    if (ok) confirmed.add(String(s.ticker).toUpperCase());
    if (process.env.GEMINI_DEBUG) console.log(`  [verifyNoHold] ${s.ticker}: hold=${o.hold} sell=${o.sell} quellen=${o.quellen} sicher=${o.sicher} -> ${ok ? 'BESTÄTIGT' : 'abgelehnt'}`);
  }
  return confirmed;
}

/* (B) Neue unbekannte Werte entdecken ---------------------------------
   `focus` lenkt die Suche auf eine Region/Branche, damit über mehrere Läufe
   verschiedene Werte gefunden werden (z. B. "deutsche Small-Caps", "Biotech").  */
export async function discoverNew(key, knownNames, focus = '') {
  const known = knownNames.slice(0, 140).join(', ');
  const focusLine = focus
    ? `Lege diesmal den Schwerpunkt auf: ${focus}. `
    : '';
  const prompt = `Du suchst über die Google-Suche WELTWEIT kleine bis mittelgroße, eher UNBEKANNTE Aktien (Small-/Mid-Caps, gern aus Deutschland/Europa, aber auch USA/Asien), bei denen ALLE Analysten zum Kauf raten (nur Buy/Outperform, KEIN Hold/Sell). ${focusLine}
Unternehmensgröße egal — je unbekannter/kleiner, desto besser. KEINE Mega-Caps (kein Apple, Microsoft, Nvidia, Amazon, Alphabet, Meta usw.).
Schlage NUR Aktien vor, die NICHT in dieser Liste bereits bekannter Werte stehen: ${known || '(noch keine)'}.
${RATING_RULES}

Gib NUR ein JSON-Array mit bis zu 10 Aktien zurück, deren Verteilung du auf einer der beiden
Quellen sicher belegt hast. Kein Text außerhalb des JSON.`;

  const { text, sources } = await groundedJSON(key, prompt);
  const arr = extractJSON(text);
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const o of arr) {
    if (!o || !o.ticker) continue;
    const r = normRating(o);
    if (!r.sector) continue;
    if (qualifies(r)) {
      out.push({
        ticker: String(o.ticker).toUpperCase(),
        name: o.name || o.ticker,
        sector: r.sector,
        buyPct: r.buyPct, strongBuyPct: r.strongBuyPct,
        analysts: r.analysts, upside: r.upside, yahoo: r.yahoo, peGemini: r.pe,
        ratingCounts: r.ratingCounts, ratingSource: r.ratingSource, ratingUrl: r.ratingUrl,
        via: 'gemini-discover', source: r.ratingSource,
        seen: new Date().toISOString().slice(0, 10),
      });
    }
  }
  return out;
}
