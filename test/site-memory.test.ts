/**
 * Site memory — the learning layer that works without source code.
 *
 * These tests pin the properties that make it worth having: it generalises
 * volatile URLs, it remembers *where* a control lives rather than just that it
 * exists, it converges rather than clobbers when two agents write at once, and
 * its adaptive settle budget only kicks in once there is real evidence.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultConfig } from '../src/config.js';
import { digestSnapshot, pagePattern, urlForPattern } from '../src/site/digest.js';
import { FsSiteMemoryStore, originSlug } from '../src/site/memory.js';
import type { FbaConfig, PageSnapshot, SnapNode } from '../src/types.js';

let home: string;
let config: FbaConfig;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fba-site-'));
  config = { ...defaultConfig(), home, siteMemory: true };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function snapshot(url: string, tree: SnapNode, tabPath?: string[]): PageSnapshot {
  return {
    url,
    title: 'Acme Admin',
    version: 1,
    tree,
    ...(tabPath ? { tabPath } : {}),
    stats: { interactive: 4, emitted: 4, elided: 0, captureMs: 3 },
  };
}

const settingsTree: SnapNode = {
  role: 'main',
  children: [
    {
      role: 'tabpanel',
      name: 'Network',
      children: [
        {
          role: 'tabpanel',
          name: 'SMTP',
          children: [
            { role: 'textbox', name: 'SMTP host', ref: 'e1', meta: { testId: 'smtp-host' } },
            { role: 'spinbutton', name: 'SMTP port', ref: 'e2' },
          ],
        },
      ],
    },
    { role: 'button', name: 'Save', ref: 'e3' },
  ],
};

describe('pagePattern', () => {
  it('generalises volatile segments so repeat visits collapse onto one page', () => {
    expect(pagePattern('http://x/users/17/edit')).toBe('/users/:id/edit');
    expect(pagePattern('http://x/o/3f2a1b4c-1111-2222-3333-444455556666')).toBe('/o/:uuid');
    expect(pagePattern('http://x/reports/2026-01-05')).toBe('/reports/:date');
    expect(pagePattern('http://x/')).toBe('/');
  });

  it('leaves real route words alone', () => {
    expect(pagePattern('http://x/settings/advanced')).toBe('/settings/advanced');
  });

  it('does not hand back a url that still contains a parameter', () => {
    // A link with a literal ":id" in it is broken, not a shortcut.
    expect(urlForPattern('http://x', '/users/:id')).toBeUndefined();
    expect(urlForPattern('http://x', '/settings')).toBe('http://x/settings');
  });
});

describe('digestSnapshot', () => {
  it('tags each control with the tab path it actually lives under', () => {
    const { controls } = digestSnapshot(snapshot('http://x/settings', settingsTree), 1);
    const host = controls.find((c) => c.name === 'SMTP host');
    expect(host?.tabPath).toEqual(['Network', 'SMTP']);
    expect(host?.testId).toBe('smtp-host');

    // A control outside any panel carries no path — it needs no tab switch.
    const save = controls.find((c) => c.name === 'Save');
    expect(save?.tabPath).toBeUndefined();
  });

  it('does not remember tabs as destinations', () => {
    const tree: SnapNode = {
      role: 'main',
      children: [
        { role: 'tab', name: 'Network', ref: 'e1' },
        { role: 'button', name: 'Network', ref: 'e2' },
      ],
    };
    const { controls } = digestSnapshot(snapshot('http://x/', tree), 1);
    expect(controls.map((c) => c.role)).toEqual(['button']);
  });
});

describe('FsSiteMemoryStore', () => {
  it('remembers where a control lives and can answer without a browser', async () => {
    const store = new FsSiteMemoryStore(config);
    store.recordSnapshot(snapshot('http://acme.test/settings', settingsTree, ['Network', 'SMTP']));
    await store.flush();

    const hits = await store.search('http://acme.test', 'smtp port');
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0]!;
    expect(top.name).toBe('SMTP port');
    expect(top.page).toBe('/settings');
    expect(top.tabPath).toEqual(['Network', 'SMTP']);
    expect(top.url).toBe('http://acme.test/settings');
  });

  it('counts repeat sightings instead of duplicating them', async () => {
    const store = new FsSiteMemoryStore(config);
    for (let i = 0; i < 3; i++) store.recordSnapshot(snapshot('http://acme.test/settings', settingsTree));
    await store.flush();

    const memory = await store.get('http://acme.test');
    expect(memory?.pages).toHaveLength(1);
    expect(memory?.pages[0]?.visits).toBe(3);
    const host = memory?.controls.find((c) => c.name === 'SMTP host');
    expect(host?.seen).toBe(3);
  });

  it('records navigation edges but ignores clicks that stay put', async () => {
    const store = new FsSiteMemoryStore(config);
    store.recordTransition('http://acme.test/', 'Settings', 'http://acme.test/settings');
    store.recordTransition('http://acme.test/', 'Settings', 'http://acme.test/settings');
    store.recordTransition('http://acme.test/settings', 'Save', 'http://acme.test/settings');
    await store.flush();

    const memory = await store.get('http://acme.test');
    expect(memory?.transitions).toHaveLength(1);
    expect(memory?.transitions[0]).toMatchObject({ from: '/', via: 'Settings', to: '/settings', count: 2 });
  });

  it('ignores transitions that cross an origin', async () => {
    const store = new FsSiteMemoryStore(config);
    store.recordTransition('http://other.test/', 'Login', 'http://acme.test/dashboard');
    await store.flush();
    const memory = await store.get('http://acme.test');
    expect(memory?.transitions ?? []).toHaveLength(0);
  });

  it('withholds an adaptive settle budget until it has evidence', async () => {
    const store = new FsSiteMemoryStore(config);
    // Guessing from one or two samples would either waste time or report a
    // half-rendered page, so below the threshold there must be no opinion.
    store.recordSettle('http://acme.test/', 100, 'interaction');
    store.recordSettle('http://acme.test/', 110, 'interaction');
    expect(store.settleBudget('http://acme.test', 'interaction')).toBeUndefined();

    for (let i = 0; i < 8; i++) store.recordSettle('http://acme.test/', 100, 'interaction');
    const budget = store.settleBudget('http://acme.test', 'interaction')!;
    expect(budget).toBeDefined();
    // A consistently fast site must end up with tighter windows than the
    // generic 300/200 default — this is the "gets faster with use" mechanism.
    expect(budget.domQuietMs!).toBeLessThan(200);
    expect(budget.networkQuietMs!).toBeLessThan(300);
  });

  it('keeps navigation and interaction budgets apart', async () => {
    const store = new FsSiteMemoryStore(config);
    // A page load that takes 900ms must not make tab clicks wait 900ms, and a
    // 60ms tab click must not make page loads give up early.
    for (let i = 0; i < 8; i++) store.recordSettle('http://acme.test/', 900, 'navigation');
    for (let i = 0; i < 8; i++) store.recordSettle('http://acme.test/', 60, 'interaction');

    const nav = store.settleBudget('http://acme.test', 'navigation')!;
    const act = store.settleBudget('http://acme.test', 'interaction')!;
    expect(nav.domQuietMs!).toBeGreaterThan(act.domQuietMs!);
    expect(nav.timeoutMs!).toBeGreaterThan(act.timeoutMs!);
  });

  it('does not record anything when the feature is switched off', async () => {
    const store = new FsSiteMemoryStore({ ...config, siteMemory: false });
    store.recordSnapshot(snapshot('http://acme.test/settings', settingsTree));
    await store.flush();
    expect(await store.get('http://acme.test')).toBeUndefined();
  });

  it('ignores non-http origins', async () => {
    const store = new FsSiteMemoryStore(config);
    store.recordSnapshot(snapshot('about:blank', settingsTree));
    store.recordSnapshot(snapshot('data:text/html,<p>x', settingsTree));
    await store.flush();
    expect(await store.list()).toHaveLength(0);
  });

  it('merges with a concurrent writer instead of clobbering it', async () => {
    // Two agent processes, same origin, different discoveries.
    const a = new FsSiteMemoryStore(config);
    const b = new FsSiteMemoryStore(config);

    a.recordSnapshot(snapshot('http://acme.test/settings', settingsTree));
    await a.flush();

    b.recordSnapshot(
      snapshot('http://acme.test/billing', {
        role: 'main',
        children: [{ role: 'textbox', name: 'Card number', ref: 'e9' }],
      }),
    );
    await b.flush();

    const merged = await new FsSiteMemoryStore(config).get('http://acme.test');
    const patterns = merged?.pages.map((p) => p.pattern).sort();
    expect(patterns).toEqual(['/billing', '/settings']);
    expect(merged?.controls.some((c) => c.name === 'Card number')).toBe(true);
    expect(merged?.controls.some((c) => c.name === 'SMTP host')).toBe(true);
  });

  it('survives a corrupt memory file rather than failing the session', async () => {
    const store = new FsSiteMemoryStore(config);
    store.recordSnapshot(snapshot('http://acme.test/settings', settingsTree));
    await store.flush();

    writeFileSync(join(home, 'sites', `${originSlug('http://acme.test')}.json`), '{not json', 'utf8');

    const fresh = new FsSiteMemoryStore(config);
    expect(await fresh.get('http://acme.test')).toBeUndefined();
    fresh.recordSnapshot(snapshot('http://acme.test/settings', settingsTree));
    await fresh.flush();
    expect((await fresh.get('http://acme.test'))?.pages).toHaveLength(1);
  });

  it('forgets an origin on request', async () => {
    const store = new FsSiteMemoryStore(config);
    store.recordSnapshot(snapshot('http://acme.test/settings', settingsTree));
    await store.flush();
    expect(await store.forget('http://acme.test')).toBe(true);
    expect(await store.get('http://acme.test')).toBeUndefined();
  });

  it('keeps distinct origins apart, including http vs https', () => {
    expect(originSlug('http://acme.test')).not.toBe(originSlug('https://acme.test'));
  });
});
