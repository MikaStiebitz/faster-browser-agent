/**
 * Request blocking (L0).
 *
 * Agents pay for bytes twice: once in wall-clock latency waiting for the page
 * to settle, and once in the settle heuristic itself (every in-flight request
 * resets the network-quiet window). Killing images, fonts, media and analytics
 * beacons typically removes 60-80% of the requests on a real app page and takes
 * a chunk of a second off every navigation — without changing a single thing
 * the agent can perceive, because none of it reaches the accessibility tree.
 */

import type { BrowserContext, Route } from 'playwright-core';

import type { BlockingPolicy, ResourceCategory } from '../types.js';
import { createLogger } from '../util/logger.js';

const logger = createLogger('blocking');

/**
 * Map playwright's resource types onto our smaller category vocabulary.
 *
 * `xhr` deliberately absorbs fetch/eventsource/websocket: from a blocking
 * perspective they are all "the application talking to its own backend", which
 * is exactly the traffic we must never touch.
 */
export function categoryFor(resourceType: string): ResourceCategory {
  switch (resourceType) {
    case 'document':
      return 'document';
    case 'image':
      return 'image';
    case 'media':
    case 'texttrack':
      return 'media';
    case 'font':
      return 'font';
    case 'stylesheet':
      return 'stylesheet';
    case 'script':
      return 'script';
    case 'xhr':
    case 'fetch':
    case 'eventsource':
    case 'websocket':
      return 'xhr';
    default:
      return 'other';
  }
}

/** Categories that are never blockable, whatever the policy says. */
const NEVER_BLOCK: ReadonlySet<ResourceCategory> = new Set<ResourceCategory>([
  // Blocking the main document means blocking the navigation itself.
  'document',
  // The app's own data. Blocking it does not "speed the page up", it breaks it,
  // and a broken page costs the agent far more round trips than it saves.
  'xhr',
]);

interface CompiledPolicy {
  categories: ReadonlySet<ResourceCategory>;
  block?: RegExp;
  allow?: RegExp;
  /** Cheap fingerprint used to notice that the policy object was replaced. */
  signature: string;
}

/**
 * Compiled policies are cached by object identity. `loadConfig()` rebuilds the
 * policy object whenever anything changes, so identity is a sound key; the
 * signature guards the remaining case where a caller mutates the arrays in
 * place. Compiling on every request would dominate the cost of the check
 * itself — this route handler runs for *every* subresource on the page.
 */
const compiledCache = new WeakMap<BlockingPolicy, CompiledPolicy>();

function signatureOf(policy: BlockingPolicy): string {
  return `${policy.enabled ? 1 : 0}:${policy.categories.length}:${policy.patterns.length}:${policy.allow.length}`;
}

function compile(policy: BlockingPolicy): CompiledPolicy {
  const cached = compiledCache.get(policy);
  if (cached && cached.signature === signatureOf(policy)) return cached;

  const compiled: CompiledPolicy = {
    categories: new Set(policy.categories),
    signature: signatureOf(policy),
  };
  const block = combine(policy.patterns);
  if (block) compiled.block = block;
  const allow = combine(policy.allow);
  if (allow) compiled.allow = allow;

  compiledCache.set(policy, compiled);
  return compiled;
}

/**
 * Fold many patterns into ONE alternation regex.
 *
 * A single `RegExp.test` over the raw URL string beats N `String.includes`
 * calls once N passes a handful, and the default policy alone ships ~20
 * patterns. We also never build a `URL` object here: parsing a URL allocates
 * and normalises for no benefit when a substring test answers the question.
 *
 * Pattern dialect (documented for users writing config):
 *   `/re/flags`  — an explicit regular expression
 *   `*` present  — a glob, where `*` means "any characters"
 *   otherwise    — a literal substring, matched anywhere in the URL
 */
