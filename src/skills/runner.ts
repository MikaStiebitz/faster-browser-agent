/**
 * L3 skill cache — replay.
 *
 * The economics: the first time an agent completes a flow it pays many LLM
 * round trips (snapshot, decide, click, snapshot, ...). Replaying the compiled
 * trajectory costs zero model calls — the executor runs the recorded steps
 * straight through. For recurring flows (log in, open the settings page, seed a
 * fixture) that is the single largest saving in the whole system.
 *
 * The price of that saving is a verification discipline: a skill that half
 * executes and reports success is *worse* than no skill, because the agent then
 * reasons about a page state that does not exist. So every `assert` step in a
 * record is treated as a verifier and any failure aborts the replay immediately
 * with a `fallbackReason` the caller can act on (fall back to model-driven
 * navigation, then re-record).
 */

import type { Executor, Session, SkillRunner, SkillStore } from '../contracts.js';
import type {
  ActOptions,
  ActResult,
  ActionStep,
  Observation,
  SettleOptions,
  SkillRecord,
  SkillReplayResult,
  StepResult,
  Target,
} from '../types.js';
import { FbaError, errorMessage } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { truncate } from '../util/text.js';
import { extractParams, interpolateSteps, normalizeOrigin, normalizeSkillName } from './store.js';

const logger = createLogger('skills:runner');

/** Runs after which the failure ratio is worth reporting at all. */
const STALE_MIN_RUNS = 4;

export class DefaultSkillRunner implements SkillRunner {
  constructor(
    private readonly store: SkillStore,
    private readonly executor: Executor,
  ) {}

  async replay(
    session: Session,
    name: string,
    params: Record<string, string> = {},
    options: ActOptions = {},
  ): Promise<SkillReplayResult> {
    const currentOrigin = normalizeOrigin(sessionUrl(session));
    const { record, originMismatch } = await this.resolve(name, currentOrigin);

    const notes: string[] = [];
    if (originMismatch) {
      // Not fatal: the same app on another port is the common case in dev. The
      // caller still deserves to know the steps were never proven here.
      notes.push(
        `skill "${record.name}" was recorded against ${record.origin} but the page is on ${currentOrigin}`,
      );
    }
    if (isStale(record)) {
      notes.push(
        `skill "${record.name}" looks stale — ${record.failures} of ${record.runs} replays failed; consider re-recording it`,
      );
    }
    if (!record.steps.some((step) => step.do === 'assert')) {
      notes.push(`skill "${record.name}" has no assert steps, so its replay is unverified`);
    }

    const steps = this.prepare(record, params);
    const started = Date.now();

    let result: ActResult;
    try {
      result = await this.executor.run(session, steps, {
        ...options,
        // A skill is a compiled trajectory, not a best-effort script: the first
        // divergence must stop it, never limp on into an unknown page state.
        onFailure: 'stop',
        // Replaying a skill must not silently re-record over itself.
        record: undefined,
      });
    } catch (e) {
      const ms = Date.now() - started;
      await this.recordRun(record, false, ms);
      const reason = `replay aborted: ${errorMessage(e)}`;
      const observation = await observeQuietly(session);
      if (!observation) throw new FbaError('SKILL_REPLAY_FAILED', reason, { hint: FALLBACK_HINT, cause: e });
      return {
        name: record.name,
        ok: false,
        steps: [],
        ms,
        fallbackReason: reason,
        observation: withNotes(observation, [...notes, reason]),
      };
    }

    const ms = Date.now() - started;
    // Defence in depth: even if an executor variant reports overall success, a
    // failed assertion means the page is not in the state the skill promises.
    const brokenAssert = result.steps.find((step) => step.step === 'assert' && step.status === 'failed');
    const ok = result.ok && !brokenAssert;
    const fallbackReason = ok ? undefined : describeFailure(result.steps, record, brokenAssert);

    await this.recordRun(record, ok, ms);
    if (fallbackReason) notes.push(fallbackReason);

    return {
      name: record.name,
      ok,
      steps: result.steps,
      ms,
      ...(fallbackReason ? { fallbackReason } : {}),
      observation: withNotes(result.observation, notes),
    };
  }

