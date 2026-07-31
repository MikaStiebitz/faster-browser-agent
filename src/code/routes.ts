/**
 * Route extraction (L3).
 *
 * This is the module that makes the agent fast on deep configuration UIs.
 * Instead of `click Settings -> snapshot -> click Advanced -> snapshot -> click
 * Networking -> snapshot` (three round trips and three full perceptions), the
 * agent reads the route map once and navigates straight to
 * `/settings/advanced/networking`.
 *
 * Two extraction strategies, picked per framework:
 *   - file-system routing (Next, SvelteKit, Nuxt, Astro, Remix) is derived from
 *     file PATHS, which costs nothing beyond the scan we already did;
 *   - declarative routing (React Router, Vue Router, Angular, Django, Rails,
 *     Flask/FastAPI) is derived by regex + brace scanning over file CONTENT.
 *
 * Deliberately no AST parser: see the note in `scan.ts`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { RouteEntry, UiFramework } from '../types.js';
import { normalizeText } from '../util/text.js';
import {
  isTestPath,
  makeLineIndex,
  readSources,
  scanObjectLiterals,
  type ObjectLiteral,
  type ScannedFile,
  type SourceFile,
} from './scan.js';

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

const DEP_FRAMEWORKS: Array<{ dep: RegExp; framework: UiFramework }> = [
  { dep: /^@sveltejs\/kit$/, framework: 'sveltekit' },
  { dep: /^(nuxt|nuxt3|nuxt-edge)$/, framework: 'nuxt' },
  { dep: /^astro$/, framework: 'astro' },
  { dep: /^@remix-run\/(react|node|serve)$/, framework: 'remix' },
  { dep: /^@angular\/(core|router)$/, framework: 'angular' },
  { dep: /^(solid-start|@solidjs\/start)$/, framework: 'solid-start' },
  { dep: /^vue-router$/, framework: 'vue-router' },
  { dep: /^react-router(-dom)?$/, framework: 'react-router' },
  { dep: /^express$/, framework: 'express' },
];

/** Small manifests we are willing to read synchronously during detection. */
const MANIFESTS = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'Gemfile'];

function readTextSafe(path: string, maxBytes = 64 * 1024): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const text = readFileSync(path, 'utf8');
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    return undefined;
  }
}

function readPackageJson(root: string): Record<string, unknown> | undefined {
  const text = readTextSafe(join(root, 'package.json'));
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* a broken package.json must not break indexing */
  }
  return undefined;
}

function dependencyNames(packageJson: Record<string, unknown> | undefined): Set<string> {
  const names = new Set<string>();
  if (!packageJson) return names;
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const section = packageJson[key];
    if (section && typeof section === 'object') {
      for (const name of Object.keys(section as Record<string, unknown>)) names.add(name);
    }
  }
  return names;
}

/**
 * Identify which UI frameworks the workspace uses.
 *
 * Path evidence outranks dependency evidence: a repo can depend on `next` and
 * still route with the pages router, and monorepos list dependencies they do
 * not use in the directory being indexed.
 */