function combine(patterns: readonly string[]): RegExp | undefined {
  const sources: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    const explicit = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
    try {
      if (explicit?.[1]) {
        // Validate in isolation so one bad pattern cannot poison the whole
        // alternation (and take blocking down with it).
        new RegExp(explicit[1]);
        sources.push(`(?:${explicit[1]})`);
      } else if (pattern.includes('*')) {
        sources.push(`(?:${pattern.split('*').map(escapeRegExp).join('.*')})`);
      } else {
        sources.push(`(?:${escapeRegExp(pattern)})`);
      }
    } catch (e) {
      logger.warn(`ignoring invalid blocking pattern ${JSON.stringify(raw)}: ${String(e)}`);
    }
  }
  if (sources.length === 0) return undefined;
  return new RegExp(sources.join('|'), 'i');
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The whole decision, synchronously and allocation-free on the hot path.
 *
 * Order matters: never-block categories first (a rule can never override
 * them), then the allow-list (an explicit allow beats every block rule), then
 * patterns, then categories.
 */
export function shouldBlock(url: string, resourceType: string, policy: BlockingPolicy): boolean {
  if (!policy.enabled) return false;

  const category = categoryFor(resourceType);
  if (NEVER_BLOCK.has(category)) return false;

  const compiled = compile(policy);
  if (compiled.allow?.test(url)) return false;
  if (compiled.block?.test(url)) return true;
  return compiled.categories.has(category);
}

export interface BlockingHandle {
  /** Stop intercepting. Safe to call more than once, and after context close. */
  detach(): Promise<void>;
  stats(): { blocked: number; allowed: number; bytesSaved: number };
}

/**
 * Rough per-category byte savings, used only for reporting.
 *
 * We abort before any body arrives, so the true saving is unknowable; these are
 * conservative medians from real app pages. Reported as an estimate precisely
 * so nobody mistakes it for a measurement.
 */
const ESTIMATED_BYTES: Record<ResourceCategory, number> = {
  image: 45_000,
  media: 250_000,
  font: 60_000,
  stylesheet: 20_000,
  script: 80_000,
  xhr: 0,
  document: 0,
  other: 10_000,
};

/** Process-wide counters behind {@link blockingStats}. */
let globalBlocked = 0;
let globalAllowed = 0;

/**
 * Install the route handler on a context.
 *
 * One `**\/*` route rather than several narrower ones: playwright evaluates
 * route patterns in order and each one costs a URL match per request, so a
 * single catch-all with our own fast test is measurably cheaper.
 */
export async function applyBlocking(context: BrowserContext, policy: BlockingPolicy): Promise<BlockingHandle> {
  let blocked = 0;
  let allowed = 0;
  let bytesSaved = 0;
  let detached = false;

  const handler = (route: Route): void => {
    const request = route.request();
    const url = request.url();
    const resourceType = request.resourceType();

    if (shouldBlock(url, resourceType, policy)) {
      blocked += 1;
      globalBlocked += 1;
      bytesSaved += ESTIMATED_BYTES[categoryFor(resourceType)];
      // `blockedbyclient` rather than fulfilling a 1x1 transparent pixel:
      // fulfilling costs an extra IPC round trip plus a body copy per request.
      // The tradeoff is that an aborted image contributes no intrinsic size, so
      // pages using un-sized <img> reflow slightly. Agents read the
      // accessibility tree, not pixels, and every element keeps its box, its
      // role and its accessible name — so we take the speed.
      void route.abort('blockedbyclient').catch(swallow);
      return;
    }

    allowed += 1;
    globalAllowed += 1;
    void route.continue().catch(swallow);
  };

  await context.route('**/*', handler);
  logger.debug(
    `blocking active: ${policy.categories.join(',') || 'no categories'} + ${policy.patterns.length} patterns`,
  );

  return {
    async detach(): Promise<void> {
      if (detached) return;
      detached = true;
      try {
        await context.unroute('**/*', handler);
      } catch {
        // Context already closed — the route died with it.
      }
    },
    stats: () => ({ blocked, allowed, bytesSaved }),
  };
}

/**
 * Aborting/continuing races page teardown constantly (navigations cancel
 * in-flight requests). Those rejections are noise, never actionable.
 */
function swallow(): void {
  /* intentionally empty */
}

/** Process-wide totals since start; per-context numbers live on the handle. */
export function blockingStats(): { blocked: number; allowed: number } {
  return { blocked: globalBlocked, allowed: globalAllowed };
}

/** Reset the process-wide counters (used by tests and by long-lived servers). */
export function resetBlockingStats(): void {
  globalBlocked = 0;
  globalAllowed = 0;
}
