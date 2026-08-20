/**
 * Defects found by running 0.4.0, not by reading it.
 *
 * Every case below started as a reproduction against the shipped package, so
 * each test reproduces the observation rather than the diagnosis:
 *
 *   1. `browser_open` advertised `{"type":"object","properties":{}}` over MCP —
 *      nothing threw, the model simply could not see that the deep-link tool
 *      took a `route`.
 *   2. a fresh session's first `goto` returned a *different* number of
 *      endpoints run to run, because the endpoint table was cleared after the
 *      new page had already started recording into it.
 *   3. a failed targetless step reported "goto  failed" — verb, two spaces,
 *      "failed" — naming the action and hiding the argument.
 *   4. no tool schema could name the session it opened.
 *   5. `fillForm` took no `ActOptions`, so per-field progress was unobservable
 *      from outside even though `run` has had `onStep` since 0.3.0.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Locator, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DefaultBrowserPool } from '../src/browser/pool.js';
import type { PageSession } from '../src/browser/session.js';
import { defaultConfig, loadConfig } from '../src/config.js';
import type { AcquireOptions, BrowserPool, ObserveOptions, Session } from '../src/contracts.js';
import { DefaultExecutor } from '../src/executor/index.js';
import { createServer } from '../src/mcp/server.js';
import { TOOL_NAMES } from '../src/mcp/tools.js';
import type {
  ActionStep,
  FbaConfig,
  Observation,
  PageSnapshot,
  SessionInfo,
  SettleResult,
  StepResult,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// 1 + 4 — the MCP-visible tool schema
// ---------------------------------------------------------------------------

/**
 * A pool that records what it was asked for and never launches anything.
 *
 * `browser_open` is the only tool here that needs a session, and what matters
 * is the `AcquireOptions` it forwards — not what the tab does afterwards.
 */
class RecordingPool implements BrowserPool {
  readonly acquired: AcquireOptions[] = [];
  private readonly session: Session;

  constructor(config: FbaConfig) {
    this.session = stubSession(config);
  }

