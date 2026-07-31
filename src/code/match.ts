/**
 * Ranking free text against the code index (L3).
 *
 * The agent asks in human terms — "the SMTP port field", "advanced networking
 * settings" — and gets back either a URL it can navigate to directly or a
 * selector it can act on, with no snapshot in between. Everything here is
 * pure and synchronous; the index is already in memory.
 */

import type { CodeIndex, CodeMatch, ConfigFieldEntry, NavGroupEntry, RouteEntry, SelectorEntry, Target } from '../types.js';
import { cssEscapeValue, fuzzyScore, matchKey } from '../util/text.js';
import { hasUnresolvedParams, routeToPath, titleCase } from './routes.js';

const DEFAULT_LIMIT = 10;
const MIN_SCORE = 0.32;
/** How much a match on the surrounding component name is worth. */
const COMPONENT_WEIGHT = 0.75;

/**
 * Per-kind weights.
 *
 * Routes rank above selectors because a deep link removes several round trips
 * while a selector removes at most one, and because a route match is far
 * likelier to be what "take me to X" means.
 */
const WEIGHTS: Record<CodeMatch['kind'], number> = {
  route: 1,
  nav: 0.97,
  config: 0.9,
  selector: 0.88,
};

/** Extra multipliers applied when the query is clearly a path. */
const PATH_QUERY_WEIGHTS: Record<CodeMatch['kind'], number> = {
  route: 1.25,
  nav: 1.1,
  config: 0.6,
  selector: 0.5,
};

export function searchIndex(index: CodeIndex, query: string, limit = DEFAULT_LIMIT): CodeMatch[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const isPathQuery = trimmed.startsWith('/');
  const normalizedQuery = matchKey(trimmed);
  const matches: CodeMatch[] = [];

  const push = (kind: CodeMatch['kind'], raw: number, build: () => Omit<CodeMatch, 'score' | 'kind'>): void => {
    if (raw <= 0) return;
    const weight = WEIGHTS[kind] * (isPathQuery ? PATH_QUERY_WEIGHTS[kind] : 1);
    // The threshold applies to the *weighted* score: a weak match in a kind the
    // query is not asking for (a selector, when the query is a path) is noise,
    // and noise in a tool result costs the caller tokens and a wrong turn.
    const score = Math.min(1, raw * weight);
    if (score < MIN_SCORE) return;
    matches.push({ kind, score, ...build() });
  };

  for (const route of index.routes) {
    const score = best(trimmed, [route.pattern, route.label, humanizePattern(route.pattern)]);
    push('route', score, () => ({
      label: route.label ?? humanizePattern(route.pattern) ?? route.pattern,
      url: routeUrl(index, route),
      source: route.source,
    }));
  }

  for (const group of index.navGroups) {
    for (const item of group.items) {
      const score = best(trimmed, [item.label, item.href, item.id, groupItemPath(group, item)]);
      push('nav', score, () => ({
        label: group.label ? `${group.label}: ${item.label}` : item.label,
        url: item.href ? absoluteUrl(index.baseUrl, item.href) : undefined,
        target: navTarget(item),
        source: group.source,
      }));
    }
  }

  for (const field of index.configFields) {
    const score = best(trimmed, [field.path, field.label, humanizeFieldPath(field.path)]);
    push('config', score, () => ({
      label: configLabel(field),
      target: configTarget(field),
      source: field.source,
    }));
  }

  for (const selector of index.selectors) {
    // The component name is context, not the thing being named, so it only
    // contributes a damped score — otherwise every selector in `SettingsTabs`
    // would answer a query about settings.
    const score = Math.max(
      best(trimmed, [selector.value, humanizeIdentifier(selector.value)]),
      COMPONENT_WEIGHT * best(trimmed, [selector.component]),
    );
    push('selector', score, () => ({
      label: selector.component ? `${selector.value} (${selector.component})` : selector.value,
      target: selectorTarget(selector),
      source: selector.source,
    }));
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic tie-break, and exact label matches first.
    const ae = matchKey(a.label) === normalizedQuery ? 0 : 1;
    const be = matchKey(b.label) === normalizedQuery ? 0 : 1;
    if (ae !== be) return ae - be;
    return a.label.length - b.label.length;
  });

  return matches.slice(0, Math.max(1, limit));
}

