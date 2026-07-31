/**
 * L3 skill cache — persistence.
 *
 * A "skill" is a compiled trajectory: an action program that already worked
 * once, stored so that every later run of the same flow costs zero model
 * calls. The store is deliberately boring — one JSON file per skill, keyed by
 * (origin, name) — because it has to survive several agent processes writing
 * to the same home directory at the same time.
 *
 * Layout:
 *   <home>/skills/<originSlug>/<name>.json
 *   e.g. ~/.faster-browser-agent/skills/localhost_3000/checkout.json
 *
 * Concurrency model: no global lock, ever. Parallel agents each own different
 * skills far more often than they contend on one, and a shared lock would turn
 * an unrelated agent's slow disk into everyone's latency. Instead each write is
 * a tmp-file + rename, which is atomic on every filesystem we support: readers
 * either see the old file or the new one, never a half-written one.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { paths } from '../config.js';
import type { SkillStore } from '../contracts.js';
import type { ActionStep, FbaConfig, SkillRecord } from '../types.js';
import { FbaError, errorMessage } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { normalizeText } from '../util/text.js';

const logger = createLogger('skills');

/**
 * Skill names become filenames, so the pattern is enforced rather than merely
 * sanitised: a name like `../../.ssh/config` or `a/b` would let a caller write
 * (or read, or delete) outside the skills directory. Rejecting instead of
 * rewriting also keeps the name the agent chose identical to the name it can
 * later look up.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Every `do` value in the ActionStep union. Kept here so `validateSkill` can
 *  reject a record the executor would silently skip at replay time. */
const ACTION_KINDS: ReadonlySet<string> = new Set([
  'click',
  'dblclick',
  'hover',
  'focus',
  'blur',
  'type',
  'setValue',
  'select',
  'check',
  'upload',
  'press',
  'scroll',
  'goto',
  'back',
  'forward',
  'reload',
  'waitFor',
  'settle',
  'assert',
  'dialog',
  'selectTab',
  'expand',
  'eval',
]);

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Canonical origin for a URL: scheme + host + non-default port, lowercased.
 *
 * Skills are keyed by origin because the same flow on `localhost:3000` and on
 * `staging.example.com` is genuinely the same flow, while two different apps on
 * one machine must never share a cache entry.
 */
export function normalizeOrigin(url: string): string {
  const raw = normalizeText(url);
  if (!raw) return 'about:blank';
  // `new URL('localhost:3000')` succeeds — it parses as the scheme `localhost:`
  // with path `3000`. That bare host:port form is exactly what developers type,
  // so detect it (and any scheme-less input) before handing it to the parser.
  const bareHostPort = !raw.includes('://') && /^[a-z0-9.-]+:\d+(\/|$)/i.test(raw);
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  const parsed = parseUrl(bareHostPort || !hasScheme ? `http://${raw}` : raw) ?? parseUrl(`http://${raw}`);
  if (!parsed) return raw.toLowerCase().replace(/\/+$/, '');
  // `file:` URLs have an opaque (null) WHATWG origin; treat the whole local
  // filesystem as one origin so file-based fixtures can carry skills at all.
  if (parsed.protocol === 'file:') return 'file://';
  if (parsed.origin && parsed.origin !== 'null') return parsed.origin.toLowerCase();
  if (parsed.host) return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  // Schemes with no authority (`about:blank`, `chrome:newtab`).
  return `${parsed.protocol}${parsed.pathname}`.toLowerCase();
}

function parseUrl(input: string): URL | undefined {
  try {
    return new URL(input);
  } catch {
    return undefined;
  }
}

/** Directory name for an origin: scheme stripped, unsafe characters folded. */
export function originSlug(origin: string): string {
  const stripped = origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slug = (stripped || origin)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    // Leading dots would produce `.`/`..`-ish directory names.
    .replace(/^[._]+|[._]+$/g, '');
  return slug || 'unknown';
}

/** Stable cache key for a (name, origin) pair. */
export function skillKey(name: string, origin: string): string {
  return `${normalizeOrigin(origin)}#${normalizeText(name).toLowerCase()}`;
}

/** Lowercase and validate a skill name, throwing `INVALID_ARGUMENT` if unusable. */
export function normalizeSkillName(name: string): string {
  const candidate = normalizeText(name).toLowerCase();
  if (!NAME_PATTERN.test(candidate)) {
    throw new FbaError('INVALID_ARGUMENT', `invalid skill name ${JSON.stringify(name)}`, {
      hint: 'use 1-64 chars matching [a-z0-9][a-z0-9._-]* — no slashes, spaces or leading dots',
    });
  }
  return candidate;
}

