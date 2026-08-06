/**
 * The code indexer (L3).
 *
 * Owns the lifecycle of a `CodeIndex`: build, cache in memory, persist to disk,
 * revalidate incrementally, and answer route lookups.
 *
 * Two properties matter more than anything else here:
 *
 *   1. `get()` never throws. The code index is an accelerator, not a
 *      dependency — if a workspace is unreadable, half-written or simply not a
 *      UI project, the browser layer must keep working, so failures degrade to
 *      an empty index and a warning on stderr.
 *   2. Revalidation is cheap. Every tool call may ask for the index, so the
 *      common path is "one directory listing, compare mtimes, done" rather
 *      than a rebuild.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { paths } from '../config.js';
import type { CodeIndexer } from '../contracts.js';
import { workspaceIdFor } from '../browser/profile.js';
import {
  CODE_INDEX_SCHEMA,
  type CodeIndex,
  type CodeMatch,
  type FbaConfig,
  type RouteEntry,
  type RouteRegistryConfig,
} from '../types.js';
import { errorMessage } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { rankMatches } from '../util/text.js';
import { extractConfigFields } from './config-fields.js';
import { absoluteUrl, isConcretePath, searchIndex } from './match.js';
import { detectBaseUrl, detectFrameworks, extractRoutes, normalizePattern, patternParams, routeToPath } from './routes.js';
import { extractRegistryRoutes, extractTranslations } from './registry.js';
import { extractNavGroups, extractSelectors } from './selectors.js';
import { clearSourceCache, scanWorkspace, type ScannedFile } from './scan.js';

const logger = createLogger('code:index');

/** How long a loaded index is trusted before its mtimes are re-checked. */
const REVALIDATE_AFTER_MS = 3_000;

interface CacheEntry {
  index: CodeIndex;
  /** Unix ms of the last successful freshness check. */
  checkedAt: number;
}

export class FsCodeIndexer implements CodeIndexer {
  private readonly config: FbaConfig;
  private readonly memory = new Map<string, CacheEntry>();
  /** De-duplicates concurrent builds of the same workspace. */
  private readonly inFlight = new Map<string, Promise<CodeIndex>>();

  constructor(config: FbaConfig) {
    this.config = config;
  }

  async get(workspaceRoot: string, options: { force?: boolean } = {}): Promise<CodeIndex> {
    const root = resolve(workspaceRoot);
    if (!this.config.codeIndex) return emptyIndex(root);

    const pending = this.inFlight.get(root);
    if (pending && !options.force) return pending;

    const task = this.load(root, options.force === true).catch((e) => {
      logger.warn(`code index unavailable for ${root}: ${errorMessage(e)}`);
      return emptyIndex(root);
    });
    this.inFlight.set(root, task);
    try {
      const index = await task;
      // Explicit configuration outranks inference, and it is applied here so
      // every consumer sees the same origin. It matters most exactly where
      // detection cannot help: a server-rendered monolith has no dev script to
      // read a port from, so the user states the origin and route matches have
      // to honour it.
      return this.config.baseUrl ? { ...index, baseUrl: this.config.baseUrl } : index;
    } finally {
      this.inFlight.delete(root);
    }
  }

  search(index: CodeIndex, query: string, limit?: number): CodeMatch[] {
    return searchIndex(index, query, limit);
  }

  /**
   * Turn a route-ish string into an absolute URL.
   *
   * Accepts what an agent (or a model) actually produces: `/settings/advanced`,
   * `settings/advanced`, a label like `Advanced`, or the raw pattern
   * `/settings/[section]` plus params.
   */
  resolveRoute(index: CodeIndex, route: string, params?: Record<string, string>): string | undefined {
    const query = route.trim();
    if (!query) return undefined;
    // An absolute URL is already resolved; pass it through unchanged.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(query)) return query;

    const baseUrl = this.config.baseUrl ?? index.baseUrl;
    const candidate = normalizePattern(query);
    const canonical = canonicalKey(candidate);

    // 1. exact static route.
    for (const entry of index.routes) {
      if (entry.params.length === 0 && normalizePattern(entry.pattern) === candidate) {
        return finish(baseUrl, entry.pattern, params);
      }
    }

    // 2. the same pattern written in any dialect (`[id]` / `:id` / `{id}`).
    for (const entry of index.routes) {
      if (canonicalKey(entry.pattern) === canonical) {
        return finish(baseUrl, entry.pattern, mergeParams(entry, candidate, params));
      }
    }

    // 3. a concrete path that structurally matches a dynamic route — the
    //    caller already substituted the values, so use them as given.
    for (const entry of index.routes) {
      if (entry.params.length === 0) continue;
      if (structurallyMatches(entry.pattern, candidate)) return finish(baseUrl, candidate, params);
    }

    // 4. fuzzy match on human labels ("Advanced", "Networking settings").
    const ranked = rankMatches(
      query,
      index.routes,
      (entry) => [entry.label, entry.pattern, entry.pattern.split('/').filter(Boolean).pop()],
      { limit: 1, minScore: 0.55 },
    );
    const bestEntry = ranked[0]?.item;
    if (bestEntry) return finish(baseUrl, bestEntry.pattern, params);

    return undefined;
  }

