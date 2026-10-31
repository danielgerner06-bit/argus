// Inflationsprognose fuer Deutschland, EINMAL PRO MONAT via Gemini + Google-Suche.
//
// Warum ueberhaupt: die World Bank veroeffentlicht nur ABGESCHLOSSENE Jahre. Das
// laufende Jahr fehlt dort komplett, und ein Schaetzwert aus dem Mittel der
// letzten Jahre liegt regelmaessig daneben (3,4 % statt real ~2 %). Deshalb holt
// dieses Modul einmal im Monat die aktuelle Prognose der grossen Institute und
// legt sie in sectordata.json ab; die App liest sie von dort.
//
// Sobald das Jahr vorbei ist, wird automatisch fuer das NAECHSTE Jahr gesucht --
// der abgeschlossene Wert kommt dann wieder aus der bestehenden World-Bank-Quelle.

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

async function gen(key, prompt) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
    tools: [{ google_search: {} }],
  });
  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(modelUrl(key), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (modelGone(res)) continue;
    if (res.status === 429) {
      lastErr = 'HTTP 429';
      await new Promise(r => setTimeout(r, 20000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) { lastErr = 'HTTP ' + res.status; continue; }
    const j = await res.json();
    const text = j?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('').trim();
    if (text) return text;
    lastErr = 'leer';
    await new Promise(r => setTimeout(r, 600));
  }
  throw new Error(lastErr);
}

/** true, wenn fuer [year] in diesem Kalendermonat noch keine Prognose geholt wurde. */
export function inflationDue(prev, year) {
  const month = new Date().toISOString().slice(0, 7);   // YYYY-MM
  const cur = prev?.inflation;
  if (!cur) return true;
  if (cur.year !== year) return true;        // Jahreswechsel -> neues Jahr suchen
  return cur.month !== month;                // schon in diesem Monat geholt?
}

/**
 * Holt die Prognose fuer die deutsche Jahresinflation (VPI, Jahresdurchschnitt).
 * Rueckgabe: { year, rate, month, sources, fetchedAt } oder null bei Misserfolg.
 */
export async function fetchInflationForecast(key, year) {
  const prompt = [
    `Wie hoch ist die aktuelle PROGNOSE fuer die Inflationsrate in Deutschland`,
    `im Gesamtjahr ${year} (Verbraucherpreisindex, Jahresdurchschnitt, in Prozent)?`,
    ``,
    `Nutze die Google-Suche und stuetze dich auf die aktuellen Prognosen von`,
    `Bundesbank, ifo-Institut, IWF, EU-Kommission oder Statistischem Bundesamt.`,
    `Wenn das Jahr bereits weitgehend vorbei ist, nimm den bisher gemessenen`,
    `Jahresdurchschnitt als beste Schaetzung.`,
    ``,
    `Antworte NUR mit einer Zeile in exakt diesem Format, ohne weiteren Text:`,
    `RATE=<zahl mit punkt als dezimaltrennzeichen>|QUELLEN=<institut1, institut2>`,
    `Beispiel: RATE=2.1|QUELLEN=Bundesbank, ifo`,
  ].join('\n');

  const raw = await gen(key, prompt);
  const m = /RATE\s*=\s*([0-9]+(?:[.,][0-9]+)?)/i.exec(raw);
  if (!m) throw new Error('keine Rate erkannt: ' + raw.slice(0, 160));
  const rate = parseFloat(m[1].replace(',', '.'));
  // Plausibilitaet: Deutschland lag seit 1950 nie ausserhalb dieses Bandes.
  if (!isFinite(rate) || rate < -3 || rate > 15) {
    throw new Error('unplausible Rate: ' + rate);
  }
  const qs = /QUELLEN\s*=\s*(.+)$/im.exec(raw);
  return {
    year,
    rate: Math.round(rate * 100) / 100,
    month: new Date().toISOString().slice(0, 7),
    sources: qs ? qs[1].trim().slice(0, 120) : '',
    fetchedAt: new Date().toISOString(),
  };
}
