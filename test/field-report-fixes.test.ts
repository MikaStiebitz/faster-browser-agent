/**
 * Fixes driven by a real-world field report (a Next.js admin console).
 *
 * Each case here is a concrete failure someone actually hit, not a hypothetical:
 * a sidecar process shadowing the framework's own dev port, constant tables
 * being indexed as navigation, and cookies that could not be injected at all.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractNavGroups } from '../src/code/selectors.js';
import { detectBaseUrl } from '../src/code/routes.js';
import { scanWorkspace } from '../src/code/scan.js';
import { normalizeCookies } from '../src/browser/state.js';
import { FbaError } from '../src/util/errors.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fba-field-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('detectBaseUrl attributes ports to their own command', () => {
  it('prefers the framework dev server over an unrelated sidecar', async () => {
    const dir = join(root, 'sidecar');
    await mkdir(join(dir, 'src/app'), { recursive: true });
    await writeFile(join(dir, 'src/app/page.tsx'), 'export default function Page(){return null}\n');
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        // The sidecar states a port; `next dev` does not. Taking the first port
        // in the string sent every deep link to the wrong process.
        scripts: { dev: 'concurrently "opencode serve --port 7800" "next dev"' },
        dependencies: { next: '15.0.0' },
      }),
    );
    const files = await scanWorkspace(dir);
    expect(detectBaseUrl(dir, undefined, files)).toBe('http://localhost:3000');
  });

  it('still honours an explicit port on the framework command itself', async () => {
    const dir = join(root, 'explicit');
    await mkdir(join(dir, 'src/app'), { recursive: true });
    await writeFile(join(dir, 'src/app/page.tsx'), 'export default function Page(){return null}\n');
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        scripts: { dev: 'npm run api & next dev -p 4001' },
        dependencies: { next: '15.0.0' },
      }),
    );
    const files = await scanWorkspace(dir);
    expect(detectBaseUrl(dir, undefined, files)).toBe('http://localhost:4001');
  });
});

describe('nav group extraction rejects constant tables', () => {
  it('keeps real navigation and drops lookalike arrays', async () => {
    const dir = join(root, 'nav');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src/nav.tsx'),
      `
      export const mainNav = [
        { id: 'overview', label: 'Overview', href: '/overview' },
        { id: 'shares', label: 'Freigaben', href: '/shares' },
      ];
      // Not navigation: a status enum. Shape-identical to a tab array and named
      // for what it is, so only the naming signal can tell them apart.
      const statuses = [
        { id: 'enabled', label: 'Enabled' },
        { id: 'disabled', label: 'Disabled' },
      ];
      // Not navigation: duration constants in SCREAMING_CASE.
      const durations = [
        { id: 'DAY_MS', label: 'DAY MS' },
        { id: 'HOUR_MS', label: 'HOUR MS' },
      ];
      `,
    );
    const files = await scanWorkspace(dir);
    const groups = await extractNavGroups(dir, files);
    const labels = groups.flatMap((g) => g.items.map((i) => i.label));

    expect(labels).toContain('Freigaben');
    expect(labels).not.toContain('Disabled');
    expect(labels).not.toContain('DAY MS');
  });

  it('keeps an id-only tab array when the variable is named like navigation', async () => {
    const dir = join(root, 'nav-idonly');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src/tabs.tsx'),
      `export const settingsTabs = [
         { id: 'general', label: 'General' },
         { id: 'advanced', label: 'Advanced' },
       ];`,
    );
    const files = await scanWorkspace(dir);
    const labels = (await extractNavGroups(dir, files)).flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toEqual(['General', 'Advanced']);
  });
});

describe('cookie normalisation accepts every shape an agent has', () => {
  const url = 'https://app.example.com';

  it('parses a raw Cookie header, the devtools copy format', () => {
    const cookies = normalizeCookies('PHPSESSID=abc123; clientid=42; master_db=main', url);
    expect(cookies.map((c) => c.name)).toEqual(['PHPSESSID', 'clientid', 'master_db']);
    expect(cookies[0]!.value).toBe('abc123');
    expect(cookies[0]!.url).toBe(url);
  });

  it('parses a plain name/value map', () => {
    const cookies = normalizeCookies({ PHPSESSID: 'abc', clientid: '7' }, url);
    expect(cookies).toHaveLength(2);
    expect(cookies[1]).toMatchObject({ name: 'clientid', value: '7', url });
  });

  it('leaves a fully-specified cookie alone', () => {
    const cookies = normalizeCookies(
      [{ name: 'session', value: 'x', domain: '.example.com', path: '/', httpOnly: true }],
      url,
    );
    // An explicit domain wins — that is the escape hatch for subdomain-wide cookies.
    expect(cookies[0]).toMatchObject({ domain: '.example.com', httpOnly: true });
    expect(cookies[0]!.url).toBeUndefined();
  });

  it('refuses a cookie it cannot scope rather than silently dropping it', () => {
    expect(() => normalizeCookies({ PHPSESSID: 'abc' })).toThrow(FbaError);
    expect(() => normalizeCookies('bogus-without-equals', url)).toThrow(/malformed/);
  });
});

describe('unexpanded MCP placeholders are ignored', () => {
  it('falls back to the default home instead of creating a literal directory', async () => {
    // A host that does not define ${CLAUDE_PLUGIN_DATA} passes it through
    // verbatim; taking it literally once wrote a 7MB Chromium profile into a
    // directory of that name inside a git repo.
    const previous = process.env['FBA_HOME'];
    process.env['FBA_HOME'] = '${CLAUDE_PLUGIN_DATA}';
    try {
      const { defaultHome, loadConfig } = await import('../src/config.js');
      expect(defaultHome()).not.toContain('${');
      expect(loadConfig().home).not.toContain('${');
    } finally {
      if (previous === undefined) delete process.env['FBA_HOME'];
      else process.env['FBA_HOME'] = previous;
    }
  });
});
