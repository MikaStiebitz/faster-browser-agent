/**
 * Regression tests for two `find()` properties that directly cost round trips
 * when they regress:
 *
 *  1. A container and its own toggle (a `<details>`/`<summary>` accordion, a
 *     `<label>` wrapping its input) share an accessible name. Reporting them as
 *     two competing candidates makes the resolver raise TARGET_AMBIGUOUS for
 *     what is really one element, forcing the caller to disambiguate an element
 *     from itself.
 *
 *  2. Candidates carry the tab path *they* live under, not the page's currently
 *     open one. A control behind an unopened tab that claims to be reachable
 *     buys a failed interaction plus a recovery round trip.
 */

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveExecutablePath } from '../src/browser/launcher.js';
import { defaultConfig } from '../src/config.js';
import { PAGE_RUNTIME_SOURCE } from '../src/runtime/index.js';
import type { FindCandidate, FindQuery } from '../src/contracts.js';

const fixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'config-app.html'),
  'utf8',
);

let server: Server;
let browser: Browser;
let page: Page;
let origin: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fixture);
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

const find = (query: FindQuery): Promise<FindCandidate[]> =>
  page.evaluate((q) => window.__fba!.find(q), query);

describe('runtime find()', () => {
  it('does not report a container and its own toggle as competing candidates', async () => {
    // <details><summary>Experimental features</summary> — both carry the name.
    const candidates = await find({ name: 'Experimental features' });
    expect(candidates.length).toBeGreaterThan(0);

    const top = candidates[0]!;
    const contenders = candidates.filter((c) => top.score - c.score < 0.05);
    expect(
      contenders.length,
      `expected one clear winner, got: ${contenders.map((c) => `${c.role} "${c.name}"`).join(', ')}`,
    ).toBe(1);

    // The survivor must be the actionable toggle, not the wrapping container.
    expect(top.role).not.toBe('group');
  });

  it('reports the tab path a candidate actually lives under', async () => {
    const [smtpPort] = await find({ name: 'SMTP port' });
    expect(smtpPort).toBeDefined();
    // The page opens on General; this field is two tab levels away.
    expect(smtpPort!.tabPath).toEqual(['Network', 'SMTP']);
  });

  it('omits the tab path for controls that are not inside any tab panel', async () => {
    const [help] = await find({ name: 'Help' });
    expect(help).toBeDefined();
    expect(help!.tabPath).toBeUndefined();
  });

  it('distinguishes sibling panels rather than lumping them together', async () => {
    const [rateLimit] = await find({ name: 'Rate limit' });
    expect(rateLimit).toBeDefined();
    expect(rateLimit!.tabPath).toEqual(['Network', 'Limits']);
  });

  it('still returns genuinely distinct same-name elements', async () => {
    // 40 rows each carry a "Revoke" button — that IS real ambiguity and must
    // survive the containment filter, otherwise the resolver would silently
    // pick a row.
    const candidates = await find({ name: 'Revoke', limit: 10 });
    expect(candidates.length).toBeGreaterThan(3);
  });
});
