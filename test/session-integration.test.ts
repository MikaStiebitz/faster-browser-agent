/**
 * End-to-end coverage of the integration layer against a REAL Chromium.
 *
 * Everything below the MCP surface is exercised together — profile directory,
 * persistent context, request blocking, runtime injection, snapshotting,
 * diffing and settling — because that is where the interesting failures live:
 * each piece passes its own unit tests and still breaks when the runtime is
 * injected a millisecond too late.
 */

import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DefaultBrowserPool } from '../src/browser/pool.js';
import { workspaceIdFor } from '../src/browser/profile.js';
import type { PageSession } from '../src/browser/session.js';
import { defaultConfig } from '../src/config.js';
import { RUNTIME_VERSION } from '../src/runtime/index.js';
import type { FbaConfig, SnapNode } from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixture page
// ---------------------------------------------------------------------------

/**
 * Deliberately sizeable and heterogeneous.
 *
 * Sizeable because the diff/full decision is a cost comparison: on a
 * five-element page a full tree really is cheaper than a diff, so a small
 * fixture would test the wrong branch. Heterogeneous because the page runtime
 * compresses runs of structurally identical siblings into one line — forty
 * identical text inputs collapse to three lines plus "+37 similar", which is
 * correct behaviour but would leave nothing to diff.
 */
