/**
 * Workspace file discovery, plus the low-level source-scanning primitives the
 * rest of the code index is built on (L3).
 *
 * Two responsibilities live here because they share the same constraint: the
 * whole index must be buildable in well under a second on a real repository, so
 * everything is a single linear pass over bytes we already had to read.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import { createLogger } from '../util/logger.js';

const logger = createLogger('code:scan');

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

export interface ScanOptions {
  /** Hard cap on returned files. Least-relevant files are dropped first. */
  maxFiles?: number;
  /** Files larger than this are not indexed at all. */
  maxFileBytes?: number;
  /** Glob-ish patterns; when present only matching files are kept. */
  include?: string[];
  /** Glob-ish patterns to drop, applied after `include`. */
  exclude?: string[];
}

export interface ScannedFile {
  /** Absolute path. */
  path: string;
  /** Path relative to the workspace root, always with `/` separators. */
  rel: string;
  mtimeMs: number;
  size: number;
  /** Lowercased extension including the dot, e.g. `.tsx`. */
  ext: string;
}

export const DEFAULT_MAX_FILES = 4000;
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

/** Extensions that can plausibly describe a UI: routes, markup, schemas. */
export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
  '.html',
  '.py',
  '.rb',
  '.json',
  '.yaml',
  '.yml',
]);

/** Directories that never contain first-party UI source. */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'coverage',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  'bower_components',
  '.gradle',
  '.terraform',
]);

/** Generated or machine-owned files that share an interesting extension. */
const IGNORED_BASENAMES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'composer.lock',
  'poetry.lock',
  'Cargo.lock',
]);

/**
 * True when a workspace-relative path is worth reading for the index.
 *
 * Path-only: callers use this before paying for a `stat`.
 */
/**
 * True for test/spec files.
 *
 * Tests are deliberately *kept* for selector extraction — a suite is a goldmine
 * of known-good selectors. They are excluded from structural extraction (nav
 * groups, routes) because a fixture built to exercise a parser is not a
 * description of the application's navigation, and indexing it produces
 * confident-looking noise in `browser_map`.
 */
export function isTestPath(rel: string): boolean {
  const normalized = rel.replace(/\\/g, '/');
  return (
    /(^|\/)(tests?|__tests__|__mocks__|e2e|cypress|spec|fixtures?)(\/|$)/i.test(normalized) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized)
  );
}

export function isSourceFile(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/');
  if (!norm || norm.startsWith('../') || norm.startsWith('/')) return false;

  const segments = norm.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (!base || base.startsWith('.')) {
    // Dotfiles (.eslintrc.json, .babelrc) describe tooling, not the UI.
    return false;
  }
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (!seg) continue;
    if (EXCLUDED_DIRS.has(seg)) return false;
  }
  if (IGNORED_BASENAMES.has(base)) return false;
  if (/\.min\.(js|css)$/i.test(base) || base.endsWith('.map') || base.endsWith('.snap')) return false;

  return SOURCE_EXTENSIONS.has(extname(base).toLowerCase());
}

/**
 * Relevance rank, lowest first. Used to decide what survives `maxFiles`:
 * component/route source is always more valuable than a random data file.
 */
function relevanceRank(rel: string, ext: string): number {
  if (/(^|\/)(app|pages|routes|src)\//.test(rel)) {
    if (ext === '.json' || ext === '.yaml' || ext === '.yml') return 2;
    return 0;
  }
  if (ext === '.json' || ext === '.yaml' || ext === '.yml') return 3;
  return 1;
}