export function detectFrameworks(
  root: string,
  files: ScannedFile[],
  packageJson?: Record<string, unknown>,
): UiFramework[] {
  const abs = resolve(root);
  const pkg = packageJson ?? readPackageJson(abs);
  const deps = dependencyNames(pkg);
  const found = new Set<UiFramework>();

  for (const file of files) {
    const rel = file.rel;
    if (/^(src\/)?app\/.*page\.(tsx|ts|jsx|js|mjs)$/.test(rel)) found.add('next-app');
    else if (/^(src\/)?pages\/.*\.(tsx|ts|jsx|js|mjs)$/.test(rel) && deps.has('next')) found.add('next-pages');
    if (/^src\/routes\/.*\+page\.(svelte|ts|js)$/.test(rel)) found.add('sveltekit');
    if (/^(src\/)?pages\/.*\.vue$/.test(rel)) found.add('nuxt');
    if (/^src\/pages\/.*\.astro$/.test(rel)) found.add('astro');
    if (/^app\/routes\//.test(rel) && /\.(tsx|ts|jsx|js)$/.test(rel)) found.add('remix');
    if (rel === 'angular.json') found.add('angular');
    if (rel === 'nuxt.config.ts' || rel === 'nuxt.config.js') found.add('nuxt');
    if (rel === 'astro.config.mjs' || rel === 'astro.config.ts' || rel === 'astro.config.js') found.add('astro');
    if (rel === 'manage.py' || /(^|\/)urls\.py$/.test(rel)) found.add('django');
    if (rel === 'config/routes.rb') found.add('rails');
  }

  for (const { dep, framework } of DEP_FRAMEWORKS) {
    for (const name of deps) {
      if (dep.test(name)) found.add(framework);
    }
  }
  if (deps.has('next') && !found.has('next-app') && !found.has('next-pages')) found.add('next-pages');

  // Python/Ruby projects have no package.json; their manifests are tiny.
  for (const manifest of MANIFESTS) {
    const text = readTextSafe(join(abs, manifest), 16 * 1024);
    if (!text) continue;
    if (/(^|[^\w])fastapi/i.test(text)) found.add('fastapi');
    if (/(^|[^\w])flask/i.test(text)) found.add('flask');
    if (/(^|[^\w])django/i.test(text)) found.add('django');
    if (/(^|[^\w])rails/i.test(text)) found.add('rails');
  }

  // React Router ships inside Remix/Next-less SPAs; keep it only when there is
  // no file-system router that would already own the same paths.
  if (found.size === 0) return ['unknown'];
  return [...found];
}

// ---------------------------------------------------------------------------
// Pattern helpers
// ---------------------------------------------------------------------------

const WORD_BOUNDARY = /[-_\s]+/;

/** `advanced-networking` -> `Advanced Networking`. */
export function titleCase(input: string): string {
  const cleaned = input.replace(/[[\]{}<>:*$]/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned
    .split(WORD_BOUNDARY)
    .filter(Boolean)
    .map((word) => {
      // Preserve intentionally-capitalised words like "API" or "SMTP".
      if (word.length > 1 && word === word.toUpperCase()) return word;
      const spaced = word.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
      return spaced
        .split(' ')
        .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
        .join(' ');
    })
    .join(' ');
}

interface SegmentOptions {
  /** Nuxt v2 style `_id.vue`. */
  underscoreParams?: boolean;
}

interface ConvertedSegment {
  /** Emitted path segment, or undefined when the segment is not routable. */
  out?: string;
  param?: string;
}

function convertSegment(segment: string, options: SegmentOptions = {}): ConvertedSegment {
  if (!segment) return {};
  // Route groups `(marketing)` and parallel routes `@modal` are organisational.
  if (/^\(.*\)$/.test(segment)) return {};
  if (segment.startsWith('@')) return {};
  if (segment === '.' || segment === '..') return {};

  let m = /^\[\[?\.\.\.([^\]]+)\]?\]$/.exec(segment);
  if (m && m[1]) return { out: '*', param: m[1] };
  m = /^\[([^\]]+)\]$/.exec(segment);
  if (m && m[1]) {
    const name = m[1].replace(/^\.\.\./, '');
    return { out: `:${name}`, param: name };
  }
  if (options.underscoreParams && segment.startsWith('_') && segment.length > 1) {
    const name = segment.slice(1);
    return { out: `:${name}`, param: name };
  }
  return { out: segment };
}

function buildPattern(segments: string[], options: SegmentOptions = {}): { pattern: string; params: string[] } {
  const out: string[] = [];
  const params: string[] = [];
  for (const segment of segments) {
    const converted = convertSegment(segment, options);
    if (!converted.out) continue;
    out.push(converted.out);
    if (converted.param) params.push(converted.param);
  }
  return { pattern: out.length === 0 ? '/' : `/${out.join('/')}`, params };
}

/** Normalise any route string to a leading-slash, no-trailing-slash form. */
export function normalizePattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (!trimmed) return '/';
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const collapsed = withSlash.replace(/\/{2,}/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) return collapsed.slice(0, -1);
  return collapsed;
}