  async acquire(options: AcquireOptions = {}): Promise<Session> {
    this.acquired.push(options);
    return this.session;
  }
  get(): Session | undefined {
    return this.session;
  }
  list(): SessionInfo[] {
    return [this.session.info()];
  }
  async closeSession(): Promise<void> {}
  async closeWorkspace(): Promise<void> {}
  async warm(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

function stubSession(config: FbaConfig, id = 'stub-1'): Session {
  const url = 'http://localhost:3000/settings';
  const info: SessionInfo = {
    id,
    workspaceId: 'ws-stub',
    url,
    title: 'Settings',
    createdAt: 0,
    lastUsedAt: Date.now(),
    version: 1,
    busy: false,
  };
  return {
    id,
    workspaceId: info.workspaceId,
    config,
    page: {} as Page,
    info: () => info,
    goto: async () => undefined,
    snapshot: async (): Promise<PageSnapshot> => ({
      url,
      title: 'Settings',
      version: 1,
      tree: { role: 'main' },
      stats: { interactive: 0, emitted: 1, elided: 0, captureMs: 1 },
    }),
    lastSnapshot: () => undefined,
    settle: async (): Promise<SettleResult> => ({ settled: true, reason: 'quiet', waitedMs: 0 }),
    observe: async (o?: ObserveOptions): Promise<Observation> => ({
      url,
      title: 'Settings',
      summary: o?.summaryPrefix ?? 'observed',
    }),
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

interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

describe('the MCP tool schema an agent actually receives', () => {
  let config: FbaConfig;
  let pool: RecordingPool;
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'fba-0-4-0-'));
    config = { ...defaultConfig(), home, baseUrl: 'http://localhost:3000', logLevel: 'silent' };
    pool = new RecordingPool(config);
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const handle = createServer({ config, pool });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'schema-probe', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      return await fn(client);
    } finally {
      await client.close();
      await handle.close();
    }
  }

  it('advertises every property of browser_open over tools/list', async () => {
    const schemas = await withClient(async (client) => {
      const listed = await client.listTools();
      return new Map(listed.tools.map((t) => [t.name, t.inputSchema as JsonSchema]));
    });

    const open = schemas.get('browser_open');
    expect(open).toBeDefined();
    // The exact shape the SDK falls back to when it cannot convert a schema.
    expect(open).not.toEqual({ type: 'object', properties: {} });
    expect(Object.keys(open?.properties ?? {}).sort()).toEqual(
      ['fresh', 'full', 'label', 'params', 'route', 'scope', 'sessionId', 'url', 'workspace'].sort(),
    );

    // Not one tool may be empty: the fallback is silent, so a second tool could
    // acquire a `.refine()` tomorrow and nobody would notice.
    for (const name of TOOL_NAMES) {
      expect(Object.keys(schemas.get(name)?.properties ?? {}).length).toBeGreaterThan(0);
    }
  });

  it('still rejects neither-or-both url/route, from the handler', async () => {
    const [neither, both, ok] = await withClient(async (client) => {
      const call = async (args: Record<string, unknown>) => {
        const result = await client.callTool({ name: 'browser_open', arguments: args });
        const content = result.content as Array<{ type: string; text: string }>;
        return { isError: result.isError === true, text: content[0]?.text ?? '' };
      };
      return [
        await call({}),
        await call({ url: 'http://localhost:3000/', route: '/settings' }),
        await call({ url: 'http://localhost:3000/' }),
      ];
    });

    expect(neither.isError).toBe(true);
    expect(neither.text).toContain('exactly one of url or route');
    expect(both.isError).toBe(true);
    expect(both.text).toContain('exactly one of url or route');
    expect(ok.isError).toBe(false);
  });

  it('forwards a label from browser_open to the pool', async () => {
    pool.acquired.length = 0;
    await withClient(async (client) => {
      await client.callTool({
        name: 'browser_open',
        arguments: { url: 'http://localhost:3000/', label: 'Checkout flow' },
      });
    });

    expect(pool.acquired.at(-1)?.label).toBe('Checkout flow');
  });
});

// ---------------------------------------------------------------------------
// 3 — the failure detail of a step that carries no target
// ---------------------------------------------------------------------------

/** A session on which every interesting call fails, so each step reports. */
function failingSession(config: FbaConfig): Session {
  const url = 'http://localhost:3000/app';
  const page = {
    url: () => url,
    locator: () => ({ count: async () => 0 }) as unknown as Locator,
    keyboard: {
      press: async () => {
        throw new Error('the renderer is gone');
      },
    },
    goBack: async () => null,
    goForward: async () => null,
    reload: async () => {
      throw new Error('the renderer is gone');
    },
    evaluate: async () => null,
    waitForURL: async () => undefined,
  } as unknown as Page;

  return {
    id: 's-fail',
    workspaceId: 'ws-fail',
    page,
    config,
    info: () => ({
      id: 's-fail',
      workspaceId: 'ws-fail',
      url,
      title: 'App',
      createdAt: 0,
      lastUsedAt: 0,
      version: 1,
      busy: false,
    }),
    goto: async () => {
      throw new Error('net::ERR_CONNECTION_REFUSED');
    },
    snapshot: async (): Promise<PageSnapshot> => ({
      url,
      title: 'App',
      version: 1,
      tree: { role: 'main' },
      stats: { interactive: 0, emitted: 1, elided: 0, captureMs: 1 },
    }),
    lastSnapshot: () => undefined,
    settle: async (): Promise<SettleResult> => {
      throw new Error('the renderer is gone');
    },
    observe: async (o?: ObserveOptions): Promise<Observation> => ({
      url,
      title: 'App',
      summary: o?.summaryPrefix ?? 'observed',
    }),
    find: async () => [],
    structure: async () => ({ tabs: [], sections: [] }),
    pendingDialog: () => undefined,
    answerDialog: async () => {
      throw new Error('no dialog is open');
    },
    endpoints: () => [],
    recentRequests: () => [],
    drainProblems: async () => [],
    ensureRuntime: async () => undefined,
    close: async () => undefined,
  };
}

