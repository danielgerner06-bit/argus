// Aktualisiert sectordata.json mit ECHTEN Daten.
//
// Datenquellen:
//  - Finnhub  (FINNHUB_API_KEY): 30-Tage-Sektor-Performance über Sektor-ETFs
//    + Analystenratings, rollierend über das US-Aktien-Universum gescannt.
//  - Gemini + Google-Search-Grounding (GEMINI_API_KEY):
//      * prüft eine wachsende Kandidatenliste (Nebenwerte) per Websuche,
//      * schlägt täglich NEUE unbekannte Treffer vor (kennt die bereits gefundenen),
//      * schreibt den kurzen Marktlage-Text.
//
// Alle Analysten-Treffer landen in einer gemeinsamen, über Tage gepflegten DB.
// Robust: fehlende Keys / Fehler lassen den jeweils alten Stand erhalten.

import fs from 'node:fs';
import { SECTORS, REGIONS, sectorForFinnhub } from './sectors.mjs';
import { buildNews } from './insight.mjs';
import { fetchInflationForecast, inflationDue } from './inflation.mjs';
import { scanAnalystStocks } from './finnhub.mjs';
import { fetchSectorPerformance, fetchRegionPerformance, fetchStockPerf6m, enrichStock, fetchSectorOf, perfBetween } from './prices.mjs';
import { checkCandidates, discoverNew, verifyNoHold, MIN_BUY_PCT } from './gemini-stocks.mjs';
import { verifyAcrossSources } from './ratings.mjs';
import { SEED_CANDIDATES } from './candidates.mjs';
import { SEED_SECTOR_NOTES, SEED_REGION_NOTES } from './seed-notes.mjs';
import { loadHistory, saveHistory, snapshotStocks, measureMilestones, measureHighs, pruneHistory, computeFindings } from './history.mjs';

const OUT = 'sectordata.json';
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const SCAN_BUDGET = Number(process.env.SCAN_BUDGET || 300);   // Finnhub-Symbole pro Lauf (kostet KEIN Gemini)
const CAND_BUDGET = Number(process.env.CAND_BUDGET || 8);     // Kandidaten je Lauf

// Gemini-Budget pro Lauf. Paid Tier (1.500 grounded Calls/Tag frei). verifyNoHold prüft
// jetzt EINZELN (1 Call/Aktie) -> höheres Budget nötig, damit die Gegenprüfung nicht
// mitten in einem Batch abgewürgt wird. Reihenfolge im Code = Priorität.
const GEMINI_BUDGET = Number(process.env.GEMINI_BUDGET || 60);
let geminiUsed = 0;
let geminiDailyDead = false;   // gesetzt, sobald ein Call trotz Backoff am 429 scheitert (Tageslimit)
const geminiBudgetLeft = () => geminiUsed < GEMINI_BUDGET && !geminiDailyDead;
const useGemini = () => { geminiUsed++; };
// Wenn ein Gemini-Aufruf endgültig mit 429 scheitert, ist das Tageskontingent vermutlich leer
// -> restliche Gemini-Schritte dieses Laufs überspringen (statt je 20 min Backoff zu verbrennen).
const noteGeminiError = e => { if (/\b429\b/.test(String(e && e.message))) geminiDailyDead = true; };

function readPrev() {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return null; }
}
const today = () => new Date().toISOString().slice(0, 10);