/**
 * Reject "routes" that are really regex or glob source text.
 *
 * We extract declarative routes with regexes over source, which is fast and
 * framework-agnostic but occasionally matches a string that merely *looks* like
 * a route — a pattern literal inside a router library, a `path.join` argument,
 * a glob. A bogus route is worse than a missing one: `browser_open {route}`
 * would deep-link somewhere that does not exist, and the agent pays a failed
 * navigation to find out.
 */
export function isPlausibleRoute(pattern: string): boolean {
  if (!pattern.startsWith('/')) return false;
  if (pattern.length > 200) return false;
  // Regex metacharacters that no real URL path carries. `*` and `:`/`[]`/`{}`
  // are excluded from this list — they are legitimate dynamic-segment syntax.
  if (/[\\|()^$+?<>"'`\s]/.test(pattern.replace(/<[a-z_]+:[a-z_]+>/gi, ''))) return false;
  // A bare "/..." or "/.." is spread/parent-dir syntax, never a route.
  if (/(^|\/)\.{2,}(\/|$)/.test(pattern)) return false;
  // Character classes and quantifiers leaking out of a regex literal.
  if (/\[\^|\]\*|\)\*|\.\*/.test(pattern)) return false;
  return true;
}

/** Dynamic segment names in a pattern, in order. */
export function patternParams(pattern: string): string[] {
  const params: string[] = [];
  for (const segment of pattern.split('/')) {
    if (segment.startsWith(':')) params.push(segment.slice(1).replace(/[?*+]$/, ''));
    else if (segment.startsWith('*') && segment.length > 1) params.push(segment.slice(1));
    else if (/^\[.*\]$/.test(segment)) params.push(segment.replace(/^\[+\.?\.?\.?|\]+$/g, ''));
    else if (/^\{.*\}$/.test(segment)) params.push(segment.slice(1, -1).split(':').pop() ?? '');
    else if (/^<.*>$/.test(segment)) params.push(segment.slice(1, -1).split(':').pop() ?? '');
  }
  return params.filter(Boolean);
}

/**
 * Substitute params into a route pattern.
 *
 * Understands every dynamic-segment dialect we extract (`:id`, `[id]`,
 * `[...slug]`, `{id}`, `<int:id>`) so a caller can pass whichever form it read
 * out of the index. Unknown params are left in place — a visibly unresolved
 * URL is far more debuggable than a silently wrong one.
 */
export function routeToPath(pattern: string, params?: Record<string, string>): string {
  const values = params ?? {};
  const segments = normalizePattern(pattern).split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment) continue;
    const name = paramNameOf(segment);
    if (name === undefined) {
      out.push(segment);
      continue;
    }
    const value = values[name] ?? (segment.startsWith('*') || name === '*' ? values['*'] : undefined);
    if (value === undefined || value === '') {
      out.push(segment);
      continue;
    }
    // Catch-alls may legitimately carry slashes.
    const encoded = value
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    out.push(encoded);
  }
  return out.length === 0 ? '/' : `/${out.join('/')}`;
}

function paramNameOf(segment: string): string | undefined {
  if (segment === '*') return '*';
  if (segment.startsWith(':')) return segment.slice(1).replace(/[?*+]$/, '');
  if (segment.startsWith('*')) return segment.slice(1);
  let m = /^\[\[?\.\.\.([^\]]+)\]?\]$/.exec(segment);
  if (m && m[1]) return m[1];
  m = /^\[([^\]]+)\]$/.exec(segment);
  if (m && m[1]) return m[1];
  m = /^\{([^}]+)\}$/.exec(segment);
  if (m && m[1]) return m[1].split(':').pop();
  m = /^<([^>]+)>$/.exec(segment);
  if (m && m[1]) return m[1].split(':').pop();
  return undefined;
}

/**
 * Rewrite `{id}` (FastAPI), `<int:pk>` (Django/Flask) and `[id]` segments as
 * `:id`, so the whole index speaks one dialect regardless of source language.
 */
export function normalizeDynamicSegments(pattern: string): string {
  return normalizePattern(pattern)
    .split('/')
    .map((segment) => {
      if (!segment || segment.startsWith(':') || segment.startsWith('*')) return segment;
      const name = paramNameOf(segment);
      return name === undefined ? segment : `:${name}`;
    })
    .join('/');
}