function globToRegExp(pattern: string): RegExp {
  const src = pattern.replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (ch === '*') {
      if (src[i + 1] === '*') {
        if (src[i + 2] === '/') {
          // `**/` spans zero or more directories.
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function makeMatcher(patterns: string[] | undefined): ((rel: string) => boolean) | undefined {
  if (!patterns || patterns.length === 0) return undefined;
  const tests = patterns.map((p) => {
    // A bare name like "locales" is meant as "anything under locales/".
    if (!p.includes('/') && !p.includes('*')) {
      const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|/)${escaped}(/|$)`);
    }
    return globToRegExp(p);
  });
  return (rel: string) => tests.some((t) => t.test(rel));
}

/**
 * List candidate source files under `root`.
 *
 * `git ls-files` is tried first and is not an optimisation detail: on a real
 * repository it is typically 10-50x faster than a JS directory walk (one C
 * process reading the index vs. thousands of `readdir`/`stat` round trips
 * through libuv), and it applies `.gitignore` for free, which is exactly the
 * "don't index generated code" rule we would otherwise have to reimplement.
 */
export async function scanWorkspace(root: string, options: ScanOptions = {}): Promise<ScannedFile[]> {
  const abs = resolve(root);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const include = makeMatcher(options.include);
  const exclude = makeMatcher(options.exclude);

  let rels = await listWithGit(abs);
  if (!rels) rels = await walkDirectory(abs, maxFiles * 4);

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const rel of rels) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!isSourceFile(rel)) continue;
    if (include && !include(rel)) continue;
    if (exclude && exclude(rel)) continue;
    candidates.push(rel);
  }

  // Rank before capping so a huge repo keeps its UI source rather than an
  // arbitrary alphabetical prefix.
  candidates.sort((a, b) => {
    const ra = relevanceRank(a, extname(a).toLowerCase());
    const rb = relevanceRank(b, extname(b).toLowerCase());
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const limited = candidates.slice(0, maxFiles * 2);
  const stated = await mapPool(limited, 32, async (rel): Promise<ScannedFile | undefined> => {
    const path = join(abs, rel);
    try {
      const st = await stat(path);
      if (!st.isFile()) return undefined;
      if (st.size > maxFileBytes) return undefined;
      return { path, rel, mtimeMs: Math.floor(st.mtimeMs), size: st.size, ext: extname(rel).toLowerCase() };
    } catch {
      // Deleted between listing and stat, or unreadable — simply not indexed.
      return undefined;
    }
  });

  const files: ScannedFile[] = [];
  for (const f of stated) {
    if (f) files.push(f);
    if (files.length >= maxFiles) break;
  }
  // Stable path order keeps the persisted index diff-friendly.
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return files;
}

function listWithGit(root: string): Promise<string[] | undefined> {
  return new Promise((resolveP) => {
    execFile(
      'git',
      ['ls-files', '-co', '--exclude-standard', '-z'],
      { cwd: root, timeout: 3_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          logger.debug(`git ls-files unavailable (${error.message}); falling back to a directory walk`);
          resolveP(undefined);
          return;
        }
        const rels = stdout.split('\0').filter(Boolean);
        resolveP(rels.length > 0 ? rels : undefined);
      },
    );
  });
}

async function walkDirectory(root: string, budget: number): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [''];
  while (queue.length > 0 && out.length < budget) {
    const relDir = queue.shift() as string;
    let entries;
    try {
      entries = await readdir(join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        // Hidden directories are tooling/state; `.github` etc. hold no UI.
        if (entry.name.startsWith('.')) continue;
        queue.push(rel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(rel);
        if (out.length >= budget) break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bounded-concurrency reading
// ---------------------------------------------------------------------------

/** Map with at most `limit` promises in flight. Order of results is preserved. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  if (items.length === 0) return out;
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        const item = items[i];
        if (item === undefined) continue;
        out[i] = await fn(item, i);
      }
    }),
  );
  return out;
}

export interface SourceFile extends ScannedFile {
  content: string;
}

export interface ReadSourcesOptions {
  concurrency?: number;
  maxBytes?: number;
  /** Only read files for which this returns true. */
  filter?: (file: ScannedFile) => boolean;
}

/**
 * Short-lived content cache.
 *
 * One index build runs four independent extractors over overlapping file sets;
 * without this they would each pay for the same reads, which is the single
 * largest cost of a rebuild. Entries are keyed by path + mtime + size, so a
 * file edited between builds is never served stale, and the whole cache is
 * dropped once it ages out or grows past its byte budget.
 */
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
const contentCache = new Map<string, { content: string; at: number }>();
let contentCacheBytes = 0;

/** Drop every cached file body. */
export function clearSourceCache(): void {
  contentCache.clear();
  contentCacheBytes = 0;
}

function pruneCache(now: number): void {
  if (contentCacheBytes > CACHE_MAX_BYTES) {
    clearSourceCache();
    return;
  }
  for (const [key, entry] of contentCache) {
    if (now - entry.at > CACHE_TTL_MS) {
      contentCacheBytes -= entry.content.length;
      contentCache.delete(key);
    }
  }
}

/** Read file contents with a bounded pool; unreadable files are skipped. */
export async function readSources(
  files: readonly ScannedFile[],
  options: ReadSourcesOptions = {},
): Promise<SourceFile[]> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  const filter = options.filter;
  const wanted = files.filter((f) => f.size <= maxBytes && (!filter || filter(f)));
  const now = Date.now();
  pruneCache(now);

  const read = await mapPool(wanted, options.concurrency ?? 16, async (file): Promise<SourceFile | undefined> => {
    const key = `${file.path}:${file.mtimeMs}:${file.size}`;
    const cached = contentCache.get(key);
    if (cached) {
      cached.at = now;
      return { ...file, content: cached.content };
    }
    try {
      const content = await readFile(file.path, 'utf8');
      contentCache.set(key, { content, at: now });
      contentCacheBytes += content.length;
      return { ...file, content };
    } catch {
      return undefined;
    }
  });
  const out: SourceFile[] = [];
  for (const f of read) if (f) out.push(f);
  return out;
}

// ---------------------------------------------------------------------------
// Lightweight source scanning
// ---------------------------------------------------------------------------
//
// The index deliberately uses regex + a brace walker rather than a real parser.
// A parser would have to be per-language (TS, JSX, Vue SFC, Svelte, Python,
// Ruby), would need to keep up with syntax changes, and would cost an order of
// magnitude more time and dependencies. Scanning is framework-agnostic, never
// fails on syntax it does not understand, and degrades to "found fewer things"
// instead of "threw". Precision is recovered downstream by scoring: a wrong
// candidate simply ranks low.

function skipQuoted(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    // An unterminated literal is a mis-scan, not a file-ending event.
    if (ch === '\n') return i;
    i++;
  }
  return source.length;
}

function skipTemplate(source: string, start: number): number {
  let i = start + 1;
  const braces: number[] = [];
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (braces.length === 0) {
      if (ch === '`') return i + 1;
      if (ch === '$' && source[i + 1] === '{') {
        braces.push(1);
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(source, i);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i, ch);
      continue;
    }
    const top = braces.length - 1;
    if (ch === '{') {
      braces[top] = (braces[top] ?? 0) + 1;
    } else if (ch === '}') {
      const depth = (braces[top] ?? 1) - 1;
      if (depth <= 0) braces.pop();
      else braces[top] = depth;
    }
    i++;
  }
  return source.length;
}

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_ALLOWED_BEFORE = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', 'n']);

function skipRegexLiteral(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n') return start; // not a regex after all
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return i + 1;
    i++;
  }
  return start;
}

/**
 * Visit every character of `source` that is real code — string literals,
 * template literals, comments and regex literals are skipped wholesale.
 * Return `false` from the callback to stop early.
 */
export function forEachCodeChar(
  source: string,
  cb: (index: number, ch: string) => boolean | void,
  from = 0,
): void {
  let i = Math.max(0, from);
  let prev = '';
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl;
      prev = '';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      prev = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i, ch);
      prev = ch;
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(source, i);
      prev = ch;
      continue;
    }
    if (ch === '/' && REGEX_ALLOWED_BEFORE.has(prev)) {
      const end = skipRegexLiteral(source, i);
      if (end > i) {
        i = end;
        prev = '/';
        continue;
      }
    }
    if (cb(i, ch) === false) return;
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') prev = ch;
    i++;
  }
}

