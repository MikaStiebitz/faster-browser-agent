/**
 * Network observation — API shortcutting and problem capture.
 *
 * Two jobs, one set of page listeners:
 *
 *  1. Learn the JSON endpoints the application calls itself. For extraction
 *     tasks ("list every user", "what does the settings API return") replaying
 *     the endpoint the page already called is orders of magnitude cheaper than
 *     driving the UI: no render, no snapshot, no clicks, no scrolling, and the
 *     answer arrives as structured data instead of prose scraped off the DOM.
 *  2. Capture the problems the page reports about itself — console errors, page
 *     errors and failed requests — so an action that "succeeded" but broke the
 *     app is not silently reported as a success.
 *
 * Cost discipline is the whole design constraint here. This code runs on every
 * response of every page load, so the hot path is synchronous, allocation-light
 * filtering; the only expensive operation (reading a response body over CDP) is
 * deferred, never awaited inline, and performed at most once per endpoint.
 */

import type { ConsoleMessage, Page, Request, Response } from 'playwright-core';

import type { ObservedEndpoint, RecentRequest } from '../types.js';
import { FbaError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { normalizeText, plural, truncate } from '../util/text.js';

const logger = createLogger('net');

// ---------------------------------------------------------------------------
// URL patterns
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mongo ObjectId and friends. */
const HEX24 = /^[0-9a-f]{24}$/i;
const NUMERIC = /^\d+$/;
/** `2024-05`, `2024-05-17`, `2024-05-17T09:30:00Z`. */
const DATE_LIKE = /^\d{4}-\d{2}(?:-\d{2}(?:[T_]\d{2}[:-]?\d{2}(?::?\d{2})?(?:\.\d+)?Z?)?)?$/;
/** Opaque tokens: jwt fragments, signed ids, base64 blobs, long hex digests. */
const TOKENISH = /^[A-Za-z0-9_=+/-]{21,}$/;

/**
 * Does this path segment carry an identity rather than a name?
 *
 * Deliberately conservative: over-matching would collapse `/api/settings` and
 * `/api/billing` into the same row, which destroys the table's usefulness. A
 * long lowercase slug like `getting-started-with-webhooks` is a name, so
 * `TOKENISH` additionally requires a digit or mixed case — the entropy
 * signature that separates an opaque id from a human-authored slug.
 */
function looksLikeId(segment: string): boolean {
  if (NUMERIC.test(segment) || UUID.test(segment) || HEX24.test(segment)) return true;
  if (DATE_LIKE.test(segment)) return true;
  if (segment.length > 20 && TOKENISH.test(segment)) {
    const hasDigit = /\d/.test(segment);
    const mixedCase = /[a-z]/.test(segment) && /[A-Z]/.test(segment);
    return hasDigit || mixedCase;
  }
  return false;
}

function normalizePath(path: string): string {
  // `split`/`join` preserves leading, trailing and repeated slashes exactly.
  return path
    .split('/')
    .map((segment) => (segment && looksLikeId(segment) ? ':id' : segment))
    .join('/');
}

function sortedParamNames(query: string): string {
  if (!query) return '';
  const names = new Set<string>();
  for (const key of new URLSearchParams(query).keys()) names.add(key);
  if (names.size === 0) return '';
  return `?${[...names].sort().join('&')}`;
}

/**
 * Normalise a URL into a grouping key.
 *
 * Keeps origin + path with identity-bearing segments replaced by `:id`, drops
 * parameter *values* but keeps the sorted parameter *names*. Values are noise
 * (`?page=2` and `?page=3` are the same endpoint) whereas the name set is
 * signal: `/api/users?q=` is a search endpoint and genuinely different from
 * `/api/users?page=`. Sorting makes the key independent of parameter order.
 */
export function urlPattern(url: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }

  if (parsed) {
    // `origin` is the literal string "null" for opaque schemes (file:, data:);
    // fall back to protocol+host so the key stays distinguishable.
    const origin =
      parsed.origin && parsed.origin !== 'null' ? parsed.origin : `${parsed.protocol}//${parsed.host}`;
    return `${origin}${normalizePath(parsed.pathname)}${sortedParamNames(parsed.search.replace(/^\?/, ''))}`;
  }

  // Relative or malformed URL: do the same job by hand rather than inventing a
  // base origin, which would make two unrelated relative URLs collide.
  const hash = url.indexOf('#');
  const withoutHash = hash === -1 ? url : url.slice(0, hash);
  const q = withoutHash.indexOf('?');
  const path = q === -1 ? withoutHash : withoutHash.slice(0, q);
  const query = q === -1 ? '' : withoutHash.slice(q + 1);
  return `${normalizePath(path)}${sortedParamNames(query)}`;
}

