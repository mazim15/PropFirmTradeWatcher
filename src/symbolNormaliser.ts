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

/**
 * How a symbol reached its canonical form.
 *
 * The distinction that matters is `suffix` versus `map`: a symbol resolved by
 * the built-in suffix list is a GUESS. It is usually right, and when it is
 * wrong it fails silently — the trade lands under a symbol the web app has no
 * record of, and never shows up as a hedge candidate. Those are the ones worth
 * putting in front of the operator so an explicit mapping can be added.
 */
export type ResolutionVia = 'map' | 'alias' | 'suffix' | 'exact';

export interface SymbolResolution {
  raw: string;
  canonical: string;
  via: ResolutionVia;
  /** True when only the built-in heuristics got us here — no explicit rule. */
  guessed: boolean;
}

export function explainSymbol(raw: string, customMap?: SymbolMap): SymbolResolution {
  const original = (raw ?? '').trim().toUpperCase();
  const canonical = normaliseSymbol(raw, customMap);

  if (!original) return { raw: original, canonical, via: 'exact', guessed: false };

  const reverseCustom = buildReverseMap(customMap);
  if (reverseCustom[original]) {
    return { raw: original, canonical, via: 'map', guessed: false };
  }
  if (DEFAULT_ALIASES[original]) {
    return { raw: original, canonical, via: 'alias', guessed: false };
  }
  if (canonical === original) {
    return { raw: original, canonical, via: 'exact', guessed: false };
  }
  return { raw: original, canonical, via: 'suffix', guessed: true };
}
