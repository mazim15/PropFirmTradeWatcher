// Strips common broker suffixes and applies aliases so symbols emitted by
// MT4/MT5 (e.g. XAUUSDm, XAUUSD.r, GOLD#) resolve to the canonical name.
//
// Order: alias first (GOLD -> XAUUSD), then suffix-strip (XAUUSDm -> XAUUSD).

const DEFAULT_SUFFIXES = [
  '.raw', '.std', '.pro', '.cnt', '.ecn',
  '.r', '.c', '.s', '.x', '.m',
  'pro', 'raw', 'cnt', 'ecn',
  '#', '+', '-', '_',
  'm', 'c', 's', 'x'
];

const DEFAULT_ALIASES: Record<string, string> = {
  GOLD: 'XAUUSD',
  SILVER: 'XAGUSD',
  WTI: 'USOIL',
  BRENT: 'UKOIL'
};

export interface SymbolMap {
  // Canonical symbol -> list of broker variants that should map to it.
  // e.g. { XAUUSD: ['XAUUSDm', 'GOLD#'] }
  [canonical: string]: string[];
}

function buildReverseMap(map: SymbolMap | undefined): Record<string, string> {
  const reverse: Record<string, string> = {};
  if (!map) return reverse;
  for (const canonical of Object.keys(map)) {
    for (const variant of map[canonical] || []) {
      reverse[variant.toUpperCase()] = canonical.toUpperCase();
    }
  }
  return reverse;
}

export function normaliseSymbol(raw: string, customMap?: SymbolMap): string {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim().toUpperCase();
  if (!s) return '';

  // Custom map takes priority — exact-match lookup of the raw symbol.
  const reverseCustom = buildReverseMap(customMap);
  if (reverseCustom[s]) return reverseCustom[s];

  // Strip suffixes (longest first to avoid e.g. ".r" stealing from ".raw").
  const sortedSuffixes = [...DEFAULT_SUFFIXES].sort((a, b) => b.length - a.length);
  for (const suffix of sortedSuffixes) {
    const upperSuffix = suffix.toUpperCase();
    if (s.length > upperSuffix.length + 2 && s.endsWith(upperSuffix)) {
      s = s.slice(0, -upperSuffix.length);
      break;
    }
  }

  // Aliases (GOLD -> XAUUSD).
  if (DEFAULT_ALIASES[s]) return DEFAULT_ALIASES[s];

  return s;
}
