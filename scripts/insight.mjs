// Gemini-Texte: knappe Lage-Notizen je Sektor/Region (rollierend) + Markt-News-Ticker.
import { SECTORS, REGIONS } from './sectors.mjs';

const MODEL0 = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
// Google schaltet alte Modelle ab (dann 404). Einmal je Lauf auf den
// laufend gepflegten Namen wechseln statt still keine Texte mehr zu liefern
// (seit 2026-10-31). Fest waehlbar ueber die Umgebung GEMINI_MODEL.
const MODEL_FALLBACK = 'gemini-flash-lite-latest';
let MODEL = MODEL0;
const modelUrl = (key) => `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
const modelGone = (res) => (res.status === 404 && MODEL !== MODEL_FALLBACK)
  ? (console.log(`Gemini-Modell ${MODEL} nicht mehr da — weiter mit ${MODEL_FALLBACK}.`), MODEL = MODEL_FALLBACK, true)
  : false;
const nameOf = id => (SECTORS.find(s => s.id === id) || REGIONS.find(s => s.id === id) || {}).name || id;

async function gen(key, prompt, useSearch = false) {
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.6, maxOutputTokens: 6144, thinkingConfig: { thinkingBudget: 0 } },
  };
  if (useSearch) payload.tools = [{ google_search: {} }];
  const body = JSON.stringify(payload);
  let lastErr = '';
  for (let attempt = 0; attempt < 5; attempt++) {   // flash-lite liefert sporadisch leer; 429 = RPM-Limit -> Backoff
    const res = await fetch(modelUrl(key), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (modelGone(res)) continue;
    if (res.status === 429) {                        // Minutenlimit -> warten & erneut (statt aufgeben)
      lastErr = 'HTTP 429';
      await new Promise(r => setTimeout(r, 20000 * (attempt + 1)));   // 20s, 40s, 60s, 80s
      continue;
    }
    if (!res.ok) { lastErr = 'HTTP ' + res.status; continue; }
    const j = await res.json();
    const cand = j?.candidates?.[0];
    const text = cand?.content?.parts?.map(p => p.text).filter(Boolean).join('').trim();
    if (text) return text;
    lastErr = 'leer' + (cand?.finishReason ? ' (' + cand.finishReason + ')' : '');
    await new Promise(r => setTimeout(r, 600));     // kurz warten vor erneutem Versuch
  }
  throw new Error(lastErr);
}

// Knappe Lage-Notizen für Sektoren ODER Regionen. items = [{id, perf, avg30, perf6m}, ...]
// Liefert { id: { text, date } }. Text ist SEHR kurz (1-2 Sätze).
export async function buildNotes(key, ids, bars, topStocks, kind = 'Sektor') {
  const out = {};
  const today = new Date().toISOString().slice(0, 10);
  for (const id of ids) {
    const bar = (bars || []).find(b => b.id === id);
    const perf = bar ? `${bar.perf > 0 ? '+' : ''}${bar.perf}%` : 'k. A.';
    const perf6m = bar && bar.perf6m != null ? `${bar.perf6m > 0 ? '+' : ''}${bar.perf6m}%` : 'k. A.';
    const avg = bar && bar.avg30 != null ? `${bar.avg30 > 0 ? '+' : ''}${bar.avg30}%` : 'k. A.';
    const perlen = kind === 'Sektor'
      ? (topStocks || []).filter(s => s.sector === id).slice(0, 3).map(s => s.ticker).join(', ')
      : '';

    const prompt = `${kind === 'Region' ? 'Weltregion' : 'Aktienmarkt-Sektor'} "${nameOf(id)}".
Zahlen: 30-Tage ${perf} (Normalniveau ${avg}), 6 Monate ${perf6m}${perlen ? `, auffällige Werte: ${perlen}` : ''}.

