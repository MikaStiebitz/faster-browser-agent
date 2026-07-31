/**
 * Text normalisation and fuzzy matching.
 *
 * Used by the target resolver, the form filler and the code-index search. The
 * scoring function is deliberately simple and dependency-free: matching UI
 * labels is a short-string problem where token overlap plus a few structural
 * bonuses beats edit distance, and it costs microseconds.
 */

/** Collapse whitespace, strip zero-width chars, trim. */
export function normalizeText(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Aggressive normalisation for matching: lowercase, strip accents, drop
 * punctuation and common UI noise (trailing `*` for required, `:` after
 * labels, surrounding parentheses).
 */
export function matchKey(input: string | null | undefined): string {
  return normalizeText(input)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[*:_]/g, ' ')
    .replace(/[^a-z0-9\s./-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split into comparable tokens, also breaking camelCase and snake/kebab case. */
export function tokenize(input: string): string[] {
  return matchKey(
    input
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[._/-]+/g, ' '),
  )
    .split(' ')
    .filter(Boolean);
}

/**
 * Score how well `query` matches `candidate`, in [0, 1].
 *
 * Tiers, highest first:
 *   1.00  exact match after normalisation
 *   0.95  candidate starts with the query
 *   0.90  candidate contains the query as a substring
 *   <0.9  token overlap (Jaccard-ish, weighted toward covering the query)
 *
 * A short candidate matching a short query scores higher than a long one, so
 * "Port" beats "Port forwarding rules" for the query "port".
 */
export function fuzzyScore(query: string, candidate: string): number {
  const q = matchKey(query);
  const c = matchKey(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.startsWith(q)) return 0.95 - lengthPenalty(q, c) * 0.05;
  if (c.includes(q)) return 0.9 - lengthPenalty(q, c) * 0.1;

  const qt = tokenize(query);
  const ct = tokenize(candidate);
  if (qt.length === 0 || ct.length === 0) return 0;

  const cset = new Set(ct);
  let covered = 0;
  let partial = 0;
  for (const token of qt) {
    if (cset.has(token)) {
      covered += 1;
    } else if (ct.some((t) => t.startsWith(token) || token.startsWith(t))) {
      partial += 1;
    }
  }
  const coverage = (covered + partial * 0.6) / qt.length;
  if (coverage === 0) return 0;
  // Penalise candidates that carry a lot of unrelated tokens.
  const precision = (covered + partial * 0.6) / ct.length;
  return Math.min(0.85, coverage * 0.7 + precision * 0.15);
}

function lengthPenalty(query: string, candidate: string): number {
  if (candidate.length <= query.length) return 0;
  return Math.min(1, (candidate.length - query.length) / Math.max(8, query.length * 3));
}

export interface ScoredMatch<T> {
  item: T;
  score: number;
}

/** Rank items by the best score across all keys produced by `keys`. */
export function rankMatches<T>(
  query: string,
  items: readonly T[],
  keys: (item: T) => Array<string | undefined>,
  options: { limit?: number; minScore?: number } = {},
): Array<ScoredMatch<T>> {
  const minScore = options.minScore ?? 0.3;
  const scored: Array<ScoredMatch<T>> = [];
  for (const item of items) {
    let best = 0;
    for (const key of keys(item)) {
      if (!key) continue;
      const score = fuzzyScore(query, key);
      if (score > best) best = score;
      if (best === 1) break;
    }
    if (best >= minScore) scored.push({ item, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return options.limit ? scored.slice(0, options.limit) : scored;
}

/** Best single match, or undefined when nothing clears `minScore`. */
export function bestMatch<T>(
  query: string,
  items: readonly T[],
  keys: (item: T) => Array<string | undefined>,
  options: { minScore?: number } = {},
): ScoredMatch<T> | undefined {
  return rankMatches(query, items, keys, { ...options, limit: 1 })[0];
}

/** Truncate with an ellipsis, never mid-surrogate. */
export function truncate(input: string, max: number): string {
  if (max <= 0) return '';
  if (input.length <= max) return input;
  let cut = max - 1;
  const code = input.charCodeAt(cut - 1);
  // Avoid slicing a surrogate pair in half.
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return input.slice(0, Math.max(0, cut)).trimEnd() + '…';
}

/** Escape a string for use inside a CSS attribute selector. */
export function cssEscapeValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** Stable short hash (FNV-1a, base36) used for ids and cache keys. */
export function shortHash(input: string, length = 8): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let out = hash.toString(36);
  // Mix in the length so short collisions are less likely.
  out += (input.length % 1296).toString(36).padStart(2, '0');
  return out.slice(0, length).padEnd(length, '0');
}

/** Pluralise a count: `plural(1,'control') === '1 control'`. */
export function plural(count: number, noun: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? noun : (pluralForm ?? noun + 's')}`;
}