/** True when the pattern still contains a dynamic segment. */
export function hasUnresolvedParams(path: string): boolean {
  return path.split('/').some((segment) => paramNameOf(segment) !== undefined);
}

function labelFromPattern(pattern: string): string | undefined {
  const segments = normalizePattern(pattern)
    .split('/')
    .filter((s) => s && paramNameOf(s) === undefined);
  const last = segments[segments.length - 1];
  if (!last) return 'Home';
  return titleCase(last) || undefined;
}

// ---------------------------------------------------------------------------
// File-system routing
// ---------------------------------------------------------------------------

interface FsRoute {
  pattern: string;
  params: string[];
  framework: UiFramework;
}

function nextAppRoute(rel: string): FsRoute | undefined {
  const m = /^(?:src\/)?app\/(.*)page\.(?:tsx|ts|jsx|js|mjs)$/.exec(rel);
  if (!m) return undefined;
  const dirs = (m[1] ?? '').split('/').filter(Boolean);
  // `_private` folders opt out of routing entirely.
  if (dirs.some((d) => d.startsWith('_'))) return undefined;
  const { pattern, params } = buildPattern(dirs);
  return { pattern, params, framework: 'next-app' };
}

function nextPagesRoute(rel: string): FsRoute | undefined {
  const m = /^(?:src\/)?pages\/(.*)\.(?:tsx|ts|jsx|js|mjs)$/.exec(rel);
  if (!m) return undefined;
  const parts = (m[1] ?? '').split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return undefined;
  if (parts[0] === 'api') return undefined;
  if (/^_(app|document|error|middleware)$/.test(last)) return undefined;
  const segments = last === 'index' ? parts.slice(0, -1) : parts;
  const { pattern, params } = buildPattern(segments);
  return { pattern, params, framework: 'next-pages' };
}

function svelteKitRoute(rel: string): FsRoute | undefined {
  const m = /^src\/routes\/(.*)\+page(?:@[\w-]*)?\.svelte$/.exec(rel);
  if (!m) return undefined;
  const dirs = (m[1] ?? '').split('/').filter(Boolean);
  const { pattern, params } = buildPattern(dirs);
  return { pattern, params, framework: 'sveltekit' };
}

function nuxtRoute(rel: string): FsRoute | undefined {
  const m = /^(?:src\/)?pages\/(.*)\.vue$/.exec(rel);
  if (!m) return undefined;
  const parts = (m[1] ?? '').split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return undefined;
  const segments = last === 'index' ? parts.slice(0, -1) : parts;
  const { pattern, params } = buildPattern(segments, { underscoreParams: true });
  return { pattern, params, framework: 'nuxt' };
}

function astroRoute(rel: string): FsRoute | undefined {
  const m = /^src\/pages\/(.*)\.astro$/.exec(rel);
  if (!m) return undefined;
  const parts = (m[1] ?? '').split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return undefined;
  const segments = last === 'index' ? parts.slice(0, -1) : parts;
  const { pattern, params } = buildPattern(segments);
  return { pattern, params, framework: 'astro' };
}

/**
 * Remix flat routes: `app/routes/settings.advanced.tsx` -> `/settings/advanced`.
 * Also handles the folder form `app/routes/settings.advanced/route.tsx`.
 */
function remixRoute(rel: string): FsRoute | undefined {
  const m = /^app\/routes\/(.*)\.(?:tsx|ts|jsx|js)$/.exec(rel);
  if (!m) return undefined;
  let flat = m[1] ?? '';
  if (!flat) return undefined;
  if (flat.endsWith('/route') || flat.endsWith('/index')) flat = flat.slice(0, flat.lastIndexOf('/'));
  // Nested directories are only used for colocation; the route name is flat.
  const name = flat.includes('/') ? (flat.split('/').pop() ?? flat) : flat;
  if (!name || name.startsWith('__')) return undefined;

  const out: string[] = [];
  const params: string[] = [];
  for (const raw of name.split('.')) {
    if (!raw) continue;
    if (raw === '_index') continue;
    // A leading `_` marks a pathless layout route.
    if (raw.startsWith('_')) continue;
    if (raw === '$') {
      out.push('*');
      params.push('*');
      continue;
    }
    if (raw.startsWith('$')) {
      const param = raw.slice(1);
      out.push(`:${param}`);
      params.push(param);
      continue;
    }
    out.push(raw.replace(/^\[|\]$/g, ''));
  }
  return { pattern: out.length === 0 ? '/' : `/${out.join('/')}`, params, framework: 'remix' };
}