/**
 * Blank out comments while preserving every other character offset.
 *
 * Offset preservation matters: callers slice the result and still report line
 * numbers from the original file.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let prev = '';
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i);
      const end = nl < 0 ? source.length : nl;
      out += ' '.repeat(end - i);
      i = end;
      prev = '';
      continue;
    }
    if (ch === '/' && next === '*') {
      const found = source.indexOf('*/', i + 2);
      const end = found < 0 ? source.length : found + 2;
      for (let k = i; k < end; k++) out += source[k] === '\n' ? '\n' : ' ';
      i = end;
      prev = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = skipQuoted(source, i, ch);
      out += source.slice(i, end);
      i = end;
      prev = ch;
      continue;
    }
    if (ch === '`') {
      const end = skipTemplate(source, i);
      out += source.slice(i, end);
      i = end;
      prev = ch;
      continue;
    }
    if (ch === '/' && REGEX_ALLOWED_BEFORE.has(prev)) {
      const end = skipRegexLiteral(source, i);
      if (end > i) {
        out += source.slice(i, end);
        i = end;
        prev = '/';
        continue;
      }
    }
    out += ch;
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') prev = ch;
    i++;
  }
  return out;
}

/**
 * Slice the balanced `{...}`, `[...]` or `(...)` starting at `openIndex`.
 * Returns the inner body (without the delimiters) and the closing index.
 */
