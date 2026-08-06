/**
 * Selector, label and nav-structure extraction (L3).
 *
 * The point of this module is to answer "what selector addresses the SMTP port
 * field?" without taking a snapshot at all. Two sources feed it:
 *
 *   1. the application's own markup — test ids, ids, aria-labels, input names,
 *      placeholders;
 *   2. the application's TESTS. An existing e2e/unit suite is a goldmine: every
 *      `getByTestId('save-button')` in it is a selector that a human already
 *      verified works against this app, which is a much stronger signal than
 *      anything we could infer from the DOM.
 *
 * i18n catalogues are indexed as well, so a query phrased in the app's display
 * language ("Erweitert") resolves to the same control as the developer-facing
 * key (`settings.advanced`).
 */

import { basename } from 'node:path';

import type { NavGroupEntry, SelectorEntry } from '../types.js';
import { normalizeText, truncate } from '../util/text.js';
import {
  groupByArray,
  isTestPath,
  makeLineIndex,
  readSources,
  scanObjectLiterals,
  type ObjectLiteral,
  type ScannedFile,
  type SourceFile,
} from './scan.js';

const MARKUP_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro', '.html']);

const MAX_SELECTORS = 4000;
const MAX_VALUE_LENGTH = 120;

// ---------------------------------------------------------------------------
// Component attribution
// ---------------------------------------------------------------------------

/** `function Foo(`, `const Foo = `, `class Foo` — capitalised names only. */
const COMPONENT_RE =
  /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([A-Z][\w$]*)|(?:const|let|var)\s+([A-Z][\w$]*)\s*(?::[^=\n]{0,80})?=|class\s+([A-Z][\w$]*))/g;

interface ComponentAnchor {
  index: number;
  name: string;
}

function componentAnchors(content: string): ComponentAnchor[] {
  const anchors: ComponentAnchor[] = [];
  COMPONENT_RE.lastIndex = 0;
  for (let m = COMPONENT_RE.exec(content); m; m = COMPONENT_RE.exec(content)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (name) anchors.push({ index: m.index, name });
  }
  return anchors;
}

