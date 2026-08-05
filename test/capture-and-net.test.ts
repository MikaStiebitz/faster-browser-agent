/**
 * Browser-backed coverage for the visual escape hatch and runtime network
 * control — the two feature groups that extend the driver beyond text
 * perception without touching its hot path.
 *
 * What must stay true:
 *   - a screenshot is small by default (jpeg, viewport) and tiny when clipped
 *     to an element — the cost story in the tool description has to be honest
 *   - a canvas-heavy page announces itself in the snapshot notes, because that
 *     note is the only trigger that makes screenshot use "smart"
 *   - a mock intercepts the page's own fetch and a block kills it, while
 *     documents are never touched by either
 */

import { createServer, type Server } from 'node:http';

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { capture } from '../src/browser/capture.js';
import { resolveExecutablePath } from '../src/browser/launcher.js';
import { defaultConfig } from '../src/config.js';
import { NetControl } from '../src/net/control.js';
import { PAGE_RUNTIME_SOURCE } from '../src/runtime/index.js';

const HTML = `<!doctype html><title>capture fixture</title>
<body style="margin:0">
  <button id="load" onclick="fetch('/api/data').then(r=>r.json()).then(d=>{document.getElementById('out').textContent=d.msg}).catch(()=>{document.getElementById('out').textContent='FETCH FAILED'})">Load</button>
  <p id="out"></p>
</body>`;

const CANVAS_HTML = `<!doctype html><title>canvas fixture</title>
<body style="margin:0"><canvas width="1440" height="900" style="width:100vw;height:100vh"></canvas></body>`;

let server: Server;
let origin: string;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/canvas') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(CANVAS_HTML);
    } else if (req.url === '/api/data') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"msg":"from server"}');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;

  const executablePath = resolveExecutablePath(defaultConfig());
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe('capture', () => {
  it('produces a small jpeg viewport shot by default', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const shot = await capture(page);
    expect(shot.mimeType).toBe('image/jpeg');
    expect(shot.clipped).toBe('viewport');
    expect(shot.width).toBe(800);
    // A mostly-white 800x600 UI shot must stay well under 100KB, or the cost
    // claim in the tool description is a lie.
    expect(shot.bytes).toBeLessThan(100_000);
    // Sanity: real jpeg magic bytes.
    expect(Buffer.from(shot.data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('element clips are a fraction of a viewport shot', async () => {
    const full = await capture(page);
    const clipped = await capture(page, { locator: page.locator('#load') });
    expect(clipped.clipped).toBe('element');
    expect(clipped.bytes).toBeLessThan(full.bytes / 2);
  });

  it('flags canvas-heavy pages in the snapshot so screenshots trigger smartly', async () => {
    await page.goto(`${origin}/canvas`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(PAGE_RUNTIME_SOURCE);
    const snapshot = await page.evaluate(() => window.__fba!.snapshot());
    expect((snapshot.notes ?? []).join(' ')).toContain('canvas-heavy');
  });
});

describe('NetControl', () => {
  it('mocks the page-issued fetch and blocks it after unmock+block', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const control = new NetControl(page);

    await control.mock({ pattern: '/api/data', body: { msg: 'MOCKED' } });
    await page.click('#load');
    await page.waitForFunction(() => document.getElementById('out')?.textContent !== '');
    expect(await page.textContent('#out')).toBe('MOCKED');

    control.unmock();
    await control.block('/api/data');
    await page.click('#load');
    await page.waitForFunction(() => document.getElementById('out')?.textContent === 'FETCH FAILED');

    // The document itself must never be blocked, whatever the rules say.
    await control.block(origin);
    const response = await page.goto(origin, { waitUntil: 'domcontentloaded' });
    expect(response?.ok()).toBe(true);

    await control.clear();
  });

  it('reports its own state compactly', async () => {
    const control = new NetControl(page);
    await control.mock({ pattern: '/api/x', status: 503, body: { error: 'down' } });
    await control.block('*.png');
    const description = control.describe().join('\n');
    expect(description).toContain('mock  ANY /api/x -> 503');
    expect(description).toContain('block *.png');
    await control.clear();
    expect(control.describe().join('')).toContain('no active rules');
  });
});
