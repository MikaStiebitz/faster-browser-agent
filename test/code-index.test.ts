/**
 * Code-index tests.
 *
 * A real (if tiny) application is written to a temp directory so the extractors
 * run against genuine file layouts and source text rather than fixtures that
 * were shaped to fit the regexes.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FsCodeIndexer } from '../src/code/indexer.js';
import { searchIndex } from '../src/code/match.js';
import { detectBaseUrl, detectFrameworks, extractRoutes, routeToPath } from '../src/code/routes.js';
import { scanWorkspace } from '../src/code/scan.js';
import { extractConfigFields } from '../src/code/config-fields.js';
import { extractNavGroups, extractSelectors } from '../src/code/selectors.js';
import { defaultConfig } from '../src/config.js';

let root: string;
let home: string;
let files: Awaited<ReturnType<typeof scanWorkspace>>;

const FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'demo-app',
      private: true,
      scripts: { dev: 'next dev -p 4001', build: 'next build' },
      dependencies: { next: '14.2.0', react: '18.3.0', 'react-router-dom': '6.26.0' },
    },
    null,
    2,
  ),

  'app/page.tsx': `export default function HomePage() {
  return <main>Welcome</main>;
}
`,

  'app/settings/[section]/page.tsx': `export default function SettingsSectionPage() {
  return <section>settings</section>;
}
`,

  'app/(marketing)/about/page.tsx': `export default function AboutPage() {
  return <article>about</article>;
}
`,

  'src/router.tsx': `import { createBrowserRouter } from 'react-router-dom';
import { Dashboard } from './Dashboard';
import { Settings } from './Settings';
import { Advanced } from './Advanced';

export const router = createBrowserRouter([
  { path: '/dashboard', element: <Dashboard /> },
  {
    path: '/settings',
    element: <Settings />,
    children: [{ path: 'advanced', element: <Advanced /> }],
  },
]);
`,

  'src/components/SettingsTabs.tsx': `import { useState } from 'react';

const settingsTabs = [
  { id: 'general', label: 'General' },
  { id: 'advanced', label: 'Advanced' },
];

export function SettingsTabs() {
  const [active, setActive] = useState('general');
  return (
    <div>
      {settingsTabs.map((tab) => (
        <button key={tab.id} onClick={() => setActive(tab.id)}>{tab.label}</button>
      ))}
      <input name="smtpPort" aria-label="SMTP port" placeholder="587" />
      <button data-testid="save-button">Save</button>
    </div>
  );
}
`,

  'src/config/settings.ts': `import { z } from 'zod';

export const SettingsSchema = z.object({
  mode: z.enum(['light', 'dark']),
  smtp: z.object({
    host: z.string().describe('SMTP host'),
    port: z.number().default(587),
  }),
  notifications: z.boolean().optional(),
});
`,
};

async function writeWorkspace(dir: string): Promise<void> {
  for (const [rel, content] of Object.entries(FILES)) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fba-code-'));
  home = await mkdtemp(join(tmpdir(), 'fba-home-'));
  await writeWorkspace(root);
  files = await scanWorkspace(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('scanWorkspace', () => {
  it('finds the source files and skips nothing relevant', () => {
    const rels = files.map((f) => f.rel).sort();
    expect(rels).toContain('app/settings/[section]/page.tsx');
    expect(rels).toContain('src/router.tsx');
    expect(rels).toContain('package.json');
    for (const file of files) {
      expect(file.mtimeMs).toBeGreaterThan(0);
      expect(file.path.endsWith(file.rel)).toBe(true);
    }
  });
});

describe('detectFrameworks', () => {
  it('detects the app router and react-router', () => {
    const frameworks = detectFrameworks(root, files);
    expect(frameworks).toContain('next-app');
    expect(frameworks).toContain('react-router');
  });
});

describe('extractRoutes', () => {
  it('derives patterns from the file system and from router objects', async () => {
    const routes = await extractRoutes(root, files, detectFrameworks(root, files));
    const byPattern = new Map(routes.map((r) => [r.pattern, r]));

    expect(byPattern.has('/')).toBe(true);
    expect(byPattern.has('/about')).toBe(true); // route group dropped
    expect(byPattern.has('/dashboard')).toBe(true);
    expect(byPattern.has('/settings')).toBe(true);
    expect(byPattern.has('/settings/advanced')).toBe(true); // nested child route

    const dynamic = byPattern.get('/settings/:section');
    expect(dynamic).toBeDefined();
    expect(dynamic?.params).toEqual(['section']);
    expect(dynamic?.framework).toBe('next-app');
    expect(dynamic?.source.startsWith('app/settings/[section]/page.tsx')).toBe(true);

    expect(byPattern.get('/about')?.label).toBe('About');
  });

  it('substitutes params', () => {
    expect(routeToPath('/settings/:section', { section: 'advanced' })).toBe('/settings/advanced');
    expect(routeToPath('/settings/[section]', { section: 'advanced' })).toBe('/settings/advanced');
    expect(routeToPath('/docs/*', { '*': 'a/b' })).toBe('/docs/a/b');
  });
});

describe('detectBaseUrl', () => {
  it('reads the port out of the dev script', () => {
    expect(detectBaseUrl(root, undefined, files)).toBe('http://localhost:4001');
  });
});

describe('extractNavGroups', () => {
  it('finds the settings tab structure', async () => {
    const groups = await extractNavGroups(root, files);
    const tabs = groups.find((g) => g.items.some((i) => i.label === 'Advanced'));
    expect(tabs).toBeDefined();
    expect(tabs?.label).toBe('Settings Tabs');
    expect(tabs?.items.map((i) => i.label)).toEqual(['General', 'Advanced']);
    expect(tabs?.items[0]?.id).toBe('general');
  });
});

describe('extractConfigFields', () => {
  it('produces dotted paths, enum values and required flags', async () => {
    const fields = await extractConfigFields(root, files);
    const byPath = new Map(fields.map((f) => [f.path, f]));

    expect(byPath.has('smtp.port')).toBe(true);
    expect(byPath.get('smtp.port')?.type).toBe('number');
    expect(byPath.get('smtp.host')?.label).toBe('SMTP host');
    expect(byPath.get('smtp.host')?.required).toBe(true);

    const mode = byPath.get('mode');
    expect(mode?.enumValues).toEqual(['light', 'dark']);

    expect(byPath.get('notifications')?.required).toBe(false);
  });
});

describe('extractSelectors', () => {
  it('finds test ids, aria labels, names and placeholders', async () => {
    const selectors = await extractSelectors(root, files);
    const find = (kind: string, value: string) =>
      selectors.find((s) => s.kind === kind && s.value === value);

    expect(find('testid', 'save-button')).toBeDefined();
    expect(find('aria-label', 'SMTP port')).toBeDefined();
    expect(find('name', 'smtpPort')).toBeDefined();
    expect(find('placeholder', '587')).toBeDefined();
    expect(find('testid', 'save-button')?.component).toBe('SettingsTabs');
  });
});

describe('FsCodeIndexer', () => {
  const makeIndexer = () => new FsCodeIndexer({ ...defaultConfig(), home });

  it('builds, caches and reuses an index', async () => {
    const indexer = makeIndexer();
    const index = await indexer.get(root);

    expect(index.schema).toBe(1);
    expect(index.baseUrl).toBe('http://localhost:4001');
    expect(index.routes.length).toBeGreaterThan(3);
    expect(Object.keys(index.files).length).toBe(files.length);

    // Second read must come back from cache without a rebuild.
    const again = await indexer.get(root);
    expect(again.builtAt).toBe(index.builtAt);
  });

  it('rebuilds when a file is added', async () => {
    const indexer = makeIndexer();
    const first = await indexer.get(root, { force: true });
    expect(first.routes.some((r) => r.pattern === '/reports')).toBe(false);

    const added = join(root, 'app/reports/page.tsx');
    await mkdir(dirname(added), { recursive: true });
    await writeFile(added, 'export default function ReportsPage() { return null; }\n', 'utf8');
    indexer.invalidate(root);

    const second = await indexer.get(root);
    expect(second.routes.some((r) => r.pattern === '/reports')).toBe(true);

    await rm(dirname(added), { recursive: true, force: true });
    indexer.invalidate(root);
  });

  it('ranks a route query above an unrelated selector', async () => {
    const index = await makeIndexer().get(root, { force: true });
    const matches = searchIndex(index, '/settings');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.kind).toBe('route');
    expect(matches[0]?.url).toBe('http://localhost:4001/settings');
    expect(matches.some((m) => m.kind === 'selector' && m.label.includes('save-button'))).toBe(false);
  });

  it('resolves selector queries to a usable target', async () => {
    const index = await makeIndexer().get(root, { force: true });
    const matches = searchIndex(index, 'save-button');
    const selector = matches.find((m) => m.kind === 'selector');
    expect(selector?.target).toEqual({ testId: 'save-button' });
  });

  it('resolves routes to absolute URLs', async () => {
    const indexer = makeIndexer();
    const index = await indexer.get(root, { force: true });

    expect(indexer.resolveRoute(index, '/settings/advanced')).toBe('http://localhost:4001/settings/advanced');
    expect(indexer.resolveRoute(index, 'settings/advanced')).toBe('http://localhost:4001/settings/advanced');
    expect(indexer.resolveRoute(index, '/settings/[section]', { section: 'general' })).toBe(
      'http://localhost:4001/settings/general',
    );
    expect(indexer.resolveRoute(index, '/settings/:section', { section: 'general' })).toBe(
      'http://localhost:4001/settings/general',
    );
    // A label, not a path.
    expect(indexer.resolveRoute(index, 'Dashboard')).toBe('http://localhost:4001/dashboard');
    // Unfilled params are an error, not a broken URL.
    expect(indexer.resolveRoute(index, '/settings/[section]')).toBeUndefined();
    expect(indexer.resolveRoute(index, '/nothing/like/this/at/all')).toBeUndefined();
    // Already absolute.
    expect(indexer.resolveRoute(index, 'https://example.com/x')).toBe('https://example.com/x');
  });

  it('never throws for a missing workspace', async () => {
    const indexer = makeIndexer();
    const index = await indexer.get(join(root, 'does-not-exist'));
    expect(index.routes).toEqual([]);
    expect(index.stats.filesScanned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A second workspace, covering the remaining framework dialects.
// ---------------------------------------------------------------------------

const POLYGLOT: Record<string, string> = {
  'package.json': JSON.stringify({
    dependencies: { '@sveltejs/kit': '2.0.0', 'vue-router': '4.4.0', '@remix-run/react': '2.11.0' },
    scripts: { dev: 'vite dev' },
  }),
  'src/routes/settings/[section]/+page.svelte': '<h1>settings</h1>\n',
  'src/routes/(app)/dash/+page.svelte': '<h1>dash</h1>\n',
  'app/routes/settings.advanced.tsx': 'export default function Advanced() { return null; }\n',
  'app/routes/users.$id.tsx': 'export default function User() { return null; }\n',
  'src/vue-router.ts': `import { createRouter } from 'vue-router';

export const router = createRouter({
  routes: [
    { path: '/vue', name: 'Vue home', component: Home },
    { path: '/vue/:id', name: 'Vue detail', component: Detail },
  ],
});
`,
  'api/urls.py': `from django.urls import path

urlpatterns = [
    path('admin/settings/', views.settings, name='settings'),
    path('users/<int:pk>/', views.user),
]
`,
  'server/main.py': `from fastapi import FastAPI

app = FastAPI()

@app.get("/api/health")
def health():
    return {}

@router.post("/api/items/{item_id}")
def item():
    return {}
`,
  'config/routes.rb': `Rails.application.routes.draw do
  root 'home#index'
  get '/reports', to: 'reports#index'
  resources :invoices
end
`,
  'src/types/AppConfig.ts': `export interface AppConfig {
  apiUrl: string; // where the API lives
  theme?: 'light' | 'dark';
  smtp: { host: string; port?: number };
  headers: Record<string, string>;
}
`,
  'schema/app.schema.json': JSON.stringify({
    properties: {
      server: { properties: { port: { type: 'integer', title: 'Port' } } },
      level: { type: 'string', enum: ['debug', 'info'] },
    },
    required: ['level'],
  }),
  'locales/de/common.json': JSON.stringify({ settings: { advanced: 'Erweitert' } }),
  'e2e/checkout.spec.ts': `test('checkout', async ({ page }) => {
  await page.getByTestId('submit-order').click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  cy.get('[data-cy=login-form]').should('exist');
});
`,
};

describe('polyglot workspace', () => {
  let dir: string;
  let scanned: Awaited<ReturnType<typeof scanWorkspace>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fba-poly-'));
    for (const [rel, content] of Object.entries(POLYGLOT)) {
      const path = join(dir, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    }
    scanned = await scanWorkspace(dir);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts routes from every supported dialect', async () => {
    const routes = await extractRoutes(dir, scanned, detectFrameworks(dir, scanned));
    const patterns = new Map(routes.map((r) => [r.pattern, r.framework]));

    expect(patterns.get('/settings/:section')).toBe('sveltekit');
    expect(patterns.get('/dash')).toBe('sveltekit'); // (app) group dropped
    expect(patterns.get('/settings/advanced')).toBe('remix'); // dot-nesting
    expect(patterns.get('/users/:id')).toBe('remix'); // $id
    expect(patterns.get('/vue')).toBe('vue-router');
    expect(patterns.get('/admin/settings')).toBe('django');
    expect(patterns.get('/users/:pk')).toBe('django'); // <int:pk> normalised
    expect(patterns.get('/api/health')).toBe('fastapi');
    expect(patterns.get('/api/items/:item_id')).toBe('fastapi'); // {item_id}
    expect(patterns.get('/reports')).toBe('rails');
    expect(patterns.get('/invoices/:id/edit')).toBe('rails'); // RESTful defaults
    expect(patterns.get('/')).toBe('rails');
  });

  it('extracts config fields from a TS interface and a JSON schema', async () => {
    const fields = await extractConfigFields(dir, scanned);
    const byPath = new Map(fields.map((f) => [f.path, f]));

    expect(byPath.get('apiUrl')?.required).toBe(true);
    expect(byPath.get('theme')?.enumValues).toEqual(['light', 'dark']);
    expect(byPath.get('theme')?.required).toBe(false);
    expect(byPath.get('smtp.port')?.required).toBe(false);
    expect(byPath.get('headers')?.type).toBe('Record<string, string>');
    expect(byPath.get('server.port')?.label).toBe('Port');
    expect(byPath.get('level')?.enumValues).toEqual(['debug', 'info']);
    expect(byPath.get('level')?.required).toBe(true);
  });

  it('mines selectors out of the test suite and the i18n catalogue', async () => {
    const selectors = await extractSelectors(dir, scanned);
    expect(selectors.find((s) => s.kind === 'testid' && s.value === 'submit-order')).toBeDefined();
    expect(selectors.find((s) => s.kind === 'testid' && s.value === 'login-form')).toBeDefined();
    expect(selectors.find((s) => s.kind === 'text' && s.value === 'Save changes')).toBeDefined();

    const translated = selectors.find((s) => s.value === 'Erweitert');
    expect(translated?.kind).toBe('text');
    expect(translated?.component).toBe('settings.advanced');
  });
});