(async () => {
  const prev = readPrev();

  if (!FINNHUB_KEY && !GEMINI_KEY) {
    console.error('Weder FINNHUB_API_KEY noch GEMINI_API_KEY gesetzt. Bestehende Datei bleibt.');
    process.exit(1);
  }

  // Zeit-Konstanten früh definieren (werden in mehreren Schritten genutzt).
  const STALE = 5 * 86400000; // 5 Tage
  const nowMs = Date.now();

  // DB der Treffer (ticker -> Eintrag) aus bisherigem Stand laden.
  const db = {};
  for (const s of (prev?.topStocks || [])) db[s.ticker] = s;

  // Blacklist (vom Lösch-Button gesetzt): { TICKER: 'YYYY-MM-DD' bis wann gesperrt }.
  // Abgelaufene Sperren entfernen; gesperrte Ticker aus der DB werfen.
  const blacklist = prev?.blacklist || {};
  const todayISO = today();
  for (const [tk, until] of Object.entries(blacklist)) {
    if (until < todayISO) delete blacklist[tk];          // Sperre abgelaufen
    else if (db[tk]) delete db[tk];                       // noch gesperrt -> raus
  }
  const isBlacklisted = tk => blacklist[tk] && blacklist[tk] >= todayISO;

  // Einmalige Bereinigung: "Geister-Treffer" aus dem früheren breiten Finnhub-Scan
  // entfernen — 5-stellige OTC-/Pink-Sheet-Ticker (ohne Yahoo-Daten), die via=finnhub
  // sind und kein eigenes Yahoo-Symbol haben. Gemini-Funde (DE-Werte) bleiben unberührt.
  let purged = 0;
  for (const tk of Object.keys(db)) {
    const s = db[tk];
    if (s.via === 'finnhub' && !/^[A-Z]{1,4}$/.test(tk)) { delete db[tk]; purged++; }
  }
  // Einmalig (REVALIDATE_TAG): alle Gemini-Perlen zur Neuprüfung gegen die feste Quelle
  // (MarketScreener) freigeben -> recheckAt löschen, damit die Re-Validierung sie über die
  // nächsten Läufe neu bewertet und inkonsistente Altdaten (gemischte Quellen) ersetzt/aussortiert.
  const REVALIDATE_TAG = 'multi-source-v9';   // Multi-Quellen-Konsens (stockanalysis+Yahoo+Finnhub) -> alle neu prüfen
  if (purged) console.log(`Bereinigt: ${purged} OTC-Geister-Treffer entfernt.`);

  // Kriteriums-Bereinigung: bereits aufgenommene Treffer, die das aktuelle Kauf-%-Kriterium
  // nicht mehr erfüllen, sofort entfernen (nicht erst beim nächsten Scan ihres Symbols).
  // buyPct == null (noch nicht bewertet) bleibt drin, damit nichts vorschnell fliegt.
  let belowCut = 0;
  for (const tk of Object.keys(db)) {
    const bp = db[tk].buyPct;
    if (bp != null && bp < MIN_BUY_PCT) {
      if (process.env.GEMINI_DEBUG && /OCGN|KTN|A1OS/i.test(tk)) console.log(`[DEL belowCut] ${tk} buyPct=${bp}`);
      delete db[tk]; belowCut++;
    }
  }
  if (belowCut) console.log(`Bereinigt: ${belowCut} Treffer unter ${MIN_BUY_PCT}% Kauf entfernt.`);

  // WOCHEN-LÖSCHSCHUTZ: eine in den letzten 7 Tagen bestätigte Perle ist geschützt und darf
  // von KEINER Bereinigung/keinem Reset entfernt werden. So gehen einmal echt bestätigte
  // Perlen nie durch einen Gemini-Aussetzer/Reset still verloren. Entfernt werden sie nur
  // durch einen AKTIVEN Hold-Fund in der Re-Validierung (nach Ablauf der Schutzwoche).
  const PROTECT_MS = 7 * 86400000;
  const isProtected = s => s.verifiedAt && (nowMs - Date.parse(s.verifiedAt)) < PROTECT_MS;

  // Bereinigung (am Anfang UND am Ende): entfernt nur Gemini-Perlen, deren COUNTS SELBST
  // das Kriterium verletzen (Hold/Sell>0 oder inkonsistent) ODER die gar keine Counts haben.
  const cleanInconsistent = (label) => {
    let nInc = 0, nNo = 0;
    for (const tk of Object.keys(db)) {
      const s = db[tk];
      if (!(s.via && s.via.startsWith('gemini'))) continue;
      if (isProtected(s)) continue;        // Wochen-Löschschutz: bestätigte Perle bleibt
      const c = s.ratingCounts;
      const cleanCounts = c && !('strongBuy' in c);
      if (cleanCounts) {
        const sum = (c.buy || 0) + (c.outperform || 0) + (c.hold || 0) + (c.underperform || 0) + (c.sell || 0);
        // NUR löschen, wenn die Counts SELBST das Kriterium verletzen: inkonsistent
        // (analysts != Summe) ODER irgendein Hold/Underperform/Sell > 0.
        if ((s.analysts && sum > 0 && s.analysts !== sum) || c.hold || c.underperform || c.sell) {
          if (process.env.GEMINI_DEBUG && /OCGN|KTN|A1OS/i.test(tk)) console.log(`[DEL ${label} inkons] ${tk} analysts=${s.analysts} sum=${sum} hold=${c.hold} sell=${c.sell}`);
          delete db[tk]; nInc++;
        }
      } else {
        // Gemini-Perle OHNE saubere Counts -> raus. Erfüllt sie den Ablauf wirklich,
        // kommt sie über checkCandidates + Gegenprüfung sauber zurück.
        delete db[tk]; nNo++;
      }
    }
    if (nInc || nNo) console.log(`Bereinigt (${label}): ${nInc} inkonsistent, ${nNo} unbestätigt/ohne Counts entfernt.`);
  };
  cleanInconsistent('Start');

  // Persistenter Scan-/Kandidaten-Zustand.
  const scan = prev?.scan || { universe: 0, scanned: 0, lastCursor: 0, candCursor: 0 };
  let candidates = Array.isArray(prev?.scan?.candidates) && prev.scan.candidates.length
    ? prev.scan.candidates.slice()
    : SEED_CANDIDATES.slice();

  // Einmalige Neuprüfungs-Freigabe (s. REVALIDATE_TAG): markiert alle Gemini-Perlen als
  // "noch nicht unabhängig gegengeprüft" (verifiedAt weg, recheckAt weg) -> die Re-Validierung
  // arbeitet sie der Reihe nach durch verifyNoHold ab und entfernt dabei die Falschen.
  // WICHTIG: ratingCounts NICHT pauschal löschen (sonst räumt die End-Bereinigung alle noch
  // ungeprüften sofort ab, bevor die Gegenprüfung dran war). Stattdessen Namen als Kandidaten
  // sichern, damit nichts unwiederbringlich verloren geht.
  if (scan.revalidateTag !== REVALIDATE_TAG) {
    let freed = 0;
    for (const s of Object.values(db)) if (s.via && s.via.startsWith('gemini')) {
      if (s.recheckAt) { delete s.recheckAt; }   // recheckAt weg -> Re-Validierung wird fällig
      // verifiedAt NICHT löschen: der Wochen-Löschschutz bleibt erhalten, sonst würden alle
      // bestätigten Perlen beim Tag-Wechsel ungeschützt und könnten still verschwinden.
      // altes strongBuy-Format ist kein gültiger Count -> verwerfen (wird neu ermittelt)
      if (s.ratingCounts && ('strongBuy' in s.ratingCounts)) delete s.ratingCounts;
      if (s.name && !candidates.includes(s.name)) candidates.push(s.name);   // Name sichern -> später erneut prüfbar
      freed++;
    }
    scan.revalidateTag = REVALIDATE_TAG;
    if (freed) console.log(`Re-Validierung freigegeben: ${freed} Gemini-Perlen werden neu gegengeprüft (Schutz bleibt).`);
  }

  // Takt-Trennung: Yahoo-Daten (Kurse/Performance, kein Limit) laufen JEDEN Lauf (stündlich).
  // Die limitierten Quellen Gemini + Finnhub nur, wenn seit dem letzten "schweren" Lauf
  // >= HEAVY_GAP_H Stunden vergangen sind (Default 6h). Spart das Gemini-Free-Tier-Kontingent.
  const HEAVY_GAP_MS = Number(process.env.HEAVY_GAP_H || 6) * 3600000 - 5 * 60000; // 5 min Toleranz für Cron-Jitter
  const gapPassed = !scan.heavyAt || (nowMs - Date.parse(scan.heavyAt)) >= HEAVY_GAP_MS;

  // ZWEI getrennte Takte:
  //
  //  pearlDue  -> die PERLENSUCHE (Discovery, Kandidatenpruefung, Re-Validierung)
  //               und die Markt-News. Laeuft wie frueher rund alle 12 h, auch am
  //               Wochenende. Die Perlensuche ist der eigentliche Zweck des
  //               Gemini-Kontingents und soll NICHT ausgeduennt werden.
  //
  //  heavyDue  -> der KURSABHAENGIGE Finnhub-Scan und die monatliche
  //               Inflationsprognose. Nur EINMAL PRO WERKTAG: am
  //               Wochenende bewegen sich keine Kurse, und die 30-Tage-Fenster
  //               rechnet das System selbst weiter.
  //
  // HEAVY_GAP_H=0 (manuelles force_heavy) ueberbrueckt beide Sperren.
  const nowUtc = new Date(nowMs);
  const dow = nowUtc.getUTCDay();            // 0 = So, 6 = Sa
  const isWeekday = dow >= 1 && dow <= 5;
  const heavyDayStr = nowUtc.toISOString().slice(0, 10);
  const alreadyHeavyToday = scan.heavyDay === heavyDayStr;
  const forceHeavy = Number(process.env.HEAVY_GAP_H || 6) === 0;

  const pearlDue = forceHeavy || gapPassed;
  const heavyDue =
      forceHeavy || (isWeekday && !alreadyHeavyToday && gapPassed);

  if (!pearlDue) {
    console.log(`Perlensuche: noch nicht faellig (Takt ${process.env.HEAVY_GAP_H || 6} h).`);
  }
  if (pearlDue && !heavyDue) {
    console.log(isWeekday
      ? 'Heute bereits ein Finnhub-Lauf erfolgt -> nur Perlensuche + News.'
      : 'Wochenende: kein Finnhub-Lauf -> nur Perlensuche + News.');
  }

  // Mehrere Cron-Slots pro Stunde (gegen GitHubs unzuverlässige :00-Zustellung) könnten
  // kurz hintereinander feuern. Ein NICHT-schwerer Lauf, dessen letzter Lauf < MIN_GAP_MIN
  // her ist, bricht hier ab -> Yahoo wird höchstens ~1×/Stunde geholt, keine Doppelläufe.
  const MIN_GAP_MIN = Number(process.env.MIN_GAP_MIN || 50);
  const lastRunMs = prev?.updatedAt ? Date.parse(prev.updatedAt) : 0;
  const tooSoon = lastRunMs && (nowMs - lastRunMs) < MIN_GAP_MIN * 60000;
  if (tooSoon && !pearlDue && !heavyDue && !process.env.FORCE_RUN) {
    const mins = Math.round((nowMs - lastRunMs) / 60000);
    console.log(`Übersprungen: letzter Lauf vor ${mins} min (< ${MIN_GAP_MIN} min), kein schwerer Lauf fällig.`);
    return;   // nichts schreiben -> Git-Diff leer -> kein Commit
  }

  console.log(`Lauf-Typ: Yahoo${pearlDue ? ' + Perlensuche/News' : ''}${heavyDue ? ' + Finnhub' : ''}.`);
  // heavyAt taktet die Perlensuche (12 h), heavyDay sperrt den Kurs-/News-Teil
  // auf einen Lauf pro Werktag.
  if (pearlDue) scan.heavyAt = new Date(nowMs).toISOString();
  if (heavyDue) scan.heavyDay = heavyDayStr;

  /* 1) Sektor- & Regions-Performance (30T + 360T-Schnitt + 6M) via Yahoo (kein Key) -- */
  let bars30 = prev?.bars30 || [];
  let bars30Region = prev?.bars30Region || [];
  try { bars30 = await fetchSectorPerformance(); console.log('Sektor-Performance aktualisiert.'); }
  catch (e) { console.error('Sektor-Performance fehlgeschlagen, behalte alte:', e.message); }
  try { bars30Region = await fetchRegionPerformance(); console.log('Regions-Performance aktualisiert.'); }
  catch (e) { console.error('Regions-Performance fehlgeschlagen, behalte alte:', e.message); }

  /* 1b) Markt-News ZUERST (höchste Priorität im Gemini-Budget).
     Laeuft auf dem PERLEN-Takt (~2x taeglich, auch am Wochenende): Schlagzeilen
     veralten schnell, und am Wochenende passiert weiterhin genug, das die App
     im Cockpit anzeigen soll. */
  let news = prev?.news || null;
  if (GEMINI_KEY && pearlDue && geminiBudgetLeft()) {
    useGemini();
    try { news = await buildNews(GEMINI_KEY); console.log(`News: ${news.items.length} Schlagzeilen.`); }
    catch (e) { noteGeminiError(e); console.error('News fehlgeschlagen, behalte alte:', e.message); }
  }

  /* 2a) Finnhub-Analysten-Scan (US, rollierend) ---------------------- */
  scan.seenBySector = scan.seenBySector || {};   // geprüfte Aktien je Sektor (für Trefferquote)
  scan.pendingReject = scan.pendingReject || []; // abgelehnte Ticker, deren Sektor noch via Yahoo zu klären ist
  if (FINNHUB_KEY && heavyDue) {
    try {
      const state = { scan, db };
      const r = await scanAnalystStocks(FINNHUB_KEY, state, SCAN_BUDGET);
      Object.assign(scan, r.scan);
      // abgelehnte Ticker zur Sektor-Auflösung vormerken (max. 300 in der Queue)
      for (const t of (state._rejected || [])) if (!scan.pendingReject.includes(t)) scan.pendingReject.push(t);
      if (scan.pendingReject.length > 2000) scan.pendingReject = scan.pendingReject.slice(-2000);
      // Finnhub-Funde NICHT direkt aufnehmen -> als Kandidaten vorne einreihen, damit sie
      // der Multi-Quellen-Konsens prüft (gleiches strenges Kriterium wie überall).
      let fhNew = 0;
      for (const c of (state._finnhubCandidates || [])) if (!candidates.includes(c)) { candidates.unshift(c); fhNew++; }
      if (fhNew) scan.candCursor = 0;   // neue Finnhub-Kandidaten stehen vorne -> zuerst prüfen
      console.log(`Finnhub-Scan: ${scan.scanned}/${scan.universe} geprüft, ${(state._finnhubCandidates || []).length} Treffer -> ${fhNew} neue Kandidaten, ${(state._rejected || []).length} abgelehnt.`);
    } catch (e) { console.error('Finnhub-Scan fehlgeschlagen:', e.message); }
  }

  /* 2a2) Sektor abgelehnter Aktien via Yahoo klären (kein Kontingent) -> Trefferquote.
     Yahoo hat kein Tageslimit, daher großzügiges Budget pro Lauf. */
  if (scan.pendingReject.length) {
    const batch = scan.pendingReject.splice(0, Number(process.env.SECTORRESOLVE_BUDGET || 150));
    let resolved = 0;
    for (const sym of batch) {
      const info = await fetchSectorOf(sym);
      const sid = info ? sectorForFinnhub(info.industry || info.sector) : null;
      if (sid) { scan.seenBySector[sid] = (scan.seenBySector[sid] || 0) + 1; resolved++; }
      // ohne klaren Sektor: verwerfen (nicht zurück in die Queue, sonst Endlosschleife)
    }
    if (batch.length) console.log(`Sektor-Auflösung: ${resolved}/${batch.length} abgelehnte Aktien zugeordnet.`);
  }

  /* 1c) Inflationsprognose Deutschland - EINMAL PRO MONAT.
     Billig (1 Call/Monat) und ersetzt die schlechte Schaetzung in der App, die
     das laufende Jahr aus dem Mittel der letzten drei Jahre abgeleitet hat. */
  let inflation = prev?.inflation || null;
  {
    const inflYear = new Date().getFullYear();
    if (GEMINI_KEY && heavyDue && geminiBudgetLeft() && inflationDue(prev, inflYear)) {
      useGemini();
      try {
        inflation = await fetchInflationForecast(GEMINI_KEY, inflYear);
        console.log(`Inflationsprognose ${inflYear}: ${inflation.rate}% (${inflation.sources}).`);
      } catch (e) {
        noteGeminiError(e);
        console.error('Inflationsprognose fehlgeschlagen, behalte alte:', e.message);
      }
    }
  }

  /* 2c) Gemini: neue unbekannte Werte entdecken (1 Fokus/Lauf, rotierend) -- */
  const FOCI = [
    'deutsche Small- und Mid-Caps (XETRA, SDAX, TecDAX)',
    'europäische Nebenwerte (Skandinavien, Benelux, Frankreich, Italien)',
    'US-amerikanische Small-Caps abseits der Mega-Caps',
    'asiatische Aktien (Japan, Südkorea, Taiwan, Indien)',
    'Technologie, Software und Halbleiter weltweit',
    'Gesundheit, Biotech und Medizintechnik weltweit',
    'Industrie, Energie und Rohstoffe weltweit',
    'Finanzwerte und Versorger weltweit',
  ];
  if (GEMINI_KEY && pearlDue && geminiBudgetLeft()) {
    useGemini();
    const focus = FOCI[(scan.focusCursor || 0) % FOCI.length];
    scan.focusCursor = ((scan.focusCursor || 0) + 1) % FOCI.length;
    try {
      const knownNames = Object.values(db).map(s => s.name).concat(candidates);
      const found = await discoverNew(GEMINI_KEY, knownNames, focus);
      // Discovery erzeugt NIE direkt Perlen — nur Kandidaten. Aufnahme erst über
      // checkCandidates + unabhängige Gegenprüfung (verifyNoHold). "Im Zweifel raus".
      let queued = 0;
      for (const f of found) {
        if (f.name && !candidates.includes(f.name)) { candidates.push(f.name); queued++; }
      }
      console.log(`Gemini-Discovery (${focus}): ${found.length} Vorschläge, ${queued} als Kandidat vorgemerkt (Aufnahme erst nach Gegenprüfung).`);
    } catch (e) { noteGeminiError(e); console.error('Discovery fehlgeschlagen:', e.message); }
  }

  /* Zentrale Verifizierung: Multi-Quellen-Konsens (stockanalysis + Yahoo + Finnhub).
     Eine Aktie wird nur bestätigt, wenn ALLE Quellen, die sie kennen, übereinstimmend
     0 Hold/0 Sell zeigen. Widerspricht eine seriöse Quelle -> raus. Gemini-Gegenprüfung
     nur als LETZTER Fallback, wenn KEINE harte Quelle die Aktie kennt ("im Zweifel raus"). */
  const verifyStock = async (h) => {
    const v = await verifyAcrossSources(h.ticker, h.yahoo);
    if (v.sources.length) {   // mind. eine harte Quelle kannte die Aktie -> deren Urteil zählt
      return v.ok
        ? { ok: true, counts: v.counts, analysts: v.analysts, verifiedSource: v.sources.join('+') }
        : { ok: false, reason: v.reason };
    }
    // keine harte Quelle kennt sie -> Geminis Mehrquellen-Gegenprüfung als Fallback
    if (!GEMINI_KEY || !geminiBudgetLeft()) return { ok: false, reason: 'keine-quelle' };
    useGemini();
    const conf = await verifyNoHold(GEMINI_KEY, [h]);
    return conf.has(String(h.ticker).toUpperCase())
      ? { ok: true, verifiedSource: 'gemini' } : { ok: false, reason: 'gemini-abgelehnt' };
  };

  // Firmenname auf Vergleichskern reduzieren (für Meta-Zuordnung Gemini <-> Kandidat).
  const nameKeyOf = s => String(s || '').toLowerCase()
    .replace(/\b(se|ag|nv|sa|corp|corporation|inc|incorporated|ltd|limited|plc|co|kgaa|group|holding|holdings|company|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '');

  /* Eine geprüfte, aber NICHT aufgenommene Aktie für die Trefferquote zählen.
     Zählt je Ticker genau einmal (scan.rejectedTickers), damit wiederholte
     Prüfungen desselben Titels den Nenner nicht aufblähen. */
  const noteRejected = (stock) => {
    const sector = stock && stock.sector;
    const tk = stock && stock.ticker;
    if (!sector || !tk) return;
    scan.rejectedTickers = scan.rejectedTickers || {};
    const key = String(tk).toUpperCase();
    if (scan.rejectedTickers[key]) return;
    scan.rejectedTickers[key] = sector;
    scan.seenBySector[sector] = (scan.seenBySector[sector] || 0) + 1;
  };

  /* 2b) Kandidaten prüfen (rollierend) ----------------------------------
     Gemini liefert NUR Metadaten (Ticker/Name/Sektor/Yahoo-Symbol). Die eigentliche
     Aufnahme-Entscheidung trifft IMMER der Multi-Quellen-Konsens (stockanalysis/Yahoo/
     Finnhub) — auch wenn Gemini gerade ausfällt (503). So hängt keine echte Perle an
     Geminis Verfügbarkeit. Gemini-Counts dienen nur als Fallback, falls keine harte
     Quelle die Aktie kennt. */
  if (pearlDue && candidates.length) {
    try {
      const n = candidates.length;
      const start = (scan.candCursor || 0) % n;
      const slice = [];
      for (let i = 0; i < Math.min(CAND_BUDGET, n); i++) slice.push(candidates[(start + i) % n]);
      scan.candCursor = (start + slice.length) % n;

      // Gemini-Metadaten (Sektor/Yahoo/Name) holen — optional, scheitert bei 503 still.
      let hits = [];
      if (GEMINI_KEY && geminiBudgetLeft()) {
        useGemini();
        try { hits = await checkCandidates(GEMINI_KEY, slice); }
        catch (e) { noteGeminiError(e); console.error('Gemini-Kandidatencheck fehlgeschlagen:', e.message); }
      }
      const byKey = {};
      hits.forEach(h => { byKey[nameKeyOf(h.name)] = h; if (h.ticker) byKey[h.ticker.toUpperCase()] = h; });

      // Aus jedem Kandidaten-String Name + (Ticker) ziehen.
      let kept = 0, tried = 0;
      for (const cand of slice) {
        const m = cand.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
        const name = (m ? m[1] : cand).trim();
        const ticker = (m ? m[2] : '').trim().toUpperCase();
        const meta = byKey[ticker] || byKey[nameKeyOf(name)] || {};
        const yahoo = meta.yahoo || (/\.[A-Z]+$/.test(ticker) ? ticker : null);
        const probe = { ticker: meta.ticker || ticker || name, name, yahoo, sector: meta.sector,
                        ratingCounts: meta.ratingCounts, countsBad: meta.countsBad };
        if (!probe.ticker) continue;
        tried++;
        const v = await verifyStock(probe);
        if (process.env.GEMINI_DEBUG) console.log(`  [verify] ${probe.ticker}: ${v.ok ? 'OK ('+v.verifiedSource+')' : 'raus ('+v.reason+')'}`);

        // Sektor IMMER bestimmen — auch für abgelehnte Kandidaten.
        // Bisher wurde bei !v.ok sofort abgebrochen, sodass geprüfte, aber nicht
        // 100 % Buy bewertete Titel NIRGENDS gezählt wurden. Damit fehlten sie im
        // Nenner der Trefferquote: nur Finnhubs Ablehnungen landeten dort, Geminis
        // nicht. Die Quote war dadurch systematisch zu hoch.
        let sector = meta.sector;
        const symForSector = yahoo || (/^[A-Z]{1,5}$/.test(ticker) ? ticker : null);
        if (!sector && symForSector) { const info = await fetchSectorOf(symForSector); sector = info ? sectorForFinnhub(info.industry || info.sector) : null; }

        if (!v.ok) {
          // Geprüft und durchgefallen -> als geprüfte Aktie des Sektors zählen.
          // Je Ticker nur EINMAL, damit wiederholte Prüfungen desselben Kandidaten
          // die Quote nicht verwässern.
          noteRejected({ ticker: probe.ticker, sector });
          continue;
        }
        if (!sector) continue;   // ohne Sektor nicht aufnehmen
        const counts = v.counts || meta.ratingCounts;
        const analysts = v.analysts ?? meta.analysts;
        db[probe.ticker] = {
          ...db[probe.ticker],
          ticker: probe.ticker, name, yahoo: yahoo || symForSector || null, sector,
          buyPct: 100, ratingCounts: counts, analysts,
          strongBuyPct: counts ? Math.round((counts.buy / analysts) * 100) : null,
          via: 'gemini', source: v.verifiedSource,
          verifiedAt: today(), verifiedSource: v.verifiedSource,
          seen: db[probe.ticker]?.seen || today(),
        };
        kept++;
      }
      console.log(`Kandidaten: ${slice.length} im Slice, ${tried} geprüft, ${kept} nach Multi-Quellen-Konsens aufgenommen.`);
    } catch (e) { console.error('Kandidatenprüfung fehlgeschlagen:', e.message); }
  }

  /* 2b2) Bestehende Gemini-Perlen RE-VALIDIEREN — nur 1× pro WOCHE je Perle.
     Analysten-Kaufempfehlungen ändern sich langsam; häufiger zu prüfen wäre
     verschwendetes Kontingent. Nur Perlen ohne/mit >7 Tage altem recheckAt. */
  const RECHECK_AGE = 7 * 86400000;
  if (GEMINI_KEY && pearlDue && geminiBudgetLeft()) {
    const allDue = Object.values(db)
      .filter(s => s.via && s.via.startsWith('gemini'))
      // GERADE in diesem Lauf gegengeprüfte (verifiedAt = heute) NICHT erneut prüfen —
      // sonst löscht ein zufällig leerer Zweit-Call die frisch aufgenommene Perle sofort.
      .filter(s => s.verifiedAt !== today())
      // fällig: noch nie gegengeprüft ODER letzte Prüfung > RECHECK_AGE her
      .filter(s => !s.verifiedAt || !s.recheckAt || (nowMs - Date.parse(s.recheckAt)) > RECHECK_AGE)
      // noch nie unabhängig gegengeprüfte Perlen zuerst (Bestand schnell verifizieren/aussortieren)
      .sort((a, b) => (a.verifiedAt ? 1 : 0) - (b.verifiedAt ? 1 : 0));
    const BATCH = Number(process.env.RECHECK_BUDGET || 8);        // Namen pro Gemini-Call (klein -> saubere Daten je Aktie)
    const ROUNDS = Number(process.env.RECHECK_ROUNDS || 3);       // Batches pro Lauf (Paid Tier -> schnellerer Abbau des Rückstands)
    const MAX_MISS = Number(process.env.RECHECK_MAX_MISS || 3);
    let checked = 0, dropped = 0, round = 0;
    while (round < ROUNDS && geminiBudgetLeft()) {
      const due = allDue.slice(round * BATCH, round * BATCH + BATCH);
      if (!due.length) break;
      round++;
      try {
        // Jede fällige Perle über den Multi-Quellen-Konsens prüfen.
        for (const b of due) {
          if (!db[b.ticker]) continue;
          const v = await verifyStock(b);
          if (v.ok) {
            // weiterhin auf allen Quellen 0 Hold/0 Sell -> frisch halten, ggf. Counts aktualisieren
            if (v.counts) { db[b.ticker].ratingCounts = v.counts; db[b.ticker].analysts = v.analysts; }
            db[b.ticker].recheckAt = today(); db[b.ticker].verifiedAt = today(); db[b.ticker].miss = 0;
          } else if (v.reason === 'keine-quelle') {
            // KEINE harte Quelle kennt sie + Gemini-Fallback unklar -> KEIN Hold-Beweis.
            // miss nur zählen; geschützte Perlen (in der Schutzwoche bestätigt) NIE löschen,
            // sonst gingen sie bei einem reinen Quellen-Aussetzer verloren.
            const m = (db[b.ticker].miss || 0) + 1;
            if (m >= MAX_MISS && !isProtected(db[b.ticker])) { noteRejected(db[b.ticker]); delete db[b.ticker]; dropped++; }
            else db[b.ticker].miss = m;
          } else {
            // eine seriöse Quelle fand AKTIV Hold/Sell -> ECHTES Signal, raus (auch geschützte:
            // ein belegter Hold ist ein echter Grund, anders als ein Aussetzer).
            noteRejected(db[b.ticker]);
            delete db[b.ticker]; dropped++;
          }
          checked++;
        }
      } catch (e) { noteGeminiError(e); console.error('Re-Validierung fehlgeschlagen:', e.message); break; }
    }
    if (checked) console.log(`Re-Validierung: ${checked} geprüft (${round} Batches), ${dropped} entfernt, ${Math.max(0, allDue.length - checked)} verbleibend.`);
    else console.log('Re-Validierung: keine Perle fällig.');
  }

  // Kandidatenliste begrenzen, damit sie nicht unbegrenzt wächst.
  if (candidates.length > 400) candidates = candidates.slice(candidates.length - 400);
  scan.candidates = candidates;

  // Top-Liste: nach Kursziel-Potenzial, dann Kauf-%. KEINE Obergrenze — alle
  // qualifizierten Treffer (> 50 % Kauf) werden angezeigt. Sortierung = beste zuerst.
  // gesperrte Ticker (Lösch-Button, 3-Monats-Sperre) NICHT aufnehmen — auch wenn der
  // Scan/Discovery sie zwischenzeitlich wieder gefunden hat.
  for (const tk of Object.keys(db)) if (isBlacklisted(tk)) delete db[tk];
  cleanInconsistent('Ende');   // von Discovery/Re-Validierung neu eingebrachte Fehler vor dem Speichern raus

  /* DUBLETTEN: dieselbe Aktie unter zwei Ticker-Schreibweisen.
     Die Datenbank ist nach TICKER geschluesselt. Findet der Scan dieselbe
     Aktie einmal als `JST` und einmal als `JST.DE`, stehen zwei Eintraege
     drin — mit demselben Yahoo-Symbol. In der App zaehlte die Firma damit in
     JEDER Auswertung doppelt: im Durchschnitt, in den Faktor-Toepfen, im
     Zufallstest, in der Kursziel-Quote. Gemessen am 2026-09-10 waren 8 von 61
     Perlen Dubletten (13 %); ohne sie stand der Ø Hoechststand nach drei
     Monaten bei 30,6 statt 27,5 Prozent.

     Behalten wird der Eintrag mit dem FRUEHEREN Fundtag — das ist der Moment,
     in dem die Aktie wirklich zuerst gefunden wurde; der spaetere ist nur eine
     zweite Schreibweise derselben Sache. Gleicher Tag → der mit dem
     ausfuehrlicheren Ticker (`JST.DE` statt `JST`), weil der die Boerse nennt. */
  {
    // ZWEI Stufen, weil es zwei Arten von Dubletten gibt:
    //   1. dasselbe Wertpapier unter zwei Ticker-Schreibweisen
    //      (`JST` und `JST.DE`, beide mit Yahoo-Symbol JST.DE)
    //   2. dieselbe Firma an ZWEI Boersenplaetzen, also mit verschiedenen
    //      Yahoo-Symbolen (Hamborner Reit: HABA.DE und HABAN.DE)
    // Stufe 2 verlangt zusaetzlich denselben Sektor — sonst koennten zwei
    // wirklich verschiedene Firmen zusammenfallen, deren Namen sich nur nach
    // dem Streichen der Rechtsform gleichen.
    const normName = (n) => String(n || '').toLowerCase()
      .replace(/[.,()&-]/g, ' ')
      .replace(/\b(aktiengesellschaft|ag|se|sa|spa|plc|nv|oyj|ab|asa|inc|corp|corporation|co|ltd|limited|holdings?|group|company|kgaa|gmbh)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
    // Der frueher gefundene Eintrag gewinnt — das ist der Moment, in dem die
    // Aktie wirklich zuerst da war. Gleicher Tag → der ausfuehrlichere Ticker
    // (`JST.DE` statt `JST`), weil der die Boerse nennt.
    const besser = (a, b) => {
      const af = String(a.seen || '9999'), bf = String(b.seen || '9999');
      if (af !== bf) return af < bf ? a : b;
      return String(a.ticker || '').length >= String(b.ticker || '').length ? a : b;
    };
    const falten = (liste, schluessel) => {
      const beste = new Map();
      for (const s of liste) {
        const k = schluessel(s);
        if (!k) continue;
        const alt = beste.get(k);
        beste.set(k, alt ? besser(s, alt) : s);
      }
      return [...beste.values()];
    };
    const vorher = Object.keys(db).length;
    let liste = Object.values(db);
    liste = falten(liste, (s) => {
      const y = String(s.yahoo || '').trim().toUpperCase();
      return y ? 'Y:' + y : 'T:' + String(s.ticker || '').toUpperCase();
    });
    liste = falten(liste, (s) => {
      const n = normName(s.name);
      return n ? 'N:' + n + '|' + String(s.sector || '') : 'T:' + s.ticker;
    });
    const behalten = new Set(liste.map((s) => s.ticker));
    for (const tk of Object.keys(db)) if (!behalten.has(tk)) delete db[tk];
    const weg = vorher - Object.keys(db).length;
    if (weg) console.log(`Dubletten entfernt: ${weg} (${Object.keys(db).length} bleiben).`);
  }
  let topStocks = Object.values(db)
    .sort((a, b) => (b.upside ?? -999) - (a.upside ?? -999) || (b.buyPct || 0) - (a.buyPct || 0));

  /* 3) 6-Monats-Kursperformance je Aktie (Yahoo), rollierend nachladen --- */
  // Pro Lauf nur für Aktien ohne/alten 6M-Wert, damit es schnell bleibt.
  const needPerf = topStocks.filter(s => s.perf6m == null || !s.perf6mAt || (nowMs - Date.parse(s.perf6mAt)) > STALE)
    .slice(0, Number(process.env.PERF6M_BUDGET || 40));
  for (const s of needPerf) {
    const v = await fetchStockPerf6m(s.yahoo || s.ticker);   // Yahoo-Symbol bevorzugen (z. B. KTN.DE)
    if (v != null) { s.perf6m = v; s.perf6mAt = today(); db[s.ticker] = { ...db[s.ticker], perf6m: v, perf6mAt: s.perf6mAt }; }
  }
  if (needPerf.length) console.log(`6M-Performance für ${needPerf.length} Aktien aktualisiert.`);

  /* 3a2) 1-Monats-Performance VOR Aufnahme (Momentum) je Perle, EINMALIG aus Yahoo.
     = Kursentwicklung im Monat vor dem seen-Datum. Fix gespeichert (ändert sich nicht). */
  const dayMs = d => new Date((d || today()) + 'T00:00:00Z').getTime();
  const needPre = topStocks.filter(s => s.perf1mBefore === undefined)
    .slice(0, Number(process.env.PRE1M_BUDGET || 40));
  for (const s of needPre) {
    const seenMs = dayMs(s.seen);
    const v = await perfBetween(s.yahoo || s.ticker, seenMs - 30 * 86400000, seenMs);
    s.perf1mBefore = (v == null ? null : v);   // null = nicht ermittelbar (verhindert erneutes Versuchen)
    db[s.ticker] = { ...db[s.ticker], perf1mBefore: s.perf1mBefore };
  }
  if (needPre.length) console.log(`1M-vor-Aufnahme für ${needPre.length} Perlen gesetzt.`);


  /* 3b) Kursziel + KGV + EPS + Analysten je Aktie über Yahoo (1 Call, kein Key,
     funktioniert auch für deutsche Werte). Ersetzt die alte Finnhub-Anreicherung. */
  {
    // Anreichern wenn: noch nie, veraltet (>STALE), ODER ein neues Feld fehlt noch ganz
    // (z. B. div nach Feature-Einführung) -> zieht neue Datenfelder einmalig nach.
    const needEnrich = topStocks.filter(s =>
      s.enrichAt == null || (nowMs - Date.parse(s.enrichAt)) > STALE || s.div === undefined)
      .slice(0, Number(process.env.ENRICH_BUDGET || 40));
    // Kandidaten-Yahoo-Symbole (Name -> Symbol) aus früheren Gemini-Funden, zum Nachschlagen
    let upCount = 0, peCount = 0;
    for (const s of needEnrich) {
      // Symbol bestimmen: explizites yahoo-Feld, sonst Ticker; bei Fehlschlag .DE-Fallback
      let e = await enrichStock(s.yahoo || s.ticker);
      if (!e && !s.yahoo && /^[A-Z0-9]{1,5}$/.test(s.ticker)) {
        // deutsche/europäische Nebenwerte hängen an .DE (z. B. KTN -> KTN.DE)
        e = await enrichStock(s.ticker + '.DE');
        if (e) { s.yahoo = s.ticker + '.DE'; }
      }
      if (!e) {
        // auch bei Fehlschlag markieren (sonst jeder Lauf erneut). div explizit auf null,
        // damit "s.div === undefined" nicht endlos sofortige Re-Enrichments triggert.
        s.enrichAt = today(); if (s.div === undefined) s.div = null;
        db[s.ticker] = { ...db[s.ticker], enrichAt: s.enrichAt, div: s.div ?? null };
        continue;
      }
      if (e.upside != null) { s.upside = e.upside; upCount++; }
      // KGV: Yahoo-Wert; bei Verlust (EPS < 0) bewusst kein KGV
      s.pe = (e.eps != null && e.eps < 0) ? null : e.pe;
      if (e.eps != null) s.eps = e.eps;
      // Analystenzahl: bei sauberen MS-Counts ist deren Summe maßgeblich (100%-Kriterium).
      // Yahoos Zahl zählt ALLE Analysten (auch Hold/Sell) -> würde analysts!==sum machen
      // und die Konsistenzprüfung brechen. Nur als Fallback ohne MS-Counts übernehmen.
      const hasMsCounts = s.ratingCounts && !('strongBuy' in s.ratingCounts);
      if (e.analysts != null && !hasMsCounts) s.analysts = e.analysts;
      s.div = e.divYield;   // Dividendenrendite in % (null = keine Dividende)
      // Breiter Faktor-Satz aus demselben Yahoo-Call — wandert ueber
      // history.mjs::factorsFrom EINMALIG in den Aufnahme-Snapshot.
      if (e.factors) s.factors = e.factors;
      s.enrichAt = today();
      if (s.pe != null) peCount++;
      db[s.ticker] = { ...db[s.ticker], upside: s.upside, pe: s.pe, eps: s.eps, analysts: s.analysts, div: s.div, yahoo: s.yahoo, enrichAt: s.enrichAt, factors: s.factors ?? db[s.ticker]?.factors ?? null };
    }
    if (needEnrich.length) console.log(`Yahoo-Anreicherung: ${needEnrich.length} Aktien, ${upCount} mit Kursziel, ${peCount} mit KGV.`);
  }

  /* 4) Lage-Texte: NUR 1× pro Tag je 1 Sektor + 1 Region (rollierend) -- */
  let sectorNotes = prev?.sectorNotes || {};
  let regionNotes = prev?.regionNotes || {};
  // Start-Texte einsetzen, wo noch keiner steht -> sofort überall etwas da,
  // Gemini überarbeitet sie dann rollierend. seed=true markiert Platzhalter.
  for (const id of Object.keys(SEED_SECTOR_NOTES)) {
    if (!sectorNotes[id]) sectorNotes[id] = { text: SEED_SECTOR_NOTES[id], date: null, seed: true };
  }
  for (const id of Object.keys(SEED_REGION_NOTES)) {
    if (!regionNotes[id]) regionNotes[id] = { text: SEED_REGION_NOTES[id], date: null, seed: true };
  }
  const todayStr = today();
  // Sektor-/Regions-Lagetexte werden NICHT mehr von Gemini erzeugt.
  // Die Performance-Zahlen selbst kommen ohnehin aus Yahoo (ETF-Kurse in
  // prices.mjs), Gemini hat hier nur beschreibenden Text geliefert. Die
  // gepflegten SEED-Texte oben bleiben als Beschreibung stehen; Geminis
  // Kontingent gehört jetzt vollstaendig der Perlensuche.
  void todayStr;

  /* 6) Backtest-Historie pflegen (Snapshots + Monats-Performance; Yahoo, kein Kontingent) */
  try {
    const hist = loadHistory();
    const snapped = await snapshotStocks(hist, topStocks, Number(process.env.SNAPSHOT_BUDGET || 30));
    // NUR echte Monatswerte: für jeden vergangenen Monat seit Aufnahme die Performance messen.
    // KEIN provisorischer 1M-Wert mehr (seedBacktest1m) — echte Daten reifen über die Monate.
    const measured = await measureMilestones(hist, Number(process.env.MILESTONE_BUDGET || 40));
    // Hoechststaende + Kursziel-Treffer gegen JEDEN Tagesabschluss. Reihum die
    // am laengsten nicht gemessenen Eintraege, damit ein Lauf nicht 400
    // Yahoo-Abrufe braucht. Ein spaet entdeckter Treffer wird trotzdem auf
    // seinen echten Tag datiert — die Reihenfolge kostet nur Aktualitaet.
    const highs = await measureHighs(hist, Number(process.env.HIGH_BUDGET || 60));
    const pruned = pruneHistory(hist);
    console.log(`Historie: ${Object.keys(hist.entries).length} Aktien (${snapped} neu, ${measured} Monatspunkte, ${highs} Hoechststaende, ${pruned} entfernt).`);

    // KI-Analyse der stärksten Faktoren — 1× pro Tag (Budget-schonend)
    const findings = computeFindings(hist);
    hist.findings = findings;
    // Keine Gemini-KI-Analyse mehr im Analysen-Bereich: die Faktor-Auswertung
    // (computeFindings) ist reine Mathematik ueber die eigene Historie und
    // laeuft weiter. Ein evtl. alter kiAnalysis-Text wird entfernt, damit die
    // App keinen veralteten KI-Text mehr anzeigt.
    delete hist.kiAnalysis;
    delete hist.kiDay;
    saveHistory(hist);
  } catch (e) { console.error('Historie fehlgeschlagen:', e.message); }

  /* Trefferquoten-Basis je Sektor: geprüfte Aktien = abgelehnte (Scan) + Perlen (akzeptiert).
     Die Perlen sind selbst geprüfte Treffer und gehören in den Nenner. So hat JEDER Sektor
     mit mindestens einer Perle immer eine berechenbare Quote (nie „unbekannt"). */
  scan.seenBySector = scan.seenBySector || {};
  const evaluatedBySector = { ...scan.seenBySector };
  for (const s of topStocks) {
    if (!s.sector) continue;
    evaluatedBySector[s.sector] = (evaluatedBySector[s.sector] || 0) + 1;   // Perle = geprüfter Treffer
  }
  scan.evaluatedBySector = evaluatedBySector;

  /* Sektor-PSI je Aktie. PSI = hitRate / relPos:
     - hitRate = Perlen / geprüfte Aktien des Sektors (Trefferquote des Sektors)
     - relPos  = relative 30T-Performance-Position des SEKTORS (0.05..1); niedrig = Aufholpotenzial
     s.sektorPsi      = aktueller Sektor-PSI (Live).
     s.sektorPsiAtAdd = der Sektor-PSI zum AUFNAHME-Zeitpunkt der Perle, EINMALIG eingefroren
                        (wie perf1mBefore) -> Datenbasis für die Faktor-Analyse. */
  let out_psiHistory = Array.isArray(prev?.psiHistory) ? prev.psiHistory : [];
  {
    const perfMap = {};
    (bars30 || []).forEach(b => { perfMap[b.id] = b.perf; });
    const secPerfs = Object.values(perfMap).filter(v => v != null);
    const sMin = secPerfs.length ? Math.min(...secPerfs) : 0;
    const sMax = secPerfs.length ? Math.max(...secPerfs) : 1;
    const sSpan = (sMax - sMin) || 1;
    const hitOf = sec => {
      const n = topStocks.filter(s => s.sector === sec).length;
      const seen = evaluatedBySector[sec] || n;
      return seen > 0 ? Math.min(1, n / Math.max(n, seen)) : 0;
    };
    for (const s of topStocks) {
      if (!s.sector) { s.sektorPsi = null; continue; }
      const hit = hitOf(s.sector);
      const secPerf = perfMap[s.sector];
      const relSec = secPerf != null ? Math.max(0.05, (secPerf - sMin) / sSpan) : 1;
      s.sektorPsi = +(hit / relSec).toFixed(4);
      s.sektorHit = +(hit * 100).toFixed(4);
      // beim ersten Mal (Aufnahme) den Sektor-PSI einfrieren
      if (s.sektorPsiAtAdd === undefined) s.sektorPsiAtAdd = s.sektorPsi;
      // ... und daneben die reine Trefferquote des Sektors. Ψ mischt sie mit
      // der relativen 30T-Position; als eigener Faktor ist sie einzeln
      // auswertbar. Nachtraeglich laesst sie sich nur ueber die Git-Historie
      // von sectordata.json zurueckrechnen — also lieber gleich mitschreiben.
      if (s.sektorHitAtAdd === undefined) s.sektorHitAtAdd = s.sektorHit;
      delete s.aktienPsi; delete s.perf30;     // Aktien-PSI/30T-Aktienperf entfernt
      db[s.ticker] = { ...db[s.ticker], sektorPsi: s.sektorPsi, sektorPsiAtAdd: s.sektorPsiAtAdd, sektorHit: s.sektorHit, sektorHitAtAdd: s.sektorHitAtAdd };
      delete db[s.ticker].aktienPsi; delete db[s.ticker].perf30;
    }

    /* PSI-Historie: sammelt den eingefrorenen Sektor-PSI (sektorPsiAtAdd) ECHTER Perlen
       -> Verteilungsdiagramm. Genau EIN Eintrag je Perle (ihr Aufnahme-Wert, ändert sich nicht). */
    const histMap = new Map(out_psiHistory.map(e => [e.t, e]));   // key: ticker (1× je Perle)
    for (const s of topStocks) {
      if (s.sektorPsiAtAdd == null || !s.verifiedAt) continue;
      histMap.set(s.ticker, { t: s.ticker, d: s.seen || today(), v: s.sektorPsiAtAdd });
    }
    let psiHistory = [...histMap.values()].sort((a, b) => (a.v - b.v));
    if (psiHistory.length > 5000) psiHistory = psiHistory.slice(-5000);
    out_psiHistory = psiHistory;
  }

  const out = {
    updated: today(),
    updatedAt: new Date().toISOString(),
    source: [FINNHUB_KEY && 'Finnhub', GEMINI_KEY && 'Gemini (Websuche & Analyse)'].filter(Boolean).join(' · '),
    sectors: SECTORS,
    regions: REGIONS,
    bars30,
    bars30Region,
    topStocks,
    psiHistory: out_psiHistory,
    sectorNotes,
    regionNotes,
    news,
    inflation,
    scan,
    blacklist,
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`sectordata.json geschrieben (${out.updated}). Treffer gesamt: ${topStocks.length}.`);
})().catch(err => { console.error('Update abgebrochen:', err.message); process.exit(1); });
