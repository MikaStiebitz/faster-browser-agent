/**
 * Settle behaviour on polling apps.
 *
 * Regression guard for the single worst latency bug this project has had: the
 * original rule required BOTH dom quiet AND network quiet, which any app with a
 * refetch interval, a session heartbeat or an HMR channel never satisfies. A
 * real Next.js console measured 3.3s per settle — 96% of wall-clock — where the
 * page was visibly done in ~150ms.
 *
 * The rule is now: dom quiet is necessary, network quiet is sufficient but not
 * necessary. These tests pin both halves of that, including the part that makes
 * it *safe* — a request that actually changes the page still holds the settle,
 * because landing it mutates the DOM and resets the clock.
 */

import { createServer, type Server } from 'node:http';

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveExecutablePath } from '../src/browser/launcher.js';
import { defaultConfig } from '../src/config.js';
import { PAGE_RUNTIME_SOURCE } from '../src/runtime/index.js';
import type { SettleResult } from '../src/types.js';

/** Polls every 120ms forever and never touches the DOM — i.e. React Query idle. */
const POLLING_HTML = `<!doctype html><title>polling app</title>
<body><h1>Dashboard</h1><button id="go">Go</button><p id="out">idle</p>
<script>
  setInterval(() => { fetch('/api/ping').catch(() => {}); }, 120);
  document.getElementById('go').addEventListener('click', () => {
    // A real interaction: fetch, then mutate. The settle must wait for THIS.
    fetch('/api/slow').then(r => r.text()).then(t => { document.getElementById('out').textContent = t; });
  });
</script></body>`;

let server: Server;
let origin: string;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } else if (req.url === '/api/slow') {
      // Long enough that a premature settle would be caught by the assertion.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('loaded');
      }, 400);
    } else if (req.url === '/static') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>static</title><body><p>static</p></body>');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(POLLING_HTML);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;

  const executablePath = resolveExecutablePath(defaultConfig());
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  page = await browser.newPage();
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.evaluate(PAGE_RUNTIME_SOURCE);
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

const settle = (options: Record<string, number>): Promise<SettleResult> =>
  page.evaluate((o) => window.__fba!.waitSettled(o), options);

describe('settle on a polling app', () => {
  it('settles on DOM stability instead of burning the whole timeout', async () => {
    const started = Date.now();
    const result = await settle({ networkQuietMs: 300, domQuietMs: 200, timeoutMs: 5_000 });
    const elapsed = Date.now() - started;

    expect(result.settled).toBe(true);
    // Network quiet is unreachable here — a 120ms poll interval never leaves a
    // 300ms gap — so this must be the dom-stable path.
    expect(result.reason).toBe('dom-stable');
    // The old behaviour was the full 5s timeout. Anything near that is a
    // regression; the confidence window is 500ms plus scheduling slack.
    expect(elapsed).toBeLessThan(1_500);
  });

  it('still waits for a request that actually changes the page', async () => {
    await page.evaluate(() => {
      document.getElementById('out')!.textContent = 'idle';
    });
    await page.click('#go');

    const result = await settle({ networkQuietMs: 300, domQuietMs: 200, timeoutMs: 5_000 });
    expect(result.settled).toBe(true);
    // This is the safety property: the /api/slow response mutates the DOM when
    // it lands, resetting the quiet clock, so settle cannot have returned
    // before the text changed.
    expect(await page.textContent('#out')).toBe('loaded');
  });

  it('reports plain quiet when nothing is polling', async () => {
    const quiet = await browser.newPage();
    try {
      await quiet.goto(`${origin}/static`, { waitUntil: 'domcontentloaded' });
      await quiet.evaluate(PAGE_RUNTIME_SOURCE);
      const result = await quiet.evaluate(() =>
        window.__fba!.waitSettled({ networkQuietMs: 300, domQuietMs: 200, timeoutMs: 5_000 }),
      );
      expect(result.settled).toBe(true);
      expect(result.reason).toBe('quiet');
    } finally {
      await quiet.close();
    }
  });

  it('does not let the escape hatch outrun a short network budget', async () => {
    // With a tiny timeout the dom-stable window is clamped so it can never be
    // the slower option — the guard that keeps the heuristic from making a
    // fast page slower.
    const started = Date.now();
    const result = await settle({ networkQuietMs: 300, domQuietMs: 200, timeoutMs: 1_000 });
    expect(result.settled).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