  invalidate(workspaceRoot?: string): void {
    if (!workspaceRoot) {
      this.memory.clear();
      return;
    }
    const root = resolve(workspaceRoot);
    this.memory.delete(root);
    const file = this.cacheFile(root);
    // Best-effort: a stale file simply loses the mtime comparison next time.
    void rm(file, { force: true }).catch(() => undefined);
  }

  // -------------------------------------------------------------------------

  private cacheFile(root: string): string {
    return join(paths(this.config).indexes, `${workspaceIdFor(root)}.json`);
  }

  private async load(root: string, force: boolean): Promise<CodeIndex> {
    const now = Date.now();
    const cached = this.memory.get(root);
    if (!force && cached && now - cached.checkedAt < REVALIDATE_AFTER_MS) return cached.index;

    const files = await scanWorkspace(root);

    if (!force) {
      const candidate = cached?.index ?? (await this.readCacheFile(root));
      if (candidate && candidate.schema === CODE_INDEX_SCHEMA && isFresh(candidate, files)) {
        this.memory.set(root, { index: candidate, checkedAt: now });
        return candidate;
      }
    }

    const index = await buildIndex(root, files, this.config.routeRegistry);
    this.memory.set(root, { index, checkedAt: Date.now() });
    await this.persist(root, index);
    return index;
  }