async function failureDetail(config: FbaConfig, step: ActionStep): Promise<string> {
  const result = await new DefaultExecutor().run(failingSession(config), [step], {
    onFailure: 'stop',
    settle: false,
  });
  const failed = result.steps[0];
  expect(failed?.status).toBe('failed');
  return failed?.detail ?? '';
}

describe('a failed step names what it was aiming at', () => {
  const config = { ...defaultConfig(), logLevel: 'silent' as const };

  it.each<[string, ActionStep, string]>([
    ['goto url', { do: 'goto', url: 'http://localhost:3000/settings' }, 'goto http://localhost:3000/settings failed'],
    ['goto route', { do: 'goto', route: '/settings' }, 'goto route "/settings" failed'],
    ['press', { do: 'press', keys: 'Control+Enter' }, 'press Control+Enter failed'],
    ['dialog accept', { do: 'dialog', accept: true }, 'dialog accept failed'],
    ['dialog dismiss', { do: 'dialog', accept: false }, 'dialog dismiss failed'],
    ['settle', { do: 'settle', options: { timeoutMs: 5 } }, 'settle timeout 5ms failed'],
    ['waitFor state', { do: 'waitFor', state: 'visible', timeoutMs: 5 }, 'waitFor visible failed'],
  ])('%s', async (_name, step, expected) => {
    expect(await failureDetail(config, step)).toBe(expected);
  });

  it('collapses to one space when the step genuinely has no argument', async () => {
    const detail = await failureDetail(config, { do: 'reload' });
    // The bug's signature was the doubled space, so assert on it directly.
    expect(detail).toBe('reload failed');
    expect(detail).not.toContain('  ');
  });

  it('never emits a doubled space for any step shape', async () => {
    const steps: ActionStep[] = [
      { do: 'goto', url: 'http://localhost:3000/x' },
      { do: 'goto', route: '/x' },
      { do: 'goto' },
      { do: 'press', keys: 'Enter' },
      { do: 'dialog', accept: true },
      { do: 'settle' },
      { do: 'settle', options: { networkQuietMs: 10, domQuietMs: 20, timeoutMs: 30 } },
      { do: 'waitFor', timeoutMs: 5 },
      { do: 'reload' },
    ];
    for (const step of steps) {
      const detail = await failureDetail(config, step);
      expect(detail, `detail for ${step.do}`).not.toMatch(/ {2}/);
      expect(detail).toMatch(/ failed$/);
    }
  });
});

// ---------------------------------------------------------------------------
// 5 — per-field progress out of fillForm
// ---------------------------------------------------------------------------