// ---------------------------------------------------------------------------
// Shape sketching
// ---------------------------------------------------------------------------

const MAX_SHAPE_CHARS = 300;
const MAX_OBJECT_KEYS = 12;
/** How many array elements to inspect before declaring the element shape. */
const ARRAY_SAMPLE = 3;

/**
 * Render a compact type sketch of a JSON value, e.g.
 * `{ items: [{ id: number, name: string, tags: string[] }], total: number }`.
 *
 * The point is to let the agent decide whether an endpoint answers its question
 * *without* paying for the payload. A sketch is a couple of dozen tokens where
 * the response is thousands.
 *
 * Arrays are expressed with `[]` and never repeat their elements. We sample the
 * first few elements rather than only the first, because real APIs routinely
 * put a `null` or an incomplete record in position 0 and a shape of `null[]`
 * teaches the agent nothing; differing element shapes surface as a union
 * (`(string|null)[]`).
 */
export function describeShape(value: unknown, maxDepth = 3): string {
  return truncate(sketch(value, 0, Math.max(0, maxDepth), new Set<object>()), MAX_SHAPE_CHARS);
}

function sketch(value: unknown, depth: number, maxDepth: number, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'bigint':
      return 'bigint';
    case 'undefined':
      return 'undefined';
    case 'function':
      return 'function';
    case 'symbol':
      return 'symbol';
    default:
      break;
  }

  const obj = value as object;
  // Parsed JSON is acyclic, but this function is exported and may be handed a
  // live object graph; without this guard a cycle inside an array chain (which
  // does not consume depth, see below) would recurse forever.
  if (seen.has(obj)) return '<circular>';
  seen.add(obj);
  try {
    if (Array.isArray(value)) return sketchArray(value, depth, maxDepth, seen);

    if (depth >= maxDepth) return '{…}';
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const parts: string[] = [];
    for (const entry of entries.slice(0, MAX_OBJECT_KEYS)) {
      parts.push(`${entry[0]}: ${sketch(entry[1], depth + 1, maxDepth, seen)}`);
    }
    if (entries.length > MAX_OBJECT_KEYS) parts.push('…');
    return `{ ${parts.join(', ')} }`;
  } finally {
    seen.delete(obj);
  }
}

