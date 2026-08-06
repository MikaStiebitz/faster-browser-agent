/**
 * User-configured route registries and the translation reverse index (L3).
 *
 * Two features that together make the code-aware layer work for applications
 * the built-in extractors cannot see:
 *
 *  1. **Route registries.** A legacy monolith routes through one hand-rolled
 *     array (`'page' => …, 'sub' => …`) rather than a framework's conventions.
 *     Pointing at that file turns "0 routes found" into the whole application.
 *
 *  2. **Translation call sites.** Finding "Print delivery note" in a catalogue
 *     answers half the question; the caller still has to grep for the key to
 *     learn which template renders it. Doing that hop here completes the
 *     screen-to-source path.
 */

import type { RouteEntry, RouteRegistryConfig, TranslationEntry, UiFramework } from '../types.js';
import { normalizeText, truncate } from '../util/text.js';
import { extractRecords, renderTemplate } from './records.js';
import { readSources, type ScannedFile, type SourceFile } from './scan.js';

const MAX_ROUTES_PER_REGISTRY = 2_000;
const MAX_TRANSLATIONS = 5_000;
const MAX_CALL_SITES = 6;

// ---------------------------------------------------------------------------
// Route registries
// ---------------------------------------------------------------------------

function matchesFile(rel: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = pattern.replace(/\\/g, '/');
    if (!normalized.includes('*')) return rel === normalized || rel.endsWith(`/${normalized}`);
    const source = normalized
      .split('*')
      .map((part) => part.replace(/[.+^${}()|[\]\\?]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${source}$`).test(rel);
  });
}

/** Title-case the most specific non-empty template field, as a label fallback. */
function fallbackLabel(fields: Record<string, string>, url: string): string {
  for (const key of ['title', 'label', 'name', 'sub', 'page']) {
    const value = fields[key];
    if (value) return titleish(value);
  }
  return titleish(url);
}

function titleish(value: string): string {
  const cleaned = value.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  if (!cleaned) return value;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export async function extractRegistryRoutes(
  files: ScannedFile[],
  registries: RouteRegistryConfig[],
): Promise<RouteEntry[]> {
  const out: RouteEntry[] = [];
  if (registries.length === 0) return out;

  for (const registry of registries) {
    const patterns = Array.isArray(registry.file) ? registry.file : [registry.file];
    const targets = files.filter((file) => matchesFile(file.rel, patterns));
    if (targets.length === 0) continue;

    const sources = await readSources(targets, { concurrency: 4 });
    for (const source of sources) {
      // Registry files are hand-maintained tables, so a generous record cap is
      // the right trade: missing half a menu is worse than a slightly bigger
      // index.
      const records = extractRecords(source.content, { maxRecords: MAX_ROUTES_PER_REGISTRY, minFields: 1 });
      const seen = new Set<string>();

      for (const record of records) {
        const fields = record.fields;
        if (registry.require && !registry.require.every((field) => fields[field])) continue;

        const url = renderTemplate(registry.url, fields);
        if (!url || seen.has(url)) continue;
        seen.add(url);

        const label = registry.label ? renderTemplate(registry.label, fields) : undefined;
        const entry: RouteEntry = {
          pattern: url.startsWith('/') ? url : `/${url}`,
          params: [],
          framework: 'unknown' as UiFramework,
          source: `${source.rel}:${record.line}`,
          label: truncate(normalizeText(label || fallbackLabel(fields, url)), 80),
        };

        if (registry.aclField) {
          const acl = fields[registry.aclField];
          if (acl) entry.acl = acl;
        }
        if (registry.meta && registry.meta.length > 0) {
          const meta: Record<string, string> = {};
          for (const field of registry.meta) {
            const value = fields[field];
            if (value) meta[field] = truncate(value, 120);
          }
          if (Object.keys(meta).length > 0) entry.meta = meta;
        }
        out.push(entry);
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Translations and their call sites
// ---------------------------------------------------------------------------

const CATALOGUE_EXTS = new Set(['.json', '.yaml', '.yml']);

/** `translations/order.en.json`, `locales/de/common.json`, `messages/en.json`. */
export function isTranslationCatalogue(rel: string): boolean {
  return /(^|\/)(translations?|locales?|lang|i18n|messages)(\/|$)/i.test(rel) && CATALOGUE_EXTS.has(extOf(rel));
}

function extOf(rel: string): string {
  const dot = rel.lastIndexOf('.');
  return dot === -1 ? '' : rel.slice(dot).toLowerCase();
}

/** Locale inferred from the path: `order.en.json`, `locales/de/x.json`. */
function localeOf(rel: string): string | undefined {
  const named = /[.\-_/]([a-z]{2}(?:[-_][A-Za-z]{2})?)(?:[.+][\w-]+)?\.(?:json|ya?ml)$/i.exec(rel);
  if (named?.[1]) return named[1].toLowerCase();
  const dir = /(?:^|\/)([a-z]{2}(?:[-_][A-Za-z]{2})?)\//i.exec(rel);
  return dir?.[1]?.toLowerCase();
}

/** Flatten a nested catalogue into dotted keys, which is how apps reference them. */
function flatten(value: unknown, prefix: string, out: Map<string, string>, depth = 0): void {
  if (depth > 8 || out.size >= MAX_TRANSLATIONS) return;
  if (typeof value === 'string') {
    if (prefix) out.set(prefix, value);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, out, depth + 1);
  }
}

/**
 * Every way an app asks for a translation.
 *
 * Deliberately broad — PHP, Twig, Laravel, Symfony, JS i18n libraries all end
 * up as `something('key')` or `'key'|trans` — because a missed call site is a
 * silently incomplete answer, while a spurious one is filtered out by the
 * intersection with real catalogue keys below.
 */
const CALL_PATTERNS: RegExp[] = [
  /\b(?:trans|translate|__|_t|t|gettext|lang)\s*\(\s*['"]([\w.:@/-]{2,120})['"]/g,
  /\{\{\s*['"]([\w.:@/-]{2,120})['"]\s*\|\s*trans/g,
  /\btrans_choice\s*\(\s*['"]([\w.:@/-]{2,120})['"]/g,
  /\bi18nKey\s*=\s*["']([\w.:@/-]{2,120})["']/g,
];

/**
 * Build the catalogue index and attach the places each key is referenced.
 *
 * The intersection is what keeps this honest: only keys that actually exist in
 * a catalogue get call sites, so the very permissive call patterns above cannot
 * fill the index with `t('some string')` noise from unrelated code.
 */
export async function extractTranslations(files: ScannedFile[]): Promise<TranslationEntry[]> {
  const catalogues = files.filter((file) => isTranslationCatalogue(file.rel));
  if (catalogues.length === 0) return [];

  const entries = new Map<string, TranslationEntry>();
  const catalogueSources = await readSources(catalogues, { concurrency: 16 });

  for (const source of catalogueSources) {
    if (extOf(source.rel) !== '.json') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.content);
    } catch {
      continue;
    }
    const flat = new Map<string, string>();
    flatten(parsed, '', flat);
    const locale = localeOf(source.rel);
    for (const [key, value] of flat) {
      if (entries.size >= MAX_TRANSLATIONS) break;
      // First catalogue wins; later locales of the same key add nothing to the
      // reverse lookup, which is keyed on the key itself.
      if (entries.has(key)) continue;
      entries.set(key, {
        key,
        value: truncate(normalizeText(value), 200),
        ...(locale ? { locale } : {}),
        source: source.rel,
        callSites: [],
      });
    }
  }

  if (entries.size === 0) return [];

  // --- second pass: where is each key used? --------------------------------
  const codeFiles = files.filter((file) => !isTranslationCatalogue(file.rel) && extOf(file.rel) !== '.json');
  const codeSources = await readSources(codeFiles, { concurrency: 16 });

  for (const source of codeSources) {
    collectCallSites(source, entries);
  }

  return [...entries.values()];
}

function collectCallSites(source: SourceFile, entries: Map<string, TranslationEntry>): void {
  const content = source.content;
  // Cheap pre-filter: most files reference no translations at all.
  if (!/\b(?:trans|translate|__|gettext|lang|i18nKey)\b/.test(content)) return;

  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') lineStarts.push(i + 1);
  }
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  for (const pattern of CALL_PATTERNS) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(content); m; m = pattern.exec(content)) {
      const key = m[1];
      if (!key) continue;
      const entry = entries.get(key);
      if (!entry || entry.callSites.length >= MAX_CALL_SITES) continue;
      const site = `${source.rel}:${lineOf(m.index)}`;
      if (!entry.callSites.includes(site)) entry.callSites.push(site);
    }
  }
}
