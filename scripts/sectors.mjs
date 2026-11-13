// Zentrale Sektordefinition (Farben/Reihenfolge stabil halten) + Mapping
// von Finnhub-Branchenbezeichnungen ("finnhubIndustry") auf unsere IDs.

export const SECTORS = [
  { id: 'software',   name: 'Software & Cloud',       color: '#6366f1', etf: 'IGV'  },
  { id: 'ai_semi',    name: 'KI & Halbleiter',        color: '#a855f7', etf: 'SOXX' },
  { id: 'hardware',   name: 'Hardware & Geräte',      color: '#8b5cf6', etf: 'XLK'  },
  { id: 'comm',       name: 'Kommunikation & Medien', color: '#ec4899', etf: 'XLC'  },
  { id: 'health',     name: 'Gesundheit & Pharma',    color: '#22c55e', etf: 'XLV'  },
  { id: 'finance',    name: 'Finanzen & Banken',      color: '#0ea5e9', etf: 'XLF'  },
  { id: 'cons_cycl',  name: 'Konsum zyklisch',        color: '#f59e0b', etf: 'XLY'  },
  { id: 'cons_def',   name: 'Konsum defensiv',        color: '#84cc16', etf: 'XLP'  },
  { id: 'industrial', name: 'Industrie',              color: '#64748b', etf: 'XLI'  },
  { id: 'energy',     name: 'Energie',                color: '#ef4444', etf: 'XLE'  },
  { id: 'materials',  name: 'Rohstoffe',              color: '#d97706', etf: 'XLB'  },
  { id: 'utilities',  name: 'Versorger',              color: '#14b8a6', etf: 'XLU'  },
  { id: 'realestate', name: 'Immobilien',             color: '#a16207', etf: 'XLRE' },
];

export const SECTOR_IDS = SECTORS.map(s => s.id);

// Weltregionen über breite Regions-ETFs (Yahoo-Symbole) — gleiche Logik wie Sektoren.
export const REGIONS = [
  { id: 'usa',      name: 'USA',                 color: '#6366f1', etf: 'SPY'  },
  { id: 'europe',   name: 'Europa',              color: '#0ea5e9', etf: 'VGK'  },
  { id: 'germany',  name: 'Deutschland',         color: '#f59e0b', etf: 'EWG'  },
  { id: 'japan',    name: 'Japan',               color: '#ec4899', etf: 'EWJ'  },
  { id: 'china',    name: 'China',               color: '#ef4444', etf: 'MCHI' },
  { id: 'em',       name: 'Schwellenländer',     color: '#22c55e', etf: 'EEM'  },
  { id: 'apac',     name: 'Asien-Pazifik',       color: '#14b8a6', etf: 'VPL'  },
  { id: 'india',    name: 'Indien',              color: '#a855f7', etf: 'INDA' },
  { id: 'latam',    name: 'Lateinamerika',       color: '#d97706', etf: 'ILF'  },
  { id: 'world',    name: 'Welt gesamt',         color: '#94a3b8', etf: 'URTH' },
];

// Finnhub-Industrie -> unsere Sektor-ID. Bewusst fein, damit Software, KI/Halbleiter
// und Hardware getrennt bleiben.
const INDUSTRY_MAP = {
  'Semiconductors': 'ai_semi',
  'Technology': 'hardware',
  'Hardware': 'hardware',
  'Electronic Equipment': 'hardware',
  'Software': 'software',
  'Internet Software/Services': 'software',
  'Communications': 'comm',
  'Media': 'comm',
  'Telecommunication': 'comm',
  'Health Care': 'health',
  'Pharmaceuticals': 'health',
  'Biotechnology': 'health',
  'Life Sciences Tools & Services': 'health',
  'Banking': 'finance',
  'Financial Services': 'finance',
  'Insurance': 'finance',
  'Diversified Financial Services': 'finance',
  'Retail': 'cons_cycl',
  'Consumer products': 'cons_cycl',
  'Automobiles': 'cons_cycl',
  'Hotels, Restaurants & Leisure': 'cons_cycl',
  'Textiles, Apparel & Luxury Goods': 'cons_cycl',
  'Food, Beverage & Tobacco': 'cons_def',
  'Consumer Staples': 'cons_def',
  'Household Products': 'cons_def',
  'Industrial Conglomerates': 'industrial',
  'Machinery': 'industrial',
  'Aerospace & Defense': 'industrial',
  'Building': 'industrial',
  'Logistics & Transportation': 'industrial',
  'Energy': 'energy',
  'Oil & Gas': 'energy',
  'Basic Materials': 'materials',
  'Metals & Mining': 'materials',
  'Chemicals': 'materials',
  'Utilities': 'utilities',
  'Real Estate': 'realestate',
  // Yahoo-Sektornamen (assetProfile.sector) — ohne sie blieben z. B.
  // „Packaging & Containers“ / „Consumer Cyclical“ ohne Sektor.
  'Communication Services': 'comm',
  'Consumer Cyclical': 'cons_cycl',
  'Consumer Defensive': 'cons_def',
  'Healthcare': 'health',
  'Industrials': 'industrial',
};

// Liefert unsere Sektor-ID für eine Finnhub-Industrie (per Schlüsselwort-Heuristik).
export function sectorForFinnhub(industry) {
  if (!industry) return null;
  if (INDUSTRY_MAP[industry]) return INDUSTRY_MAP[industry];
  const s = industry.toLowerCase();
  if (s.includes('semiconductor')) return 'ai_semi';
  if (s.includes('software') || s.includes('internet')) return 'software';
  if (s.includes('media') || s.includes('telecom') || s.includes('communication')) return 'comm';
  if (s.includes('bank') || s.includes('financ') || s.includes('insurance')) return 'finance';
  if (s.includes('pharma') || s.includes('health') || s.includes('biotech')) return 'health';
  if (s.includes('energy') || s.includes('oil') || s.includes('gas')) return 'energy';
  if (s.includes('real estate')) return 'realestate';
  if (s.includes('utilit')) return 'utilities';
  if (s.includes('chemical') || s.includes('mining') || s.includes('metal') || s.includes('material')) return 'materials';
  if (s.includes('retail') || s.includes('auto') || s.includes('apparel') || s.includes('leisure') || s.includes('hotel')) return 'cons_cycl';
  if (s.includes('food') || s.includes('beverage') || s.includes('staple') || s.includes('household')) return 'cons_def';
  if (s.includes('aerospace') || s.includes('machinery') || s.includes('industrial') || s.includes('transport')) return 'industrial';
  if (s.includes('hardware') || s.includes('technology') || s.includes('electronic')) return 'hardware';
  return null;
}