  /**
   * Find the record for (name, origin), falling back to a name-only lookup.
   *
   * The fallback exists because dev servers move ports constantly; refusing to
   * replay a known-good flow because the port changed would throw away the
   * whole benefit for the most common workflow there is.
   */
  private async resolve(
    name: string,
    currentOrigin: string,
  ): Promise<{ record: SkillRecord; originMismatch: boolean }> {
    const exact = await this.store.get(name, currentOrigin);
    if (exact) return { record: exact, originMismatch: false };

    const anywhere = await this.store.get(name);
    if (anywhere) return { record: anywhere, originMismatch: normalizeOrigin(anywhere.origin) !== currentOrigin };

    const available = (await this.store.list(currentOrigin)).map((r) => r.name);
    throw new FbaError('SKILL_NOT_FOUND', `no skill named "${name}"`, {
      hint: available.length
        ? `known skills for ${currentOrigin}: ${available.slice(0, 20).join(', ')}`
        : 'record one by passing `record: "<name>"` to a successful action program',
      details: { name, origin: currentOrigin, available },
    });
  }

  /** Validate parameters up front, then interpolate. */
  private prepare(record: SkillRecord, params: Record<string, string>): ActionStep[] {
    // The steps are the source of truth: `record.params` can lag behind if a
    // record was edited by hand.
    const needed = extractParams(record.steps);
    const missing = needed.filter((param) => params[param] === undefined);
    if (missing.length > 0) {
      throw new FbaError(
        'INVALID_ARGUMENT',
        `skill "${record.name}" needs ${missing.map((p) => `"${p}"`).join(', ')}`,
        { hint: `required parameters: ${needed.join(', ')}`, details: { required: needed, missing } },
      );
    }
    return interpolateSteps(record.steps, params);
  }

  private async recordRun(record: SkillRecord, ok: boolean, ms: number): Promise<void> {
    try {
      // Statistics are keyed by where the record actually lives, not by the
      // session's origin, or a port change would orphan the counters.
      await this.store.markRun(record.name, record.origin, ok, ms);
    } catch (e) {
      // Bookkeeping must never turn a successful replay into a failure.
      logger.warn(`failed to record run for skill ${record.name}: ${errorMessage(e)}`);
    }
  }
}

const FALLBACK_HINT = 'fall back to model-driven navigation, then re-record the skill';

function sessionUrl(session: Session): string {
  try {
    const live = session.page.url();
    if (live) return live;
  } catch {
    // Page closed or detached — fall through to the last known snapshot.
  }
  return session.lastSnapshot()?.url ?? 'about:blank';
}

function isStale(record: SkillRecord): boolean {
  return record.runs >= STALE_MIN_RUNS && record.failures > record.runs / 2;
}

function withNotes(observation: Observation, notes: string[]): Observation {
  if (notes.length === 0) return observation;
  return { ...observation, notes: [...(observation.notes ?? []), ...notes] };
}

async function observeQuietly(session: Session): Promise<Observation | undefined> {
  try {
    return await session.observe({ noSettle: true });
  } catch {
    return undefined;
  }
}

/** Human/model-readable explanation of why the replay stopped. */
function describeFailure(
  steps: StepResult[],
  record: SkillRecord,
  brokenAssert: StepResult | undefined,
): string {
  const failed = brokenAssert ?? steps.find((step) => step.status === 'failed');
  if (!failed) return 'replay did not complete; page state is unverified';

  const total = record.steps.length;
  const where = `step ${failed.index + 1}/${total} (${failed.step})`;
  const detail = failed.error ?? failed.detail ?? 'no detail';
  if (failed.step === 'assert') {
    const original = record.steps[failed.index];
    return `verification failed at ${where}: expected ${assertSummary(original)} — ${truncate(detail, 200)}`;
  }
  return `${where} failed: ${truncate(detail, 200)}`;
}

function assertSummary(step: ActionStep | undefined): string {
  if (!step || step.do !== 'assert') return 'assertion to hold';
  const parts: string[] = [];
  if (step.urlContains) parts.push(`url to contain "${step.urlContains}"`);
  if (step.text !== undefined) parts.push(`text "${step.text}"`);
  if (step.value !== undefined) parts.push(`value "${step.value}"`);
  if (step.exists === true) parts.push('element to exist');
  if (step.exists === false) parts.push('element to be absent');
  if (step.target) parts.push(`on ${describeTarget(step.target)}`);
  return parts.length > 0 ? parts.join(' and ') : 'assertion to hold';
}