Schreibe MAXIMAL 2 sehr knappe deutsche Sätze (zusammen höchstens 30 Wörter), die SOFORT klar machen, was gerade abgeht und warum. Konkret (Zinsen, KI, Energie, Konjunktur, Geopolitik …), kein Geschwafel, keine Floskeln, keine Anlageberatung. Nur den Text.`;
    try {
      out[id] = { text: await gen(key, prompt), date: today };
    } catch (e) {
      console.error(`  ${kind}-Text ${id} fehlgeschlagen:`, e.message);
    }
  }
  return out;
}

// Schlagzeilen-Geschmack des Besitzers (in der App im Cockpit markiert, seit
// 2026-10-27). Kommt vom App-Worker; fehlt er, sucht Gemini wie bisher. Kostet
// keinen zusätzlichen Gemini-Aufruf, nur ~300 Eingabe-Tokens im selben Prompt.
const TASTE_URL = process.env.NEWS_TASTE_URL ||
  'https://portfolio-cors-proxy.daniel-gerner06.workers.dev/news-taste';

async function fetchTaste() {
  try {
    const r = await fetch(TASTE_URL, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    const clean = a => (Array.isArray(a) ? a : [])
      .filter(x => typeof x === 'string' && x.trim())
      .map(x => x.trim().slice(0, 140)).slice(0, 15);
    const liked = clean(j.liked), skipped = clean(j.skipped);
    return liked.length ? { liked, skipped } : null;
  } catch { return null; }
}

export function tasteBlock(taste) {
  if (!taste || !taste.liked.length) return '';
  const list = a => a.map(h => `- ${h}`).join('\n');
  return `

GESCHMACK DES LESERS (nur zur AUSWAHL, KEINE Quelle): Diese ALTEN Schlagzeilen fand er wirklich relevant:
${list(taste.liked)}${taste.skipped.length ? `
Diese ALTEN fand er weniger relevant:
${list(taste.skipped)}` : ''}
Suche trotzdem über Google nach HEUTIGEN Meldungen und bevorzuge unter ihnen solche mit ähnlichen Themen und ähnlicher Tragweite. Übernimm KEINE dieser alten Schlagzeilen, erfinde nichts, und gib nur Meldungen mit echtem, aktuellem Datum zurück.`;
}

// Markt-News-Ticker: die wichtigsten (max 3) marktbewegenden News, sehr knapp.
// Liefert { items: ["...", "..."], date } per Google-Search-Grounding.
export async function buildNews(key) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const COUNT = Number(process.env.NEWS_COUNT || 6);
  const MAX_AGE_H = Number(process.env.NEWS_MAX_AGE_H || 72);   // älter -> verworfen (außer es bleibt zu wenig)
  const prompt = `Heutiges Datum: ${today}. Suche über Google die ALLERNEUESTEN marktbewegenden Finanznachrichten — möglichst von HEUTE oder gestern (max. die letzten ${Math.round(MAX_AGE_H)} Stunden). Politik, Wirtschaft, Geopolitik, Notenbanken, große Unternehmen.

WICHTIG: Nimm NUR wirklich aktuelle Meldungen. Lass veraltete/alte Nachrichten weg, auch wenn dadurch weniger als ${COUNT} übrig bleiben — lieber 3 topaktuelle als 6 mit alten dabei. Erfinde keine Zeitstempel; nutze das echte Veröffentlichungsdatum aus der Quelle.