export function sliceBalanced(source: string, openIndex: number): { body: string; end: number } | undefined {
  const open = source[openIndex];
  if (open !== '{' && open !== '[' && open !== '(') return undefined;
  const close = open === '{' ? '}' : open === '[' ? ']' : ')';
  let depth = 0;
  let end = -1;
  forEachCodeChar(
    source,
    (i, ch) => {
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          end = i;
          return false;
        }
      }
    },
    openIndex,
  );
  if (end < 0) return undefined;
  return { body: source.slice(openIndex + 1, end), end };
}

/**
 * Split on a separator that appears at nesting depth zero.
 *
 * Angle brackets are tracked separately from `(){}[]` so a generic like
 * `Record<string, number>` survives a comma split, while a stray `>` from `=>`
 * or a comparison cannot unbalance the scan.
 */
export function splitTopLevel(body: string, separator = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let angle = 0;
  let last = 0;
  let prev = '';
  forEachCodeChar(body, (i, ch) => {
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      if (depth > 0) depth--;
    } else if (ch === '<' && /[\w$>\]]/.test(prev)) angle++;
    else if (ch === '>' && angle > 0 && prev !== '=') angle--;
    else if (depth === 0 && angle === 0 && ch === separator) {
      parts.push(body.slice(last, i));
      last = i + 1;
    }
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') prev = ch;
  });
  parts.push(body.slice(last));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Build a fast index -> 1-based line number lookup. */