function isValidName(name: string): boolean {
  return NAME_PATTERN.test(normalizeText(name).toLowerCase());
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/** A param name: conservative on purpose, so `{{ 2 + 2 }}` stays literal text. */
const PARAM_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

type Chunk = { kind: 'literal'; text: string } | { kind: 'param'; name: string };

/**
 * Split a template string into literal and `{{param}}` chunks.
 *
 * `extractParams` and `interpolateSteps` share this one parser so they can
 * never disagree about what counts as a placeholder — a disagreement would show
 * up as a skill that validates and then throws halfway through a replay.
 */
function parseTemplate(input: string): Chunk[] {
  const chunks: Chunk[] = [];
  let literal = '';
  let i = 0;
  while (i < input.length) {
    // Escape sequence: `{{{{` renders a literal `{{`.
    if (input.startsWith('{{{{', i)) {
      literal += '{{';
      i += 4;
      continue;
    }
    if (input.startsWith('{{', i)) {
      const end = input.indexOf('}}', i + 2);
      if (end !== -1) {
        const name = input.slice(i + 2, end).trim();
        if (PARAM_NAME.test(name)) {
          if (literal) {
            chunks.push({ kind: 'literal', text: literal });
            literal = '';
          }
          chunks.push({ kind: 'param', name });
          i = end + 2;
          continue;
        }
      }
    }
    literal += input[i] ?? '';
    i += 1;
  }
  if (literal) chunks.push({ kind: 'literal', text: literal });
  return chunks;
}

/**
 * Generic deep walk over a step object.
 *
 * Deliberately structural rather than a switch over `ActionStep['do']`: new
 * step variants (and new string fields on existing ones) become parameterisable
 * for free, with no chance of the skill layer silently ignoring a field the
 * executor understands.
 */
function walkStrings(value: unknown, visit: (s: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) walkStrings(item, visit);
  }
}

/** Deep clone, mapping every string through `map`. See `walkStrings`. */
function mapStrings(value: unknown, map: (s: string) => string): unknown {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, map);
    return out;
  }
  return value;
}