describe('fillForm reports the steps it compiles', () => {
  const config = { ...defaultConfig(), logLevel: 'silent' as const };

  /** A session whose snapshot holds three fillable fields. */
  function formSession(): Session {
    const base = stubSession(config, 's-form');
    const tree = {
      role: 'form' as const,
      children: [
        { ref: 'e1', role: 'textbox' as const, name: 'Host', value: '' },
        { ref: 'e2', role: 'textbox' as const, name: 'Port', value: '' },
        { ref: 'e3', role: 'checkbox' as const, name: 'TLS', checked: false },
      ],
    };
    return {
      ...base,
      snapshot: async (): Promise<PageSnapshot> => ({
        url: 'http://localhost:3000/settings',
        title: 'Settings',
        version: 1,
        tree,
        stats: { interactive: 3, emitted: 4, elided: 0, captureMs: 1 },
      }),
    };
  }

  it('threads onStep into the program, so a host sees field-by-field progress', async () => {
    const seen: Array<{ step: string; index: number; total: number }> = [];
    // Before the fix there was nowhere to put this callback: `fillForm` took no
    // options at all, so a twelve-field form was one opaque call from outside.
    const executor = new DefaultExecutor();

    const result = await executor.fillForm(
      formSession(),
      { fields: { Host: 'smtp.example.com', Port: '587', TLS: true } },
      {
        onStep: (r: StepResult, index: number, total: number) => {
          seen.push({ step: r.step, index, total });
        },
        settle: false,
      },
    );

    expect(result.fields.map((f) => f.key)).toEqual(['Host', 'Port', 'TLS']);
    expect(seen).toHaveLength(3);
    expect(seen.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(seen.every((s) => s.total === 3)).toBe(true);
  });

  it('keeps its own failure policy even when the caller passes another', async () => {
    const seen: string[] = [];
    const executor = new DefaultExecutor();
    // 'stop' would abandon the remaining fields and destroy the per-field
    // report the tool result is built from; fillForm's policy has to win.
    const result = await executor.fillForm(
      formSession(),
      { fields: { Host: 'a', Port: 'b', TLS: true } },
      { onFailure: 'stop', onStep: (r) => seen.push(r.step), settle: false },
    );
    expect(seen).toHaveLength(3);
    expect(result.fields).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 2 — the endpoint table across a session's first navigation (real Chromium)
// ---------------------------------------------------------------------------

/**
 * The document fires its three XHRs from `<head>`, before the body arrives.
 *
 * `goto` returns at `commit` — as soon as the response headers land — and then
 * does two CDP round trips before it is done. Flushing the head first and the
 * body 250ms later puts those three responses *inside* that window every time,
 * which is exactly where the race used to eat them: the reset for the
 * about:blank -> app origin change fired after the new page had recorded.
 */
function head(calls: string[]): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Loader</title>
<script>
${calls.map((c) => `  fetch('${c}');`).join('\n')}
</script>
</head><body>`;
}
const TAIL = `<main><h1>Loader</h1><p id="out">ready</p></main></body></html>`;

let httpServer: Server | undefined;
let baseUrl = '';
let otherOrigin = '';
let otherServer: Server | undefined;
let home = '';
let workspace = '';
let pool: DefaultBrowserPool | undefined;

beforeAll(async () => {
  httpServer = createHttpServer((req, res) => {
    if (req.url?.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // The second page calls a *different* endpoint, so "kept" and "recorded
    // again" are distinguishable in the table.
    res.write(head(req.url === '/second' ? ['/api/four'] : ['/api/one', '/api/two', '/api/three']));
    // Hold the document open so `commit` happens well before `load`.
    setTimeout(() => res.end(TAIL), 250);
  });
  await new Promise<void>((r) => httpServer!.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;

  otherServer = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Other app</title><p>other</p>');
  });
  await new Promise<void>((r) => otherServer!.listen(0, '127.0.0.1', r));
  otherOrigin = `http://127.0.0.1:${(otherServer.address() as AddressInfo).port}/`;

  home = await realpath(await mkdtemp(join(tmpdir(), 'fba-endpoints-home-')));
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'fba-endpoints-ws-')));
  pool = new DefaultBrowserPool({
    config: {
      ...defaultConfig(),
      home,
      workspace,
      headless: true,
      idleTimeoutMs: 10 * 60_000,
      logLevel: 'silent',
    },
  });
});

afterAll(async () => {
  await pool?.shutdown();
  await new Promise<void>((r) => (httpServer ? httpServer.close(() => r()) : r()));
  await new Promise<void>((r) => (otherServer ? otherServer.close(() => r()) : r()));
  for (const dir of [home, workspace]) if (dir) await rm(dir, { recursive: true, force: true });
});

/** Endpoint patterns as bare paths, sorted, so an ephemeral port cannot leak in. */
function pathsOf(session: PageSession): string[] {
  return session
    .endpoints()
    .map((e) => new URL(e.pattern, baseUrl).pathname)
    .sort();
}

async function settled(session: PageSession): Promise<void> {
  await session.settle({ networkQuietMs: 400, domQuietMs: 300, timeoutMs: 8_000 });
}