  private async readCacheFile(root: string): Promise<CodeIndex | undefined> {
    try {
      const raw = await readFile(this.cacheFile(root), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return undefined;
      const index = parsed as CodeIndex;
      if (index.schema !== CODE_INDEX_SCHEMA) return undefined;
      if (!Array.isArray(index.routes) || !index.files || typeof index.files !== 'object') return undefined;
      // The cached root must match; profiles are keyed by hash but a collision
      // or a moved directory would otherwise serve someone else's index.
      if (resolve(index.workspaceRoot) !== root) return undefined;
      return index;
    } catch {
      return undefined;
    }
  }

  private async persist(root: string, index: CodeIndex): Promise<void> {
    const file = this.cacheFile(root);
    try {
      await mkdir(paths(this.config).indexes, { recursive: true });
      // Write-then-rename: a reader must never observe a half-written index,
      // and several agents may be indexing sibling worktrees concurrently.
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(index), 'utf8');
      await rename(tmp, file);
    } catch (e) {
      logger.warn(`could not persist code index for ${root}: ${errorMessage(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export async function buildIndex(
  root: string,
  files?: ScannedFile[],
  registries?: RouteRegistryConfig | RouteRegistryConfig[],
): Promise<CodeIndex> {
  const started = Date.now();
  const scanned = files ?? (await scanWorkspace(root));
  const packageJson = await readPackageJson(root);
  const frameworks = detectFrameworks(root, scanned, packageJson);

  // The extractors are independent and I/O bound; running them together, on
  // top of the shared source cache, keeps a full rebuild to roughly one read
  // pass over the workspace.
  // A configured registry is authoritative for apps the built-ins cannot see,
  // so its routes are merged in rather than replacing anything: a repo can have
  // both a framework router and a legacy menu table.
  const registryList = registries ? (Array.isArray(registries) ? registries : [registries]) : [];

  const [routes, registryRoutes, translations, selectors, navGroups, configFields] = await Promise.all([
    extractRoutes(root, scanned, frameworks),
    extractRegistryRoutes(scanned, registryList),
    extractTranslations(scanned),
    extractSelectors(root, scanned),
    extractNavGroups(root, scanned),
    extractConfigFields(root, scanned),
  ]);
  const allRoutes = mergeRoutes(routes, registryRoutes);
  // Nothing else needs the file bodies; a long-lived server should not hold
  // tens of megabytes of source until the cache ages out.
  clearSourceCache();

  const fileMap: Record<string, number> = {};
  for (const file of scanned) fileMap[file.rel] = file.mtimeMs;

  return {
    workspaceRoot: resolve(root),
    builtAt: Date.now(),
    schema: CODE_INDEX_SCHEMA,
    frameworks,
    baseUrl: detectBaseUrl(root, packageJson, scanned),
    routes: allRoutes,
    translations,
    selectors,
    configFields,
    navGroups,
    files: fileMap,
    stats: { filesScanned: scanned.length, buildMs: Date.now() - started },
  };
}

/** A usable, empty index — returned instead of throwing. */
export function emptyIndex(root: string): CodeIndex {
  return {
    workspaceRoot: resolve(root),
    builtAt: Date.now(),
    schema: CODE_INDEX_SCHEMA,
    frameworks: [],
    routes: [],
    selectors: [],
    translations: [],
    configFields: [],
    navGroups: [],
    files: {},
    stats: { filesScanned: 0, buildMs: 0 },
  };
}

async function readPackageJson(root: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(join(resolve(root), 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* not a node project, or an unreadable manifest */
  }
  return undefined;
}

/**
 * True when nothing indexed has changed: same file set, same mtimes.
 *
 * Comparing the file set (not just mtimes) is what catches additions and
 * deletions — a new `app/settings/advanced/page.tsx` must invalidate the index
 * even though every previously-indexed file is untouched.
 */
function isFresh(index: CodeIndex, files: ScannedFile[]): boolean {
  const known = index.files;
  const knownCount = Object.keys(known).length;
  if (knownCount !== files.length) return false;
  for (const file of files) {
    const mtime = known[file.rel];
    if (mtime === undefined || mtime !== file.mtimeMs) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Route resolution helpers
// ---------------------------------------------------------------------------

/** Collapse every dynamic-segment dialect to a single placeholder. */
function canonicalKey(pattern: string): string {
  return normalizePattern(pattern)
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (/^(:|\*|\[|\{|<)/.test(segment)) return ':';
      return segment.toLowerCase();
    })
    .join('/');
}

/** A concrete path matches a pattern when the static segments line up. */
function structurallyMatches(pattern: string, candidate: string): boolean {
  const p = normalizePattern(pattern).split('/');
  const c = normalizePattern(candidate).split('/');
  const catchAll = p.includes('*') || p.some((s) => s.startsWith('*'));
  if (!catchAll && p.length !== c.length) return false;
  for (let i = 0; i < p.length; i++) {
    const ps = p[i] ?? '';
    const cs = c[i];
    if (ps === '*' || ps.startsWith('*')) return true;
    if (/^(:|\[|\{|<)/.test(ps)) {
      if (cs === undefined || cs === '') return false;
      continue;
    }
    if (ps.toLowerCase() !== (cs ?? '').toLowerCase()) return false;
  }
  return true;
}

/**
 * Fill in params from a caller-supplied pattern of the same shape, e.g.
 * `resolveRoute(index, '/settings/general')` against `/settings/:section`.
 */
function mergeParams(
  entry: RouteEntry,
  candidate: string,
  params: Record<string, string> | undefined,
): Record<string, string> {
  const merged: Record<string, string> = { ...(params ?? {}) };
  const names = entry.params.length > 0 ? entry.params : patternParams(entry.pattern);
  const candidateSegments = normalizePattern(candidate).split('/').filter(Boolean);
  const patternSegments = normalizePattern(entry.pattern).split('/').filter(Boolean);
  let nameIndex = 0;
  for (let i = 0; i < patternSegments.length; i++) {
    const segment = patternSegments[i] ?? '';
    if (!/^(:|\*|\[|\{|<)/.test(segment)) continue;
    const name = names[nameIndex++];
    const value = candidateSegments[i];
    // Only adopt a value that is itself concrete.
    if (name && merged[name] === undefined && value && !/^(:|\*|\[|\{|<)/.test(value)) merged[name] = value;
  }
  return merged;
}

function finish(
  baseUrl: string | undefined,
  pattern: string,
  params: Record<string, string> | undefined,
): string | undefined {
  const path = routeToPath(pattern, params);
  // Refusing to return `/settings/:section` is deliberate: a URL that cannot be
  // navigated to is worse than a clear "unresolved", which tells the caller to
  // supply params.
  if (!isConcretePath(path)) return undefined;
  return absoluteUrl(baseUrl, path) ?? path;
}

/**
 * Combine framework-derived and registry-derived routes.
 *
 * Registry entries win on collision: a hand-maintained menu table states the
 * label and the permission a convention-based guess cannot know.
 */
function mergeRoutes(framework: RouteEntry[], registry: RouteEntry[]): RouteEntry[] {
  if (registry.length === 0) return framework;
  const byPattern = new Map<string, RouteEntry>();
  for (const route of framework) byPattern.set(route.pattern, route);
  for (const route of registry) byPattern.set(route.pattern, route);
  return [...byPattern.values()];
}