Gib bis zu ${COUNT} als JSON-Array zurück, wichtigste zuerst. Jedes Element:
{ "h": "kurze deutsche Schlagzeile (max 9 Wörter, konkret)", "t": "Veröffentlichungsdatum als ISO 8601, z.B. ${today}" }
Beim Datum das echte Veröffentlichungsdatum aus der Quelle verwenden.
Nur das JSON-Array, kein weiterer Text.`;
  // Erst mit Geschmack; liefert Gemini damit nichts Aktuelles (am 28.10.2026
  // kamen erfundene Meldungen vom 23.07.2024), noch einmal ohne.
  const taste = tasteBlock(await fetchTaste());
  let items = parseNews(await gen(key, prompt + taste, true), now, MAX_AGE_H);
  if (!items.length && taste) {
    console.log('News: mit Geschmack nichts Aktuelles, zweiter Versuch ohne.');
    items = parseNews(await gen(key, prompt, true), now, MAX_AGE_H);
  }
  items = items.slice(0, COUNT).map(({ text, stamp }) => ({ text, stamp }));
  // NIE veraltete Meldungen zeigen — dann bleiben die vorigen stehen.
  if (!items.length) throw new Error('keine aktuellen News');
  return { items, date: today };
}

// Antwort → [{ text, stamp, ms }]: nur Meldungen mit echtem Datum in den
// letzten maxAgeH Stunden, neueste zuerst. Kein Rückfall auf Altes.
function parseNews(text, now, maxAgeH) {
  let raw = [];
  try {
    const t = text.replace(/```json/gi, '').replace(/```/g, '');
    const a = t.indexOf('['), b = t.lastIndexOf(']');
    if (a >= 0 && b > a) raw = JSON.parse(t.slice(a, b + 1));
  } catch { /* ignore */ }

  // -> [{ text, stamp, ms }] mit nur dem DATUM (TT.MM.JJ), keine Uhrzeit.
  const fmt = val => {
    const iso = val == null ? '' : String(val).trim();
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return { stamp: '', ms: null };
    const p = n => String(n).padStart(2, '0');
    const stamp = `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${String(d.getUTCFullYear()).slice(2)}`;
    return { stamp, ms: d.getTime() };
  };
  let items = (Array.isArray(raw) ? raw : []).map(o => {
    if (typeof o === 'string') return { text: o.trim(), stamp: '', ms: null };
    const f = fmt(o.t || o.time || o.date);
    // Schlusspunkt weg: eine Schlagzeile endet ohne, und auf dem iPhone
    // landete der Punkt allein in der nächsten Zeile.
    const h = String(o.h || o.headline || o.text || '').trim().replace(/[.。]+$/, '');
    return { text: h, stamp: f.stamp, ms: f.ms };
  }).filter(x => x.text);

  // Veraltete und undatierte verwerfen — auch wenn dann nichts bleibt.
  const cutoff = now.getTime() - maxAgeH * 3600000;
  const fresh = items.filter(x => x.ms != null && x.ms >= cutoff && x.ms <= now.getTime() + 36 * 3600000);
  fresh.sort((a, b) => b.ms - a.ms);
  return fresh;
}

// Knappe KI-Analyse der stärksten Faktoren/Kombination. `findings` ist ein bereits
// serverseitig berechnetes Objekt mit den besten Stufen je Faktor + bester Kombi.
export async function buildFactorInsight(key, findings) {
  const today = new Date().toISOString().slice(0, 10);
  // Reifegrad der Daten beschreiben, damit die KI ihre Aussage entsprechend einordnet
  // und nicht mehr behauptet als die kurze (evtl. provisorische) Historie hergibt.
  const m = findings.maxMonths || 0;
  const stage = findings.provisional
    ? `Datenbasis vorläufig: nur ein rückgerechneter 1-Monats-Wert je Perle (echte Kurse). Längere Zeiträume folgen monatlich.`
    : `Datenbasis: Performance über bis zu ${m} Monat${m === 1 ? '' : 'e'} seit Aufnahme, ${findings.sampleSize} Perlen.`;
  const prompt = `Du bist Aktien-Analyst. Backtest der Analysten-Perlen (Performance seit Aufnahme). ${stage}
Befunde: ${JSON.stringify({ factors: findings.factors, combo: findings.combo })}

Schreibe MAXIMAL 2 sehr knappe deutsche Sätze (zusammen ≤ 40 Wörter): welche Faktor-Ausprägung bzw. -Kombination bisher am besten lief (mit Zahlen) und welcher Faktor kaum Einfluss hatte. ${findings.provisional ? 'Mache klar, dass dies ein vorläufiger 1-Monats-Befund ist.' : ''} Kein Geschwafel, keine Anlageberatung. Nur den Text.`;
  const text = await gen(key, prompt);
  return { text, date: today, stage: findings.provisional ? 'prov' : 'real', months: m };
}