export function makeLineIndex(source: string): (index: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return (index: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ---------------------------------------------------------------------------
// Object-literal scanning
// ---------------------------------------------------------------------------

export interface ObjectLiteral {
  id: number;
  /** Id of the nearest enclosing object literal, when there is one. */
  parent?: number;
  /** Id of the nearest enclosing array literal, when there is one. */
  array?: number;
  /** Character offset of the opening brace. */
  index: number;
  /** 1-based line of the opening brace. */
  line: number;
  /** Nearest preceding binding name (`const tabs = [` -> `tabs`). */
  owner?: string;
  /** Properties whose value is a plain string literal. */
  props: Record<string, string>;
  /** Properties whose value is an expression, kept as a short raw snippet. */
  refs: Record<string, string>;
}

/** Keys are identifiers or quoted strings; `?` before `:` excludes ternaries. */
const KEY_RE = /(?:(['"])([A-Za-z_$][\w$.\-/]*)\1|([A-Za-z_$][\w$]*))\s*:\s*/g;

/**
 * Names that can own an array/object literal. Covers `const x =`, `x =`,
 * `x: [` (a nested property) and `function x(`.
 */
const OWNER_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]{0,120})?=|([A-Za-z_$][\w$]*)\s*:\s*\[|([A-Za-z_$][\w$]*)\s*=\s*[[{]/g;

const MAX_RAW_VALUE = 160;

function readLiteralValue(source: string, at: number): { literal?: string; raw: string; end: number } {
  const ch = source[at];
  if (ch === '"' || ch === "'") {
    const end = skipQuoted(source, at, ch);
    const raw = source.slice(at, end);
    const inner = raw.slice(1, raw.endsWith(ch) ? -1 : undefined);
    return { literal: unescapeLiteral(inner), raw, end };
  }
  if (ch === '`') {
    const end = skipTemplate(source, at);
    const raw = source.slice(at, end);
    const inner = raw.slice(1, raw.endsWith('`') ? -1 : undefined);
    // Interpolated templates are not usable as literals.
    if (inner.includes('${')) return { raw: raw.slice(0, MAX_RAW_VALUE), end };
    return { literal: unescapeLiteral(inner), raw, end };
  }
  let depth = 0;
  let end = source.length;
  forEachCodeChar(
    source,
    (i, c) => {
      if (i === at) {
        if (c === '{' || c === '[' || c === '(') depth++;
        return;
      }
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') {
        if (depth === 0) {
          end = i;
          return false;
        }
        depth--;
      } else if (depth === 0 && (c === ',' || c === '\n')) {
        end = i;
        return false;
      }
      if (i - at > MAX_RAW_VALUE) {
        end = i;
        return false;
      }
    },
    at,
  );
  return { raw: source.slice(at, end).trim(), end };
}

function unescapeLiteral(input: string): string {
  return input.replace(/\\(["'`\\nrt])/g, (_m, c: string) =>
    c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c,
  );
}

/**
 * Find object literals and their string-valued properties.
 *
 * This one primitive powers route arrays (`{ path, element, children }`),
 * nav/tab arrays (`{ id, label }`) and Angular/Vue router configs. Nesting is
 * recorded so a child route's path can be joined onto its parent's.
 */
export function scanObjectLiterals(source: string, options: { maxObjects?: number } = {}): ObjectLiteral[] {
  const maxObjects = options.maxObjects ?? 1500;
  const len = source.length;
  if (len === 0) return [];

  const objAt = new Int32Array(len).fill(-1);
  const code = new Uint8Array(len);
  const objects: ObjectLiteral[] = [];
  const arrayIndexes: number[] = [];
  const lineOf = makeLineIndex(source);

  const kindStack: Array<'obj' | 'arr' | 'paren'> = [];
  const objStack: number[] = [];
  const arrStack: number[] = [];

  forEachCodeChar(source, (i, ch) => {
    code[i] = 1;
    if (ch === '{') {
      const parent = objStack[objStack.length - 1];
      const array = arrStack[arrStack.length - 1];
      const id = objects.length;
      if (id >= maxObjects) return false;
      objects.push({
        id,
        parent,
        array,
        index: i,
        line: lineOf(i),
        props: {},
        refs: {},
      });
      kindStack.push('obj');
      objStack.push(id);
    } else if (ch === '[') {
      const id = arrayIndexes.length;
      arrayIndexes.push(i);
      kindStack.push('arr');
      arrStack.push(id);
    } else if (ch === '(') {
      kindStack.push('paren');
    } else if (ch === '}' || ch === ']' || ch === ')') {
      const want = ch === '}' ? 'obj' : ch === ']' ? 'arr' : 'paren';
      if (kindStack[kindStack.length - 1] === want) {
        kindStack.pop();
        if (want === 'obj') objStack.pop();
        else if (want === 'arr') arrStack.pop();
      }
      // A mismatched close means we mis-scanned something; ignoring it keeps
      // the rest of the file usable instead of collapsing every scope.
    }
    objAt[i] = objStack[objStack.length - 1] ?? -1;
  });

  if (objects.length === 0) return [];

  // Owner bindings, for naming nav groups after their variable.
  const owners: Array<{ index: number; name: string }> = [];
  OWNER_RE.lastIndex = 0;
  for (let m = OWNER_RE.exec(source); m; m = OWNER_RE.exec(source)) {
    if (code[m.index] !== 1) continue;
    const name = m[1] ?? m[2] ?? m[3];
    if (name) owners.push({ index: m.index, name });
  }

  KEY_RE.lastIndex = 0;
  for (let m = KEY_RE.exec(source); m; m = KEY_RE.exec(source)) {
    const start = m.index;
    if (code[start] !== 1) continue;
    const objectId = objAt[start] ?? -1;
    if (objectId < 0) continue;
    // Only accept a key that opens a property: preceded by `{` or `,`.
    let p = start - 1;
    while (p >= 0 && /\s/.test(source[p] as string)) p--;
    const before = p >= 0 ? (source[p] as string) : '{';
    if (before !== '{' && before !== ',') continue;

    const key = m[2] ?? m[3];
    if (!key) continue;
    const object = objects[objectId];
    if (!object) continue;

    const value = readLiteralValue(source, KEY_RE.lastIndex);
    if (value.literal !== undefined) object.props[key] = value.literal;
    else if (value.raw) object.refs[key] = value.raw;
    // Scanning continues *inside* the value rather than past it: a nested
    // `children: [{ path: 'advanced' }]` must still be seen. Keys that occur
    // inside string literals are rejected by the code mask above.
  }

  for (const object of objects) {
    const anchor = object.array !== undefined ? (arrayIndexes[object.array] ?? object.index) : object.index;
    object.owner = nearestOwner(owners, anchor);
  }
  return objects;
}

function nearestOwner(owners: Array<{ index: number; name: string }>, anchor: number): string | undefined {
  let lo = 0;
  let hi = owners.length - 1;
  let found: string | undefined;
  let foundIndex = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = owners[mid];
    if (!entry) break;
    if (entry.index < anchor) {
      found = entry.name;
      foundIndex = entry.index;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // A binding thousands of characters away is unrelated.
  if (found && anchor - foundIndex <= 2000) return found;
  return undefined;
}

/** Collect sibling object literals that live in the same array literal. */
export function groupByArray(objects: readonly ObjectLiteral[]): Map<number, ObjectLiteral[]> {
  const groups = new Map<number, ObjectLiteral[]>();
  for (const object of objects) {
    if (object.array === undefined) continue;
    const list = groups.get(object.array);
    if (list) list.push(object);
    else groups.set(object.array, [object]);
  }
  return groups;
}