function componentAt(anchors: ComponentAnchor[], index: number, fallback: string): string {
  let lo = 0;
  let hi = anchors.length - 1;
  let found: string | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const anchor = anchors[mid];
    if (!anchor) break;
    if (anchor.index <= index) {
      found = anchor.name;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found ?? fallback;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

interface SelectorPattern {
  kind: SelectorEntry['kind'];
  re: RegExp;
  /** Which capture groups may hold the value. */
  groups: number[];
}

const QUOTED = `(?:"([^"\\n]{1,${MAX_VALUE_LENGTH}})"|'([^'\\n]{1,${MAX_VALUE_LENGTH}})')`;

const PATTERNS: SelectorPattern[] = [
  // Markup attributes. `data-testid={'x'}` is covered by the braces alternative.
  {
    kind: 'testid',
    re: new RegExp(`\\bdata-(?:testid|test-id|test|cy|qa)\\s*=\\s*\\{?\\s*${QUOTED}`, 'g'),
    groups: [1, 2],
  },
  { kind: 'aria-label', re: new RegExp(`\\baria-label\\s*=\\s*\\{?\\s*${QUOTED}`, 'g'), groups: [1, 2] },
  { kind: 'placeholder', re: new RegExp(`\\bplaceholder\\s*=\\s*\\{?\\s*${QUOTED}`, 'g'), groups: [1, 2] },

  // Test-suite locators — known-good selectors, already verified by a human.
  {
    kind: 'testid',
    re: new RegExp(`\\b(?:get|find|query)ByTestId\\s*\\(\\s*${QUOTED}`, 'g'),
    groups: [1, 2],
  },
  {
    kind: 'testid',
    re: new RegExp(`\\[data-(?:testid|test-id|test|cy|qa)\\s*=\\s*['"]?([\\w .:-]{1,${MAX_VALUE_LENGTH}})['"]?\\]`, 'g'),
    groups: [1],
  },
  { kind: 'aria-label', re: new RegExp(`\\b(?:get|find|query)ByLabel(?:Text)?\\s*\\(\\s*${QUOTED}`, 'g'), groups: [1, 2] },
  { kind: 'placeholder', re: new RegExp(`\\b(?:get|find|query)ByPlaceholder(?:Text)?\\s*\\(\\s*${QUOTED}`, 'g'), groups: [1, 2] },
  { kind: 'text', re: new RegExp(`\\b(?:get|find|query)ByText\\s*\\(\\s*${QUOTED}`, 'g'), groups: [1, 2] },
  {
    kind: 'text',
    re: new RegExp(`\\b(?:get|find|query)ByRole\\s*\\([^)]*?\\bname\\s*:\\s*${QUOTED}`, 'g'),
    groups: [1, 2],
  },
];

/** `id`/`name` are only interesting on form controls and forms themselves. */
const CONTROL_TAG = '(?:input|select|textarea|button|form|fieldset|option)';
const CONTROL_ID_RE = new RegExp(`<${CONTROL_TAG}\\b[^>]{0,400}?\\bid\\s*=\\s*\\{?\\s*${QUOTED}`, 'gi');
const CONTROL_NAME_RE = new RegExp(`<${CONTROL_TAG}\\b[^>]{0,400}?\\bname\\s*=\\s*\\{?\\s*${QUOTED}`, 'gi');
/** `<label for="smtp-port">SMTP port</label>` ties a label to a control id. */
const LABEL_FOR_RE = new RegExp(`<label\\b[^>]{0,200}?\\b(?:for|htmlFor)\\s*=\\s*\\{?\\s*${QUOTED}[^>]*>([^<]{1,${MAX_VALUE_LENGTH}})<`, 'gi');

function valueOf(match: RegExpExecArray, groups: number[]): string | undefined {
  for (const g of groups) {
    const value = match[g];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function usable(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VALUE_LENGTH) return false;
  // Interpolations and expressions are not literal selectors.
  if (trimmed.includes('${') || trimmed.includes('{{')) return false;
  return /[A-Za-z0-9]/.test(trimmed);
}

// ---------------------------------------------------------------------------
// Selector extraction
// ---------------------------------------------------------------------------

export async function extractSelectors(root: string, files: ScannedFile[]): Promise<SelectorEntry[]> {
  // See `extractRoutes`: `root` is signature symmetry, paths come from `files`.
  void root;
  const out: SelectorEntry[] = [];
  const seen = new Set<string>();

  const add = (entry: SelectorEntry): void => {
    if (out.length >= MAX_SELECTORS) return;
    const value = normalizeText(entry.value);
    if (!usable(value)) return;
    const key = `${entry.kind}::${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...entry, value: truncate(value, MAX_VALUE_LENGTH) });
  };

  const markup = files.filter((f) => MARKUP_EXTS.has(f.ext));
  const catalogues = files.filter((f) => f.ext === '.json' && isI18nCatalogue(f.rel));

  const sources = await readSources([...markup, ...catalogues], { concurrency: 16 });
  for (const source of sources) {
    if (source.ext === '.json') extractCatalogue(source, add);
    else extractMarkup(source, add);
    if (out.length >= MAX_SELECTORS) break;
  }

  return out;
}

function extractMarkup(source: SourceFile, add: (entry: SelectorEntry) => void): void {
  const content = source.content;
  const lineOf = makeLineIndex(content);
  // Single-file components have one implicit component: the file itself.
  const singleFile = source.ext === '.vue' || source.ext === '.svelte' || source.ext === '.astro' || source.ext === '.html';
  const fallback = basename(source.rel).replace(/\.[^.]+$/, '');
  const anchors = singleFile ? [] : componentAnchors(content);

  const emit = (kind: SelectorEntry['kind'], value: string, index: number): void => {
    add({
      kind,
      value,
      source: `${source.rel}:${lineOf(index)}`,
      component: singleFile ? fallback : componentAt(anchors, index, fallback),
    });
  };

  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    for (let m = pattern.re.exec(content); m; m = pattern.re.exec(content)) {
      const value = valueOf(m, pattern.groups);
      if (value !== undefined) emit(pattern.kind, value, m.index);
    }
  }

  CONTROL_ID_RE.lastIndex = 0;
  for (let m = CONTROL_ID_RE.exec(content); m; m = CONTROL_ID_RE.exec(content)) {
    const value = valueOf(m, [1, 2]);
    if (value !== undefined) emit('id', value, m.index);
  }

  CONTROL_NAME_RE.lastIndex = 0;
  for (let m = CONTROL_NAME_RE.exec(content); m; m = CONTROL_NAME_RE.exec(content)) {
    const value = valueOf(m, [1, 2]);
    if (value !== undefined) emit('name', value, m.index);
  }

  LABEL_FOR_RE.lastIndex = 0;
  for (let m = LABEL_FOR_RE.exec(content); m; m = LABEL_FOR_RE.exec(content)) {
    const target = valueOf(m, [1, 2]);
    const text = m[3];
    if (target !== undefined) emit('id', target, m.index);
    // The visible label text is what an agent will actually be asked for.
    if (text !== undefined) emit('text', text, m.index);
  }
}

// ---------------------------------------------------------------------------
// i18n catalogues
// ---------------------------------------------------------------------------

const I18N_DIR_RE = /(^|\/)(locales?|messages|lang|langs|translations?|i18n|intl)\//i;

function isI18nCatalogue(rel: string): boolean {
  if (I18N_DIR_RE.test(rel)) return true;
  // `en.json` / `de-DE.json` at any level is conventionally a catalogue.
  return /(^|\/)[a-z]{2}(?:[-_][A-Za-z]{2,4})?\.json$/.test(rel);
}

function extractCatalogue(source: SourceFile, add: (entry: SelectorEntry) => void): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.content);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

  const walk = (node: Record<string, unknown>, prefix: string, depth: number): void => {
    if (depth > 6) return;
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'string') {
        // The translated label is the searchable text; the key is kept as the
        // "component" so a developer-facing query resolves too.
        add({ kind: 'text', value, source: source.rel, component: path });
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, path, depth + 1);
      }
    }
  };
  walk(parsed as Record<string, unknown>, '', 0);
}

// ---------------------------------------------------------------------------
// Nav / tab groups
// ---------------------------------------------------------------------------

const LABEL_KEYS = ['label', 'title', 'name', 'text', 'heading'] as const;
const HREF_KEYS = ['href', 'to', 'path', 'url', 'route', 'link'] as const;
const ID_KEYS = ['id', 'key', 'value', 'slug', 'section', 'tab'] as const;

function pickProp(object: ObjectLiteral, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = object.props[key];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/**
 * Find declarative tab/menu structures.
 *
 * These arrays are exactly the structures an agent wastes round trips on: a
 * tab strip renders as a handful of anonymous buttons, but the source says
 * plainly that the app has `general`, `advanced` and `networking` sections and
 * what each of them is called.
 */
/** A nav item points somewhere: a path, a url, or a template hole. */
function isDestination(item: { label: string; href?: string; id?: string }): boolean {
  if (!item.href) return false;
  const href = item.href.trim();
  return /^[./#]/.test(href) || /^https?:/i.test(href) || href.startsWith('${');
}

/** `mainNav`, `settingsTabs`, `sidebarLinks` — the developer said what it is. */
function isNavigationName(owner: string | undefined): boolean {
  return !!owner && /(nav|tab|menu|link|route|section|sidebar|breadcrumb)/i.test(owner);
}

/**
 * Reject labels that are plainly not UI text.
 *
 * SCREAMING_SNAKE and ALL-CAPS multi-word values are constants (`DAY MS`,
 * `MAX_RETRIES`); nav labels are written for humans.
 */
function looksLikeUiLabel(label: string): boolean {
  const trimmed = label.trim();
  if (trimmed.length < 2 || trimmed.length > 60) return false;
  if (/^[A-Z0-9]+(?:[_\s][A-Z0-9]+)+$/.test(trimmed)) return false;
  return /[a-zA-Z]/.test(trimmed);
}

export async function extractNavGroups(root: string, files: ScannedFile[]): Promise<NavGroupEntry[]> {
  // See `extractRoutes`: `root` is signature symmetry, paths come from `files`.
  void root;
  const out: NavGroupEntry[] = [];
  // Tests are excluded here (but not from selector extraction): an array built
  // to exercise a parser reads exactly like a nav definition and would show up
  // in `browser_map` as if it described the app.
  const candidates = files.filter(
    (f) => MARKUP_EXTS.has(f.ext) && f.ext !== '.html' && !isTestPath(f.rel),
  );

  const sources = await readSources(candidates, { concurrency: 16 });

  for (const source of sources) {
    const content = source.content;
    // Cheap pre-filter: a nav array needs a label-ish and a target-ish key.
    // Skipping the brace walk on files that cannot qualify is most of the
    // reason nav extraction is effectively free.
    if (!/\b(?:label|title|name|text)\s*:/.test(content)) continue;
    if (!/\b(?:href|to|path|id|key|slug)\s*:/.test(content)) continue;

    const objects = scanObjectLiterals(content);
    if (objects.length === 0) continue;

    for (const [, siblings] of groupByArray(objects)) {
      // A single object is a config blob, not a navigation structure.
      if (siblings.length < 2) continue;
      const items: NavGroupEntry['items'] = [];
      for (const object of siblings) {
        const label = pickProp(object, LABEL_KEYS);
        if (!label) continue;
        const href = pickProp(object, HREF_KEYS);
        const id = pickProp(object, ID_KEYS);
        if (!href && !id) continue;
        items.push({
          label: normalizeText(label),
          ...(href ? { href } : {}),
          ...(id ? { id } : {}),
        });
      }
      if (items.length < 2) continue;
      if (!items.some((item) => looksLikeUiLabel(item.label))) continue;

      const first = siblings[0];
      const owner = first?.owner;
      // Shape alone cannot tell navigation from a status enum or a duration
      // table — `[{id:'disabled', label:'Disabled'}]` is structurally identical
      // to a tab definition. Two independent signals disambiguate, and one must
      // hold: the items actually link somewhere, or the developer named the
      // array after navigation. Observed noise this removes: "Disabled",
      // "DAY MS"; observed navigation it keeps: id-only tab arrays.
      const links = items.some((item) => isDestination(item));
      if (!links && !isNavigationName(owner)) continue;
      out.push({
        label: owner ? titleizeOwner(owner) : undefined,
        items,
        source: `${source.rel}:${first?.line ?? 1}`,
      });
    }
  }
  return out;
}

function titleizeOwner(owner: string): string {
  const spaced = owner
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
