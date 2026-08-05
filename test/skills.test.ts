import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultConfig } from '../src/config.js';
import type { Executor, Session } from '../src/contracts.js';
import {
  DefaultSkillRunner,
  FsSkillStore,
  compileFromSteps,
  extractParams,
  interpolateSteps,
  normalizeOrigin,
  originSlug,
  skillKey,
  validateSkill,
} from '../src/skills/index.js';
import type {
  ActOptions,
  ActResult,
  ActionStep,
  FbaConfig,
  FormFillResult,
  Observation,
  PageSnapshot,
  SkillRecord,
  StepResult,
} from '../src/types.js';
import { isFbaError } from '../src/util/errors.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const fixtures: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fba-skills-'));
  fixtures.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of fixtures.splice(0)) await rm(dir, { recursive: true, force: true });
});

function store(home: string): FsSkillStore {
  const config: FbaConfig = { ...defaultConfig(), home };
  return new FsSkillStore(config);
}

function record(overrides: Partial<SkillRecord> = {}): SkillRecord {
  const now = Date.now();
  return {
    name: 'checkout',
    origin: 'http://localhost:3000',
    params: [],
    steps: [{ do: 'goto', url: '/cart' }, { do: 'click', target: { name: 'Checkout' } }],
    createdAt: now,
    updatedAt: now,
    runs: 0,
    failures: 0,
    ...overrides,
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined).catch((e: unknown) => e);
}

function codeOf(e: unknown): string {
  return isFbaError(e) ? e.code : `not-an-FbaError: ${String(e)}`;
}

// ---------------------------------------------------------------------------
// origins and keys
// ---------------------------------------------------------------------------

describe('normalizeOrigin', () => {
  it('reduces a full URL to scheme + host + port', () => {
    expect(normalizeOrigin('http://localhost:3000/settings/advanced?x=1#y')).toBe('http://localhost:3000');
    expect(normalizeOrigin('https://App.Example.com/a')).toBe('https://app.example.com');
  });

  it('drops default ports and tolerates bare hosts', () => {
    expect(normalizeOrigin('https://example.com:443/')).toBe('https://example.com');
    expect(normalizeOrigin('localhost:5173')).toBe('http://localhost:5173');
  });

  it('gives opaque schemes a usable key', () => {
    expect(normalizeOrigin('file:///tmp/app/index.html')).toBe('file://');
    expect(normalizeOrigin('about:blank')).toBe('about:blank');
    expect(normalizeOrigin('')).toBe('about:blank');
  });
});

describe('originSlug', () => {
  it('strips the scheme and folds unsafe characters', () => {
    expect(originSlug('http://localhost:3000')).toBe('localhost_3000');
    expect(originSlug('https://app.example.com')).toBe('app.example.com');
    expect(originSlug('file://')).toBe('file');
  });
});

describe('skillKey', () => {
  it('is case- and URL-insensitive', () => {
    expect(skillKey('Checkout', 'http://localhost:3000/cart')).toBe(skillKey('checkout', 'http://localhost:3000'));
    expect(skillKey('checkout', 'http://localhost:3000')).not.toBe(skillKey('checkout', 'http://localhost:3001'));
  });
});

// ---------------------------------------------------------------------------
// name validation / path traversal
// ---------------------------------------------------------------------------

describe('skill name validation', () => {
  it('accepts a lowercased name and rejects path separators', async () => {
    const home = await tempHome();
    const s = store(home);

    await s.save(record({ name: 'Login-Admin' }));
    expect(existsSync(join(home, 'skills', 'localhost_3000', 'login-admin.json'))).toBe(true);

    for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '', '.', '..', '.hidden', 'has space', 'x'.repeat(65)]) {
      const error = await caught(s.save(record({ name: bad })));
      expect(codeOf(error), `expected ${JSON.stringify(bad)} to be rejected`).toBe('INVALID_ARGUMENT');
    }

    // Nothing escaped the skills directory.
    const origins = await readdir(join(home, 'skills'));
    expect(origins).toEqual(['localhost_3000']);
    expect(await readdir(join(home, 'skills', 'localhost_3000'))).toEqual(['login-admin.json']);
  });

  it('reports the problem instead of throwing in validateSkill', () => {
    expect(validateSkill(record())).toEqual([]);
    expect(validateSkill(record({ name: '../evil' })).join(' ')).toContain('invalid name');
    expect(validateSkill(record({ steps: [] })).join(' ')).toContain('no steps');
    expect(validateSkill(record({ steps: [{ do: 'eval', fn: 'x' }] })).join(' ')).toContain('eval');
    expect(validateSkill(record({ runs: 1, failures: 3 })).join(' ')).toContain('failures exceeds runs');
    expect(validateSkill(record({ params: ['unused'] })).join(' ')).toContain('no step uses');
  });
});