function fixtureHtml(): string {
  const kinds = ['text', 'checkbox', 'select', 'number', 'textarea', 'email'] as const;
  const rows: string[] = [];
  for (let i = 0; i < 36; i++) {
    const kind = kinds[i % kinds.length];
    const id = `field-${i}`;
    const label = `<label for="${id}">Setting number ${i}</label>`;
    let control: string;
    if (kind === 'select') {
      control = `<select id="${id}" name="${id}"><option>alpha</option><option>beta ${i}</option></select>`;
    } else if (kind === 'textarea') {
      control = `<textarea id="${id}" name="${id}">note ${i}</textarea>`;
    } else if (kind === 'checkbox') {
      control = `<input type="checkbox" id="${id}" name="${id}">`;
    } else if (kind === 'email') {
      control = `<input type="email" id="${id}" name="${id}" value="user${i}@example.com">`;
    } else {
      control = `<input type="${kind}" id="${id}" name="${id}" value="value ${i}" data-testid="${id}">`;
    }
    rows.push(`<p>${label}${control}</p>`);
  }
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture Settings</title></head>
<body>
  <main>
    <h1>Fixture Settings</h1>
    <form id="settings">
      ${rows.join('\n      ')}
      <p><label for="notify">Email notifications</label><input type="checkbox" id="notify" name="notify"></p>
      <p id="status">Status: idle</p>
      <button type="button" id="save">Save changes</button>
    </form>
  </main>
  <script>
    document.getElementById('save').addEventListener('click', function () {
      document.getElementById('status').textContent = 'Status: saved';
      document.getElementById('field-0').value = 'changed by save';
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;
let home: string;
let workspaceA: string;
let workspaceB: string;
let pool: DefaultBrowserPool;
let config: FbaConfig;

async function tempDir(prefix: string): Promise<string> {
  // Symlinks are resolved because profile ids are derived from real paths.
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url && req.url.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, items: [{ id: 1, name: 'one' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fixtureHtml());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  home = await tempDir('fba-home-');
  workspaceA = await tempDir('fba-ws-a-');
  workspaceB = await tempDir('fba-ws-b-');

  config = {
    ...defaultConfig(),
    home,
    headless: true,
    workspace: workspaceA,
    // Keep the reaper away from a test that deliberately leaves contexts idle
    // while a second browser launches.
    idleTimeoutMs: 10 * 60_000,
  };
  pool = new DefaultBrowserPool({ config });
});

afterAll(async () => {
  await pool?.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of [home, workspaceA, workspaceB]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function refsOf(node: SnapNode | undefined): string[] {
  if (!node) return [];
  const out: string[] = [];
  const walk = (n: SnapNode): void => {
    if (n.ref) out.push(n.ref);
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session integration', () => {
  it(
    'injects the runtime, snapshots with refs, diffs after a change and settles fast',
    async () => {
      const session = (await pool.acquire({ workspace: workspaceA })) as PageSession;
      await session.goto(baseUrl);

      // -- runtime is present in the loaded document -------------------------
      const version = await session.page.evaluate(() => window.__fba?.version ?? null);
      expect(version).toBe(RUNTIME_VERSION);

      // -- snapshot carries addressable refs ---------------------------------
      const snapshot = await session.snapshot({ scope: 'page' });
      expect(snapshot.url).toContain('127.0.0.1');
      expect(snapshot.title).toBe('Fixture Settings');
      expect(snapshot.version).toBeGreaterThan(0);
      const refs = refsOf(snapshot.tree);
      expect(refs.length).toBeGreaterThan(10);
      // Refs must be unique and addressable back in the page.
      expect(new Set(refs).size).toBe(refs.length);
      const first = refs[0] as string;
      const selector = await session.page.evaluate(
        (ref: string) => window.__fba?.selectorForRef(ref) ?? null,
        first,
      );
      expect(selector).toBeTruthy();

      // -- settle returns quickly on a static page ---------------------------
      const startedAt = Date.now();
      const settled = await session.settle();
      expect(settled.settled).toBe(true);
      expect(settled.reason).toBe('quiet');
      expect(Date.now() - startedAt).toBeLessThan(5_000);

      // -- first observation is a full tree ----------------------------------
      const firstObservation = await session.observe({ scope: 'page' });
      expect(firstObservation.tree).toBeDefined();
      expect(firstObservation.diff).toBeUndefined();
      expect(firstObservation.summary).toContain('control');

      // -- a small DOM change is reported as a diff --------------------------
      await session.page.click('#save');
      await session.page.click('#notify');
      const secondObservation = await session.observe({ scope: 'page' });
      expect(secondObservation.diff).toBeDefined();
      expect(secondObservation.tree).toBeUndefined();
      const entries = secondObservation.diff?.entries ?? [];
      expect(entries.length).toBeGreaterThan(0);
      // The input we rewrote must show up as a value change.
      expect(entries.some((e) => e.kind === 'value' && e.to === 'changed by save')).toBe(true);

      // -- structure/find go through the same runtime ------------------------
      const found = await session.find({ role: 'checkbox', name: 'Email notifications', limit: 3 });
      expect(found.length).toBeGreaterThan(0);
      expect(found[0]?.ref).toBeTruthy();

      // -- the session is reused rather than duplicated ----------------------
      const again = await pool.acquire({ workspace: workspaceA });
      expect(again.id).toBe(session.id);
      expect(pool.list().some((info) => info.id === session.id)).toBe(true);
    },
    60_000,
  );

  it(
    're-injects a wiped runtime and never blocks on a native dialog',
    async () => {
      const session = (await pool.acquire({ workspace: workspaceA, fresh: true })) as PageSession;
      await session.goto(baseUrl);

      // An SPA that replaces globals (or a document.write) takes the runtime
      // with it; the next call must transparently reinstall it.
      await session.page.evaluate(() => {
        delete (window as unknown as Record<string, unknown>).__fba;
      });
      const recovered = await session.snapshot({ scope: 'page' });
      expect(recovered.title).toBe('Fixture Settings');

      // Opened from a timer so the test does not itself block on the click that
      // raises the dialog — a blocked renderer never answers CDP.
      await session.page.evaluate(() => {
        setTimeout(() => window.confirm('Really delete everything?'), 0);
      });
      for (let i = 0; i < 60 && !session.pendingDialog(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(session.pendingDialog()?.type).toBe('confirm');

      // The page cannot be queried at all right now, so observing must answer
      // from Node — immediately — instead of hanging on an evaluation.
      const startedAt = Date.now();
      const blocked = await session.observe();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(blocked.nativeDialog?.message).toContain('Really delete');
      expect(blocked.summary).toContain('blocked by native confirm');
      expect(blocked.tree).toBeUndefined();

      await session.answerDialog(true);
      expect(session.pendingDialog()).toBeUndefined();
      const unblocked = await session.observe({ scope: 'page' });
      expect(unblocked.nativeDialog).toBeUndefined();
      expect(unblocked.url).toContain('127.0.0.1');

      await pool.closeSession(session.id);
    },
    60_000,
  );

  it(
    'gives two workspace roots two independent profile directories',
    async () => {
      const sessionA = await pool.acquire({ workspace: workspaceA });
      const sessionB = await pool.acquire({ workspace: workspaceB });

      expect(sessionA.workspaceId).toBe(workspaceIdFor(workspaceA));
      expect(sessionB.workspaceId).toBe(workspaceIdFor(workspaceB));
      expect(sessionA.workspaceId).not.toBe(sessionB.workspaceId);
      expect(sessionA.id).not.toBe(sessionB.id);

      const profiles = join(home, 'profiles');
      const dirs = (await readdir(profiles, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      expect(dirs).toEqual([sessionA.workspaceId, sessionB.workspaceId].sort());

      // Both are real, launched Chromium profiles — not empty placeholders.
      for (const dir of dirs) expect(existsSync(join(profiles, dir, 'Default'))).toBe(true);

      // Closing one workspace must leave the other's browser alone.
      await pool.closeWorkspace(sessionB.workspaceId);
      expect(pool.list().some((info) => info.workspaceId === sessionB.workspaceId)).toBe(false);
      expect(pool.list().some((info) => info.workspaceId === sessionA.workspaceId)).toBe(true);
    },
    60_000,
  );
});