/** Distinct `{{param}}` names used anywhere in the program, first-appearance order. */
export function extractParams(steps: ActionStep[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  walkStrings(steps, (text) => {
    if (!text.includes('{{')) return;
    for (const chunk of parseTemplate(text)) {
      if (chunk.kind !== 'param' || seen.has(chunk.name)) continue;
      seen.add(chunk.name);
      order.push(chunk.name);
    }
  });
  return order;
}

/**
 * Substitute `{{param}}` placeholders throughout a program.
 *
 * Missing parameters throw rather than rendering an empty string: a replay that
 * types "" into a search box and reports success is exactly the silent-partial-
 * execution failure mode skills exist to avoid.
 */
export function interpolateSteps(steps: ActionStep[], params: Record<string, string>): ActionStep[] {
  const substitute = (text: string): string => {
    if (!text.includes('{{')) return text;
    let out = '';
    for (const chunk of parseTemplate(text)) {
      if (chunk.kind === 'literal') {
        out += chunk.text;
        continue;
      }
      const value = params[chunk.name];
      if (value === undefined) {
        throw new FbaError('INVALID_ARGUMENT', `missing skill parameter "${chunk.name}"`, {
          hint: `pass params.${chunk.name}`,
          details: { param: chunk.name },
        });
      }
      out += value;
    }
    return out;
  };
  return steps.map((step) => mapStrings(step, substitute) as ActionStep);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Structural problems with a record; empty array means it is safe to store. */
export function validateSkill(record: SkillRecord): string[] {
  const problems: string[] = [];

  if (typeof record.name !== 'string' || !isValidName(record.name)) {
    problems.push(`invalid name ${JSON.stringify(record.name)}: expected [a-z0-9][a-z0-9._-]{0,63}`);
  }
  if (typeof record.origin !== 'string' || !normalizeText(record.origin)) {
    problems.push('missing origin');
  }
  if (!Array.isArray(record.steps) || record.steps.length === 0) {
    problems.push('no steps: a skill must contain at least one action');
  } else {
    record.steps.forEach((step, index) => {
      const kind: unknown = (step as { do?: unknown } | undefined)?.do;
      if (typeof kind !== 'string' || !ACTION_KINDS.has(kind)) {
        problems.push(`step ${index + 1}: unknown action ${JSON.stringify(kind)}`);
      } else if (kind === 'eval') {
        // See compileFromSteps: captured JS is the one step whose effect we can
        // neither verify nor heal, so it never enters the cache.
        problems.push(`step ${index + 1}: 'eval' steps cannot be replayed safely`);
      }
    });

    const used = extractParams(record.steps);
    const declared = Array.isArray(record.params) ? record.params : [];
    for (const param of used) {
      if (!declared.includes(param)) problems.push(`step uses undeclared parameter "${param}"`);
    }
    for (const param of declared) {
      if (!used.includes(param)) problems.push(`declares parameter "${param}" that no step uses`);
    }
  }

  if (!Number.isFinite(record.createdAt) || record.createdAt < 0) problems.push('invalid createdAt');
  if (!Number.isFinite(record.updatedAt) || record.updatedAt < 0) problems.push('invalid updatedAt');
  if (!Number.isInteger(record.runs) || record.runs < 0) problems.push('invalid runs counter');
  if (!Number.isInteger(record.failures) || record.failures < 0) problems.push('invalid failures counter');
  if (Number.isInteger(record.runs) && Number.isInteger(record.failures) && record.failures > record.runs) {
    problems.push('failures exceeds runs');
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface CacheEntry {
  mtimeMs: number;
  size: number;
  record: SkillRecord;
}

export class FsSkillStore implements SkillStore {
  private readonly root: string;
  /**
   * Parsed-record cache keyed by absolute path and validated against
   * (mtimeMs, size). Listing skills happens on nearly every tool call, and
   * re-parsing a directory of JSON each time is pure waste; stat is ~10x
   * cheaper than read+parse.
   */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(config: FbaConfig) {
    this.root = paths(config).skills;
  }

  /** Absolute directory holding every skill recorded for `origin`. */
  dirFor(origin: string): string {
    return join(this.root, originSlug(normalizeOrigin(origin)));
  }

  /** Absolute path of one skill file. */
  fileFor(name: string, origin: string): string {
    return join(this.dirFor(origin), `${normalizeSkillName(name)}.json`);
  }

  async list(origin?: string): Promise<SkillRecord[]> {
    const dirs = origin ? [this.dirFor(origin)] : await this.originDirs();
    const records: SkillRecord[] = [];
    for (const dir of dirs) {
      for (const file of await this.filesIn(dir)) {
        const record = await this.read(file);
        if (record) records.push(record);
      }
    }
    // Stable order so tool output does not churn between calls.
    records.sort((a, b) => a.origin.localeCompare(b.origin) || a.name.localeCompare(b.name));
    return records;
  }

  async get(name: string, origin?: string): Promise<SkillRecord | undefined> {
    const wanted = normalizeText(name).toLowerCase();
    if (!wanted) return undefined;

    if (origin !== undefined) {
      if (isValidName(wanted)) {
        const direct = await this.read(this.fileFor(wanted, origin));
        if (direct) return direct;
      }
      // Fall back to a directory scan so records written by hand (or by an
      // older version with different casing) are still findable.
      for (const file of await this.filesIn(this.dirFor(origin))) {
        const record = await this.read(file);
        if (record && record.name.toLowerCase() === wanted) return record;
      }
      return undefined;
    }

    const matches = (await this.list()).filter((r) => r.name.toLowerCase() === wanted);
    // Newest wins: if the same flow was recorded against several origins, the
    // most recently touched one is the best guess at what the caller means.
    matches.sort((a, b) => b.updatedAt - a.updatedAt);
    return matches[0];
  }

  async save(record: SkillRecord): Promise<void> {
    const problems = validateSkill(record);
    if (problems.length > 0) {
      throw new FbaError('INVALID_ARGUMENT', `cannot save skill: ${problems.join('; ')}`, {
        details: { problems },
      });
    }
    const now = Date.now();
    const normalized: SkillRecord = {
      ...record,
      // The name is an identifier; storing it canonically keeps `get()` and the
      // on-disk filename in agreement.
      name: normalizeSkillName(record.name),
      origin: normalizeOrigin(record.origin),
      params: [...record.params],
      steps: record.steps.map((step) => structuredClone(step)),
      createdAt: record.createdAt > 0 ? record.createdAt : now,
      updatedAt: now,
    };
    await this.write(this.fileFor(normalized.name, normalized.origin), normalized);
    logger.debug(`saved skill ${normalized.name} @ ${normalized.origin} (${normalized.steps.length} steps)`);
  }

  /** Delete one skill. With no origin, every copy of the name is removed. */
  async delete(name: string, origin?: string): Promise<boolean> {
    const wanted = normalizeText(name).toLowerCase();
    if (!wanted) return false;

    const targets: string[] = [];
    if (origin !== undefined) {
      if (isValidName(wanted)) targets.push(this.fileFor(wanted, origin));
      for (const file of await this.filesIn(this.dirFor(origin))) {
        const record = await this.read(file);
        if (record && record.name.toLowerCase() === wanted && !targets.includes(file)) targets.push(file);
      }
    } else {
      for (const dir of await this.originDirs()) {
        for (const file of await this.filesIn(dir)) {
          const record = await this.read(file);
          if (record && record.name.toLowerCase() === wanted) targets.push(file);
        }
      }
    }

    let removed = false;
    for (const file of targets) {
      try {
        await unlink(file);
        removed = true;
      } catch (e) {
        // Another agent deleting the same skill concurrently is not an error.
        if (!isMissing(e)) throw new FbaError('INTERNAL', `failed to delete skill: ${errorMessage(e)}`, { cause: e });
      }
      this.cache.delete(file);
    }
    return removed;
  }

  /**
   * Update run statistics.
   *
   * Read-modify-write without a lock: the counters are advisory (they only feed
   * the "this skill looks stale" hint), so losing one increment to a concurrent
   * writer is far cheaper than serialising every agent on a shared lock file.
   */
  async markRun(name: string, origin: string, ok: boolean, ms: number): Promise<void> {
    let file: string;
    try {
      file = this.fileFor(name, origin);
    } catch {
      return; // unusable name — nothing to update
    }
    // Bypass the cache: another process may have written since our last read.
    const current = await this.readFresh(file);
    if (!current) {
      logger.debug(`markRun: no stored skill ${name} @ ${normalizeOrigin(origin)}`);
      return;
    }
    const updated: SkillRecord = {
      ...current,
      runs: current.runs + 1,
      failures: current.failures + (ok ? 0 : 1),
      // `lastMs` is the known-good baseline used to spot regressions, so a
      // failed replay's duration must not overwrite it.
      ...(ok ? { lastMs: Math.max(0, Math.round(ms)) } : {}),
      updatedAt: Date.now(),
    };
    await this.write(file, updated);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async originDirs(): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => join(this.root, e.name));
    } catch (e) {
      if (isMissing(e)) return [];
      throw new FbaError('INTERNAL', `failed to list skills: ${errorMessage(e)}`, { cause: e });
    }
  }

  private async filesIn(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => join(dir, e.name))
        .sort();
    } catch (e) {
      if (isMissing(e)) return [];
      throw new FbaError('INTERNAL', `failed to list skills in ${dir}: ${errorMessage(e)}`, { cause: e });
    }
  }

  /** Cached read; a corrupt or foreign file yields `undefined` rather than throwing. */
  private async read(file: string): Promise<SkillRecord | undefined> {
    const stats = await stat(file).catch(() => undefined);
    if (!stats) {
      this.cache.delete(file);
      return undefined;
    }
    const cached = this.cache.get(file);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.record;

    const record = await this.readFresh(file);
    if (record) this.cache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, record });
    else this.cache.delete(file);
    return record;
  }

  private async readFresh(file: string): Promise<SkillRecord | undefined> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (e) {
      if (isMissing(e)) return undefined;
      throw new FbaError('INTERNAL', `failed to read skill ${file}: ${errorMessage(e)}`, { cause: e });
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecordShape(parsed)) {
        logger.warn(`ignoring ${file}: not a skill record`);
        return undefined;
      }
      return parsed;
    } catch (e) {
      // A truncated file (disk full, killed process) must not break listing.
      logger.warn(`ignoring ${file}: ${errorMessage(e)}`);
      return undefined;
    }
  }

  private async write(file: string, record: SkillRecord): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    // Unique tmp name per attempt: two processes saving the same skill at the
    // same time must not write into each other's temporary file.
    const tmp = `${file}.${process.pid.toString(36)}${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    try {
      await renameWithRetry(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new FbaError('INTERNAL', `failed to write skill ${file}: ${errorMessage(e)}`, { cause: e });
    }
    try {
      const stats = await stat(file);
      this.cache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, record });
    } catch {
      this.cache.delete(file);
    }
  }
}

/**
 * Rename with a short retry.
 *
 * On Windows a rename over a file another process currently has open fails with
 * EPERM/EBUSY; on POSIX this loop never runs. Retrying briefly is what makes
 * "several agents, one skills directory" actually work.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const delays = [0, 15, 45];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const retriable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!retriable || attempt === delays.length - 1) throw e;
      const wait = delays[attempt + 1] ?? 0;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isRecordShape(value: unknown): value is SkillRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SkillRecord>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.origin === 'string' &&
    Array.isArray(candidate.steps) &&
    Array.isArray(candidate.params) &&
    typeof candidate.runs === 'number' &&
    typeof candidate.failures === 'number'
  );
}