const FS_EXTRACTORS: Array<(rel: string) => FsRoute | undefined> = [
  nextAppRoute,
  nextPagesRoute,
  svelteKitRoute,
  nuxtRoute,
  astroRoute,
  remixRoute,
];

// ---------------------------------------------------------------------------
// Declarative routing
// ---------------------------------------------------------------------------

const JSX_ROUTE_RE =
  /<Route\b[^>]*?\bpath\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:'([^']*)'|"([^"]*)")\s*\})([^>]*)>/g;
const JSX_ELEMENT_RE = /\b(?:element|component|Component)\s*=\s*\{?\s*<?\s*([A-Z][\w$]*)/;

const PY_ROUTE_RE = /@(\w+)\.(route|get|post|put|patch|delete|websocket)\(\s*(?:r?["']([^"']+)["'])/g;
const DJANGO_ROUTE_RE = /\b(?:re_path|path|url)\(\s*r?["']([^"']*)["']\s*,([^),]*)/g;
const RAILS_VERB_RE = /^\s*(get|post|put|patch|delete)\s+["']([^"']+)["']/gm;
const RAILS_RESOURCE_RE = /^\s*(resources?)\s+:([\w_]+)/gm;
const RAILS_ROOT_RE = /^\s*root\s+(?:to:\s*)?["']([^"']+)["']/m;

/** Which declarative router (if any) a file defines. */
function routerFlavor(content: string, frameworks: readonly UiFramework[]): UiFramework | undefined {
  if (/RouterModule\s*\.\s*for(?:Root|Child)\s*\(|:\s*Routes\s*=/.test(content)) return 'angular';
  if (/from\s+['"]vue-router['"]|createRouter\s*\(\s*\{/.test(content)) return 'vue-router';
  if (/createBrowserRouter|createHashRouter|createMemoryRouter|from\s+['"]react-router(?:-dom)?['"]|<Route\b/.test(content)) {
    return 'react-router';
  }
  // A bare `routes` array in a project that only uses one of these is still
  // worth reading; ambiguity is resolved by the detected framework list.
  if (frameworks.includes('vue-router') && /\bcomponent\s*:/.test(content)) return 'vue-router';
  if (frameworks.includes('react-router') && /\belement\s*:/.test(content)) return 'react-router';
  if (frameworks.includes('angular') && /\bcomponent\s*:/.test(content)) return 'angular';
  return undefined;
}

function joinRoutePath(parent: string, child: string): string {
  if (child.startsWith('/')) return normalizePattern(child);
  if (!child) return normalizePattern(parent);
  return normalizePattern(`${parent}/${child}`);
}

/** Resolve a route object's full path by walking its parent chain. */
function objectRoutePath(object: ObjectLiteral, byId: Map<number, ObjectLiteral>): string | undefined {
  const own = object.props['path'];
  if (own === undefined) return undefined;
  const chain: string[] = [own];
  let cursor = object.parent;
  let guard = 0;
  while (cursor !== undefined && guard++ < 16) {
    const parent = byId.get(cursor);
    if (!parent) break;
    const parentPath = parent.props['path'];
    if (parentPath !== undefined) {
      chain.unshift(parentPath);
      if (parentPath.startsWith('/')) break;
    }
    cursor = parent.parent;
  }
  let path = '';
  for (const part of chain) path = joinRoutePath(path, part);
  return path;
}

function objectRouteLabel(object: ObjectLiteral): string | undefined {
  const explicit = object.props['name'] ?? object.props['title'] ?? object.props['label'];
  if (explicit) return normalizeText(explicit);
  const component = object.refs['element'] ?? object.refs['component'] ?? object.refs['Component'];
  if (component) {
    const m = /([A-Z][\w$]*)/.exec(component);
    if (m && m[1]) return titleCase(m[1]);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Extraction entry point
// ---------------------------------------------------------------------------

const CONTENT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb']);

/** Files worth reading for declarative routes; cheap pre-filter on the path. */
function mayDeclareRoutes(file: ScannedFile): boolean {
  // Route tables asserted on inside a test suite are fixtures, not the app's
  // navigation, and indexing them puts routes that do not exist into the map.
  return CONTENT_EXTS.has(file.ext) && !isTestPath(file.rel);
}

export async function extractRoutes(
  root: string,
  files: ScannedFile[],
  frameworks: UiFramework[],
): Promise<RouteEntry[]> {
  // `root` is part of the extractor signature for symmetry; the scanned files
  // already carry absolute paths, so nothing here needs to re-derive them.
  void root;
  const out: RouteEntry[] = [];
  const seen = new Set<string>();

  const add = (entry: RouteEntry): void => {
    const key = normalizePattern(entry.pattern);
    if (seen.has(key)) return;
    // Single choke point for both file-system and declarative routes, so a
    // regex literal that merely looks like a path cannot reach the index.
    if (!isPlausibleRoute(key)) return;
    seen.add(key);
    out.push({ ...entry, pattern: key });
  };

  // --- file-system routes ---------------------------------------------------
  const fsMatches: Array<{ file: ScannedFile; route: FsRoute }> = [];
  for (const file of files) {
    for (const extractor of FS_EXTRACTORS) {
      const route = extractor(file.rel);
      if (route) {
        fsMatches.push({ file, route });
        break;
      }
    }
  }

  // Only the matched route files are read, and only to recover a nicer label.
  const routeSources = new Map<string, string>();
  if (fsMatches.length > 0) {
    const sources = await readSources(
      fsMatches.map((m) => m.file),
      { concurrency: 16 },
    );
    for (const source of sources) routeSources.set(source.rel, source.content);
  }

  for (const { file, route } of fsMatches) {
    const label = labelFromPattern(route.pattern) ?? labelFromSource(routeSources.get(file.rel), file.rel);
    add({
      pattern: route.pattern,
      params: route.params,
      framework: route.framework,
      source: `${file.rel}:1`,
      label,
    });
  }

  // --- declarative routes ---------------------------------------------------
  const contentFiles = files.filter(mayDeclareRoutes);
  const sources = await readSources(contentFiles, { concurrency: 16 });
  for (const source of sources) {
    if (source.ext === '.py') extractPythonRoutes(source, add);
    else if (source.ext === '.rb') extractRailsRoutes(source, add);
    else extractJsRoutes(source, frameworks, add);
  }

  // A deterministic order keeps the persisted index stable across rebuilds.
  out.sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  return out;
}

function labelFromSource(content: string | undefined, rel: string): string | undefined {
  if (content) {
    const m = /export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(content);
    if (m && m[1]) return titleCase(m[1].replace(/Page$/, ''));
  }
  const base = basename(rel).replace(/\.[^.]+$/, '');
  return titleCase(base) || undefined;
}

function extractJsRoutes(source: SourceFile, frameworks: readonly UiFramework[], add: (entry: RouteEntry) => void): void {
  const content = source.content;
  const flavor = routerFlavor(content, frameworks);
  if (!flavor) return;
  const lineOf = makeLineIndex(content);

  // JSX <Route path="..."> declarations.
  if (content.includes('<Route')) {
    JSX_ROUTE_RE.lastIndex = 0;
    for (let m = JSX_ROUTE_RE.exec(content); m; m = JSX_ROUTE_RE.exec(content)) {
      const raw = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (raw === undefined) continue;
      const pattern = normalizePattern(raw);
      const rest = m[5] ?? '';
      const elementMatch = JSX_ELEMENT_RE.exec(rest);
      const label = elementMatch && elementMatch[1] ? titleCase(elementMatch[1]) : labelFromPattern(pattern);
      add({
        pattern,
        params: patternParams(pattern),
        framework: 'react-router',
        source: `${source.rel}:${lineOf(m.index)}`,
        label,
      });
    }
  }

  // Object-literal route tables (createBrowserRouter, Vue Router, Angular).
  if (!/\bpath\s*:/.test(content)) return;
  const objects = scanObjectLiterals(content);
  if (objects.length === 0) return;
  const byId = new Map<number, ObjectLiteral>();
  for (const object of objects) byId.set(object.id, object);

  for (const object of objects) {
    const path = objectRoutePath(object, byId);
    if (path === undefined) continue;
    // Guard against `path:` in unrelated objects (webpack aliases, fs paths).
    if (/[\\]|^\.\.?\//.test(object.props['path'] ?? '')) continue;
    add({
      pattern: path,
      params: patternParams(path),
      framework: flavor,
      source: `${source.rel}:${object.line}`,
      label: objectRouteLabel(object) ?? labelFromPattern(path),
    });
  }
}

function extractPythonRoutes(source: SourceFile, add: (entry: RouteEntry) => void): void {
  const content = source.content;
  const lineOf = makeLineIndex(content);
  const isDjangoUrls = /(^|\/)urls\.py$/.test(source.rel);

  if (isDjangoUrls) {
    DJANGO_ROUTE_RE.lastIndex = 0;
    for (let m = DJANGO_ROUTE_RE.exec(content); m; m = DJANGO_ROUTE_RE.exec(content)) {
      const raw = m[1];
      if (raw === undefined) continue;
      // Django regex routes carry anchors and groups we cannot navigate to.
      const cleaned = raw.replace(/^\^/, '').replace(/\$$/, '');
      if (/[()\\|+?]/.test(cleaned)) continue;
      const pattern = normalizeDynamicSegments(normalizePattern(cleaned));
      add({
        pattern,
        params: patternParams(pattern),
        framework: 'django',
        source: `${source.rel}:${lineOf(m.index)}`,
        label: labelFromPattern(pattern),
      });
    }
    return;
  }

  const framework: UiFramework = /FastAPI\(|APIRouter\(|from\s+fastapi/.test(content) ? 'fastapi' : 'flask';
  PY_ROUTE_RE.lastIndex = 0;
  for (let m = PY_ROUTE_RE.exec(content); m; m = PY_ROUTE_RE.exec(content)) {
    const raw = m[3];
    if (raw === undefined) continue;
    const pattern = normalizeDynamicSegments(normalizePattern(raw));
    add({
      pattern,
      params: patternParams(pattern),
      framework,
      source: `${source.rel}:${lineOf(m.index)}`,
      label: labelFromPattern(pattern),
    });
  }
}

function extractRailsRoutes(source: SourceFile, add: (entry: RouteEntry) => void): void {
  if (!/routes\.rb$/.test(source.rel)) return;
  const content = source.content;
  const lineOf = makeLineIndex(content);

  RAILS_VERB_RE.lastIndex = 0;
  for (let m = RAILS_VERB_RE.exec(content); m; m = RAILS_VERB_RE.exec(content)) {
    const raw = m[2];
    if (!raw) continue;
    const pattern = normalizePattern(raw);
    add({
      pattern,
      params: patternParams(pattern),
      framework: 'rails',
      source: `${source.rel}:${lineOf(m.index)}`,
      label: labelFromPattern(pattern),
    });
  }

  RAILS_RESOURCE_RE.lastIndex = 0;
  for (let m = RAILS_RESOURCE_RE.exec(content); m; m = RAILS_RESOURCE_RE.exec(content)) {
    const name = m[2];
    if (!name) continue;
    const plural = m[1] === 'resources';
    const line = lineOf(m.index);
    const base = normalizePattern(name);
    // Rails' RESTful defaults are entirely predictable; expanding them gives
    // the agent the deep links without any further reading.
    const generated = plural
      ? [base, `${base}/new`, `${base}/:id`, `${base}/:id/edit`]
      : [base, `${base}/new`, `${base}/edit`];
    for (const pattern of generated) {
      add({
        pattern,
        params: patternParams(pattern),
        framework: 'rails',
        source: `${source.rel}:${line}`,
        label: labelFromPattern(pattern),
      });
    }
  }

  const rootMatch = RAILS_ROOT_RE.exec(content);
  if (rootMatch) {
    add({ pattern: '/', params: [], framework: 'rails', source: `${source.rel}:1`, label: 'Home' });
  }
}

// ---------------------------------------------------------------------------
// Dev-server origin detection
// ---------------------------------------------------------------------------

const FRAMEWORK_PORTS: Record<UiFramework, number> = {
  'next-app': 3000,
  'next-pages': 3000,
  remix: 3000,
  nuxt: 3000,
  express: 3000,
  rails: 3000,
  'react-router': 5173,
  'vue-router': 5173,
  sveltekit: 5173,
  astro: 5173,
  'solid-start': 3000,
  angular: 4200,
  django: 8000,
  flask: 8000,
  fastapi: 8000,
  unknown: 3000,
};

const SCRIPT_PORT_RE = /(?:--port[= ]|(?<![\w-])-p[= ]|\bPORT=)(\d{2,5})/;
const CONFIG_PORT_RE = /\bport\s*[:=]\s*(?:Number\()?\s*['"]?(\d{2,5})/;
const ENV_URL_RE = /^\s*(?:export\s+)?(?:NEXT_PUBLIC_SITE_URL|NEXT_PUBLIC_BASE_URL|PUBLIC_BASE_URL|VITE_BASE_URL|BASE_URL|APP_URL|SITE_URL)\s*=\s*["']?(https?:\/\/[^\s"']+)/m;
const ENV_PORT_RE = /^\s*(?:export\s+)?(?:PORT|VITE_PORT|APP_PORT|SERVER_PORT|DEV_PORT)\s*=\s*["']?(\d{2,5})/m;
const COMPOSE_PORT_RE = /^\s*-\s*["']?(\d{2,5}):(\d{2,5})["']?\s*$/m;

const VITE_CONFIGS = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts'];
const NEXT_CONFIGS = ['next.config.js', 'next.config.mjs', 'next.config.ts'];
const ENV_FILES = ['.env.local', '.env.development.local', '.env.development', '.env'];
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/**
 * Best guess at where the app is served during development.
 *
 * Getting this right matters more than it looks: every deep link the index
 * produces is `baseUrl + route`, so a wrong port turns the whole feature into
 * connection errors. Explicit configuration always beats the framework default.
 */
export function detectBaseUrl(
  root: string,
  packageJson?: Record<string, unknown>,
  files?: ScannedFile[],
): string | undefined {
  const abs = resolve(root);
  const pkg = packageJson ?? readPackageJson(abs);

  // 1. dev/start scripts — the command the developer actually runs.
  const scripts = pkg?.['scripts'];
  if (scripts && typeof scripts === 'object') {
    const table = scripts as Record<string, unknown>;
    for (const name of ['dev', 'start', 'serve', 'dev:web', 'start:dev']) {
      const value = table[name];
      if (typeof value !== 'string') continue;
      const m = SCRIPT_PORT_RE.exec(value);
      if (m && m[1]) return `http://localhost:${m[1]}`;
    }
  }

  // 2. bundler / framework config.
  for (const name of [...VITE_CONFIGS, ...NEXT_CONFIGS]) {
    const text = readTextSafe(join(abs, name));
    if (!text) continue;
    const m = CONFIG_PORT_RE.exec(text);
    if (m && m[1]) return `http://localhost:${m[1]}`;
  }

  // 3. environment files.
  for (const name of ENV_FILES) {
    const text = readTextSafe(join(abs, name), 32 * 1024);
    if (!text) continue;
    const url = ENV_URL_RE.exec(text);
    if (url && url[1]) return url[1].replace(/\/+$/, '');
    const port = ENV_PORT_RE.exec(text);
    if (port && port[1]) return `http://localhost:${port[1]}`;
  }

  // 4. docker-compose host port mapping.
  for (const name of COMPOSE_FILES) {
    const text = readTextSafe(join(abs, name));
    if (!text) continue;
    const m = COMPOSE_PORT_RE.exec(text);
    if (m && m[1]) return `http://localhost:${m[1]}`;
  }

  // 5. framework default.
  const frameworks = detectFrameworks(abs, files ?? [], pkg);
  for (const framework of frameworks) {
    if (framework === 'unknown') continue;
    return `http://localhost:${FRAMEWORK_PORTS[framework]}`;
  }
  return undefined;
}