describe('network observation is configurable from FbaConfig', () => {
  it('reaches the observer, so a smaller table really is smaller', async () => {
    const capped = await realpath(await mkdtemp(join(tmpdir(), 'fba-capped-ws-')));
    const cappedPool = new DefaultBrowserPool({
      config: {
        ...defaultConfig(),
        home,
        workspace: capped,
        headless: true,
        idleTimeoutMs: 10 * 60_000,
        logLevel: 'silent',
        // Previously unreachable: `PageSession` passed the observer only
        // `captureRequests`, so an embedder wanting either of these had to
        // build their own `NetworkObserver` and bypass the session that owns it.
        network: { maxEndpoints: 2, captureBodies: false },
      },
    });
    try {
      const session = (await cappedPool.acquire({ workspace: capped, fresh: true })) as PageSession;
      await session.goto(baseUrl);
      await settled(session);

      const endpoints = session.endpoints();
      // Three XHRs fire; the table keeps two.
      expect(endpoints).toHaveLength(2);
      // captureBodies:false means no response body is ever read.
      expect(endpoints.every((e) => e.responseShape === undefined)).toBe(true);
    } finally {
      await cappedPool.shutdown();
      await rm(capped, { recursive: true, force: true });
    }
  }, 60_000);

  it('reads the sizing knobs from the environment', () => {
    const before = { ...process.env };
    try {
      process.env.FBA_MAX_ENDPOINTS = '5';
      process.env.FBA_CAPTURE_BODIES = 'false';
      process.env.FBA_MAX_BODY_BYTES = '1024';
      process.env.FBA_MAX_REQUEST_BODY_BYTES = '512';
      expect(loadConfig({ workspace: home }).network).toEqual({
        maxEndpoints: 5,
        captureBodies: false,
        maxBodyBytes: 1024,
        maxRequestBodyBytes: 512,
      });
    } finally {
      for (const key of [
        'FBA_MAX_ENDPOINTS',
        'FBA_CAPTURE_BODIES',
        'FBA_MAX_BODY_BYTES',
        'FBA_MAX_REQUEST_BODY_BYTES',
      ]) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
    }
  });

  it('leaves the knobs unset by default, so the observer owns its own defaults', () => {
    expect(defaultConfig().network).toEqual({});
  });
});

describe('the endpoint table survives the navigation that filled it', () => {
  it('records every load-time XHR on a fresh session, run after run', async () => {
    const counts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const session = (await pool!.acquire({ workspace, fresh: true })) as PageSession;
      try {
        // about:blank -> the app: an origin change, and therefore the reset
        // that used to wipe what this very page had already recorded.
        await session.goto(baseUrl);
        await settled(session);
        counts.push(session.endpoints().length);
      } finally {
        await session.close();
      }
    }
    // The defect showed up as a varying count (1, 2 or 3), so assert on all of
    // them together: a single run passing proves nothing.
    expect(counts).toEqual([3, 3, 3, 3]);
  }, 60_000);

  it('keeps what it learned across a same-origin navigation', async () => {
    const session = (await pool!.acquire({ workspace, fresh: true })) as PageSession;
    try {
      await session.goto(baseUrl);
      await settled(session);
      expect(pathsOf(session)).toEqual(['/api/one', '/api/three', '/api/two']);

      await session.goto(`${baseUrl}second`);
      await settled(session);
      // Within one origin the table is the session's accumulated knowledge of
      // the app's API — the second page adds to it rather than replacing it.
      expect(pathsOf(session)).toEqual(['/api/four', '/api/one', '/api/three', '/api/two']);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('still drops the table when the origin really changes', async () => {
    const session = (await pool!.acquire({ workspace, fresh: true })) as PageSession;
    try {
      await session.goto(baseUrl);
      await settled(session);
      expect(session.endpoints()).toHaveLength(3);

      await session.goto(otherOrigin);
      await settled(session);
      // A different app's API table is worse than none: it would send the agent
      // to endpoints this origin does not serve.
      expect(session.endpoints()).toHaveLength(0);
    } finally {
      await session.close();
    }
  }, 60_000);
});