function describeTarget(target: Target): string {
  const label =
    target.name ?? target.text ?? target.label ?? target.placeholder ?? target.testId ?? target.css ?? target.ref;
  const role = target.role ? `${target.role} ` : '';
  return label ? `${role}"${truncate(label, 60)}"` : `${role || 'element'}`.trim();
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export interface CompileOptions {
  description?: string;
  /** Append a URL assertion so the replay verifies where it landed. */
  addAssertions?: boolean;
}

/**
 * Build a replayable `SkillRecord` from a program that just succeeded.
 *
 * Two transformations matter:
 *  - `eval` steps are dropped. Arbitrary page JS is the one action whose effect
 *    we can neither verify nor heal; blind-replaying it months later against a
 *    changed app can corrupt real state with no way to notice. A skill that
 *    silently omits it is honest — one that replays it is a loaded gun.
 *  - Runs of `settle` steps collapse into one. Recorded programs accumulate
 *    redundant waits, and every extra settle is pure latency on every future
 *    replay.
 */
export function compileFromSteps(
  name: string,
  origin: string,
  steps: ActionStep[],
  options: CompileOptions = {},
): SkillRecord {
  const canonicalName = normalizeSkillName(name);
  const canonicalOrigin = normalizeOrigin(origin);

  const kept: ActionStep[] = [];
  for (const step of steps) {
    if (!step || typeof step.do !== 'string') continue;
    if (step.do === 'eval') continue;
    const previous = kept[kept.length - 1];
    if (step.do === 'settle' && previous?.do === 'settle') {
      kept[kept.length - 1] = mergeSettle(previous, step);
      continue;
    }
    kept.push(structuredClone(step));
  }

  if (options.addAssertions) {
    const assertion = urlAssertion(kept, canonicalOrigin);
    if (assertion) kept.push(assertion);
  }

  const now = Date.now();
  const record: SkillRecord = {
    name: canonicalName,
    origin: canonicalOrigin,
    ...(options.description ? { description: options.description } : {}),
    params: extractParams(kept),
    steps: kept,
    createdAt: now,
    updatedAt: now,
    runs: 0,
    failures: 0,
  };

  const problems = validateCompiled(record);
  if (problems.length > 0) {
    throw new FbaError('INVALID_ARGUMENT', `cannot compile skill "${canonicalName}": ${problems.join('; ')}`, {
      details: { problems },
    });
  }
  return record;
}

function validateCompiled(record: SkillRecord): string[] {
  if (record.steps.length === 0) {
    return ['nothing replayable remains after removing eval steps'];
  }
  return [];
}

/** Keep the most conservative of two consecutive settles. */
function mergeSettle(a: ActionStep, b: ActionStep): ActionStep {
  if (a.do !== 'settle' || b.do !== 'settle') return b;
  const left = a.options ?? {};
  const right = b.options ?? {};
  const merged: SettleOptions = {};
  const network = maxDefined(left.networkQuietMs, right.networkQuietMs);
  if (network !== undefined) merged.networkQuietMs = network;
  const dom = maxDefined(left.domQuietMs, right.domQuietMs);
  if (dom !== undefined) merged.domQuietMs = dom;
  const timeout = maxDefined(left.timeoutMs, right.timeoutMs);
  if (timeout !== undefined) merged.timeoutMs = timeout;
  return Object.keys(merged).length > 0 ? { do: 'settle', options: merged } : { do: 'settle' };
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * Derive a final URL assertion from the program's last navigation.
 *
 * Placeholders are preserved verbatim (`/orders/{{id}}`) so the assertion is
 * interpolated with the same parameters as the rest of the replay.
 */
function urlAssertion(steps: ActionStep[], origin: string): ActionStep | undefined {
  const last = steps[steps.length - 1];
  // Do not stack a second URL assertion on top of one the caller wrote.
  if (last?.do === 'assert' && last.urlContains) return undefined;

  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (!step) continue;
    if (step.do === 'goto') {
      const raw = step.url ?? step.route;
      if (!raw) continue;
      const path = pathPart(raw, origin);
      return path ? { do: 'assert', urlContains: path } : undefined;
    }
    if (step.do === 'waitFor' && step.urlContains) {
      return { do: 'assert', urlContains: step.urlContains };
    }
  }
  return undefined;
}

/**
 * Path portion of a URL, by string surgery rather than `new URL`.
 *
 * The WHATWG parser percent-encodes `{` and `}`, which would turn `{{id}}` into
 * `%7B%7Bid%7D%7D` and break interpolation.
 */
function pathPart(url: string, origin: string): string {
  let rest = url;
  if (rest.toLowerCase().startsWith(origin.toLowerCase())) {
    rest = rest.slice(origin.length);
  } else {
    const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/i.exec(rest);
    if (match) rest = match[1] ?? '';
  }
  const withoutHash = rest.split('#')[0] ?? '';
  const withoutQuery = withoutHash.split('?')[0] ?? '';
  const path = withoutQuery.startsWith('/') || withoutQuery === '' ? withoutQuery : `/${withoutQuery}`;
  // Asserting on "/" would match every page — worse than not asserting at all.
  return path === '/' || path === '' ? '' : path.replace(/\/+$/, '');
}
