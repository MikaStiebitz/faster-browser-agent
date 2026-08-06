/**
 * Route registries and the translation reverse index.
 *
 * Both come from a field report on a legacy PHP monolith where the built-in
 * extractors found *zero* routes: its navigation is one hand-rolled array in
 * one file, and its UI lives in `templates/` behind extensions the scanner did
 * not even read. Neither is exotic — it is what most non-JS applications look
 * like — so the code-aware layer is worth nothing there without these.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FsCodeIndexer } from '../src/code/indexer.js';
import { searchIndex } from '../src/code/match.js';
import { extractRecords, renderTemplate } from '../src/code/records.js';
import { extractRegistryRoutes, extractTranslations } from '../src/code/registry.js';
import { scanWorkspace } from '../src/code/scan.js';
import { defaultConfig } from '../src/config.js';
import type { RouteRegistryConfig } from '../src/types.js';

/** A PHP menu registry in the shape these applications actually use. */
const MAINMENU_PHP = `<?php
// The application's whole navigation lives here.
$mainmenu = [
    [
        'page'   => 'orders',
        'sub'    => 'list',
        'folder' => 'modul/order',
        'aclKey' => 'order.view',
        'title'  => 'Auftragsliste',
    ],
    [
        'page'   => 'orders',
        'sub'    => 'detail',
        'folder' => 'modul/order',
        'aclKey' => 'order.edit',
        'title'  => 'Auftrag bearbeiten',
    ],
    // A top-level entry with no sub-page: the URL must not carry "&sub=".
    [
        'page'   => 'dashboard',
        'folder' => 'modul/dashboard',
        'aclKey' => 'dashboard.view',
        'title'  => 'Übersicht',
    ],
];
`;

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fba-registry-'));

  await mkdir(join(root, 'framework/tb/html'), { recursive: true });
  await mkdir(join(root, 'templates/order'), { recursive: true });
  await mkdir(join(root, 'modul/order'), { recursive: true });
  await mkdir(join(root, 'translations'), { recursive: true });

  await writeFile(join(root, 'framework/tb/html/mainmenu.php'), MAINMENU_PHP);
  await writeFile(
    join(root, 'translations/order.en.json'),
    JSON.stringify({ view: { print_delivery_note: 'Print delivery note', title: 'Orders' } }, null, 2),
  );
  // The call site the reverse lookup has to find — in a template extension the
  // scanner previously ignored entirely.
  await writeFile(
    join(root, 'templates/order/detail.twig'),
    `<h1>{{ 'view.title'|trans }}</h1>\n<button>{{ 'view.print_delivery_note'|trans }}</button>\n`,
  );
  await writeFile(
    join(root, 'modul/order/index.php'),
    `<?php\n$label = translate('view.print_delivery_note');\necho $label;\n`,
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const registry: RouteRegistryConfig = {
  file: 'framework/tb/html/mainmenu.php',
  url: 'index.php?page={page}&sub={sub}',
  label: '{title}',
  aclField: 'aclKey',
  meta: ['folder'],
};

describe('extractRecords', () => {
  it('reads PHP `key => value` records and ignores the wrapping array', () => {
    const records = extractRecords(MAINMENU_PHP);
    expect(records).toHaveLength(3);
    expect(records[0]!.fields).toMatchObject({ page: 'orders', sub: 'list', aclKey: 'order.view' });
    expect(records[0]!.line).toBeGreaterThan(1);
  });

  it('is not derailed by brackets or comment markers inside strings', () => {
    const records = extractRecords(`[
      { 'label' => 'Rate [per hour]', 'url' => 'https://x/a//b', 'id' => 'rate' },
      { 'label' => "It's fine", 'id' => 'ok' },
    ]`);
    expect(records).toHaveLength(2);
    expect(records[0]!.fields['label']).toBe('Rate [per hour]');
    expect(records[0]!.fields['url']).toBe('https://x/a//b');
    expect(records[1]!.fields['label']).toBe("It's fine");
  });
});

describe('renderTemplate', () => {
  it('drops query segments whose placeholder is empty', () => {
    const template = 'index.php?page={page}&sub={sub}';
    expect(renderTemplate(template, { page: 'orders', sub: 'list' })).toBe('index.php?page=orders&sub=list');
    // A trailing `&sub=` changes which page a real app serves.
    expect(renderTemplate(template, { page: 'dashboard' })).toBe('index.php?page=dashboard');
  });

  it('refuses to build a url whose path is unresolved', () => {
    expect(renderTemplate('/app/{section}/edit', {})).toBeUndefined();
  });
});

describe('extractRegistryRoutes', () => {
  it('turns a hand-rolled menu table into deep links with labels and permissions', async () => {
    const files = await scanWorkspace(root);
    const routes = await extractRegistryRoutes(files, [registry]);

    expect(routes).toHaveLength(3);
    const detail = routes.find((r) => r.pattern.includes('sub=detail'));
    expect(detail).toBeDefined();
    expect(detail!.pattern).toBe('/index.php?page=orders&sub=detail');
    expect(detail!.label).toBe('Auftrag bearbeiten');
    expect(detail!.acl).toBe('order.edit');
    expect(detail!.meta).toMatchObject({ folder: 'modul/order' });
    expect(detail!.source).toMatch(/mainmenu\.php:\d+/);

    const dashboard = routes.find((r) => r.pattern.includes('dashboard'));
    expect(dashboard!.pattern).toBe('/index.php?page=dashboard');
  });
});

describe('translation reverse lookup', () => {
  it('links a rendered string back to the code that renders it', async () => {
    const files = await scanWorkspace(root);
    const translations = await extractTranslations(files);

    const entry = translations.find((t) => t.key === 'view.print_delivery_note');
    expect(entry).toBeDefined();
    expect(entry!.value).toBe('Print delivery note');
    expect(entry!.locale).toBe('en');
    // Both the Twig template and the PHP module reference the key; without the
    // template extension in the scanner the first of these was invisible.
    expect(entry!.callSites.join(' ')).toContain('templates/order/detail.twig');
    expect(entry!.callSites.join(' ')).toContain('modul/order/index.php');
  });

  it('only attaches call sites for keys a catalogue actually defines', async () => {
    const files = await scanWorkspace(root);
    const translations = await extractTranslations(files);
    // The permissive call patterns must not invent entries for unknown keys.
    expect(translations.every((t) => t.key.startsWith('view.'))).toBe(true);
  });
});

describe('end to end through the indexer', () => {
  it('surfaces registry routes and translation call sites from a search', async () => {
    const config = {
      ...defaultConfig(),
      home: join(root, '.fba-home'),
      workspace: root,
      baseUrl: 'https://tb.example.com',
      routeRegistry: registry,
      logLevel: 'silent' as const,
    };
    const index = await new FsCodeIndexer(config).get(root, { force: true });

    expect(index.routes.length).toBe(3);

    const routeHits = searchIndex(index, 'Auftrag bearbeiten', 5);
    expect(routeHits[0]!.kind).toBe('route');
    expect(routeHits[0]!.url).toBe('https://tb.example.com/index.php?page=orders&sub=detail');
    expect(routeHits[0]!.acl).toBe('order.edit');

    const textHits = searchIndex(index, 'Print delivery note', 5);
    const translation = textHits.find((m) => m.kind === 'translation');
    expect(translation).toBeDefined();
    expect(translation!.callSites?.join(' ')).toContain('detail.twig');
  });
});
