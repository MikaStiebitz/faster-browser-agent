/**
 * Page session (L1/L2 bridge).
 *
 * A session owns exactly one tab and everything that has to be true about it
 * for the rest of the stack to work:
 *
 *   - `window.__fba` is installed, current, and re-installed whenever the page
 *     throws it away,
 *   - snapshots carry a monotonic version so the diff engine can compare
 *     consecutive ones,
 *   - "the page has stopped changing" is answered by a hybrid heuristic that
 *     combines what only the page knows with what only Node knows,
 *   - a native dialog — which *blocks the renderer* — is surfaced instead of
 *     silently deadlocking every later call.
 *
 * Every method that talks to the page goes through `runtimeEval`, which is the
 * single place that deals with navigation races and with a runtime that has
 * gone missing. Nothing else in this file calls `page.evaluate` directly.
 */

import { clearTimeout, setTimeout } from 'node:timers';

import type { Dialog, Frame, Page, Request } from 'playwright-core';

import type { GotoOptions, ObserveOptions, PageRuntimeApi, RuntimeSnapshot, Session } from '../contracts.js';
import { NetworkObserver } from '../net/observer.js';
import { diffSnapshots, preferDiff } from '../runtime/diff.js';
import { PAGE_RUNTIME_SOURCE, RUNTIME_VERSION } from '../runtime/index.js';
import { summarize } from '../runtime/serialize.js';
import type { SiteMemoryStore } from '../site/memory.js';
import { DEFAULT_SETTLE_OPTIONS } from '../types.js';
import type {
  FbaConfig,
  NativeDialogInfo,
  Observation,
  ObservedEndpoint,
  PageSnapshot,
  Ref,
  SessionInfo,
  SettleKind,
  SettleOptions,
  SettleResult,
  SnapshotDiff,
  SnapshotOptions,
} from '../types.js';
import { FbaError, errorMessage, toFbaError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { truncate } from '../util/text.js';

const logger = createLogger('session');

/** Thrown *inside the page* when `window.__fba` is gone; caught in `runtimeEval`. */
const RUNTIME_MISSING = 'FBA_RUNTIME_MISSING';

/** Node-side settle poll interval. Cheap: it touches no CDP, only local state. */
const NODE_POLL_MS = 25;

/**
 * Grace added to the in-page settle deadline before Node gives up on it.
 * The in-page half resolves itself on timeout, so this only fires when the
 * renderer is genuinely wedged (a native dialog, a busy-loop in page script).
 */
const SETTLE_GRACE_MS = 750;

/**
 * A request that has been in flight this long stops counting as activity.
 *
 * Server-sent events, long-polls and hanging GETs never emit `requestfinished`;
 * without this rule a single SSE channel — which every modern dev server has for
 * hot reload — would make the network half of the settle heuristic permanently
 * false and every settle would burn its whole timeout.
 */
const STALE_REQUEST_MS = 3_000;

/** Cap on problems returned from one drain, matching the observer's own cap. */
const MAX_PROBLEMS = 20;

let sessionCounter = 0;

export interface SessionDeps {
  config: FbaConfig;
  workspaceId: string;
  /** Called exactly once when the page goes away, however it goes away. */
  onClose?: (id: string) => void;
  /**
   * Where observations are folded into per-origin memory.
   *
   * Optional so the session stays usable standalone, and deliberately a
   * fire-and-forget sink: learning must never be able to slow down or fail the
   * operation that produced it.
   */
  memory?: SiteMemoryStore;
}

/** Playwright's `Unboxed<>` does not reduce for an unresolved generic. */
type PageFn<Arg, R> = (arg: Arg) => R | Promise<R>;

export class PageSession implements Session {
  readonly id: string;
  readonly workspaceId: string;
  readonly page: Page;
  readonly config: FbaConfig;

  private readonly deps: SessionDeps;
  private readonly observer: NetworkObserver | undefined;
  private readonly createdAt = Date.now();

  private lastUsedAt = Date.now();
  private version = 0;
  private lastTitle = '';
  private last: PageSnapshot | undefined;
  /** Snapshot the next diff is computed against; only `observe()` moves it. */
  private diffBaseline: PageSnapshot | undefined;
  /** Set by navigation: refs are regenerated, so a diff would be meaningless. */
  private forceFullNext = true;
  private closed = false;
  private initScriptAdded = false;

  private dialogInfo: NativeDialogInfo | undefined;
  private dialogHandle: Dialog | undefined;

  /** Request -> start time. Size-bounded by the page's own concurrency. */
  private readonly inFlight = new Map<Request, number>();
  private lastNetworkAt = 0;

  constructor(page: Page, deps: SessionDeps) {
    this.page = page;
    this.deps = deps;
    this.config = deps.config;
    this.workspaceId = deps.workspaceId;
    sessionCounter += 1;
    this.id = `s${sessionCounter}`;

    this.observer = deps.config.networkObserver ? new NetworkObserver(page) : undefined;

    page.on('request', this.onRequest);
    page.on('requestfinished', this.onRequestSettled);
    page.on('requestfailed', this.onRequestSettled);
    page.on('framenavigated', this.onFrameNavigated);
    page.on('dialog', this.onDialog);
    page.on('close', this.onPageClosed);
    this.observer?.attach();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Install the runtime for both the future and the present.
   *
   * `addInitScript` covers every *later* document — it runs before any page
   * script, so the runtime is already listening when the app's own code starts
   * mutating the DOM and issuing fetches. It does nothing for the document that
   * is already loaded, hence the immediate evaluation as well.
   */
  async init(): Promise<void> {
    if (!this.initScriptAdded) {
      this.initScriptAdded = true;
      try {
        await this.page.addInitScript(PAGE_RUNTIME_SOURCE);
      } catch (e) {
        // A closed page is the only realistic failure and it will resurface on
        // the first real call with a much better message.
        logger.debug(`addInitScript failed: ${errorMessage(e)}`);
      }
    }
    await this.ensureRuntime();
  }

  info(): SessionInfo {
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      url: this.safeUrl(),
      title: this.lastTitle,
      createdAt: this.createdAt,
      lastUsedAt: this.lastUsedAt,
      version: this.version,
    };
  }

  /** True until the page (or the session) is closed. */
  isClosed(): boolean {
    return this.closed || this.page.isClosed();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detach();

    // An unanswered dialog keeps the renderer blocked and can stall the close.
    const dialog = this.dialogHandle;
    this.dialogHandle = undefined;
    this.dialogInfo = undefined;
    if (dialog) await dialog.dismiss().catch(() => undefined);

    // `runBeforeUnload: false` so a page with an unload handler cannot open a
    // dialog on the way out and block us again.
    await this.page.close({ runBeforeUnload: false }).catch((e: unknown) => {
      logger.debug(`page close failed: ${errorMessage(e)}`);
    });
    this.deps.onClose?.(this.id);
  }

  // -------------------------------------------------------------------------
  // Runtime injection
  // -------------------------------------------------------------------------

  /**
   * Guarantee `window.__fba` exists and is the version we ship.
   *
   * The check is one tiny evaluation rather than an unconditional re-injection:
   * re-installing costs a few hundred microseconds of parse per call, and this
   * runs before most page interactions. Re-injection is needed more often than
   * one would hope — SPAs that swap the document via `document.write`, pages
   * that replace `window` properties, `about:blank` -> real page transitions,
   * and any navigation whose init script we lost the race with.
   */
  async ensureRuntime(): Promise<void> {
    if (this.isClosed()) return;
    const present = await this.evaluateOnce<undefined, string | null>(
      () => (typeof window.__fba === 'undefined' ? null : (window.__fba?.version ?? null)),
      undefined,
    ).catch(() => null);
    if (present === RUNTIME_VERSION) return;

    // The runtime source is an IIFE and is idempotent within one document, so a
    // redundant injection is harmless.
    await this.evaluateSource(PAGE_RUNTIME_SOURCE).catch((e: unknown) => {
      logger.debug(`runtime injection failed: ${errorMessage(e)}`);
    });
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  /**
   * Navigate and re-establish every invariant the session promises.
   *
   * `commit` is the default `waitUntil` because it returns as soon as the new
   * document exists: `load` waits for every subresource (including ones we do
   * not care about and ones we blocked), and `domcontentloaded` still waits for
   * blocking scripts. We do not need either — our own settle heuristic decides
   * when the page is usable, and it measures the thing that actually matters.
   */
  async goto(url: string, options: GotoOptions = {}): Promise<void> {
    this.touch();
    const timeout = options.timeoutMs ?? this.config.timeoutMs;
    const previousUrl = this.safeUrl();

    try {
      await this.page.goto(url, { waitUntil: options.waitUntil ?? 'commit', timeout });
    } catch (e) {
      // Playwright appends a multi-line "Call log" to navigation errors. It is
      // useful in a terminal and pure noise in a tool result, where every line
      // is tokens the agent pays for — keep the first line, which carries the
      // net:: error code.
      const reason = firstLine(errorMessage(e));
      throw new FbaError('NAVIGATION_FAILED', `could not navigate to ${url}: ${reason}`, {
        hint: navigationHint(url, reason),
        details: { url, from: previousUrl, timeoutMs: timeout },
        cause: e,
      });
    }

    await this.ensureRuntime();
    // Refs are per-document generation counters. Resetting also strips stale
    // `data-fba` attributes, which a same-document navigation would otherwise
    // leave behind to collide with freshly minted refs.
    await this.resetRuntimeState();

    this.diffBaseline = undefined;
    this.forceFullNext = true;
    this.last = undefined;

    // The endpoint table is only stale when the *application* changed. Within
    // one origin it is the session's accumulated knowledge of the app's API and
    // is far more useful kept than dropped.
    if (this.observer && originOf(previousUrl) !== originOf(this.safeUrl())) this.observer.reset();

    // Sampled as a navigation: a page load is a different beast from a tab
    // click, and lumping the two into one distribution yields a budget that
    // fits neither.
    if (!options.noSettle) await this.settleAs('navigation');
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------

  async snapshot(options?: SnapshotOptions): Promise<PageSnapshot> {
    this.touch();
    this.assertNotBlocked('snapshot');

    const merged: SnapshotOptions = { ...this.config.snapshot, ...options };
    const raw = await this.runtimeEval<SnapshotOptions, RuntimeSnapshot>((o) => {
      const rt = window.__fba;
      if (!rt) throw new Error('FBA_RUNTIME_MISSING');
      return rt.snapshot(o);
    }, merged);

    this.version += 1;
    const snapshot: PageSnapshot = { ...raw, version: this.version };
    this.last = snapshot;
    this.lastTitle = snapshot.title;
    return snapshot;
  }

  lastSnapshot(): PageSnapshot | undefined {
    return this.last;
  }

  async observe(options: ObserveOptions = {}): Promise<Observation> {
    this.touch();

    // A blocked page cannot be snapshotted at all — every evaluation would hang
    // until the dialog is answered — so this is not just a nicety, it is the
    // only correct thing to return.
    const blocking = this.dialogInfo;
    if (blocking) return this.blockedObservation(blocking, options.summaryPrefix);

    if (!options.noSettle) await this.settle(options.settle);
    const snapshot = await this.snapshot(snapshotOptionsOf(options));
    const problems = await this.drainProblems();

    let diff: SnapshotDiff | undefined;
    const baseline = this.diffBaseline;
    if (!options.full && !this.forceFullNext && baseline) {
      const candidate = diffSnapshots(baseline, snapshot);
      if (preferDiff(candidate, snapshot)) diff = candidate;
    }
    this.forceFullNext = false;
    this.diffBaseline = snapshot;

    // Learning happens here because this is the one place a fresh, structured
    // view of the page already exists. Folding it into per-origin memory costs
    // no browser work, no navigation and no model call — which is the only way
    // a learning layer stays switched on by default.
    this.deps.memory?.recordSnapshot(snapshot);
    // Endpoints are read from a local array the observer already maintains —
    // no browser call — so folding them in here is free too. They are what
    // makes browser_extract able to skip rendering entirely on a later visit.
    if (this.deps.memory && this.observer) {
      const origin = originOf(snapshot.url);
      if (origin) this.deps.memory.recordEndpoints(origin, this.observer.endpoints());
    }

    const summary = summarize(snapshot);
    const observation: Observation = {
      url: snapshot.url,
      title: snapshot.title,
      summary: options.summaryPrefix ? `${options.summaryPrefix} — ${summary}` : summary,
    };
    if (diff) observation.diff = diff;
    else observation.tree = snapshot.tree;
    if (snapshot.overlay) observation.overlay = snapshot.overlay;
    if (snapshot.tabPath && snapshot.tabPath.length > 0) observation.tabPath = snapshot.tabPath;
    if (snapshot.notes && snapshot.notes.length > 0) observation.notes = [...snapshot.notes];
    observation.stats = snapshot.stats;
    if (problems.length > 0) observation.problems = problems;

    // A dialog can open while we were settling or snapshotting (a timer, or a
    // handler that fired mid-capture). The tree we just took is still valid,
    // but nothing else will work until it is answered — say so loudly.
    const late = this.dialogInfo;
    if (late) {
      observation.nativeDialog = late;
      observation.summary = `${dialogSummary(late)} | ${observation.summary}`;
      observation.notes = [...(observation.notes ?? []), dialogNote(late)];
    }
    return observation;
  }

  async find(
    query: Parameters<PageRuntimeApi['find']>[0],
  ): Promise<Array<{ ref: Ref; role: string; name: string; score: number }>> {
    this.touch();
    this.assertNotBlocked('find');
    return this.runtimeEval<typeof query, Array<{ ref: Ref; role: string; name: string; score: number }>>(
      (q) => {
        const rt = window.__fba;
        if (!rt) throw new Error('FBA_RUNTIME_MISSING');
        return rt.find(q);
      },
      query,
      { ensureFirst: true },
    );
  }

  async structure(): Promise<Awaited<ReturnType<PageRuntimeApi['structure']>>> {
    this.touch();
    this.assertNotBlocked('structure');
    return this.runtimeEval<undefined, Awaited<ReturnType<PageRuntimeApi['structure']>>>(
      () => {
        const rt = window.__fba;
        if (!rt) throw new Error('FBA_RUNTIME_MISSING');
        return rt.structure();
      },
      undefined,
      { ensureFirst: true },
    );
  }

  /** Scroll a ref into view. False when the ref no longer resolves. */
  async scrollIntoView(ref: Ref): Promise<boolean> {
    this.touch();
    this.assertNotBlocked('scrollIntoView');
    return this.runtimeEval<Ref, boolean>(
      (r) => {
        const rt = window.__fba;
        if (!rt) throw new Error('FBA_RUNTIME_MISSING');
        return rt.scrollIntoView(r);
      },
      ref,
      { ensureFirst: true },
    );
  }

  // -------------------------------------------------------------------------
  // Settling
  // -------------------------------------------------------------------------

  /**
   * Wait for the page to go quiet, using BOTH halves of the evidence.
   *
   * In-page (`waitSettled`): the only place that can see DOM mutations, and it
   * polls them without a single round trip. But it observes network through the
   * `fetch`/`XMLHttpRequest` patches it installed, so it is blind to everything
   * started before injection — the document itself, its subresources, anything
   * a service worker or the preload scanner issued — which is precisely the
   * traffic that dominates the moment right after a navigation.
   *
   * Node-side (`request`/`requestfinished`/`requestfailed`): sees *every*
   * request the browser makes, from the document down, with no round trip at
   * all — playwright is already receiving these CDP events whether we listen or
   * not. But it cannot see DOM work: a page that finished loading and is still
   * running 400ms of layout thrash looks perfectly quiet from here.
   *
   * Neither half is sufficient and each is cheap, so we require both to agree.
   * They run concurrently against one deadline, which means the answer arrives
   * as soon as the slower half is satisfied.
   */
  async settle(options?: SettleOptions): Promise<SettleResult> {
    return this.settleAs('interaction', options);
  }

  private async settleAs(kind: SettleKind, options?: SettleOptions): Promise<SettleResult> {
    this.touch();
    // Precedence: explicit caller options > what we have learned this origin
    // actually needs > configured defaults. The learned layer is the mechanism
    // by which repeated use of a site gets measurably faster: a site that
    // reliably goes quiet in 120ms stops being waited on for 300ms, and a slow
    // one gets a cap that reflects reality instead of a generic guess.
    const learned = this.deps.memory?.settleBudget(originOf(this.safeUrl()), kind);
    const o: Required<SettleOptions> = {
      ...DEFAULT_SETTLE_OPTIONS,
      ...this.config.settle,
      ...(learned ?? {}),
      ...options,
    };
    const startedAt = Date.now();

    if (this.dialogInfo) {
      // A page blocked on a native dialog can never settle; spending the full
      // timeout to rediscover that on every action is pure latency.
      return { settled: false, reason: 'timeout', waitedMs: 0, pendingRequests: this.activeRequests(Date.now()) };
    }
    if (this.isClosed()) return { settled: false, reason: 'detached', waitedMs: 0 };

    const deadline = startedAt + o.timeoutMs;
    let navigated = false;

    const inPage = this.runtimeEval<SettleOptions, SettleResult>(
      (opts) => {
        const rt = window.__fba;
        if (!rt) throw new Error('FBA_RUNTIME_MISSING');
        return rt.waitSettled(opts);
      },
      o,
      { timeoutMs: o.timeoutMs + SETTLE_GRACE_MS },
    ).catch((e: unknown) => {
      // A navigation mid-settle destroys the execution context. That is not a
      // failure — it is the page doing exactly what we were waiting to observe.
      // Anything else (a wedged renderer hitting the deadline) stays a timeout.
      navigated = isRecoverable(errorMessage(e));
      logger.debug(`in-page settle ended early: ${errorMessage(e)}`);
      return { settled: false, reason: 'navigated', waitedMs: Date.now() - startedAt } satisfies SettleResult;
    });

    const [pageQuiet, networkQuiet] = await Promise.all([inPage, this.waitNetworkQuiet(o.networkQuietMs, deadline)]);

    const waitedMs = Date.now() - startedAt;
    const settled = pageQuiet.settled && networkQuiet;
    if (settled) {
      // Only successful settles are sampled. Timeouts measure our own cap, not
      // the site, and feeding them back would ratchet the budget upward.
      this.deps.memory?.recordSettle(this.safeUrl(), waitedMs, kind);
      return { settled: true, reason: 'quiet', waitedMs };
    }
    if (this.isClosed()) return { settled: false, reason: 'detached', waitedMs };

    const pending = this.activeRequests(Date.now());
    if (navigated) {
      // Post-navigation the network verdict is the honest one: the old
      // document's runtime is gone and cannot report anything.
      return { settled: networkQuiet, reason: 'navigated', waitedMs, pendingRequests: pending };
    }
    return { settled: false, reason: 'timeout', waitedMs, pendingRequests: pending };
  }

  /** Resolve true once no request has been in flight for `quietMs`. */
  private async waitNetworkQuiet(quietMs: number, deadline: number): Promise<boolean> {
    for (;;) {
      const now = Date.now();
      if (this.activeRequests(now) === 0 && now - this.lastNetworkAt >= quietMs) return true;
      if (now >= deadline) return false;
      await delay(Math.min(NODE_POLL_MS, Math.max(1, deadline - now)));
    }
  }

  private activeRequests(now: number): number {
    let count = 0;
    for (const startedAt of this.inFlight.values()) {
      if (now - startedAt < STALE_REQUEST_MS) count += 1;
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Dialogs, problems, endpoints
  // -------------------------------------------------------------------------

  pendingDialog(): NativeDialogInfo | undefined {
    return this.dialogInfo;
  }

  async answerDialog(accept: boolean, promptText?: string): Promise<void> {
    const dialog = this.dialogHandle;
    const info = this.dialogInfo;
    if (!dialog || !info) {
      throw new FbaError('INVALID_ARGUMENT', 'no native dialog is open', {
        hint: 'check observation.nativeDialog before answering; dialogs are reported the moment they open',
      });
    }
    this.dialogHandle = undefined;
    this.dialogInfo = undefined;
    this.touch();

    try {
      if (accept) await dialog.accept(promptText ?? info.defaultValue ?? '');
      else await dialog.dismiss();
    } catch (e) {
      // Playwright rejects if the dialog was already handled (a racing close or
      // a second answer). The page is unblocked either way, which is all the
      // caller needs.
      logger.debug(`dialog answer failed: ${errorMessage(e)}`);
    }
    // Answering an alert usually triggers whatever the page was waiting to do.
    this.forceFullNext = true;
  }

  endpoints(): ObservedEndpoint[] {
    return this.observer?.endpoints() ?? [];
  }

  /**
   * Merge the two problem sources. They genuinely differ: the page runtime sees
   * `window.onerror` and unhandled rejections (which never reach CDP as console
   * messages in every case), while the observer sees failed requests and console
   * errors from *all* frames.
   */
  async drainProblems(): Promise<string[]> {
    const fromObserver = this.observer?.drainProblems() ?? [];
    let fromPage: string[] = [];
    if (!this.dialogInfo && !this.isClosed()) {
      fromPage = await this.runtimeEval<undefined, string[]>(() => {
        const rt = window.__fba;
        if (!rt) throw new Error('FBA_RUNTIME_MISSING');
        return rt.drainProblems();
      }, undefined).catch(() => []);
    }

    const seen = new Set<string>();
    const out: string[] = [];
    for (const problem of [...fromObserver, ...fromPage]) {
      if (!problem || seen.has(problem)) continue;
      seen.add(problem);
      out.push(problem);
      if (out.length >= MAX_PROBLEMS) break;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Page event handlers
  // -------------------------------------------------------------------------

  private readonly onRequest = (request: Request): void => {
    this.inFlight.set(request, Date.now());
    this.lastNetworkAt = Date.now();
  };

  private readonly onRequestSettled = (request: Request): void => {
    this.inFlight.delete(request);
    this.lastNetworkAt = Date.now();
  };

  private readonly onFrameNavigated = (frame: Frame): void => {
    // Sub-frame navigations do not invalidate the main document's refs.
    if (frame.parentFrame() !== null) return;
    this.forceFullNext = true;
    this.diffBaseline = undefined;
    // Requests belonging to the previous document will never report completion.
    this.inFlight.clear();
  };

  private readonly onDialog = (dialog: Dialog): void => {
    const type = dialog.type() as NativeDialogInfo['type'];

    // The one dialog we answer for the agent. `beforeunload` asks "really leave
    // this page?"; an agent that just issued a navigation has already answered
    // yes, and leaving it pending would deadlock that navigation — the goto
    // never resolves while the dialog is up.
    if (type === 'beforeunload') {
      void dialog.accept().catch(() => undefined);
      return;
    }

    const info: NativeDialogInfo = { type, message: truncate(dialog.message(), 500) };
    const defaultValue = dialog.defaultValue();
    if (defaultValue) info.defaultValue = defaultValue;

    this.dialogInfo = info;
    this.dialogHandle = dialog;
    // Deliberately NOT auto-dismissed: `confirm()` guarding a destructive action
    // is a decision, not a formality, and playwright's default (dismiss
    // everything) silently turns "delete" into "cancel". Registering this
    // listener is what suppresses that default.
    logger.debug(`native ${type} dialog opened: ${info.message}`);
  };

  private readonly onPageClosed = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.deps.onClose?.(this.id);
  };

  private detach(): void {
    this.observer?.detach();
    try {
      this.page.off('request', this.onRequest);
      this.page.off('requestfinished', this.onRequestSettled);
      this.page.off('requestfailed', this.onRequestSettled);
      this.page.off('framenavigated', this.onFrameNavigated);
      this.page.off('dialog', this.onDialog);
      this.page.off('close', this.onPageClosed);
    } catch {
      // The page is already gone; its listeners went with it.
    }
    this.inFlight.clear();
  }

  // -------------------------------------------------------------------------
  // Evaluation plumbing
  // -------------------------------------------------------------------------

  /**
   * The single choke point for talking to the page.
   *
   * Two hazards are handled here so no caller has to:
   *
   *  1. Navigation races. Between deciding to evaluate and the evaluation
   *     running, the page can commit a new document; Chromium then destroys the
   *     execution context and the call rejects. The same is true when an SPA
   *     wipes `window.__fba`. Both are recoverable by re-injecting and trying
   *     once more — and only once, because a second failure means the page is
   *     navigating continuously and retrying forever would hang the tool call.
   *  2. Unbounded waits. `page.evaluate` has no timeout of its own. A renderer
   *     blocked on a native dialog, or spinning in page script, would otherwise
   *     hang the caller — and an MCP server that stops answering is worse than
   *     one that reports an error.
   */
  private async runtimeEval<Arg, R>(
    fn: PageFn<Arg, R>,
    arg: Arg,
    options: { ensureFirst?: boolean; timeoutMs?: number } = {},
  ): Promise<R> {
    if (this.isClosed()) {
      throw new FbaError('NO_SESSION', 'the page is closed', {
        hint: 'acquire a new session',
      });
    }
    if (options.ensureFirst) await this.ensureRuntime();

    const timeoutMs = options.timeoutMs ?? Math.max(this.config.timeoutMs, 5_000);
    try {
      return await this.evaluateOnce(fn, arg, timeoutMs);
    } catch (e) {
      if (!isRecoverable(errorMessage(e))) throw toFbaError(e);
      logger.debug(`re-injecting runtime after: ${errorMessage(e)}`);
      await this.ensureRuntime();
      try {
        return await this.evaluateOnce(fn, arg, timeoutMs);
      } catch (e2) {
        throw toFbaError(e2);
      }
    }
  }

  private evaluateOnce<Arg, R>(fn: PageFn<Arg, R>, arg: Arg, timeoutMs?: number): Promise<R> {
    const promise = this.page.evaluate(fn as PageFn<unknown, R>, arg as unknown);
    return timeoutMs === undefined ? promise : withDeadline(promise, timeoutMs, this.evaluationTimeoutMessage());
  }

  private evaluateSource(source: string): Promise<void> {
    return withDeadline(
      this.page.evaluate<void>(source),
      Math.max(this.config.timeoutMs, 5_000),
      this.evaluationTimeoutMessage(),
    );
  }

  private evaluationTimeoutMessage(): string {
    return this.dialogInfo
      ? `the page is blocked by a native ${this.dialogInfo.type} dialog`
      : 'the page did not respond to an evaluation';
  }

  private async resetRuntimeState(): Promise<void> {
    await this.runtimeEval<undefined, boolean>(() => {
      const rt = window.__fba;
      if (!rt) throw new Error('FBA_RUNTIME_MISSING');
      rt.reset();
      return true;
    }, undefined).catch((e: unknown) => {
      logger.debug(`runtime reset failed: ${errorMessage(e)}`);
      return false;
    });
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  private touch(): void {
    this.lastUsedAt = Date.now();
  }

  private safeUrl(): string {
    try {
      return this.page.url();
    } catch {
      return '';
    }
  }

  private assertNotBlocked(operation: string): void {
    const dialog = this.dialogInfo;
    if (!dialog) return;
    throw new FbaError('STEP_FAILED', `cannot ${operation}: ${dialogSummary(dialog)}`, {
      hint: 'answer it first with the dialog action (accept or dismiss)',
      details: { dialog },
    });
  }

  /** What `observe()` returns while the renderer is blocked. */
  private blockedObservation(dialog: NativeDialogInfo, summaryPrefix?: string): Observation {
    const summary = dialogSummary(dialog);
    return {
      url: this.safeUrl(),
      title: this.lastTitle,
      summary: summaryPrefix ? `${summaryPrefix} — ${summary}` : summary,
      nativeDialog: dialog,
      notes: [dialogNote(dialog)],
      // Observer problems are collected in Node and cost nothing to read, so
      // they are still available even though the page cannot be queried.
      ...(this.observer ? withProblems(this.observer.drainProblems()) : {}),
    };
  }
}

/**
 * Build a session and make it usable.
 *
 * Separate from the constructor because installing the runtime is asynchronous
 * and a half-initialised session is a trap for every caller.
 */
export async function createSession(page: Page, deps: SessionDeps): Promise<PageSession> {
  const session = new PageSession(page, deps);
  await session.init();
  return session;
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

function withProblems(problems: string[]): { problems?: string[] } {
  return problems.length > 0 ? { problems } : {};
}

function dialogSummary(dialog: NativeDialogInfo): string {
  return `blocked by native ${dialog.type}: "${truncate(dialog.message, 120)}"`;
}

function dialogNote(dialog: NativeDialogInfo): string {
  const suffix = dialog.type === 'prompt' ? ' (a prompt also needs promptText)' : '';
  return `the page is frozen until this ${dialog.type} is answered — accept or dismiss it${suffix}`;
}

/** Pick only the snapshot-relevant keys out of an ObserveOptions bag. */
function snapshotOptionsOf(options: ObserveOptions): SnapshotOptions {
  const out: SnapshotOptions = {};
  if (options.scope !== undefined) out.scope = options.scope;
  if (options.root !== undefined) out.root = options.root;
  if (options.maxNodes !== undefined) out.maxNodes = options.maxNodes;
  if (options.includeText !== undefined) out.includeText = options.includeText;
  if (options.expandCollapsed !== undefined) out.expandCollapsed = options.expandCollapsed;
  if (options.filter !== undefined) out.filter = options.filter;
  if (options.nameCap !== undefined) out.nameCap = options.nameCap;
  return out;
}

/**
 * Errors that mean "the page moved under us", as opposed to "the code you ran
 * threw". Only the former is worth a re-injection and a retry.
 */
function isRecoverable(message: string): boolean {
  return (
    message.includes(RUNTIME_MISSING) ||
    /Execution context was destroyed/i.test(message) ||
    /Cannot find context with specified id/i.test(message) ||
    /Inspected target navigated or closed/i.test(message) ||
    /frame (was )?detached/i.test(message) ||
    /Unable to adopt element handle/i.test(message)
  );
}

function firstLine(message: string): string {
  const line = message.split('\n', 1)[0];
  return (line ?? message).trim();
}

function navigationHint(url: string, message: string): string {
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET/i.test(message)) {
    return `nothing is listening at ${originOf(url) || url} — start the dev server first, or check the port`;
  }
  if (/ERR_UNSAFE_PORT/i.test(message)) {
    // Chromium refuses a fixed list of ports (1, 7, 25, 87, 6000, ...) outright.
    return `Chromium blocks the port in ${url} as unsafe — run the server on a normal port such as 3000 or 8080`;
  }
  if (/ERR_NAME_NOT_RESOLVED/i.test(message)) return `the host in ${url} does not resolve — check the URL`;
  if (/ERR_CERT|SSL/i.test(message)) return 'the TLS certificate was rejected — use http:// for a local dev server';
  if (/Timeout/i.test(message)) {
    return 'the server accepted the connection but never committed a document — it may be starting up; retry, or raise timeoutMs';
  }
  if (/Cannot navigate to invalid URL|Invalid url/i.test(message)) {
    return 'pass an absolute URL including the scheme, e.g. http://localhost:3000/settings';
  }
  return 'check that the URL is reachable from this machine';
}

function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? '' : parsed.origin;
  } catch {
    return '';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never let a settle poll hold the process open.
    timer.unref();
  });
}

/** Race a promise against a timer, cleaning up both sides either way. */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new FbaError('TIMEOUT', `${what} within ${ms}ms`, {
        hint: 'if a native dialog is open, answer it; otherwise the page may be busy — retry or raise timeoutMs',
      }));
    }, ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
