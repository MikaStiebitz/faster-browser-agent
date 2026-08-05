/**
 * Executor unit tests.
 *
 * Everything here runs without a browser: the Session / Locator / runtime
 * surfaces are small enough to fake precisely, and the parts of L2 that carry
 * the product risk (fallback order, healing, ambiguity, role->action mapping,
 * the unchanged short-circuit, failure policy) are all decidable from those
 * fakes. Browser-backed coverage lives in the integration suite.
 */

import type { Locator, Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';

import { defaultConfig } from '../src/config.js';
import type { ObserveOptions, PageRuntimeApi, Session } from '../src/contracts.js';
import {
  DefaultExecutor,
  DefaultTargetResolver,
  actionForRole,
  coerceBoolean,
  collectCandidates,
  describeTarget,
  fillForm,
  pickSubmitTarget,
} from '../src/executor/index.js';
import type {
  ActOptions,
  ActResult,
  ActionStep,
  FormFillRequest,
  Observation,
  PageSnapshot,
  Ref,
  SettleResult,
  SnapNode,
  StepResult,
} from '../src/types.js';
import { isFbaError } from '../src/util/errors.js';

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

type FindQuery = Parameters<PageRuntimeApi['find']>[0];
type FindResult = Array<{ ref: Ref; role: string; name: string; score: number }>;

interface FakeLocatorSpec {
  count?: number;
  attrs?: Record<string, string>;
  onAction?: (name: string) => void;
}

function fakeLocator(spec: FakeLocatorSpec = {}): Locator {
  const note = (name: string) => spec.onAction?.(name);
  const self: Record<string, unknown> = {
    count: async () => spec.count ?? 1,
    getAttribute: async (name: string) => spec.attrs?.[name] ?? null,
    scrollIntoViewIfNeeded: async () => undefined,
    click: async () => note('click'),
    dblclick: async () => note('dblclick'),
    hover: async () => note('hover'),
    focus: async () => note('focus'),
    blur: async () => note('blur'),
    press: async () => note('press'),
    fill: async () => note('fill'),
    pressSequentially: async () => note('pressSequentially'),
    inputValue: async () => '',
    textContent: async () => '',
    isChecked: async () => true,
    isEnabled: async () => true,
    isVisible: async () => true,
    waitFor: async () => undefined,
    setChecked: async () => note('setChecked'),
    setInputFiles: async () => note('setInputFiles'),
    selectOption: async () => note('selectOption'),
    evaluate: async () => null,
  };
  self['nth'] = () => self;
  self['first'] = () => self;
  self['locator'] = () => self;
  return self as unknown as Locator;
}

interface FakeSessionSpec {
  url?: string | (() => string);
  locators?: Record<string, FakeLocatorSpec>;
  find?: (query: FindQuery) => FindResult;
  structure?: Awaited<ReturnType<PageRuntimeApi['structure']>>;
  snapshotTree?: SnapNode;
  evaluate?: () => unknown;
  settleMs?: number;
  lastSnapshot?: PageSnapshot;
}

interface FakeCalls {
  settle: number;
  observe: number;
  evaluate: number;
  ensureRuntime: number;
  actions: string[];
  observed: ObserveOptions[];
}

function makeSession(spec: FakeSessionSpec = {}): { session: Session; calls: FakeCalls } {
  const calls: FakeCalls = { settle: 0, observe: 0, evaluate: 0, ensureRuntime: 0, actions: [], observed: [] };
  const url = () => (typeof spec.url === 'function' ? spec.url() : (spec.url ?? 'http://localhost:3000/app'));

  const page = {
    url,
    locator: (selector: string) => {
      const found = spec.locators?.[selector];
      return fakeLocator({ ...(found ?? { count: 0 }), onAction: (name) => calls.actions.push(`${name}:${selector}`) });
    },
    getByText: () => fakeLocator({ count: 1 }),
    keyboard: { press: async () => calls.actions.push('keyboard.press') },
    evaluate: async () => {
      calls.evaluate += 1;
      if (!spec.evaluate) return null;
      return spec.evaluate();
    },
    goBack: async () => null,
    goForward: async () => null,
    reload: async () => null,
    waitForURL: async () => undefined,
  } as unknown as Page;

  const session: Session = {
    id: 'sess-1',
    workspaceId: 'ws-1',
    page,
    config: defaultConfig(),
    info: () => ({
      id: 'sess-1',
      workspaceId: 'ws-1',
      url: url(),
      title: 'fake',
      createdAt: 0,
      lastUsedAt: 0,
      version: 1,
    }),
    goto: async () => undefined,
    snapshot: async () => snapshotOf(spec.snapshotTree),
    lastSnapshot: () => spec.lastSnapshot,
    settle: async (): Promise<SettleResult> => {
      calls.settle += 1;
      if (spec.settleMs) await new Promise((r) => setTimeout(r, spec.settleMs));
      return { settled: true, reason: 'quiet', waitedMs: spec.settleMs ?? 0 };
    },
    observe: async (options?: ObserveOptions): Promise<Observation> => {
      calls.observe += 1;
      if (options) calls.observed.push(options);
      return { url: url(), title: 'fake', summary: options?.summaryPrefix ?? 'observed' };
    },
    find: async (query) => spec.find?.(query) ?? [],
    structure: async () => spec.structure ?? { tabs: [], sections: [] },
    pendingDialog: () => undefined,
    answerDialog: async () => undefined,
    endpoints: () => [],
    recentRequests: () => [],
    drainProblems: async () => [],
    ensureRuntime: async () => {
      calls.ensureRuntime += 1;
    },
    close: async () => undefined,
  };

  return { session, calls };
}

function snapshotOf(tree: SnapNode | undefined): PageSnapshot {
  return {
    url: 'http://localhost:3000/app',
    title: 'fake',
    version: 1,
    tree: tree ?? { role: 'main' },
    stats: { interactive: 0, emitted: 0, elided: 0, captureMs: 0 },
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined).catch((e: unknown) => e);
}

function codeOf(e: unknown): string {
  return isFbaError(e) ? e.code : `not-an-FbaError: ${String(e)}`;
}

/** A fake `Executor['run']` that records the compiled program. */
function recordingRun(overrides: Partial<Record<number, StepResult['status']>> = {}) {
  const programs: ActionStep[][] = [];
  const run = async (session: Session, steps: ActionStep[], _options?: ActOptions): Promise<ActResult> => {
    programs.push(steps);
    const results: StepResult[] = steps.map((step, index) => ({
      index,
      step: step.do,
      status: overrides[index] ?? 'ok',
      ms: 1,
    }));
    return {
      steps: results,
      ok: results.every((r) => r.status === 'ok'),
      observation: { url: session.page.url(), title: 'fake', summary: 'ran' },
    };
  };
  return { run, programs };
}

// ---------------------------------------------------------------------------
// describeTarget
// ---------------------------------------------------------------------------

describe('describeTarget', () => {
  it('reads like a human naming the control', () => {
    expect(describeTarget({ role: 'button', name: 'Save' })).toBe('button "Save"');
    expect(describeTarget({ testId: 'save-btn', nth: 2 })).toBe('testId=save-btn #2');
    expect(describeTarget({ label: 'Port', within: 'e7' })).toBe('label "Port" within e7');
    expect(describeTarget({})).toBe('<empty target>');
  });
});

// ---------------------------------------------------------------------------
// resolver: fallback chain
// ---------------------------------------------------------------------------

describe('DefaultTargetResolver', () => {
  const resolver = new DefaultTargetResolver();

  it('uses a live ref first, at full confidence and unhealed', async () => {
    const { session } = makeSession({ locators: { '[data-fba="e1"]': { count: 1, attrs: { 'data-fba': 'e1' } } } });
    const resolved = await resolver.resolve(session, { ref: 'e1', name: 'Save' });
    expect(resolved.resolution).toMatchObject({ strategy: 'ref', confidence: 1, healed: false, ref: 'e1' });
  });

  it('heals a stale ref through role+name instead of failing the step', async () => {
    const { session } = makeSession({
      // e1 is gone (a re-render minted a new generation), e9 is the same button.
      locators: {},
      find: (q) => (q.name === 'Save' ? [{ ref: 'e9', role: 'button', name: 'Save', score: 0.98 }] : []),
    });
    const resolved = await resolver.resolve(session, { ref: 'e1', role: 'button', name: 'Save' });
    expect(resolved.resolution.strategy).toBe('role+name');
    expect(resolved.resolution.healed).toBe(true);
    expect(resolved.resolution.ref).toBe('e9');
    expect(resolved.resolution.confidence).toBeCloseTo(0.98);
  });

  it('prefers testId over css and reports the strategy that won', async () => {
    const { session } = makeSession({
      locators: {
        '[data-testid="save"], [data-test="save"], [data-cy="save"], [data-qa="save"]': { count: 1 },
        '#save': { count: 1 },
      },
    });
    const resolved = await resolver.resolve(session, { testId: 'save', css: '#save' });
    expect(resolved.resolution.strategy).toBe('testId');
    expect(resolved.resolution.confidence).toBeCloseTo(0.95);
    expect(resolved.resolution.healed).toBe(false);
  });

  it('falls through a missing testId to css and marks the result healed', async () => {
    const { session } = makeSession({ locators: { '#save': { count: 1 } } });
    const resolved = await resolver.resolve(session, { testId: 'save', css: '#save' });
    expect(resolved.resolution.strategy).toBe('css');
    expect(resolved.resolution.healed).toBe(true);
  });

  it('scopes css strategies to `within`', async () => {
    const { session } = makeSession({ locators: { '[data-fba="e5"] #save': { count: 1 } } });
    const resolved = await resolver.resolve(session, { css: '#save', within: 'e5' });
    expect(resolved.resolution.strategy).toBe('css');
  });

  it('walks label, placeholder and text in order', async () => {
    const seen: string[] = [];
    const { session } = makeSession({
      find: (q) => {
        if (q.label) seen.push('label');
        if (q.placeholder) seen.push('placeholder');
        if (q.text) seen.push('text');
        return q.text ? [{ ref: 'e3', role: 'textbox', name: 'Port', score: 0.8 }] : [];
      },
    });
    const resolved = await resolver.resolve(session, { label: 'Port', placeholder: 'Port', text: 'Port' });
    expect(seen).toEqual(['label', 'placeholder', 'text']);
    expect(resolved.resolution.strategy).toBe('text');
    expect(resolved.resolution.healed).toBe(true);
  });

  it('refuses to guess between tied candidates and lists the top 3', async () => {
    const { session } = makeSession({
      find: () => [
        { ref: 'e1', role: 'button', name: 'Delete', score: 1 },
        { ref: 'e2', role: 'button', name: 'Delete', score: 0.99 },
        { ref: 'e3', role: 'button', name: 'Delete', score: 0.98 },
        { ref: 'e4', role: 'button', name: 'Delete', score: 0.97 },
      ],
    });
    const error = await caught(resolver.resolve(session, { name: 'Delete' }));
    expect(codeOf(error)).toBe('TARGET_AMBIGUOUS');
    const details = isFbaError(error) ? error.details : undefined;
    expect(Array.isArray(details?.['candidates'])).toBe(true);
    expect((details?.['candidates'] as unknown[]).length).toBe(3);
  });

  it('accepts a clear winner without complaining', async () => {
    const { session } = makeSession({
      find: () => [
        { ref: 'e1', role: 'button', name: 'Delete account', score: 0.95 },
        { ref: 'e2', role: 'button', name: 'Delete draft', score: 0.6 },
      ],
    });
    const resolved = await resolver.resolve(session, { name: 'Delete account' });
    expect(resolved.resolution.ref).toBe('e1');
  });

  it('uses nth to break a tie instead of throwing', async () => {
    const { session } = makeSession({
      find: () => [
        { ref: 'e1', role: 'button', name: 'Delete', score: 1 },
        { ref: 'e2', role: 'button', name: 'Delete', score: 1 },
      ],
    });
    const resolved = await resolver.resolve(session, { name: 'Delete', nth: 1 });
    expect(resolved.resolution.ref).toBe('e2');
  });

  it('reports the closest candidates when nothing clears the confidence floor', async () => {
    const { session } = makeSession({
      find: () => [{ ref: 'e7', role: 'button', name: 'Save draft', score: 0.31 }],
    });
    const error = await caught(resolver.resolve(session, { name: 'Publish' }));
    expect(codeOf(error)).toBe('TARGET_NOT_FOUND');
    expect(isFbaError(error) ? error.hint : '').toContain('Save draft');
  });

  it('rejects a target with nothing to search by', async () => {
    const { session } = makeSession();
    expect(codeOf(await caught(resolver.resolve(session, {})))).toBe('INVALID_ARGUMENT');
  });

  it('tryResolve swallows the error', async () => {
    const { session } = makeSession();
    expect(await resolver.tryResolve(session, { name: 'Nope' })).toBeUndefined();
  });

  it('honours a stricter minConfidence', async () => {
    const strict = new DefaultTargetResolver({ minConfidence: 0.9 });
    const { session } = makeSession({ find: () => [{ ref: 'e1', role: 'button', name: 'Savez', score: 0.7 }] });
    expect(await strict.tryResolve(session, { name: 'Save' })).toBeUndefined();
    expect(await new DefaultTargetResolver().tryResolve(session, { name: 'Save' })).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// form: pure helpers
// ---------------------------------------------------------------------------

describe('coerceBoolean', () => {
  it('understands how humans and config files write booleans', () => {
    for (const truthy of [true, 1, 'true', 'TRUE', 'yes', 'On', 'checked', '1']) {
      expect(coerceBoolean(truthy as never), String(truthy)).toBe(true);
    }
    for (const falsy of [false, 0, 'false', 'no', 'OFF', 'unchecked', '0']) {
      expect(coerceBoolean(falsy as never), String(falsy)).toBe(false);
    }
  });

  it('returns undefined rather than guessing', () => {
    expect(coerceBoolean('maybe')).toBeUndefined();
    expect(coerceBoolean(['a'])).toBeUndefined();
    expect(coerceBoolean('')).toBeUndefined();
  });
});

describe('actionForRole', () => {
  it('derives the action from the control, not the value', () => {
    expect(actionForRole('checkbox', 'off')).toBe('check');
    expect(actionForRole('switch', 'yes')).toBe('check');
    expect(actionForRole('combobox', 'Fast')).toBe('select');
    expect(actionForRole('listbox', ['a', 'b'])).toBe('select');
    expect(actionForRole('textbox', true)).toBe('type');
    expect(actionForRole('spinbutton', 587)).toBe('type');
    expect(actionForRole('slider', 5)).toBe('type');
    expect(actionForRole('radio', 'Monthly')).toBe('radio');
    expect(actionForRole('file', '/tmp/a.png')).toBe('upload');
    expect(actionForRole('button', 'x')).toBe('click');
  });

  it('falls back to the value shape only for roles with no semantics', () => {
    expect(actionForRole('generic', ['a'])).toBe('select');
    expect(actionForRole('generic', 'a')).toBe('type');
  });
});

describe('pickSubmitTarget', () => {
  it('prefers a real save button over an acknowledgement', () => {
    const picked = pickSubmitTarget([
      { ref: 'e1', role: 'button', name: 'Cancel' },
      { ref: 'e2', role: 'button', name: 'OK' },
      { ref: 'e3', role: 'button', name: 'Save changes' },
    ]);
    expect(picked?.ref).toBe('e3');
  });

  it('recognises a submit testId and ignores non-buttons', () => {
    expect(pickSubmitTarget([{ ref: 'e1', role: 'button', testId: 'submit-btn' }])?.ref).toBe('e1');
    expect(pickSubmitTarget([{ ref: 'e1', role: 'link', name: 'Save' }])).toBeUndefined();
    expect(pickSubmitTarget([{ ref: 'e1', role: 'button', name: 'Delete' }])).toBeUndefined();
  });

  it('speaks a few other languages', () => {
    expect(pickSubmitTarget([{ ref: 'e1', role: 'button', name: 'Speichern' }])?.ref).toBe('e1');
    expect(pickSubmitTarget([{ ref: 'e1', role: 'button', name: 'Enregistrer' }])?.ref).toBe('e1');
  });
});

describe('collectCandidates', () => {
  it('flattens interactive controls and remembers their section', () => {
    const tree: SnapNode = {
      role: 'main',
      children: [
        {
          role: 'fieldset',
          name: 'SMTP',
          children: [
            { ref: 'e1', role: 'textbox', name: 'Port', value: '25' },
            { ref: 'e2', role: 'checkbox', name: 'Use TLS', state: { checked: false } },
          ],
        },
        { ref: 'e3', role: 'textbox', name: 'Port', value: '80' },
        { role: 'text', name: 'not interactive' },
      ],
    };
    const pool = collectCandidates(tree);
    expect(pool.map((c) => c.ref)).toEqual(['e1', 'e2', 'e3']);
    expect(pool[0]?.group).toBe('SMTP');
    expect(pool[2]?.group).toBeUndefined();
    expect(pool[1]?.checked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// form: fillForm
// ---------------------------------------------------------------------------

const configForm: SnapNode = {
  role: 'form',
  name: 'Mail settings',
  children: [
    { ref: 'e1', role: 'textbox', name: 'Host', value: 'smtp.old.test' },
    { ref: 'e2', role: 'spinbutton', name: 'Port', value: '587' },
    { ref: 'e3', role: 'switch', name: 'Use TLS', state: { checked: true } },
    { ref: 'e4', role: 'combobox', name: 'Auth mode', value: 'Plain', meta: { options: ['Plain', 'Login'] } },
    {
      role: 'group',
      name: 'Billing period',
      children: [
        { ref: 'e5', role: 'radio', name: 'Monthly', state: { checked: true } },
        { ref: 'e6', role: 'radio', name: 'Yearly', state: { checked: false } },
      ],
    },
    { ref: 'e7', role: 'button', name: 'Save' },
    { ref: 'e8', role: 'button', name: 'Cancel' },
    { ref: 'e9', role: 'textbox', name: 'Locked', state: { disabled: true } },
  ],
};

describe('fillForm', () => {
  const resolver = new DefaultTargetResolver();

  it('compiles one program and picks the action from each control role', async () => {
    const { session } = makeSession({ snapshotTree: configForm });
    const { run, programs } = recordingRun();
    const request: FormFillRequest = {
      fields: { Host: 'smtp.new.test', 'Use TLS': 'off', 'Auth mode': 'Login', 'Billing period': 'Yearly' },
    };

    const result = await fillForm(session, request, resolver, run);

    expect(programs.length).toBe(1);
    expect(programs[0]).toEqual([
      { do: 'type', target: { ref: 'e1' }, text: 'smtp.new.test', clear: true },
      { do: 'check', target: { ref: 'e3' }, checked: false },
      { do: 'select', target: { ref: 'e4' }, option: 'Login' },
      // A radio group is filled by clicking the radio the VALUE names.
      { do: 'click', target: { ref: 'e6' } },
    ]);
    expect(result.ok).toBe(true);
    expect(result.fields.map((f) => f.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(result.fields[0]?.matchedName).toBe('Host');
  });

  it('short-circuits fields that already hold the requested value', async () => {
    const { session } = makeSession({ snapshotTree: configForm });
    const { run, programs } = recordingRun();

    const result = await fillForm(
      session,
      { fields: { Port: 587, 'Use TLS': true, 'Auth mode': 'Plain' } },
      resolver,
      run,
    );

    // Nothing to do at all: no program is compiled and the page is never touched.
    expect(programs.length).toBe(0);
    expect(result.fields.map((f) => f.status)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(result.ok).toBe(true);
  });

  it('reports unmatched keys and, in strict mode, refuses to touch the page', async () => {
    const { session } = makeSession({ snapshotTree: configForm });

    const loose = recordingRun();
    const relaxed = await fillForm(session, { fields: { Host: 'a', Nonsense: 'b' } }, resolver, loose.run);
    expect(relaxed.fields.map((f) => f.status)).toEqual(['ok', 'unmatched']);
    expect(relaxed.ok).toBe(true);
    expect(loose.programs.length).toBe(1);

    const strictRun = recordingRun();
    const strict = await fillForm(
      session,
      { fields: { Host: 'a', Nonsense: 'b' }, strict: true },
      resolver,
      strictRun.run,
    );
    expect(strict.ok).toBe(false);
    expect(strictRun.programs.length).toBe(0);
    expect(strict.observation.notes?.join(' ')).toContain('Nonsense');
  });

  it('rescues a key the snapshot text cannot place via the in-page matcher', async () => {
    // The control's accessible name in the snapshot is "Host", but the page
    // associates the label "Mail server" with it — only the runtime knows.
    const { session } = makeSession({
      snapshotTree: configForm,
      find: (q) => (q.label === 'Mail server' ? [{ ref: 'e1', role: 'textbox', name: 'Host', score: 0.9 }] : []),
      locators: { '[data-fba="e1"]': { count: 1, attrs: { 'data-fba': 'e1' } } },
    });
    const { run, programs } = recordingRun();
    const result = await fillForm(session, { fields: { 'Mail server': 'smtp.new.test' } }, resolver, run);

    expect(result.fields[0]?.status).toBe('ok');
    expect(programs[0]).toEqual([{ do: 'type', target: { ref: 'e1' }, text: 'smtp.new.test', clear: true }]);
  });

  it('refuses to fill a disabled control and says why', async () => {
    const { session } = makeSession({ snapshotTree: configForm });
    const { run } = recordingRun();
    const result = await fillForm(session, { fields: { Locked: 'x' } }, resolver, run);
    expect(result.fields[0]?.status).toBe('failed');
    expect(result.fields[0]?.error).toContain('disabled');
    expect(result.ok).toBe(false);
  });

  it('appends the submit click to the same program', async () => {
    const { session } = makeSession({ snapshotTree: configForm });
    const { run, programs } = recordingRun();
    const result = await fillForm(session, { fields: { Host: 'a' }, submit: true }, resolver, run);

    expect(programs[0]?.length).toBe(2);
    expect(programs[0]?.[1]).toEqual({ do: 'click', target: { ref: 'e7' } });
    expect(result.submitted).toBe(true);
  });

  it('surfaces a failed field without losing the rest of the report', async () => {
    const { session } = makeSession({ snapshotTree: configForm });
    const { run } = recordingRun({ 0: 'failed' });
    const result = await fillForm(session, { fields: { Host: 'a', 'Auth mode': 'Login' } }, resolver, run);
    expect(result.fields.map((f) => f.status)).toEqual(['failed', 'ok']);
    expect(result.ok).toBe(false);
  });

  it('switches tabs before snapshotting the pool', async () => {
    const { session } = makeSession({ snapshotTree: configForm });
    const { run, programs } = recordingRun();
    await fillForm(session, { fields: { Host: 'a' }, tabPath: ['Advanced'] }, resolver, run);
    expect(programs[0]).toEqual([{ do: 'selectTab', path: ['Advanced'] }]);
    expect(programs[1]?.[0]).toMatchObject({ do: 'type' });
  });
});

// ---------------------------------------------------------------------------
// act: failure policy
// ---------------------------------------------------------------------------

const failingAssert: ActionStep = { do: 'assert', urlContains: '/never-here' };
const okStep: ActionStep = { do: 'settle' };

describe('DefaultExecutor onFailure', () => {
  const executor = new DefaultExecutor();

  it('stop: aborts and marks the remaining steps skipped', async () => {
    const { session } = makeSession();
    const result = await executor.run(session, [okStep, failingAssert, okStep]);

    expect(result.steps.map((s) => s.status)).toEqual(['ok', 'failed', 'skipped']);
    expect(result.failedAt).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.steps[1]?.error).toContain('ASSERTION_FAILED');
    expect(result.steps[2]?.detail).toContain('aborted');
  });

  it('continue: records the failure and keeps going', async () => {
    const { session } = makeSession();
    const result = await executor.run(session, [okStep, failingAssert, okStep], { onFailure: 'continue' });

    expect(result.steps.map((s) => s.status)).toEqual(['ok', 'failed', 'ok']);
    expect(result.failedAt).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('retry: retries a transient failure exactly once and reports it as healed', async () => {
    let call = 0;
    const { session, calls } = makeSession({
      url: () => (++call === 1 ? 'http://localhost:3000/pending' : 'http://localhost:3000/done'),
    });
    const result = await executor.run(session, [{ do: 'assert', urlContains: '/done' }], { onFailure: 'retry' });

    expect(result.steps[0]?.status).toBe('healed');
    expect(result.ok).toBe(true);
    // The retry is preceded by a fresh settle.
    expect(calls.settle).toBeGreaterThanOrEqual(1);
  });

  it('retry: gives up after the single retry and then behaves like stop', async () => {
    const { session, calls } = makeSession({
      evaluate: () => {
        throw new Error('boom');
      },
    });
    const result = await executor.run(session, [{ do: 'eval', fn: '() => 1' }, okStep], { onFailure: 'retry' });

    expect(calls.evaluate).toBe(2);
    expect(result.steps.map((s) => s.status)).toEqual(['failed', 'skipped']);
  });

  it('re-injects the runtime and retries once when the page navigates mid-step', async () => {
    let call = 0;
    const { session, calls } = makeSession({
      evaluate: () => {
        if (++call === 1) throw new Error('Execution context was destroyed, most likely because of a navigation');
        return 42;
      },
    });
    const result = await executor.run(session, [{ do: 'eval', fn: '() => 42' }]);

    expect(calls.ensureRuntime).toBe(1);
    expect(result.steps[0]?.status).toBe('healed');
    expect(result.ok).toBe(true);
  });

  it('marks steps skipped and notes a TIMEOUT once the program budget is gone', async () => {
    const { session } = makeSession({ settleMs: 25 });
    const result = await executor.run(session, [okStep, okStep, okStep], { timeoutMs: 10 });

    expect(result.steps[0]?.status).toBe('ok');
    expect(result.steps.slice(1).every((s) => s.status === 'skipped')).toBe(true);
    expect(result.observation.notes?.join(' ')).toContain('TIMEOUT');
  });

  it('returns an observation and no steps for an empty program', async () => {
    const { session, calls } = makeSession();
    const result = await executor.run(session, []);
    expect(result).toMatchObject({ steps: [], ok: true });
    expect(calls.observe).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// act: individual steps that are decidable without a real page
// ---------------------------------------------------------------------------

describe('DefaultExecutor steps', () => {
  const executor = new DefaultExecutor();

  it('walks a tab path and skips tabs that are already active', async () => {
    const { session, calls } = makeSession({
      structure: {
        tabs: [
          { ref: 'e1', label: 'General', selected: true },
          { ref: 'e2', label: 'Advanced', selected: false },
        ],
        sections: [],
      },
      locators: { '[data-fba="e2"]': { count: 1 } },
    });

    const result = await executor.run(session, [{ do: 'selectTab', path: ['General', 'Advanced'] }]);
    expect(result.ok).toBe(true);
    expect(result.steps[0]?.detail).toContain('1 click(s), 1 already active');
    expect(calls.actions).toEqual(['click:[data-fba="e2"]']);
  });

  it('fails a selectTab with the list of tabs that do exist', async () => {
    const { session } = makeSession({
      structure: { tabs: [{ ref: 'e1', label: 'General', selected: true }], sections: [] },
    });
    const result = await executor.run(session, [{ do: 'selectTab', path: ['Nowhere'] }]);
    expect(result.ok).toBe(false);
    expect(result.steps[0]?.error).toContain('General');
  });

  it('treats an assert as a hard failure, never a silent pass', async () => {
    const { session } = makeSession({ url: 'http://localhost:3000/settings' });
    const ok = await executor.run(session, [{ do: 'assert', urlContains: '/settings' }]);
    expect(ok.ok).toBe(true);

    const bad = await executor.run(session, [{ do: 'assert', urlContains: '/billing' }]);
    expect(bad.ok).toBe(false);
    expect(bad.steps[0]?.error).toContain('ASSERTION_FAILED');
  });

  it('asserts absence when the target cannot be resolved', async () => {
    const { session } = makeSession();
    const result = await executor.run(session, [{ do: 'assert', target: { name: 'Ghost' }, exists: false }]);
    expect(result.ok).toBe(true);
  });

  it('reports an unknown option list when a select finds nothing', async () => {
    const { session } = makeSession({ locators: { '[data-fba="e1"]': { count: 1 } } });
    const result = await executor.run(session, [{ do: 'assert', target: { ref: 'e1' }, exists: true }]);
    expect(result.ok).toBe(true);
  });
});
