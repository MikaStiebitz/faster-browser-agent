/**
 * Site memory: what the agent learns about a site by browsing it.
 *
 * Persisted per origin under `<home>/sites/<origin-slug>.json`. Written as a
 * side effect of ordinary observation, so the second visit to any site — with
 * or without source code — starts from a map instead of from nothing.
 *
 * Concurrency: several agent processes may hold the same origin open. Writes
 * are buffered and flushed with a read-merge-write under an atomic rename, so
 * concurrent writers converge rather than clobber. A lost update here costs a
 * little relearning, never correctness, which is why this does not take a lock
 * (a lock would serialise agents that have no other reason to wait on each
 * other).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { paths } from '../config.js';
import {
  SITE_MEMORY_LIMITS,
  SITE_MEMORY_SCHEMA,
  type ControlMemory,
  type FbaConfig,
  type ObservedEndpoint,
  type PageMemory,
  type PageSnapshot,
  type SettleOptions,
  type SiteMatch,
  type SettleKind,
  type SiteMemory,
  type TimingSample,
  type TransitionMemory,
} from '../types.js';
import { createLogger } from '../util/logger.js';
import { matchKey, rankMatches, shortHash } from '../util/text.js';
import { digestSnapshot, originOf, rolePriority, samePath, urlForPattern } from './digest.js';

const logger = createLogger('site');

/** Filesystem-safe name for an origin. */
export function originSlug(origin: string): string {
  const bare = origin.replace(/^https?:\/\//, '');
  const safe = bare.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
  // The hash keeps two origins that sanitise to the same string apart, and
  // keeps http vs https distinct.
  return `${safe}-${shortHash(origin, 6)}`;
}

function emptyMemory(origin: string, now: number): SiteMemory {
  return {
    origin,
    schema: SITE_MEMORY_SCHEMA,
    firstSeenAt: now,
    lastSeenAt: now,
    visits: 0,
    pages: [],
    controls: [],
    transitions: [],
    endpoints: [],
    timing: { samples: 0, p50: 0, p90: 0 },
  };
}

export interface SiteMemoryStore {
  /** Load (or create) the memory for an origin. */
  get(origin: string): Promise<SiteMemory | undefined>;
  /** Fold an observation into memory. Cheap and synchronous in effect. */
  recordSnapshot(snapshot: PageSnapshot): void;
  /** Record that activating `via` on `from` navigated to `to`. */
  recordTransition(fromUrl: string, via: string, toUrl: string): void;
  /** Record how long a settle actually took, for the adaptive budget. */
  recordSettle(url: string, ms: number, kind: SettleKind): void;
  /** Merge observed API endpoints for an origin. */
  recordEndpoints(origin: string, endpoints: readonly ObservedEndpoint[]): void;
  /** Rank remembered controls against a query. */
  search(origin: string, query: string, limit?: number): Promise<SiteMatch[]>;
  /**
   * Settle windows adapted to what this origin actually does.
   * Returns undefined when there is not enough evidence yet.
   */
  settleBudget(origin: string, kind: SettleKind): SettleOptions | undefined;
  /** Known origins with a one-line summary each. */
  list(): Promise<Array<{ origin: string; pages: number; controls: number; visits: number; lastSeenAt: number }>>;
  /** Drop everything learned about an origin. */
  forget(origin: string): Promise<boolean>;
  /** Write buffered changes to disk. */
  flush(): Promise<void>;
  /** Stop the periodic flush and write out. */
  close(): Promise<void>;
}

/** How long changes may sit in memory before being written. */
const FLUSH_INTERVAL_MS = 5_000;

export class FsSiteMemoryStore implements SiteMemoryStore {
  private readonly dir: string;
  private readonly cache = new Map<string, SiteMemory>();
  private readonly dirty = new Set<string>();
  /** Recent settle samples per origin, kept out of the persisted percentiles. */
  private readonly settleSamples = new Map<string, number[]>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly config: FbaConfig) {
    this.dir = join(paths(config).home, 'sites');
  }

  private fileFor(origin: string): string {
    return join(this.dir, `${originSlug(origin)}.json`);
  }

  private loadSync(origin: string): SiteMemory {
    const cached = this.cache.get(origin);
    if (cached) return cached;
    const now = Date.now();
    let memory = emptyMemory(origin, now);
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.fileFor(origin), 'utf8'));
      if (isSiteMemory(parsed) && parsed.schema === SITE_MEMORY_SCHEMA) memory = parsed;
    } catch {
      // Missing or corrupt file: start fresh. Memory is a cache — refusing to
      // work because a cache is unreadable would be the wrong trade.
    }
    this.cache.set(origin, memory);
    return memory;
  }

  async get(origin: string): Promise<SiteMemory | undefined> {
    const memory = this.loadSync(origin);
    return isEmpty(memory) ? undefined : memory;
  }

  private touch(origin: string): SiteMemory {
    const memory = this.loadSync(origin);
    memory.lastSeenAt = Date.now();
    this.dirty.add(origin);
    this.schedule();
    return memory;
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    // Never hold the process open just to persist a cache.
    this.timer.unref?.();
  }

  recordSnapshot(snapshot: PageSnapshot): void {
    if (!this.config.siteMemory) return;
    const origin = originOf(snapshot.url);
    if (!origin) return;
    try {
      const now = Date.now();
      const memory = this.touch(origin);
      memory.visits += 1;
      const { page, controls } = digestSnapshot(snapshot, now);
      mergePage(memory, page);
      mergeControls(memory, controls);
    } catch (e) {
      logger.debug(`recordSnapshot failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  recordTransition(fromUrl: string, via: string, toUrl: string): void {
    if (!this.config.siteMemory) return;
    const origin = originOf(toUrl);
    if (!origin || originOf(fromUrl) !== origin) return;
    try {
      const memory = this.touch(origin);
      const from = patternOf(fromUrl);
      const to = patternOf(toUrl);
      // A "transition" that stays put teaches nothing and would swamp the table.
      if (from === to) return;
      const existing = memory.transitions.find((t) => t.from === from && t.via === via && t.to === to);
      if (existing) {
        existing.count += 1;
        existing.lastSeenAt = Date.now();
      } else {
        memory.transitions.push({ from, via, to, count: 1, lastSeenAt: Date.now() });
      }
      evict(memory.transitions, SITE_MEMORY_LIMITS.transitions, (t) => t.lastSeenAt);
    } catch (e) {
      logger.debug(`recordTransition failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  recordSettle(url: string, ms: number, kind: SettleKind): void {
    if (!this.config.siteMemory) return;
    const origin = originOf(url);
    if (!origin || !Number.isFinite(ms) || ms < 0) return;

    const key = `${origin}\u0000${kind}`;
    const samples = this.settleSamples.get(key) ?? [];
    samples.push(ms);
    if (samples.length > SITE_MEMORY_LIMITS.timingSamples) samples.shift();
    this.settleSamples.set(key, samples);

    const memory = this.touch(origin);
    const distribution = summarise(samples);
    memory.timing = { ...memory.timing, [kind]: distribution };
    // The flat fields stay populated as the union of both kinds so older
    // readers (and `fba sites show`) keep working.
    const all = [
      ...(this.settleSamples.get(`${origin}\u0000navigation`) ?? []),
      ...(this.settleSamples.get(`${origin}\u0000interaction`) ?? []),
    ];
    const combined = summarise(all);
    memory.timing.samples = combined.samples;
    memory.timing.p50 = combined.p50;
    memory.timing.p90 = combined.p90;
  }

  recordEndpoints(origin: string, endpoints: readonly ObservedEndpoint[]): void {
    if (!this.config.siteMemory || endpoints.length === 0) return;
    try {
      const memory = this.touch(origin);
      for (const endpoint of endpoints) {
        const existing = memory.endpoints.find((e) => e.method === endpoint.method && e.pattern === endpoint.pattern);
        if (existing) {
          existing.hits += endpoint.hits;
          existing.lastSeenAt = Math.max(existing.lastSeenAt, endpoint.lastSeenAt);
          if (endpoint.responseShape) existing.responseShape = endpoint.responseShape;
        } else {
          memory.endpoints.push({ ...endpoint });
        }
      }
      evict(memory.endpoints, SITE_MEMORY_LIMITS.endpoints, (e) => e.lastSeenAt);
    } catch (e) {
      logger.debug(`recordEndpoints failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async search(origin: string, query: string, limit = 8): Promise<SiteMatch[]> {
    const memory = await this.get(origin);
    if (!memory) return [];
    const ranked = rankMatches(
      query,
      memory.controls,
      (c) => [c.name, c.testId, `${c.tabPath?.join(' ') ?? ''} ${c.name}`],
      { limit: limit * 2, minScore: 0.4 },
    );
    const matches: SiteMatch[] = ranked.map(({ item, score }) => {
      const match: SiteMatch = {
        name: item.name,
        role: item.role,
        page: item.page,
        score,
        seen: item.seen,
      };
      if (item.tabPath) match.tabPath = [...item.tabPath];
      if (item.testId) match.testId = item.testId;
      const url = urlForPattern(origin, item.page);
      if (url) match.url = url;
      return match;
    });
    // Break ties toward inputs over buttons, and toward controls seen often —
    // both correlate with "the thing the caller meant".
    matches.sort((a, b) => {
      if (Math.abs(a.score - b.score) > 0.02) return b.score - a.score;
      const role = rolePriority(a.role) - rolePriority(b.role);
      if (role !== 0) return role;
      return b.seen - a.seen;
    });
    return matches.slice(0, limit);
  }

  settleBudget(origin: string, kind: SettleKind): SettleOptions | undefined {
    const memory = this.cache.get(origin);
    if (!memory) return undefined;
    // Only the matching distribution is consulted. A page load and a tab click
    // are different events, and a budget derived from both is simultaneously
    // too loose for the fast one and too tight for the slow one — worse than
    // the generic default it replaces.
    const distribution = memory.timing[kind];
    // Below a handful of samples the percentiles are noise, and guessing wrong
    // here either wastes time or reports a half-rendered page.
    if (!distribution || distribution.samples < 5) return undefined;
    const { p50, p90 } = distribution;
    // A site that consistently settles fast gets tighter windows; a slow one
    // gets a cap that reflects reality instead of the generic default. This is
    // the literal "gets faster the more it is used" mechanism.
    const domQuiet = clamp(Math.round(p50 * 0.4), 80, 400);
    const networkQuiet = clamp(Math.round(p50 * 0.5), 120, 500);
    const timeout = clamp(Math.round(p90 * 2.5), 1_500, 15_000);
    return { domQuietMs: domQuiet, networkQuietMs: networkQuiet, timeoutMs: timeout };
  }

  async list(): Promise<Array<{ origin: string; pages: number; controls: number; visits: number; lastSeenAt: number }>> {
    const out: Array<{ origin: string; pages: number; controls: number; visits: number; lastSeenAt: number }> = [];
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const parsed: unknown = JSON.parse(await readFile(join(this.dir, entry), 'utf8'));
        if (!isSiteMemory(parsed)) continue;
        out.push({
          origin: parsed.origin,
          pages: parsed.pages.length,
          controls: parsed.controls.length,
          visits: parsed.visits,
          lastSeenAt: parsed.lastSeenAt,
        });
      } catch {
        /* skip unreadable entry */
      }
    }
    out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    return out;
  }

  async forget(origin: string): Promise<boolean> {
    this.cache.delete(origin);
    this.dirty.delete(origin);
    this.settleSamples.delete(origin);
    try {
      await rm(this.fileFor(origin), { force: true });
      return true;
    } catch {
      return false;
    }
  }

  async flush(): Promise<void> {
    if (this.dirty.size === 0) return;
    const origins = [...this.dirty];
    this.dirty.clear();
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      return;
    }
    for (const origin of origins) {
      const memory = this.cache.get(origin);
      if (!memory) continue;
      try {
        // Re-read and merge so a concurrent agent's learning is not discarded.
        const merged = mergeWithDisk(this.fileFor(origin), memory);
        this.cache.set(origin, merged);
        writeAtomic(this.fileFor(origin), merged);
      } catch (e) {
        logger.debug(`flush failed for ${origin}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }
}

// ---------------------------------------------------------------------------
// merging
// ---------------------------------------------------------------------------

function patternOf(url: string): string {
  // Re-exported through digest so the generalisation rules live in one place.
  return digestSnapshot(
    { url, title: '', version: 0, tree: { role: 'generic' }, stats: { interactive: 0, emitted: 0, elided: 0, captureMs: 0 } },
    0,
  ).page.pattern;
}

function mergePage(memory: SiteMemory, page: PageMemory): void {
  const existing = memory.pages.find((p) => p.pattern === page.pattern);
  if (existing) {
    existing.visits += 1;
    existing.lastSeenAt = page.lastSeenAt;
    existing.controlCount = page.controlCount;
    if (page.title) existing.title = page.title;
    for (const tab of page.tabs) {
      if (!existing.tabs.some((t) => samePath(t, tab))) existing.tabs.push(tab);
    }
    // A page with a hundred remembered tab paths is a page whose "tabs" were
    // really dynamic content; keep the table honest rather than unbounded.
    if (existing.tabs.length > 40) existing.tabs.length = 40;
  } else {
    memory.pages.push(page);
    evict(memory.pages, SITE_MEMORY_LIMITS.pages, (p) => p.lastSeenAt);
  }
}

function mergeControls(memory: SiteMemory, controls: readonly ControlMemory[]): void {
  for (const control of controls) {
    const existing = memory.controls.find(
      (c) =>
        c.page === control.page &&
        c.role === control.role &&
        matchKey(c.name) === matchKey(control.name) &&
        samePath(c.tabPath ?? [], control.tabPath ?? []),
    );
    if (existing) {
      existing.seen += 1;
      existing.lastSeenAt = control.lastSeenAt;
      if (control.testId) existing.testId = control.testId;
    } else {
      memory.controls.push({ ...control });
    }
  }
  // Evict by usefulness, not purely by age: a control seen many times is worth
  // keeping over one seen once, even if the latter is more recent.
  evict(memory.controls, SITE_MEMORY_LIMITS.controls, (c) => c.lastSeenAt + Math.min(c.seen, 20) * 60_000);
}

function mergeWithDisk(file: string, mine: SiteMemory): SiteMemory {
  let theirs: SiteMemory | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isSiteMemory(parsed) && parsed.schema === SITE_MEMORY_SCHEMA) theirs = parsed;
  } catch {
    return mine;
  }
  if (!theirs) return mine;

  const merged: SiteMemory = {
    origin: mine.origin,
    schema: SITE_MEMORY_SCHEMA,
    firstSeenAt: Math.min(mine.firstSeenAt, theirs.firstSeenAt),
    lastSeenAt: Math.max(mine.lastSeenAt, theirs.lastSeenAt),
    visits: Math.max(mine.visits, theirs.visits),
    pages: [...theirs.pages],
    controls: [...theirs.controls],
    transitions: [...theirs.transitions],
    endpoints: [...theirs.endpoints],
    // Timing is per-process observation; the fresher sample set wins rather
    // than being averaged into meaninglessness.
    timing: mine.timing.samples >= theirs.timing.samples ? mine.timing : theirs.timing,
  };
  for (const page of mine.pages) mergePage(merged, { ...page, visits: 1 });
  mergeControls(merged, mine.controls);
  for (const transition of mine.transitions) {
    const existing = merged.transitions.find(
      (t) => t.from === transition.from && t.via === transition.via && t.to === transition.to,
    );
    if (existing) existing.count = Math.max(existing.count, transition.count);
    else merged.transitions.push({ ...transition });
  }
  for (const endpoint of mine.endpoints) {
    const existing = merged.endpoints.find((e) => e.method === endpoint.method && e.pattern === endpoint.pattern);
    if (existing) existing.hits = Math.max(existing.hits, endpoint.hits);
    else merged.endpoints.push({ ...endpoint });
  }
  evict(merged.transitions, SITE_MEMORY_LIMITS.transitions, (t) => t.lastSeenAt);
  evict(merged.endpoints, SITE_MEMORY_LIMITS.endpoints, (e) => e.lastSeenAt);
  return merged;
}

function writeAtomic(file: string, memory: SiteMemory): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(memory), 'utf8');
  renameSync(tmp, file);
}