// ---------------------------------------------------------------------------
// parameters
// ---------------------------------------------------------------------------

describe('extractParams', () => {
  it('collects distinct placeholders in first-appearance order', () => {
    const steps: ActionStep[] = [
      { do: 'goto', url: '/orders/{{orderId}}' },
      { do: 'type', target: { name: 'Search {{orderId}}' }, text: '{{query}}' },
      { do: 'select', target: { css: '#region' }, option: ['{{region}}', '{{query}}'] },
      { do: 'assert', urlContains: '/orders/{{orderId}}' },
    ];
    expect(extractParams(steps)).toEqual(['orderId', 'query', 'region']);
  });

  it('ignores escaped braces and non-placeholder text', () => {
    const steps: ActionStep[] = [
      { do: 'type', target: { css: '#tpl' }, text: 'literal {{{{notAParam}} and {{ 2 + 2 }} and {unclosed' },
    ];
    expect(extractParams(steps)).toEqual([]);
  });

  it('finds placeholders in every string field of a target', () => {
    const steps: ActionStep[] = [
      {
        do: 'click',
        target: { name: '{{a}}', text: '{{b}}', css: '[data-id="{{c}}"]', testId: '{{d}}', within: '{{e}}' },
      },
    ];
    expect(extractParams(steps)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('interpolateSteps', () => {
  it('substitutes across nested target fields without mutating the input', () => {
    const steps: ActionStep[] = [
      { do: 'goto', url: '/orders/{{orderId}}' },
      { do: 'type', target: { name: 'Note for {{orderId}}', css: '[data-x="{{orderId}}"]' }, text: '{{note}}' },
      { do: 'select', target: { css: '#r' }, option: ['{{note}}'] },
    ];
    const out = interpolateSteps(steps, { orderId: '42', note: 'hi' });

    expect(out[0]).toEqual({ do: 'goto', url: '/orders/42' });
    expect(out[1]).toEqual({ do: 'type', target: { name: 'Note for 42', css: '[data-x="42"]' }, text: 'hi' });
    expect(out[2]).toEqual({ do: 'select', target: { css: '#r' }, option: ['hi'] });

    // Deep clone: the stored record must survive being replayed twice.
    expect(steps[0]).toEqual({ do: 'goto', url: '/orders/{{orderId}}' });
    expect(out[1]).not.toBe(steps[1]);
  });

  it('renders {{{{ as a literal {{', () => {
    const steps: ActionStep[] = [{ do: 'type', target: { css: '#t' }, text: '{{{{x}} = {{x}}' }];
    const out = interpolateSteps(steps, { x: '9' });
    expect(out[0]).toEqual({ do: 'type', target: { css: '#t' }, text: '{{x}} = 9' });
  });

  it('throws INVALID_ARGUMENT naming the missing placeholder', () => {
    const steps: ActionStep[] = [{ do: 'goto', url: '/u/{{userId}}' }];
    let thrown: unknown;
    try {
      interpolateSteps(steps, {});
    } catch (e) {
      thrown = e;
    }
    expect(codeOf(thrown)).toBe('INVALID_ARGUMENT');
    expect(String((thrown as Error).message)).toContain('userId');
  });

  it('passes empty strings through (they are a real value, unlike undefined)', () => {
    const out = interpolateSteps([{ do: 'goto', url: '/q?s={{term}}' }], { term: '' });
    expect(out[0]).toEqual({ do: 'goto', url: '/q?s=' });
  });
});

// ---------------------------------------------------------------------------
// FsSkillStore
// ---------------------------------------------------------------------------

describe('FsSkillStore', () => {
  it('round-trips save / list / get / delete', async () => {
    const home = await tempHome();
    const s = store(home);

    expect(await s.list()).toEqual([]);
    expect(await s.get('checkout')).toBeUndefined();
    expect(await s.delete('checkout')).toBe(false);

    await s.save(record());
    await s.save(record({ name: 'login', origin: 'https://app.example.com/login' }));

    const file = join(home, 'skills', 'localhost_3000', 'checkout.json');
    expect(existsSync(file)).toBe(true);

    const all = await s.list();
    expect(all.map((r) => `${r.origin}/${r.name}`)).toEqual([
      'http://localhost:3000/checkout',
      'https://app.example.com/login',
    ]);
    // The origin is canonicalised on the way in.
    expect(all[1]?.origin).toBe('https://app.example.com');

    expect((await s.list('http://localhost:3000/anything')).map((r) => r.name)).toEqual(['checkout']);

    // Case-insensitive lookup, with and without an origin.
    expect((await s.get('CHECKOUT', 'http://localhost:3000/cart'))?.name).toBe('checkout');
    expect((await s.get('Checkout'))?.name).toBe('checkout');
    expect(await s.get('checkout', 'https://app.example.com')).toBeUndefined();

    expect(await s.delete('checkout', 'http://localhost:3000')).toBe(true);
    expect(await s.delete('checkout', 'http://localhost:3000')).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect((await s.list()).map((r) => r.name)).toEqual(['login']);
  });

  it('writes atomically and leaves no temporary files behind', async () => {
    const home = await tempHome();
    const s = store(home);
    await Promise.all([
      s.save(record({ name: 'one' })),
      s.save(record({ name: 'two' })),
      s.save(record({ name: 'three' })),
    ]);
    const files = await readdir(join(home, 'skills', 'localhost_3000'));
    expect(files.sort()).toEqual(['one.json', 'three.json', 'two.json']);

    const raw: unknown = JSON.parse(await readFile(join(home, 'skills', 'localhost_3000', 'one.json'), 'utf8'));
    expect((raw as SkillRecord).name).toBe('one');
  });

  it('re-reads a file that changed on disk (mtime-keyed cache)', async () => {
    const home = await tempHome();
    const s = store(home);
    await s.save(record({ description: 'first' }));
    expect((await s.get('checkout', 'http://localhost:3000'))?.description).toBe('first');

    // Simulate another agent process rewriting the same skill.
    const file = join(home, 'skills', 'localhost_3000', 'checkout.json');
    const other = store(home);
    await other.save(record({ description: 'second' }));

    expect((await s.get('checkout', 'http://localhost:3000'))?.description).toBe('second');
    expect(existsSync(file)).toBe(true);
  });

  it('skips corrupt files instead of failing the whole listing', async () => {
    const home = await tempHome();
    const s = store(home);
    await s.save(record());
    await mkdir(join(home, 'skills', 'broken_host'), { recursive: true });
    await writeFile(join(home, 'skills', 'broken_host', 'junk.json'), '{ not json', 'utf8');

    expect((await s.list()).map((r) => r.name)).toEqual(['checkout']);
  });

  it('refuses to store an unreplayable record', async () => {
    const home = await tempHome();
    const s = store(home);
    const error = await caught(s.save(record({ steps: [{ do: 'eval', fn: 'window.close()' }] })));
    expect(codeOf(error)).toBe('INVALID_ARGUMENT');
    expect(await s.list()).toEqual([]);
  });

  it('tracks run statistics and tolerates a missing file', async () => {
    const home = await tempHome();
    const s = store(home);
    await s.save(record());

    await s.markRun('checkout', 'http://localhost:3000/cart', true, 812.4);
    let stored = await s.get('checkout', 'http://localhost:3000');
    expect(stored?.runs).toBe(1);
    expect(stored?.failures).toBe(0);
    expect(stored?.lastMs).toBe(812);

    await s.markRun('checkout', 'http://localhost:3000', false, 5_000);
    stored = await s.get('checkout', 'http://localhost:3000');
    expect(stored?.runs).toBe(2);
    expect(stored?.failures).toBe(1);
    // A failed replay must not become the known-good baseline.
    expect(stored?.lastMs).toBe(812);

    await expect(s.markRun('nope', 'http://localhost:3000', true, 5)).resolves.toBeUndefined();
    await expect(s.markRun('bad/name', 'http://localhost:3000', true, 5)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// compileFromSteps
// ---------------------------------------------------------------------------

describe('compileFromSteps', () => {
  it('strips eval steps, collapses settles and derives params', () => {
    const steps: ActionStep[] = [
      { do: 'goto', url: 'http://localhost:3000/orders/{{orderId}}' },
      { do: 'settle', options: { timeoutMs: 1_000 } },
      { do: 'settle', options: { timeoutMs: 4_000, domQuietMs: 250 } },
      { do: 'settle' },
      { do: 'eval', fn: 'window.localStorage.clear()' },
      { do: 'click', target: { name: 'Refund' } },
    ];
    const compiled = compileFromSteps('refund-order', 'http://localhost:3000', steps, {
      description: 'refund an order',
    });

    expect(compiled.steps.map((s) => s.do)).toEqual(['goto', 'settle', 'click']);
    expect(compiled.steps[1]).toEqual({ do: 'settle', options: { domQuietMs: 250, timeoutMs: 4_000 } });
    expect(compiled.params).toEqual(['orderId']);
    expect(compiled.description).toBe('refund an order');
    expect(compiled.runs).toBe(0);
    expect(compiled.failures).toBe(0);
    expect(validateSkill(compiled)).toEqual([]);
    // The source program is untouched.
    expect(steps).toHaveLength(6);
  });

  it('normalises the name and origin', () => {
    const compiled = compileFromSteps('Deep Link'.replace(' ', '-'), 'http://LOCALHOST:3000/x', [
      { do: 'goto', url: '/x' },
    ]);
    expect(compiled.name).toBe('deep-link');
    expect(compiled.origin).toBe('http://localhost:3000');
  });

  it('appends a URL assertion that keeps placeholders intact', () => {
    const compiled = compileFromSteps(
      'open-order',
      'http://localhost:3000',
      [
        { do: 'goto', url: 'http://localhost:3000/orders/{{orderId}}?tab=items' },
        { do: 'click', target: { name: 'Items' } },
      ],
      { addAssertions: true },
    );
    expect(compiled.steps[compiled.steps.length - 1]).toEqual({ do: 'assert', urlContains: '/orders/{{orderId}}' });
    expect(compiled.params).toEqual(['orderId']);
  });

  it('does not stack a second assertion on one the caller already wrote', () => {
    const compiled = compileFromSteps(
      'open-settings',
      'http://localhost:3000',
      [{ do: 'goto', url: '/settings' }, { do: 'assert', urlContains: '/settings' }],
      { addAssertions: true },
    );
    expect(compiled.steps.filter((s) => s.do === 'assert')).toHaveLength(1);
  });

  it('rejects a program that is nothing but eval', async () => {
    const error = await caught(
      Promise.resolve().then(() => compileFromSteps('unsafe', 'http://localhost:3000', [{ do: 'eval', fn: '1' }])),
    );
    expect(codeOf(error)).toBe('INVALID_ARGUMENT');
  });
});

// ---------------------------------------------------------------------------
// DefaultSkillRunner
// ---------------------------------------------------------------------------

function fakeSession(url: string): Session {
  const snapshot: PageSnapshot = {
    url,
    title: 'Fake',
    version: 1,
    tree: { role: 'main' },
    stats: { interactive: 0, emitted: 1, elided: 0, captureMs: 0 },
  };
  const observation: Observation = { url, title: 'Fake', summary: 'observed' };
  return {
    id: 'fake-session',
    workspaceId: 'fake-workspace',
    // Only `url()` is exercised by the runner; the rest of the Page surface is
    // irrelevant to skill replay.
    page: { url: () => url } as unknown as Page,
    config: defaultConfig(),
    info: () => ({
      id: 'fake-session',
      workspaceId: 'fake-workspace',
      url,
      title: 'Fake',
      createdAt: 0,
      lastUsedAt: 0,
      version: 1,
    }),
    goto: async () => undefined,
    snapshot: async () => snapshot,
    lastSnapshot: () => snapshot,
    settle: async () => ({ settled: true, reason: 'quiet' as const, waitedMs: 0 }),
    observe: async () => ({ ...observation }),
    find: async () => [],
    structure: async () => ({ tabs: [], sections: [] }),
    pendingDialog: () => undefined,
    answerDialog: async () => undefined,
    endpoints: () => [],
    recentRequests: () => [],
    drainProblems: async () => [],
    ensureRuntime: async () => undefined,
    close: async () => undefined,
  };
}

interface FakeRun {
  steps: ActionStep[];
  options: ActOptions | undefined;
}

/** Executor that reports every step ok except an optional designated failure. */
class FakeExecutor implements Executor {
  readonly runs: FakeRun[] = [];

  constructor(private readonly failAt?: { index: number; error: string }) {}

  async run(session: Session, steps: ActionStep[], options?: ActOptions): Promise<ActResult> {
    this.runs.push({ steps, options });
    const results: StepResult[] = [];
    let failedAt: number | undefined;
    for (const [index, step] of steps.entries()) {
      if (this.failAt && index === this.failAt.index) {
        results.push({ index, step: step.do, status: 'failed', error: this.failAt.error, ms: 1 });
        failedAt = index;
        break; // onFailure: 'stop'
      }
      results.push({ index, step: step.do, status: 'ok', ms: 1 });
    }
    const observation = await session.observe();
    return {
      steps: results,
      ok: failedAt === undefined,
      ...(failedAt === undefined ? {} : { failedAt }),
      observation,
    };
  }

  async fillForm(session: Session): Promise<FormFillResult> {
    return { fields: [], submitted: false, ok: true, observation: await session.observe() };
  }
}

/** Store spy that records exactly what markRun was told. */
class SpyStore extends FsSkillStore {
  readonly marks: Array<{ name: string; origin: string; ok: boolean; ms: number }> = [];

  override async markRun(name: string, origin: string, ok: boolean, ms: number): Promise<void> {
    this.marks.push({ name, origin, ok, ms });
    await super.markRun(name, origin, ok, ms);
  }
}

async function spyStore(home: string): Promise<SpyStore> {
  return new SpyStore({ ...defaultConfig(), home });
}

describe('DefaultSkillRunner', () => {
  it('replays a skill, interpolates params and records a successful run', async () => {
    const home = await tempHome();
    const s = await spyStore(home);
    await s.save(
      record({
        name: 'open-order',
        params: ['orderId'],
        steps: [
          { do: 'goto', url: '/orders/{{orderId}}' },
          { do: 'assert', urlContains: '/orders/{{orderId}}' },
        ],
      }),
    );

    const executor = new FakeExecutor();
    const runner = new DefaultSkillRunner(s, executor);
    const result = await runner.replay(fakeSession('http://localhost:3000/'), 'Open-Order', { orderId: '77' });

    expect(result.ok).toBe(true);
    expect(result.fallbackReason).toBeUndefined();
    expect(result.name).toBe('open-order');
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(executor.runs[0]?.steps[0]).toEqual({ do: 'goto', url: '/orders/77' });
    // A replay must never re-record itself, and must stop at the first failure.
    expect(executor.runs[0]?.options?.onFailure).toBe('stop');
    expect(executor.runs[0]?.options?.record).toBeUndefined();

    expect(s.marks).toEqual([{ name: 'open-order', origin: 'http://localhost:3000', ok: true, ms: result.ms }]);
    expect((await s.get('open-order', 'http://localhost:3000'))?.runs).toBe(1);
  });

  it('fails fast with a fallbackReason when an assertion breaks', async () => {
    const home = await tempHome();
    const s = await spyStore(home);
    await s.save(
      record({
        name: 'open-order',
        params: [],
        steps: [
          { do: 'goto', url: '/orders/7' },
          { do: 'assert', urlContains: '/orders/7', target: { name: 'Refund', role: 'button' } },
          { do: 'click', target: { name: 'Refund' } },
        ],
      }),
    );

    const executor = new FakeExecutor({ index: 1, error: 'url is /login' });
    const runner = new DefaultSkillRunner(s, executor);
    const result = await runner.replay(fakeSession('http://localhost:3000/'), 'open-order');

    expect(result.ok).toBe(false);
    expect(result.fallbackReason).toContain('verification failed at step 2/3');
    expect(result.fallbackReason).toContain('/orders/7');
    expect(result.fallbackReason).toContain('url is /login');
    // The failure is surfaced in the observation too, where the model reads it.
    expect(result.observation.notes?.join(' ')).toContain('verification failed');
    // The step after the broken assertion never ran.
    expect(result.steps).toHaveLength(2);

    expect(s.marks).toEqual([{ name: 'open-order', origin: 'http://localhost:3000', ok: false, ms: result.ms }]);
    const stored = await s.get('open-order', 'http://localhost:3000');
    expect(stored?.runs).toBe(1);
    expect(stored?.failures).toBe(1);
    expect(stored?.lastMs).toBeUndefined();
  });

  it('falls back to a name-only lookup and notes the origin mismatch', async () => {
    const home = await tempHome();
    const s = await spyStore(home);
    await s.save(record({ name: 'login', origin: 'http://localhost:3000', steps: [{ do: 'goto', url: '/login' }] }));

    const runner = new DefaultSkillRunner(s, new FakeExecutor());
    const result = await runner.replay(fakeSession('http://localhost:5173/'), 'login');

    expect(result.ok).toBe(true);
    const notes = result.observation.notes?.join(' ') ?? '';
    expect(notes).toContain('recorded against http://localhost:3000');
    expect(notes).toContain('http://localhost:5173');
    // Statistics land on the record's own origin, not the session's.
    expect(s.marks[0]?.origin).toBe('http://localhost:3000');
  });

  it('warns that a skill with a bad track record looks stale but still tries', async () => {
    const home = await tempHome();
    const s = await spyStore(home);
    await s.save(
      record({ name: 'flaky', runs: 6, failures: 5, steps: [{ do: 'goto', url: '/x' }, { do: 'assert', exists: true }] }),
    );

    const runner = new DefaultSkillRunner(s, new FakeExecutor());
    const result = await runner.replay(fakeSession('http://localhost:3000/'), 'flaky');

    expect(result.ok).toBe(true);
    expect(result.observation.notes?.join(' ')).toContain('looks stale');
  });

  it('reports missing parameters before touching the browser', async () => {
    const home = await tempHome();
    const s = await spyStore(home);
    await s.save(record({ name: 'open-order', params: ['orderId'], steps: [{ do: 'goto', url: '/o/{{orderId}}' }] }));

    const executor = new FakeExecutor();
    const runner = new DefaultSkillRunner(s, executor);
    const error = await caught(runner.replay(fakeSession('http://localhost:3000/'), 'open-order', {}));

    expect(codeOf(error)).toBe('INVALID_ARGUMENT');
    expect((error as Error).message).toContain('orderId');
    expect(executor.runs).toHaveLength(0);
    expect(s.marks).toHaveLength(0);
  });

  it('raises SKILL_NOT_FOUND with the names that do exist', async () => {
    const home = await tempHome();
    const s = await spyStore(home);
    await s.save(record({ name: 'checkout' }));

    const runner = new DefaultSkillRunner(s, new FakeExecutor());
    const error = await caught(runner.replay(fakeSession('http://localhost:3000/'), 'missing'));

    expect(codeOf(error)).toBe('SKILL_NOT_FOUND');
    expect(isFbaError(error) ? error.hint : '').toContain('checkout');
  });

  it('turns an executor crash into an ok:false result with a fallback reason', async () => {
    const home = await tempHome();
    const s = await spyStore(home);
    await s.save(record({ name: 'boom', steps: [{ do: 'goto', url: '/x' }] }));

    const executor: Executor = {
      run: async () => {
        throw new Error('page crashed');
      },
      fillForm: async (session) => ({ fields: [], submitted: false, ok: false, observation: await session.observe() }),
    };
    const runner = new DefaultSkillRunner(s, executor);
    const result = await runner.replay(fakeSession('http://localhost:3000/'), 'boom');

    expect(result.ok).toBe(false);
    expect(result.fallbackReason).toContain('page crashed');
    expect(s.marks).toEqual([{ name: 'boom', origin: 'http://localhost:3000', ok: false, ms: result.ms }]);
  });
});