function sketchArray(value: readonly unknown[], depth: number, maxDepth: number, seen: Set<object>): string {
  if (value.length === 0) return '[]';

  // An array wrapper does NOT consume a depth level: `{ items: [{ ... }] }` is
  // conceptually two levels, not three, and charging the array a level would
  // truncate exactly the payload shape the agent cares about.
  const variants: string[] = [];
  for (let i = 0; i < value.length && i < ARRAY_SAMPLE; i++) {
    const shape = sketch(value[i], depth, maxDepth, seen);
    if (!variants.includes(shape)) variants.push(shape);
  }

  const inner = variants.length > 2 ? `${variants.slice(0, 2).join('|')}|…` : variants.join('|');
  // Primitive element types read better in postfix form (`string[]`); anything
  // structural reads better wrapped (`[{ id: number }]`).
  if (/^[a-z]+(?:\|[a-z]+)*$/.test(inner)) {
    return variants.length > 1 ? `(${inner})[]` : `${inner}[]`;
  }
  return `[${inner}]`;
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

export interface NetworkObserverOptions {
  /** Rows kept in the endpoint table. Default 60. */
  maxEndpoints?: number;
  /** Read response bodies to compute shapes. Default true. */
  captureBodies?: boolean;
  /** Responses larger than this are never read. Default 256KB. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_ENDPOINTS = 60;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const MAX_PROBLEMS = 20;
const MAX_PROBLEM_CHARS = 200;
const MAX_BODY_ATTEMPTS = 2;

/** Matches `application/json`, `text/json`, `application/ld+json`, ... */
const JSON_MIME = /(?:^|[/+])json\b/i;

/** Resource types that can never be an application data call. */
const STATIC_TYPES: ReadonlySet<string> = new Set([
  'image',
  'media',
  'texttrack',
  'font',
  'stylesheet',
  'script',
  'document',
  'manifest',
  'websocket',
  'ping',
  'prefetch',
  'preflight',
  'signedexchange',
]);

/** Resource types that always are one. */
const DATA_TYPES: ReadonlySet<string> = new Set(['xhr', 'fetch']);

/**
 * Failures that are noise, not problems.
 *
 * `ERR_BLOCKED_BY_CLIENT` is *our own* blocking layer aborting images and
 * analytics — reporting it as a page problem would bury the real errors under
 * dozens of self-inflicted lines. `ERR_ABORTED` is what a navigation does to
 * everything still in flight.
 */
const IGNORED_FAILURES: ReadonlySet<string> = new Set([
  'net::ERR_BLOCKED_BY_CLIENT',
  'net::ERR_ABORTED',
]);

interface ProblemEntry {
  text: string;
  count: number;
}

/**
 * Wall-clock duration of a finished request, best effort. Playwright's timing
 * uses -1 for "not available", which must not surface as a negative number.
 */
function timingMs(request: Request): number | undefined {
  try {
    const timing = request.timing();
    if (timing.responseEnd >= 0) return Math.round(timing.responseEnd);
  } catch {
    /* timing is diagnostics, never worth failing over */
  }
  return undefined;
}

export class NetworkObserver {
  private readonly page: Page;
  private readonly maxEndpoints: number;
  private readonly captureBodies: boolean;
  private readonly maxBodyBytes: number;

  /**
   * Keyed by `METHOD pattern`. Insertion order is maintained as least-recently
   * -seen first (every hit re-inserts), which makes eviction O(1).
   */
  private readonly table = new Map<string, ObservedEndpoint>();
  /**
   * Body-read attempts per endpoint. Bounds the damage from an endpoint whose
   * body is never readable — a redirect chain, or a long-poll that stays open
   * for minutes — which would otherwise start a fresh read on every single hit.
   * Two attempts, so one transient failure still gets a second chance.
   */
  private readonly bodyAttempts = new WeakMap<ObservedEndpoint, number>();
  private problems: ProblemEntry[] = [];
  /**
   * Raw last-N request log, separate from the aggregated endpoint table.
   * Fixed-size ring so a chatty page cannot grow memory; 50 entries is enough
   * to answer "what did the page just fetch?" without becoming a HAR file.
   */
  private recentLog: RecentRequest[] = [];
  private dropped = 0;
  private pending = 0;
  private attached = false;

  constructor(page: Page, options: NetworkObserverOptions = {}) {
    this.page = page;
    this.maxEndpoints = Math.max(1, options.maxEndpoints ?? DEFAULT_MAX_ENDPOINTS);
    this.captureBodies = options.captureBodies ?? true;
    this.maxBodyBytes = Math.max(0, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.page.on('response', this.onResponse);
    this.page.on('requestfailed', this.onRequestFailed);
    this.page.on('console', this.onConsole);
    this.page.on('pageerror', this.onPageError);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    try {
      this.page.off('response', this.onResponse);
      this.page.off('requestfailed', this.onRequestFailed);
      this.page.off('console', this.onConsole);
      this.page.off('pageerror', this.onPageError);
    } catch {
      // The page was already closed; its listeners died with it.
    }
  }

  private pushRecent(entry: RecentRequest): void {
    this.recentLog.push(entry);
    if (this.recentLog.length > 50) this.recentLog.shift();
  }

  /** The raw last-N requests, newest first. */
  recent(limit = 20): RecentRequest[] {
    return [...this.recentLog].reverse().slice(0, Math.max(1, limit));
  }

  /** Observed endpoints, most useful first (most hits, then most recent). */
  endpoints(): ObservedEndpoint[] {
    return [...this.table.values()]
      .map((e) => ({ ...e }))
      .sort((a, b) => b.hits - a.hits || b.lastSeenAt - a.lastSeenAt);
  }

  /** Console errors / page errors / failed requests since the last drain. */
  drainProblems(): string[] {
    const limit = this.dropped > 0 ? MAX_PROBLEMS - 1 : MAX_PROBLEMS;
    const out = this.problems
      .slice(0, limit)
      .map((p) => (p.count > 1 ? `${p.text} (x${p.count})` : p.text));
    if (this.dropped > 0) out.push(`… ${plural(this.dropped, 'more problem')} suppressed`);
    this.problems = [];
    this.dropped = 0;
    return out;
  }

  /** Response-body reads still in flight. Used by diagnostics and tests. */
  pendingCount(): number {
    return this.pending;
  }

  /** Forget everything. Called on navigation, when the old table is stale. */
  reset(): void {
    // In-flight body reads are intentionally left running: their continuations
    // mutate endpoint objects that are no longer in the table, which is a
    // harmless write to garbage, and cancelling them would cost more than it
    // saves.
    this.table.clear();
    this.problems = [];
    this.dropped = 0;
  }

  // -------------------------------------------------------------------------
  // Listeners (hot path — keep synchronous)
  // -------------------------------------------------------------------------

  private readonly onResponse = (response: Response): void => {
    try {
      const request = response.request();
      this.pushRecent({
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        status: response.status(),
        ms: timingMs(request),
        startedAt: Date.now(),
      });
      // A navigation is not an API call; the document body is not data.
      if (request.isNavigationRequest()) return;

      const resourceType = request.resourceType();
      const contentType = (response.headers()['content-type'] ?? '').split(';')[0]?.trim() ?? '';
      const isJson = JSON_MIME.test(contentType);
      const isData = DATA_TYPES.has(resourceType) || (isJson && !STATIC_TYPES.has(resourceType));
      if (!isData) return;

      // Trust `content-length` when present: it lets us reject a 40MB export
      // before touching the body at all.
      const declared = Number.parseInt(response.headers()['content-length'] ?? '', 10);
      if (Number.isFinite(declared) && declared > this.maxBodyBytes) return;

      const url = response.url();
      const method = request.method().toUpperCase();
      const entry = this.upsert(method, urlPattern(url), url, response.status(), contentType);

      if (entry.requestBodyShape === undefined) {
        // `postData()` is already in memory on our side — no round trip — so
        // this one is free. Computed once: request shapes do not drift.
        const shape = this.shapeOfPostData(request);
        if (shape) entry.requestBodyShape = shape;
      }

      if (this.captureBodies && entry.responseShape === undefined) {
        this.readBodyLazily(entry, response);
      }
    } catch (e) {
      // Anything thrown here would surface as an unhandled listener error and
      // could tear down the caller's page handling. Observation is best-effort.
      logger.debug(`response listener failed: ${String(e)}`);
    }
  };

  private readonly onRequestFailed = (request: Request): void => {
    try {
      const errorText = request.failure()?.errorText ?? 'unknown error';
      this.pushRecent({
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        failure: errorText,
        startedAt: Date.now(),
      });
      if (IGNORED_FAILURES.has(errorText)) return;
      if (STATIC_TYPES.has(request.resourceType()) && !request.isNavigationRequest()) return;
      this.pushProblem(`request failed: ${request.method()} ${this.shortUrl(request.url())} — ${errorText}`);
    } catch (e) {
      logger.debug(`requestfailed listener failed: ${String(e)}`);
    }
  };

  private readonly onConsole = (message: ConsoleMessage): void => {
    try {
      // Warnings are almost always framework chatter; errors are the ones that
      // correlate with an action having actually failed.
      if (message.type() !== 'error') return;
      this.pushProblem(`console.error: ${message.text()}`);
    } catch (e) {
      logger.debug(`console listener failed: ${String(e)}`);
    }
  };

  private readonly onPageError = (error: Error): void => {
    this.pushProblem(`pageerror: ${error.message}`);
  };

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private upsert(
    method: string,
    pattern: string,
    url: string,
    status: number,
    contentType: string,
  ): ObservedEndpoint {
    const key = `${method} ${pattern}`;
    const existing = this.table.get(key);
    const entry: ObservedEndpoint = existing ?? {
      method,
      url,
      pattern,
      hits: 0,
      lastSeenAt: 0,
    };

    entry.hits += 1;
    entry.lastSeenAt = Date.now();
    entry.status = status;
    if (contentType) entry.contentType = contentType;
    // Keep the most recent concrete URL: it is the one `replayEndpoint` will
    // fire, and the freshest ids are the ones most likely to still resolve.
    entry.url = url;

    // Delete-then-set moves the key to the end, so the Map's iteration order is
    // least-recently-seen first and eviction is just "drop the first key".
    this.table.delete(key);
    this.table.set(key, entry);
    while (this.table.size > this.maxEndpoints) {
      const oldest = this.table.keys().next();
      if (oldest.done || oldest.value === undefined) break;
      this.table.delete(oldest.value);
    }
    return entry;
  }

  private shapeOfPostData(request: Request): string | undefined {
    const raw = request.postData();
    if (!raw || raw.length > this.maxBodyBytes) return undefined;
    const parsed = parseJsonish(raw);
    return parsed === undefined ? undefined : describeShape(parsed);
  }

  /**
   * Read a response body without ever blocking or leaking.
   *
   * Reading a body pulls it across CDP, which costs a round trip and — for a
   * streaming or long-polling response — may not resolve for minutes. So:
   *   - we never `await` inside the event handler, because the handler runs on
   *     playwright's event dispatch and stalling it stalls every later event
   *     (including the ones the settle heuristic depends on);
   *   - both outcomes are handled on the same chain, so the promise can never
   *     reject unhandled. Bodies are routinely *unavailable* — redirects, aborts
   *     and responses whose page navigated away all reject here — and an
   *     unhandled rejection in an MCP server is fatal noise on stderr;
   *   - it is attempted at most twice per endpoint, so a page polling
   *     `/api/status` every second pays for one read, not thousands.
   *
   * A read that never settles (a long-poll held open by the server) simply
   * leaves the pending counter high until the page closes, at which point
   * playwright rejects it — bounded, and cheaper than arming a timer per read.
   */
  private readBodyLazily(entry: ObservedEndpoint, response: Response): void {
    const attempts = this.bodyAttempts.get(entry) ?? 0;
    if (attempts >= MAX_BODY_ATTEMPTS) return;
    this.bodyAttempts.set(entry, attempts + 1);

    this.pending += 1;
    void response
      .body()
      .then(
        (buffer) => {
          // The declared length may have been absent or wrong; this is the
          // authoritative check.
          if (buffer.length > this.maxBodyBytes) return;
          const parsed = parseJsonish(buffer.toString('utf8'));
          if (parsed !== undefined) entry.responseShape = describeShape(parsed);
        },
        () => {
          // Expected: redirect, aborted request, or the page navigated away
          // before the body finished. Nothing to report.
        },
      )
      .then(
        () => {
          this.pending -= 1;
        },
        () => {
          this.pending -= 1;
        },
      );
  }

  private pushProblem(raw: string): void {
    // Stack traces arrive multi-line; flatten so one problem is one line.
    const text = truncate(normalizeText(raw), MAX_PROBLEM_CHARS);
    if (!text) return;
    const last = this.problems[this.problems.length - 1];
    // Consecutive duplicates only: a render loop logging the same error 400
    // times must cost one line, but an error that recurs *after* something else
    // happened is genuinely new information.
    if (last && last.text === text) {
      last.count += 1;
      return;
    }
    if (this.problems.length >= MAX_PROBLEMS) {
      this.dropped += 1;
      return;
    }
    this.problems.push({ text, count: 1 });
  }

  /** Path-only when same-origin as the page, host+path otherwise. */
  private shortUrl(raw: string): string {
    try {
      const url = new URL(raw);
      let pageOrigin: string | undefined;
      try {
        pageOrigin = new URL(this.page.url()).origin;
      } catch {
        pageOrigin = undefined;
      }
      return url.origin === pageOrigin ? url.pathname : `${url.host}${url.pathname}`;
    } catch {
      return truncate(raw, 80);
    }
  }
}

/** Parse only when the text plausibly *is* JSON — `JSON.parse` on 200KB of HTML is pure waste. */
function parseJsonish(raw: string): unknown {
  const text = raw.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

interface RawReplayResult {
  ok: boolean;
  status?: number;
  contentType?: string;
  text?: string;
  truncated?: boolean;
  error?: string;
}

export interface ReplayResult {
  status: number;
  contentType?: string;
  json?: unknown;
  text?: string;
}

/** Upper bound on what we drag back over CDP from a single replay. */
const MAX_REPLAY_CHARS = 256 * 1024;
const REPLAY_TIMEOUT_MS = 15_000;

/**
 * Re-issue an observed endpoint and return its payload.
 *
 * The fetch runs **inside the page**, and that is the entire trick: the browser
 * then applies the origin's cookies for us — including `HttpOnly` session
 * cookies that no out-of-band HTTP client could ever read — plus the origin's
 * CORS rules, its service worker, and any client certificate or proxy auth
 * bound to that browser profile. Replaying from Node would mean exporting
 * cookies, replicating headers and forging an origin; replaying from the page
 * means the request is simply *the application making its own call again*.
 *
 * The tradeoff, worth stating because it decides when to fall back to the UI:
 * headers injected by the app's own client (an `Authorization` bearer held in
 * JS memory, a CSRF token read from a store) are NOT reproduced. Endpoints that
 * depend on those return 401/403 here, which the caller should read as "drive
 * the UI instead".
 */
export async function replayEndpoint(
  page: Page,
  endpoint: ObservedEndpoint,
  init?: { method?: string; body?: unknown; query?: Record<string, string> },
): Promise<ReplayResult> {
  const method = (init?.method ?? endpoint.method ?? 'GET').toUpperCase();

  let base: string | undefined;
  try {
    base = page.url();
  } catch {
    base = undefined;
  }

  let target: URL;
  try {
    target = new URL(endpoint.url, base && base !== 'about:blank' ? base : undefined);
  } catch {
    throw new FbaError('INVALID_ARGUMENT', `cannot replay ${endpoint.url}: not an absolute URL`, {
      hint: 'navigate the session to the application first, or pass an absolute endpoint URL',
    });
  }

  if (init?.query) {
    for (const [name, value] of Object.entries(init.query)) target.searchParams.set(name, value);
  }

  let body: string | null = null;
  if (init?.body !== undefined) {
    if (method === 'GET' || method === 'HEAD') {
      throw new FbaError('INVALID_ARGUMENT', `${method} cannot carry a request body`, {
        hint: 'pass method: "POST" (or put the values in `query`)',
      });
    }
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
  }

  if (base && base !== 'about:blank') {
    try {
      if (new URL(base).origin !== target.origin) {
        // Not fatal — a CORS-enabled API still answers — but the cookie benefit
        // is lost, so say so once at debug level rather than failing.
        logger.debug(`replaying ${target.origin} from a page on ${new URL(base).origin}: cookies will not be sent`);
      }
    } catch {
      // Unparseable page URL; nothing useful to warn about.
    }
  }

  const raw: RawReplayResult = await page.evaluate(
    async (args: { url: string; method: string; body: string | null; maxChars: number; timeoutMs: number }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), args.timeoutMs);
      try {
        const headers: Record<string, string> = { accept: 'application/json, text/plain, */*' };
        if (args.body !== null) headers['content-type'] = 'application/json';
        const response = await fetch(args.url, {
          method: args.method,
          headers,
          body: args.body === null ? undefined : args.body,
          // `same-origin` (fetch's default) rather than `include`: `include` on
          // a cross-origin call without matching CORS headers fails outright,
          // and for the same-origin case — which is the case that matters —
          // both send the session cookie.
          credentials: 'same-origin',
          signal: controller.signal,
        });
        const text = await response.text();
        const truncated = text.length > args.maxChars;
        return {
          ok: true,
          status: response.status,
          contentType: response.headers.get('content-type') ?? '',
          // The body is already downloaded by the time we get here; the cap is
          // on what crosses CDP, which is the expensive half.
          text: truncated ? text.slice(0, args.maxChars) : text,
          truncated,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        clearTimeout(timer);
      }
    },
    { url: target.toString(), method, body, maxChars: MAX_REPLAY_CHARS, timeoutMs: REPLAY_TIMEOUT_MS },
  );

  if (!raw.ok) {
    throw new FbaError('STEP_FAILED', `replay of ${method} ${target.pathname} failed: ${raw.error ?? 'unknown error'}`, {
      hint: 'the endpoint may need headers the app sets in JS — fall back to driving the UI',
      details: { url: target.toString(), method },
    });
  }

  const result: ReplayResult = { status: raw.status ?? 0 };
  const mime = raw.contentType ? raw.contentType.split(';')[0]?.trim() : undefined;
  if (mime) result.contentType = mime;

  const text = raw.text ?? '';
  if (!raw.truncated) {
    const parsed = parseJsonish(text);
    if (parsed !== undefined) {
      result.json = parsed;
      return result;
    }
  }
  // Non-JSON, or truncated so far past valid JSON that parsing is pointless.
  if (text) result.text = raw.truncated ? `${text}…` : text;
  return result;
}