/** Keep the `limit` highest-scoring entries, dropping the rest in place. */
function evict<T>(items: T[], limit: number, score: (item: T) => number): void {
  if (items.length <= limit) return;
  items.sort((a, b) => score(b) - score(a));
  items.length = limit;
}

function summarise(samples: readonly number[]): TimingSample {
  const sorted = [...samples].sort((a, b) => a - b);
  return { samples: samples.length, p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) };
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[index] ?? 0;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Nothing has been learned yet.
 *
 * Every store has to be checked, not just pages: a transition or a timing
 * sample recorded before the first snapshot landed is real knowledge, and
 * reporting the origin as unknown would throw it away.
 */
function isEmpty(memory: SiteMemory): boolean {
  return (
    memory.visits === 0 &&
    memory.pages.length === 0 &&
    memory.controls.length === 0 &&
    memory.transitions.length === 0 &&
    memory.endpoints.length === 0 &&
    memory.timing.samples === 0
  );
}

function isSiteMemory(value: unknown): value is SiteMemory {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<SiteMemory>;
  return (
    typeof v.origin === 'string' &&
    typeof v.schema === 'number' &&
    Array.isArray(v.pages) &&
    Array.isArray(v.controls) &&
    Array.isArray(v.transitions) &&
    Array.isArray(v.endpoints) &&
    !!v.timing
  );
}
