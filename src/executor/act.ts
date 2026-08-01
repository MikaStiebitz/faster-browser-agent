/**
 * L2 — the action program executor.
 *
 * This is where the "one LLM call per click" cost disappears. The model emits a
 * whole guarded program (`click Settings`, `selectTab Advanced > Network`,
 * `type 8080 into Port`, `click Save`, `assert url contains /network`) and this
 * file runs it to completion without any further model involvement. Control
 * returns to the model only on divergence — a failed assert, a target that no
 * longer exists, a dialog that appeared.
 *
 * Three things dominate wall-clock time in a browser agent, and each has a
 * deliberate answer here:
 *
 *   1. model round trips      -> programs instead of single actions
 *   2. implicit waiting       -> short per-step timeouts and short inter-step
 *                                settles instead of Playwright's 30s defaults
 *   3. re-discovery after DOM -> the self-healing resolver, plus a one-shot
 *      churn                     retry when the page navigates mid-step
 */

import type { Locator } from 'playwright-core';

import type { Executor, ResolvedTarget, Session, TargetResolver } from '../contracts.js';
import type {
  ActOptions,
  ActResult,
  ActionStep,
  FormFillRequest,
  FormFillResult,
  Observation,
  ResolutionInfo,
  SettleOptions,
  StepResult,
  StepStatus,
  Target,
} from '../types.js';
import { FbaError, errorMessage, toFbaError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { bestMatch, matchKey, normalizeText, truncate } from '../util/text.js';
import type { SiteMemoryStore } from '../site/memory.js';
import { fillForm } from './form.js';
import { describeTarget, selectorForRef, targetResolver } from './resolve.js';

const logger = createLogger('executor');

/**
 * Budget used *between* steps.
 *
 * A fixed `sleep` is wrong in both directions: too short and the next step
 * races a re-render, too long and every step pays for the worst case. A full
 * settle is wrong too — the configured budget (seconds) is meant for "the page
 * finished reacting to a navigation", and paying it between every click of a
 * ten-step program is the single most expensive mistake a browser agent can
 * make. What actually matters between steps is only "did the DOM stop moving",
 * which for a local click resolves in tens of milliseconds. So: short quiet
 * windows, a hard 1.5s cap, and the full budget only once, at the end.
 */
const INTER_STEP_SETTLE: SettleOptions = { networkQuietMs: 150, domQuietMs: 150, timeoutMs: 1_500 };

/** Never give a single step less than this, however many steps there are. */
const MIN_STEP_TIMEOUT_MS = 2_000;

/**
 * A human-meaningful label for whatever the step activated.
 *
 * Used as the edge label in learned navigation, so it has to be the thing a
 * later query would ask for ("Settings"), not an internal ref.
 */
function transitionLabel(step: ActionStep, resolution: ResolutionInfo | undefined): string | undefined {
  if (step.do === 'selectTab') return step.path.join(' > ');
  if (step.do === 'goto') return undefined;
  const target = 'target' in step ? step.target : undefined;
  const named = target?.name ?? target?.label ?? target?.text ?? target?.testId;
  if (named) return truncate(normalizeText(named), 60);
  // Fall back to whatever the resolver actually matched — after healing, that
  // is often more accurate than what the caller asked for.
  if (resolution?.description) return truncate(normalizeText(resolution.description), 60);
  return undefined;
}

/** Steps after which the page is likely to be mid-flight. */
function mutates(step: ActionStep): boolean {
  switch (step.do) {
    case 'click':
    case 'dblclick':
    case 'select':
    case 'check':
    case 'goto':
    case 'back':
    case 'forward':
    case 'reload':
    case 'selectTab':
    case 'expand':
      return true;
    case 'type':
      // Plain typing only mutates local input state; Enter submits.
      return step.pressEnter === true;
    default:
      return false;
  }
}

/** Errors that mean "the world moved under us", not "the action was wrong". */
function isContextLost(message: string): boolean {
  return /Execution context was destroyed|context was destroyed|Cannot find context|frame (was )?detached|Target closed|Most likely the page has been closed|navigation/i.test(
    message,
  );
}

interface StepOutcome {
  status: Extract<StepStatus, 'ok' | 'skipped'>;
  detail?: string;
}

interface StepContext {
  resolver: TargetResolver;
  onNavigate?: (session: Session, urlOrRoute: { url?: string; route?: string }) => Promise<void>;
  timeoutMs: number;
  /** Filled in by the step when it resolved a target, for reporting. */
  resolution?: ResolutionInfo;
}

export interface ExecutorOptions {
  resolver?: TargetResolver;
  /**
   * Resolves `{ route }` (and relative urls) through the code index. Injected
   * by the caller so this layer keeps no dependency on L3.
   */
  onNavigate?: (session: Session, urlOrRoute: { url?: string; route?: string }) => Promise<void>;
  /**
   * Optional sink for learned navigation edges.
   *
   * The executor is the only layer that knows *what was activated* to cause a
   * navigation, which is exactly the edge worth remembering: "clicking Settings
   * on / leads to /settings". Recording it here costs one string comparison.
   */
  memory?: Pick<SiteMemoryStore, 'recordTransition'>;
}

export class DefaultExecutor implements Executor {
  private readonly resolver: TargetResolver;
  private readonly onNavigate?: ExecutorOptions['onNavigate'];
  private readonly memory?: ExecutorOptions['memory'];

  constructor(options: ExecutorOptions = {}) {
    this.resolver = options.resolver ?? targetResolver;
    if (options.onNavigate) this.onNavigate = options.onNavigate;
    if (options.memory) this.memory = options.memory;
  }

  /**
   * Remember "activating X on page A led to page B".
   *
   * Only real cross-page moves are recorded; a click that stays put teaches
   * nothing and would swamp the table.
   */
  private learnTransition(session: Session, step: ActionStep, ctx: StepContext, urlBefore: string): void {
    if (!this.memory) return;
    const urlAfter = safeUrl(session);
    if (!urlAfter || urlAfter === urlBefore) return;
    const via = transitionLabel(step, ctx.resolution);
    if (!via) return;
    try {
      this.memory.recordTransition(urlBefore, via, urlAfter);
    } catch {
      /* learning must never fail an action */
    }
  }

  async run(session: Session, steps: ActionStep[], options: ActOptions = {}): Promise<ActResult> {
    const started = Date.now();
    const onFailure = options.onFailure ?? 'stop';
    const budgetMs = options.timeoutMs ?? session.config.timeoutMs;
    const deadline = started + budgetMs;
    const notes: string[] = [];
    const results: StepResult[] = [];

    if (steps.length === 0) {
      return {
        steps: [],
        ok: true,
        observation: await this.observe(session, 'no steps', options),
      };
    }

    // Split the overall budget across the program rather than letting any one
    // step consume all of it, but never go below a usable floor and never above
    // the configured per-action timeout.
    const baseStepTimeout = Math.min(
      session.config.timeoutMs,
      Math.max(MIN_STEP_TIMEOUT_MS, Math.floor(budgetMs / steps.length)),
    );

    let failedAt: number | undefined;
    let aborted = false;
    let timedOut = false;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;
      const stepStarted = Date.now();

      if (aborted) {
        results.push({ index: i, step: step.do, status: 'skipped', detail: 'aborted after an earlier failure', ms: 0 });
        continue;
      }
      if (stepStarted >= deadline) {
        timedOut = true;
        results.push({ index: i, step: step.do, status: 'skipped', detail: 'program budget exhausted', ms: 0 });
        continue;
      }

      const remaining = deadline - stepStarted;
      const ctx: StepContext = {
        resolver: this.resolver,
        ...(this.onNavigate ? { onNavigate: this.onNavigate } : {}),
        timeoutMs: Math.max(500, Math.min(baseStepTimeout, remaining)),
      };

      let outcome: StepOutcome | undefined;
      let error: FbaError | undefined;
      let retried = false;
      // Only read the url when something is actually listening: doing work for
      // a disabled feature is waste, and this runs once per step.
      const urlBefore = this.memory ? safeUrl(session) : '';

      try {
        outcome = await this.execute(session, step, ctx);
      } catch (e) {
        const err = toFbaError(e, 'STEP_FAILED');
        if (isContextLost(err.message)) {
          // The page navigated while we were acting; `window.__fba` went with
          // it. Re-inject and try once more before calling it a failure.
          logger.debug(`step ${i} (${step.do}) lost its context, re-injecting runtime`);
          try {
            await session.ensureRuntime();
            ctx.resolution = undefined;
            outcome = await this.execute(session, step, ctx);
            retried = true;
          } catch (e2) {
            error = toFbaError(e2, 'STEP_FAILED');
          }
        } else {
          error = err;
        }
      }

      if (error && onFailure === 'retry') {
        // Re-resolve from scratch after letting the page catch its breath: most
        // one-off failures are a control that was still animating in.
        await safeSettle(session, INTER_STEP_SETTLE);
        ctx.resolution = undefined;
        try {
          outcome = await this.execute(session, step, ctx);
          error = undefined;
          retried = true;
        } catch (e3) {
          error = toFbaError(e3, 'STEP_FAILED');
        }
      }

      const ms = Date.now() - stepStarted;

      if (!error && urlBefore) this.learnTransition(session, step, ctx, urlBefore);

      if (error) {
        failedAt ??= i;
        results.push({
          index: i,
          step: step.do,
          status: 'failed',
          ...(ctx.resolution ? { resolution: ctx.resolution } : {}),
          detail: `${step.do} ${describeStep(step)} failed`,
          error: error.toLine(),
          ms,
        });
        // 'retry' has already had its second chance by now, so it degrades to
        // 'stop' — continuing after an unrecoverable step usually compounds the
        // damage on a config UI.
        if (onFailure !== 'continue') aborted = true;
        continue;
      }

      const status: StepStatus =
        outcome?.status === 'skipped'
          ? 'skipped'
          : retried || ctx.resolution?.healed
            ? 'healed'
            : 'ok';

      results.push({
        index: i,
        step: step.do,
        status,
        ...(ctx.resolution ? { resolution: ctx.resolution } : {}),
        ...(outcome?.detail ? { detail: outcome.detail } : {}),
        ms,
      });

      const last = i === steps.length - 1;
      if (!last && mutates(step)) await safeSettle(session, INTER_STEP_SETTLE);
    }

    if (options.settle !== false) {
      await safeSettle(session, options.settle ?? session.config.settle);
    }

    if (timedOut) {
      notes.push(
        `TIMEOUT: the ${budgetMs}ms program budget was exhausted; ${results.filter((r) => r.status === 'skipped').length} step(s) were skipped`,
      );
    }
    for (const r of results) {
      if (r.status === 'healed' && r.resolution?.healed) {
        notes.push(`healed: ${r.resolution.description} (strategy ${r.resolution.strategy}) — refresh cached refs`);
      }
    }

    const observation = await this.observe(session, summarize(results), options);
    if (notes.length > 0) observation.notes = [...(observation.notes ?? []), ...notes];

    return {
      steps: results,
      ok: results.every((r) => r.status === 'ok' || r.status === 'healed'),
      ...(failedAt !== undefined ? { failedAt } : {}),
      observation,
    };
  }

  fillForm(session: Session, request: FormFillRequest): Promise<FormFillResult> {
    return fillForm(session, request, this.resolver, (s, steps, options) => this.run(s, steps, options));
  }

  // -------------------------------------------------------------------------

  private async observe(session: Session, summaryPrefix: string, options: ActOptions): Promise<Observation> {
    try {
      return await session.observe({
        // We have already settled (or were told not to); observing must not pay
        // for a second settle.
        noSettle: true,
        summaryPrefix,
        ...(options.full !== undefined ? { full: options.full } : {}),
      });
    } catch (e) {
      // An observation failure must not swallow the step results — they are the
      // valuable part of the answer.
      return {
        url: safeUrl(session),
        title: '',
        summary: `${summaryPrefix} — observation failed: ${errorMessage(e)}`,
        notes: [`observation failed: ${errorMessage(e)}`],
      };
    }
  }

  private async resolve(session: Session, target: Target, ctx: StepContext): Promise<ResolvedTarget> {
    const resolved = await ctx.resolver.resolve(session, target);
    ctx.resolution = resolved.resolution;
    // Acting on an offscreen element works in Playwright but scrolling first
    // makes the follow-up snapshot (which is viewport-scoped by default)
    // actually contain what we just touched.
    await resolved.locator.scrollIntoViewIfNeeded({ timeout: ctx.timeoutMs }).catch(() => undefined);
    return resolved;
  }

  private async execute(session: Session, step: ActionStep, ctx: StepContext): Promise<StepOutcome> {
    const timeout = ctx.timeoutMs;

    switch (step.do) {
      case 'click': {
        const { locator } = await this.resolve(session, step.target, ctx);
        await locator.click({
          timeout,
          ...(step.button ? { button: step.button } : {}),
          ...(step.clickCount ? { clickCount: step.clickCount } : {}),
          ...(step.modifiers ? { modifiers: step.modifiers } : {}),
        });
        return { status: 'ok', detail: `clicked ${ctx.resolution?.description ?? describeTarget(step.target)}` };
      }

      case 'dblclick': {
        const { locator } = await this.resolve(session, step.target, ctx);
        await locator.dblclick({ timeout });
        return { status: 'ok', detail: `double-clicked ${describeTarget(step.target)}` };
      }

      case 'hover': {
        const { locator } = await this.resolve(session, step.target, ctx);
        await locator.hover({ timeout });
        return { status: 'ok', detail: `hovered ${describeTarget(step.target)}` };
      }

      case 'focus': {
        const { locator } = await this.resolve(session, step.target, ctx);
        await locator.focus({ timeout });
        return { status: 'ok', detail: `focused ${describeTarget(step.target)}` };
      }

      case 'blur': {
        if (step.target) {
          const { locator } = await this.resolve(session, step.target, ctx);
          await locator.blur({ timeout });
        } else {
          await session.page.evaluate(() => {
            const active = document.activeElement;
            if (active instanceof HTMLElement) active.blur();
          });
        }
        return { status: 'ok', detail: 'blurred' };
      }

      case 'type':
        return this.typeInto(session, step, ctx);

      case 'setValue': {
        const { locator } = await this.resolve(session, step.target, ctx);
        // Sets the property through the native setter and fires input+change.
        // This BYPASSES key handlers entirely — no keydown/keypress/keyup — so
        // it is right for custom components that only listen to `change`, and
        // wrong for anything that filters or masks per keystroke.
        await locator.evaluate((el, value: string) => {
          const node = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
          const proto =
            node instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : node instanceof HTMLSelectElement
                ? HTMLSelectElement.prototype
                : HTMLInputElement.prototype;
          // React (and other frameworks) install a value tracker on the
          // instance; going through the prototype setter is what makes them
          // notice the change.
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
          if (descriptor?.set) descriptor.set.call(node, value);
          else node.value = value;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        }, step.value, { timeout });
        return { status: 'ok', detail: `set value of ${describeTarget(step.target)}` };
      }

      case 'select':
        return this.selectOption(session, step, ctx);

      case 'check': {
        const { locator } = await this.resolve(session, step.target, ctx);
        const want = step.checked ?? true;
        try {
          await locator.setChecked(want, { timeout });
        } catch (e) {
          // `setChecked` only understands real <input> checkboxes and radios.
          // Custom switches (div[role=switch]) need a plain click, and only
          // when they are not already in the wanted state.
          const current = await readChecked(locator, timeout);
          if (current === want) return { status: 'ok', detail: `already ${want ? 'checked' : 'unchecked'}` };
          if (current === undefined) throw e;
          await locator.click({ timeout });
        }
        const after = await readChecked(locator, timeout);
        if (after !== undefined && after !== want) {
          throw new FbaError(
            'STEP_FAILED',
            `${describeTarget(step.target)} is ${after ? 'checked' : 'unchecked'} after asking for ${want ? 'checked' : 'unchecked'}`,
            { hint: 'the control may be disabled, or its state is driven by another field' },
          );
        }
        return { status: 'ok', detail: `${want ? 'checked' : 'unchecked'} ${describeTarget(step.target)}` };
      }

      case 'upload': {
        const { locator } = await this.resolve(session, step.target, ctx);
        await locator.setInputFiles(step.files, { timeout });
        return { status: 'ok', detail: `uploaded ${step.files.length} file(s)` };
      }

      case 'press': {
        if (step.target) {
          const { locator } = await this.resolve(session, step.target, ctx);
          await locator.press(step.keys, { timeout });
        } else {
          await session.page.keyboard.press(step.keys);
        }
        return { status: 'ok', detail: `pressed ${step.keys}` };
      }

      case 'scroll':
        return this.scroll(session, step, ctx);

      case 'goto': {
        if (ctx.onNavigate && (step.url ?? step.route)) {
          // The caller owns route resolution and base-url joining (it has the
          // code index); we only sequence the navigation.
          await ctx.onNavigate(session, {
            ...(step.url ? { url: step.url } : {}),
            ...(step.route ? { route: step.route } : {}),
          });
        } else if (step.url) {
          await session.goto(step.url, { timeoutMs: timeout });
        } else {
          throw new FbaError('INVALID_ARGUMENT', `cannot resolve route "${step.route ?? ''}" without a code index`, {
            hint: 'pass an absolute url, or run through the MCP server where routes are resolved',
          });
        }
        return { status: 'ok', detail: `navigated to ${safeUrl(session)}` };
      }

      case 'back':
      case 'forward':
      case 'reload': {
        const page = session.page;
        if (step.do === 'back') await page.goBack({ timeout });
        else if (step.do === 'forward') await page.goForward({ timeout });
        else await page.reload({ timeout });
        // A document swap wipes `window.__fba`; every later step depends on it.
        await session.ensureRuntime();
        return { status: 'ok', detail: `${step.do} → ${safeUrl(session)}` };
      }

      case 'waitFor':
        return this.waitFor(session, step, ctx);

      case 'settle': {
        const result = await session.settle(step.options ?? session.config.settle);
        // A settle that times out is information, not a failure: pages with a
        // polling websocket never go fully quiet.
        return { status: 'ok', detail: `settled after ${result.waitedMs}ms (${result.reason})` };
      }

      case 'assert':
        return this.assert(session, step, ctx);

      case 'dialog': {
        await session.answerDialog(step.accept, step.promptText);
        return { status: 'ok', detail: `${step.accept ? 'accepted' : 'dismissed'} native dialog` };
      }

      case 'selectTab':
        return this.selectTab(session, step, ctx);

      case 'expand':
        return this.expand(session, step, ctx);

      case 'eval': {
        // Playwright evaluates a string that denotes a function by calling it
        // with the single argument — so the source receives the whole args
        // array: `(args) => args[0] + args[1]`.
        const value: unknown = await session.page.evaluate<unknown, unknown[]>(step.fn, step.args ?? []);
        return {
          status: 'ok',
          detail: value === undefined ? 'evaluated' : `evaluated → ${truncate(safeJson(value), 200)}`,
        };
      }
    }
  }

  // -------------------------------------------------------------------------
  // individual actions that need more than a couple of lines
  // -------------------------------------------------------------------------

  private async typeInto(
    session: Session,
    step: Extract<ActionStep, { do: 'type' }>,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const timeout = ctx.timeoutMs;
    const { locator } = await this.resolve(session, step.target, ctx);
    let slowPath = false;

    if (step.clear) {
      // `fill()` sets the value and fires one input event; `pressSequentially`
      // fires a full key sequence per character. For a 40-character API key
      // that is 120 extra CDP round trips, so fill() is the default and the
      // slow path is entered only when we can prove it was needed.
      const before = await readInputValue(locator, timeout);
      await locator.fill(step.text, { timeout });
      const after = await readInputValue(locator, timeout);
      if (after !== undefined && after === before && before !== step.text) {
        // The value did not move: a controlled component with per-keystroke
        // handlers (masked input, autocomplete) rejected the synthetic event.
        slowPath = true;
        await locator.pressSequentially(step.text, { timeout });
      }
    } else {
      await locator.focus({ timeout });
      await locator.press('End', { timeout }).catch(() => undefined);
      await locator.pressSequentially(step.text, { timeout });
    }

    if (step.pressEnter) await locator.press('Enter', { timeout });

    const how = step.clear ? (slowPath ? 'typed (per-keystroke)' : 'filled') : 'appended';
    return {
      status: 'ok',
      detail: `${how} ${truncate(step.text, 40)} into ${describeTarget(step.target)}${step.pressEnter ? ' + Enter' : ''}`,
    };
  }

  private async selectOption(
    session: Session,
    step: Extract<ActionStep, { do: 'select' }>,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const timeout = ctx.timeoutMs;
    const { locator } = await this.resolve(session, step.target, ctx);
    const wanted = Array.isArray(step.option) ? step.option : [step.option];

    // Label first: it is what the model saw in the snapshot. Values are an
    // implementation detail that only sometimes coincides with the label.
    try {
      await locator.selectOption(wanted.map((label) => ({ label })), { timeout });
      return { status: 'ok', detail: `selected ${wanted.join(', ')}` };
    } catch (e) {
      const message = errorMessage(e);
      if (/not a <select>|Element is not a/i.test(message)) {
        return this.selectCustom(session, locator, wanted, step, ctx);
      }
      try {
        await locator.selectOption(wanted.map((value) => ({ value })), { timeout });
        return { status: 'ok', detail: `selected ${wanted.join(', ')} by value` };
      } catch {
        // Last resort: fuzzy-match the option texts ourselves and select by
        // index, which handles labels that differ by whitespace or casing.
        const texts = await locator.locator('option').allTextContents();
        const indices: number[] = [];
        for (const want of wanted) {
          const hit = bestMatch(want, texts.map((text, index) => ({ text, index })), (o) => [o.text], {
            minScore: 0.6,
          });
          if (hit) indices.push(hit.item.index);
        }
        if (indices.length !== wanted.length) {
          throw new FbaError('STEP_FAILED', `no option matching ${wanted.join(', ')}`, {
            hint: `available options: ${texts.slice(0, 12).map((t) => normalizeText(t)).join(' | ')}`,
          });
        }
        await locator.selectOption(indices.map((index) => ({ index })), { timeout });
        return { status: 'ok', detail: `selected ${wanted.join(', ')} by option index` };
      }
    }
  }

  /** Custom (non-`<select>`) comboboxes: open, then click the option. */
  private async selectCustom(
    session: Session,
    locator: Locator,
    wanted: string[],
    step: Extract<ActionStep, { do: 'select' }>,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const first = wanted[0];
    if (wanted.length !== 1 || !first) {
      throw new FbaError('STEP_FAILED', 'multi-select is only supported on <select> elements', {
        hint: 'click the control and select the options one by one',
      });
    }
    await locator.click({ timeout: ctx.timeoutMs });
    // The listbox is usually rendered asynchronously into a portal.
    await safeSettle(session, { networkQuietMs: 100, domQuietMs: 100, timeoutMs: 800 });

    for (const role of ['option', 'menuitem', 'treeitem'] as const) {
      const candidates = await session.find({ role, name: first, limit: 5 }).catch(() => []);
      const top = candidates[0];
      if (top && top.score >= 0.6) {
        await session.page.locator(selectorForRef(top.ref)).first().click({ timeout: ctx.timeoutMs });
        return { status: 'ok', detail: `selected ${first} from a custom ${describeTarget(step.target)}` };
      }
    }
    throw new FbaError('STEP_FAILED', `no option named "${first}" appeared after opening the control`, {
      hint: 'snapshot the page to see what the dropdown rendered',
    });
  }

  private async scroll(
    session: Session,
    step: Extract<ActionStep, { do: 'scroll' }>,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    if (step.target) {
      const { locator, resolution } = await this.resolve(session, step.target, ctx);
      if (resolution.ref) {
        // The runtime knows about scroll containers that are not the window.
        const done = await session.page.evaluate(
          (ref: string) => window.__fba?.scrollIntoView(ref) ?? false,
          resolution.ref,
        );
        if (done) return { status: 'ok', detail: `scrolled ${describeTarget(step.target)} into view` };
      }
      await locator.scrollIntoViewIfNeeded({ timeout: ctx.timeoutMs });
      return { status: 'ok', detail: `scrolled ${describeTarget(step.target)} into view` };
    }

    const where = step.to ?? (step.by !== undefined ? 'by' : 'bottom');
    await session.page.evaluate(
      (arg: { where: string; by: number }) => {
        if (arg.where === 'top') window.scrollTo({ top: 0 });
        else if (arg.where === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight });
        else window.scrollBy({ top: arg.by });
      },
      { where, by: step.by ?? 0 },
    );
    return { status: 'ok', detail: where === 'by' ? `scrolled by ${step.by ?? 0}px` : `scrolled to ${where}` };
  }

  private async waitFor(
    session: Session,
    step: Extract<ActionStep, { do: 'waitFor' }>,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const timeout = step.timeoutMs ?? ctx.timeoutMs;

    if (step.urlContains !== undefined) {
      const needle = step.urlContains;
      await session.page.waitForURL((url) => url.href.includes(needle), { timeout });
      return { status: 'ok', detail: `url contains "${needle}"` };
    }

    if (step.target) {
      const state = step.state ?? 'visible';
      if (state === 'enabled') {
        // Playwright's waitFor() has no 'enabled' state, so poll — cheaply, and
        // bounded by the same timeout.
        const until = Date.now() + timeout;
        for (;;) {
          const resolved = await ctx.resolver.tryResolve(session, step.target);
          if (resolved) {
            ctx.resolution = resolved.resolution;
            if (await resolved.locator.isEnabled().catch(() => false)) {
              return { status: 'ok', detail: `${describeTarget(step.target)} is enabled` };
            }
          }
          if (Date.now() >= until) {
            throw new FbaError('TIMEOUT', `${describeTarget(step.target)} did not become enabled within ${timeout}ms`);
          }
          await delay(100);
        }
      }
      if (state === 'hidden') {
        // Hidden includes "not in the DOM at all", so an unresolvable target
        // satisfies the wait immediately.
        const resolved = await ctx.resolver.tryResolve(session, step.target);
        if (!resolved) return { status: 'ok', detail: `${describeTarget(step.target)} is gone` };
        ctx.resolution = resolved.resolution;
        await resolved.locator.waitFor({ state: 'hidden', timeout });
        return { status: 'ok', detail: `${describeTarget(step.target)} is hidden` };
      }
      const { locator } = await this.resolve(session, step.target, ctx);
      await locator.waitFor({ state: 'visible', timeout });
      return { status: 'ok', detail: `${describeTarget(step.target)} is visible` };
    }

    if (step.text !== undefined) {
      await session.page.getByText(step.text).first().waitFor({ state: 'visible', timeout });
      return { status: 'ok', detail: `"${truncate(step.text, 40)}" appeared` };
    }

    throw new FbaError('INVALID_ARGUMENT', 'waitFor needs a target, text or urlContains');
  }

  private async assert(
    session: Session,
    step: Extract<ActionStep, { do: 'assert' }>,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const checks: string[] = [];

    if (step.urlContains !== undefined) {
      const url = safeUrl(session);
      if (!url.includes(step.urlContains)) {
        throw new FbaError('ASSERTION_FAILED', `url "${url}" does not contain "${step.urlContains}"`);
      }
      checks.push(`url contains "${step.urlContains}"`);
    }

    let resolved: ResolvedTarget | undefined;
    if (step.target) {
      resolved = await ctx.resolver.tryResolve(session, step.target);
      if (resolved) ctx.resolution = resolved.resolution;
    }

    if (step.exists !== undefined) {
      const exists = resolved !== undefined;
      if (exists !== step.exists) {
        throw new FbaError(
          'ASSERTION_FAILED',
          `${describeTarget(step.target ?? {})} ${exists ? 'exists' : 'does not exist'}, expected ${step.exists ? 'it to exist' : 'it to be absent'}`,
          { hint: 'snapshot the page to see what is actually there' },
        );
      }
      checks.push(step.exists ? 'exists' : 'absent');
    }

    if (step.text !== undefined) {
      if (resolved) {
        const actual = normalizeText((await resolved.locator.textContent({ timeout: ctx.timeoutMs })) ?? '');
        if (!matchKey(actual).includes(matchKey(step.text))) {
          throw new FbaError(
            'ASSERTION_FAILED',
            `${describeTarget(step.target ?? {})} reads "${truncate(actual, 80)}", expected it to contain "${step.text}"`,
          );
        }
      } else if (step.target) {
        throw new FbaError('ASSERTION_FAILED', `${describeTarget(step.target)} not found, cannot check its text`);
      } else {
        const count = await session.page.getByText(step.text).count();
        if (count === 0) {
          throw new FbaError('ASSERTION_FAILED', `"${truncate(step.text, 60)}" is not on the page`);
        }
      }
      checks.push(`text contains "${truncate(step.text, 40)}"`);
    }

    if (step.value !== undefined) {
      if (!resolved) {
        throw new FbaError('ASSERTION_FAILED', `${describeTarget(step.target ?? {})} not found, cannot check its value`);
      }
      const actual = await readAnyValue(resolved.locator, ctx.timeoutMs);
      if (normalizeText(actual ?? '') !== normalizeText(step.value)) {
        throw new FbaError(
          'ASSERTION_FAILED',
          `${describeTarget(step.target ?? {})} has value "${truncate(actual ?? '', 60)}", expected "${truncate(step.value, 60)}"`,
        );
      }
      checks.push(`value is "${truncate(step.value, 40)}"`);
    }

    if (checks.length === 0) {
      // `{ do: 'assert', target: X }` has exactly one sensible reading — "X is
      // there" — and rejecting it would cost a round trip to learn a keyword.
      // Only a bare assert with no target at all is genuinely underspecified.
      if (step.target) {
        if (!resolved) {
          throw new FbaError('ASSERTION_FAILED', `${describeTarget(step.target)} not found`);
        }
        checks.push('exists');
      } else {
        throw new FbaError('INVALID_ARGUMENT', 'assert needs a target, or one of exists, text, value or urlContains');
      }
    }
    return { status: 'ok', detail: `asserted ${checks.join(', ')}` };
  }

  /**
   * Tab navigation is a first-class step because deep tabbed configuration UIs
   * are exactly the case where a naive agent burns the most round trips: each
   * level costs a snapshot, a decision and a click. Here the whole path is one
   * deterministic walk, and tabs that are already active cost nothing.
   */
  private async selectTab(
    session: Session,
    step: Extract<ActionStep, { do: 'selectTab' }>,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    if (step.path.length === 0) throw new FbaError('INVALID_ARGUMENT', 'selectTab needs a non-empty path');

    const clicked: string[] = [];
    const already: string[] = [];

    for (const label of step.path) {
      const structure = await session.structure();
      const hit = bestMatch(label, structure.tabs, (t) => [t.label], { minScore: 0.55 });
      if (!hit) {
        throw new FbaError('TARGET_NOT_FOUND', `no tab named "${label}"`, {
          hint:
            structure.tabs.length > 0
              ? `available tabs: ${structure.tabs.map((t) => t.label).slice(0, 12).join(' | ')}`
              : 'this page exposes no tablist — navigate by url or click the section directly',
        });
      }
      if (hit.item.selected) {
        already.push(hit.item.label);
        continue;
      }
      await session.page.locator(selectorForRef(hit.item.ref)).first().click({ timeout: ctx.timeoutMs });
      clicked.push(hit.item.label);
      // The next level of tabs only exists after this one has rendered.
      await safeSettle(session, INTER_STEP_SETTLE);
    }

    return {
      status: 'ok',
      detail: `tab path ${step.path.join(' > ')} — ${clicked.length} click(s), ${already.length} already active`,
    };
  }

  private async expand(
    session: Session,
    step: Extract<ActionStep, { do: 'expand' }>,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const { locator } = await this.resolve(session, step.target, ctx);

    const collapsed = await locator.evaluate((el): boolean | null => {
      const node = el as HTMLElement;
      const aria = node.getAttribute('aria-expanded') ?? node.closest('[aria-expanded]')?.getAttribute('aria-expanded');
      if (aria != null) return aria === 'false';
      const details = node.closest('details');
      if (details instanceof HTMLDetailsElement) return !details.open;
      return null;
    }, undefined, { timeout: ctx.timeoutMs });

    if (collapsed === false) {
      // Already open. Clicking would collapse it, so this is a deliberate no-op
      // rather than a failure — `expand` is declarative.
      return { status: 'skipped', detail: `${describeTarget(step.target)} is already expanded` };
    }

    await locator.click({ timeout: ctx.timeoutMs });
    return {
      status: 'ok',
      detail:
        collapsed === null
          ? `clicked ${describeTarget(step.target)} (expansion state not exposed)`
          : `expanded ${describeTarget(step.target)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function safeSettle(session: Session, options: SettleOptions): Promise<void> {
  try {
    await session.settle(options);
  } catch (e) {
    // Settling is an optimisation; never let it fail a program.
    logger.debug(`settle failed: ${errorMessage(e)}`);
  }
}

function safeUrl(session: Session): string {
  try {
    return session.page.url();
  } catch {
    return '';
  }
}

function safeJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readInputValue(locator: Locator, timeout: number): Promise<string | undefined> {
  try {
    return await locator.inputValue({ timeout });
  } catch {
    // Not an <input>/<textarea>/<select> — nothing to verify against.
    return undefined;
  }
}

async function readAnyValue(locator: Locator, timeout: number): Promise<string | undefined> {
  const value = await readInputValue(locator, timeout);
  if (value !== undefined) return value;
  try {
    return (await locator.textContent({ timeout })) ?? undefined;
  } catch {
    return undefined;
  }
}

async function readChecked(locator: Locator, timeout: number): Promise<boolean | undefined> {
  try {
    return await locator.isChecked({ timeout });
  } catch {
    try {
      const aria = await locator.getAttribute('aria-checked', { timeout });
      if (aria === 'true') return true;
      if (aria === 'false') return false;
    } catch {
      /* element vanished */
    }
    return undefined;
  }
}

function describeStep(step: ActionStep): string {
  return 'target' in step && step.target ? describeTarget(step.target) : '';
}

function summarize(results: StepResult[]): string {
  const count = (status: StepStatus): number => results.filter((r) => r.status === status).length;
  const parts = [`${results.length} step${results.length === 1 ? '' : 's'}`, `${count('ok')} ok`];
  if (count('healed') > 0) parts.push(`${count('healed')} healed`);
  if (count('failed') > 0) parts.push(`${count('failed')} failed`);
  if (count('skipped') > 0) parts.push(`${count('skipped')} skipped`);
  return `ran ${parts.join(', ')}`;
}

/** Shared default executor (no route resolution; the MCP layer injects that). */
export const executor: Executor = new DefaultExecutor();
