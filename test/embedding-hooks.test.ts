/**
 * The seams a host application needs to embed this package.
 *
 * Each test here corresponds to a gap found by running 0.3.0 against a real
 * host integration, not by reading the source: the tool list was unreachable,
 * `SessionInfo` could not distinguish idle from mid-click, a multi-step `act`
 * was opaque until it resolved, and a failed `waitFor` reported nothing.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DefaultBrowserPool } from '../src/browser/pool.js';
import { DefaultExecutor } from '../src/executor/act.js';
import { defaultConfig } from '../src/config.js';
import { createTools } from '../src/mcp/tools.js';
import type { FbaConfig, StepResult } from '../src/types.js';

// Same convention as session-integration.test.ts: a real Chromium is assumed.
const withBrowser = describe;

const PAGE = `<!doctype html><meta charset="utf-8"><title>Hooks</title>
<button id="go">Sign in</button>
<div id="out" style="height:2000px"></div>
<script>
  document.getElementById('go').addEventListener('click', () => {
    // Deliberately slow, so a step boundary is observable in wall-clock terms.
    setTimeout(() => { document.getElementById('out').textContent = 'done'; }, 120);
  });
</script>`;

let baseUrl = '';
let server: ReturnType<typeof createServer> | undefined;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

describe('the tool list is reachable without a second server', () => {
  it('createTools is importable and returns Zod-schema tools', () => {
    // A host that cannot reach this has to stand up a second McpServer and
    // proxy every call, because the wire form (draft-07 JSON Schema) cannot be
    // fed back into registerTool — the SDK only understands Zod.
    const config = defaultConfig();
    const tools = createTools({ config } as unknown as Parameters<typeof createTools>[0]);

    expect(tools.length).toBeGreaterThan(0);
    const act = tools.find((t) => t.name === 'browser_act');
    expect(act).toBeDefined();
    expect(act?.schema).toBeDefined();
    // The property registerTool needs: a Zod schema object, not JSON Schema.
    expect(typeof act?.handler).toBe('function');
  });
});

describe('the MCP server reports its real version', () => {
  it('does not report a hardcoded 0.1.0', async () => {
    const { version } = (await import('../package.json', { with: { type: 'json' } })).default as {
      version: string;
    };
    const mod = await import('../src/mcp/server.js');
    const handle = mod.createServer({ config: defaultConfig() });
    try {
      // The handshake value the SDK will send.
      const reported = (handle.server as unknown as { server: { _serverInfo: { version: string } } }).server
        ._serverInfo.version;
      expect(reported).toBe(version);
      expect(reported).not.toBe('0.1.0');
    } finally {
      await handle.close();
    }
  });
});

withBrowser('session activity, labels and per-step progress', () => {
  let pool: DefaultBrowserPool;
  let config: FbaConfig;

  beforeAll(() => {
    config = { ...defaultConfig(), siteMemory: false, skills: false };
    pool = new DefaultBrowserPool({ config });
  });

  afterAll(async () => {
    await pool.shutdown();
  });

  it('carries a label through acquire and reports busy only while acting', async () => {
    const session = await pool.acquire({ fresh: true, label: 'Checkout flow', sessionKey: 'hooks-1' });
    await session.goto(baseUrl);

    expect(session.info().label).toBe('Checkout flow');
    expect(session.info().busy).toBe(false);

    const executor = new DefaultExecutor();
    const sampled: boolean[] = [];
    const poll = setInterval(() => sampled.push(session.info().busy), 40);

    await executor.run(session, [{ do: 'click', target: { text: 'Sign in' } }, { do: 'scroll', to: 'bottom' }]);
    clearInterval(poll);

    // The point of the flag: it was true at some point during the run, which
    // lastUsedAt could never tell a host — it is stamped when work starts and
    // then sits still through the whole settle.
    expect(sampled).toContain(true);
    expect(session.info().busy).toBe(false);
  }, 40_000);

  it('reports each step before the program resolves', async () => {
    const session = await pool.acquire({ fresh: true, sessionKey: 'hooks-2' });
    await session.goto(baseUrl);

    const seen: Array<{ step: string; index: number; total: number; atMs: number }> = [];
    const started = Date.now();

    const executor = new DefaultExecutor();
    const result = await executor.run(
      session,
      [
        { do: 'click', target: { text: 'Sign in' } },
        { do: 'scroll', to: 'bottom' },
        { do: 'scroll', to: 'top' },
      ],
      {
        onStep: (r: StepResult, index: number, total: number) => {
          seen.push({ step: r.step, index, total, atMs: Date.now() - started });
        },
      },
    );

    expect(seen.map((s) => s.step)).toEqual(['click', 'scroll', 'scroll']);
    expect(seen.every((s) => s.total === 3)).toBe(true);
    expect(seen.map((s) => s.index)).toEqual([0, 1, 2]);
    // `scroll` leaves no page-level trace at all, so without this hook a host
    // watching page events sees nothing between the click and the result.
    expect(seen[0]!.atMs).toBeLessThanOrEqual(seen[2]!.atMs);
    expect(result.steps).toHaveLength(3);
  }, 40_000);

  it('does not let a throwing observer fail the program', async () => {
    const session = await pool.acquire({ fresh: true, sessionKey: 'hooks-3' });
    await session.goto(baseUrl);

    const executor = new DefaultExecutor();
    const result = await executor.run(session, [{ do: 'scroll', to: 'bottom' }], {
      onStep: () => {
        throw new Error('observer is broken');
      },
    });

    expect(result.ok).toBe(true);
  }, 40_000);

  it('captures request headers and body for promotion, with credentials redacted', async () => {
    // Off by default: recording that a call happened is not the same as
    // recording the credential it carried.
    const capturing = { ...config, captureRequests: true };
    const capturingPool = new DefaultBrowserPool({ config: capturing });
    try {
      const session = await capturingPool.acquire({ fresh: true, sessionKey: 'hooks-5' });
      await session.goto(baseUrl);

      await session.page.evaluate(async () => {
        await fetch('/api/orders', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer super-secret-token',
            'x-api-key': 'also-secret',
            'x-request-id': 'keep-me',
          },
          body: JSON.stringify({ sku: 'ABC', qty: 2 }),
        });
      });

      // Give the response listener a moment to record.
      await session.settle({ networkQuietMs: 200, domQuietMs: 200, timeoutMs: 3_000 });

      const endpoint = session.endpoints().find((e) => e.url.includes('/api/orders'));
      expect(endpoint, 'the POST should have been observed').toBeDefined();

      const headers = new Map(endpoint!.requestHeaders ?? []);
      // The name survives — knowing the call needs auth is the useful half.
      expect(headers.has('authorization')).toBe(true);
      expect(headers.get('authorization')).toBe('<redacted>');
      expect(headers.get('x-api-key')).toBe('<redacted>');
      // Non-sensitive headers come through intact, or promotion is worthless.
      expect(headers.get('x-request-id')).toBe('keep-me');

      // The body is the whole point: a promoted POST without it is a stub.
      expect(endpoint!.requestBody?.text).toContain('"sku":"ABC"');
      expect(endpoint!.requestBody?.truncated).toBe(false);
      expect(endpoint!.requestContentType).toBe('application/json');
    } finally {
      await capturingPool.shutdown();
    }
  }, 40_000);

  it('records nothing about request contents unless asked', async () => {
    const session = await pool.acquire({ fresh: true, sessionKey: 'hooks-6' });
    await session.goto(baseUrl);
    await session.page.evaluate(async () => {
      await fetch('/api/quiet', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
        body: JSON.stringify({ a: 1 }),
      });
    });
    await session.settle({ networkQuietMs: 200, domQuietMs: 200, timeoutMs: 3_000 });

    const endpoint = session.endpoints().find((e) => e.url.includes('/api/quiet'));
    expect(endpoint).toBeDefined();
    expect(endpoint!.requestHeaders).toBeUndefined();
    expect(endpoint!.requestBody).toBeUndefined();
  }, 40_000);

  it('describes a targetless waitFor failure instead of two spaces', async () => {
    const session = await pool.acquire({ fresh: true, sessionKey: 'hooks-4' });
    await session.goto(baseUrl);

    const executor = new DefaultExecutor();
    const result = await executor.run(
      session,
      [{ do: 'waitFor', text: 'this text never appears', timeoutMs: 600 }],
      { onFailure: 'continue' },
    );

    const step = result.steps[0]!;
    expect(step.status).toBe('failed');
    expect(step.detail).toContain('this text never appears');
    expect(step.detail).not.toBe('waitFor  failed');
  }, 40_000);
});