function best(query: string, candidates: Array<string | undefined>): number {
  let top = 0;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const score = fuzzyScore(query, candidate);
    if (score > top) top = score;
    if (top === 1) break;
  }
  return top;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** `/settings/[section]` -> `Settings Section`, for token-overlap matching. */
function humanizePattern(pattern: string): string | undefined {
  const words = pattern
    .split('/')
    .filter(Boolean)
    .map((segment) => titleCase(segment.replace(/^[:*]/, '')))
    .filter(Boolean);
  return words.length > 0 ? words.join(' ') : undefined;
}

function humanizeFieldPath(path: string): string {
  return path
    .split('.')
    .map((part) => titleCase(part))
    .filter(Boolean)
    .join(' ');
}

function humanizeIdentifier(value: string): string {
  return titleCase(value.replace(/[.\-_/]+/g, ' '));
}

function configLabel(field: ConfigFieldEntry): string {
  const base = field.label ? `${field.path} — ${field.label}` : field.path;
  if (field.enumValues && field.enumValues.length > 0) {
    return `${base} (${field.enumValues.slice(0, 6).join(' | ')})`;
  }
  return field.type ? `${base}: ${field.type}` : base;
}

function groupItemPath(group: NavGroupEntry, item: NavGroupEntry['items'][number]): string | undefined {
  return group.label ? `${group.label} ${item.label}` : undefined;
}

// ---------------------------------------------------------------------------
// URLs and targets
// ---------------------------------------------------------------------------

/** True when every dynamic segment has been filled in. */
export function isConcretePath(path: string): boolean {
  return !hasUnresolvedParams(path);
}

function routeUrl(index: CodeIndex, route: RouteEntry): string | undefined {
  const path = routeToPath(route.pattern);
  // A URL still containing `:section` is not navigable; the caller should ask
  // for the route by name and supply params instead.
  if (!isConcretePath(path)) return undefined;
  return absoluteUrl(index.baseUrl, path);
}

/** Join a base origin with a path; absolute hrefs pass through untouched. */
export function absoluteUrl(baseUrl: string | undefined, path: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  if (!baseUrl) return undefined;
  const base = baseUrl.replace(/\/+$/, '');
  if (path.startsWith('#') || path.startsWith('?')) return `${base}/${path}`;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

function navTarget(item: NavGroupEntry['items'][number]): Target | undefined {
  // A tab that has no href is clicked rather than navigated to, and its label
  // is the accessible name the page runtime will report. The item's `id` is
  // deliberately NOT used as a testId: it is an application key, and guessing
  // it is a `data-testid` would send the resolver at the wrong element.
  if (!item.href) return { name: item.label };
  return undefined;
}

function configTarget(field: ConfigFieldEntry): Target | undefined {
  const leaf = field.path.split('.').pop();
  if (!leaf) return undefined;
  // Form controls are conventionally named after the schema path or its leaf.
  return { label: field.label ?? humanizeFieldPath(field.path), css: `[name="${cssEscapeValue(field.path)}"], [name="${cssEscapeValue(leaf)}"]` };
}

const CSS_IDENT_RE = /^-?[A-Za-z_][\w-]*$/;

export function selectorTarget(selector: SelectorEntry): Target | undefined {
  switch (selector.kind) {
    case 'testid':
      return { testId: selector.value };
    case 'id':
      // `#id` is only legal for identifier-shaped values; fall back to an
      // attribute selector for ids containing dots, colons or spaces.
      return CSS_IDENT_RE.test(selector.value)
        ? { css: `#${selector.value}` }
        : { css: `[id="${cssEscapeValue(selector.value)}"]` };
    case 'name':
      return { css: `[name="${cssEscapeValue(selector.value)}"]` };
    case 'placeholder':
      return { placeholder: selector.value };
    case 'aria-label':
    case 'text':
      return { name: selector.value };
    default:
      return undefined;
  }
}
