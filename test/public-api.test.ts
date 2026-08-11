/**
 * The library API must expose everything the MCP tool layer can do.
 *
 * Field report (fba 0.2.0, tb-console): `browser_session { setCookies }` worked
 * over MCP, but a direct library integration could not inject cookies at all —
 * the functions existed only behind `dist/browser/state.js`, and reaching for
 * them threw ERR_PACKAGE_PATH_NOT_EXPORTED. Session injection is exactly the
 * capability an embedded integration needs first (no auth, no useful browsing),
 * so "drive it as an MCP server instead" is not a workaround.
 *
 * The cause was uniform: state, capture and net control were all built
 * tool-first and never re-exported. These tests pin the public surface so a
 * future capability cannot land MCP-only again.
 */

import { describe, expect, it } from 'vitest';

import * as fba from '../src/index.js';

describe('public API: session state', () => {
  it('exposes the cookie and storage functions the MCP layer uses', () => {
    // The whole point of the field report: these must be callable without
    // reaching into dist/.
    expect(fba.setCookies).toBeTypeOf('function');
    expect(fba.getCookies).toBeTypeOf('function');
    expect(fba.clearCookies).toBeTypeOf('function');
    expect(fba.getStorage).toBeTypeOf('function');
    expect(fba.setStorage).toBeTypeOf('function');
    expect(fba.exportState).toBeTypeOf('function');
    expect(fba.importState).toBeTypeOf('function');
    expect(fba.readStateFile).toBeTypeOf('function');
    expect(fba.normalizeCookies).toBeTypeOf('function');
  });

  it('re-exports the real implementation, not a stub', () => {
    // Cheap end-to-end proof that the binding points at the working function:
    // a raw Cookie header is the form a session-injecting integration actually
    // has on hand.
    const cookies = fba.normalizeCookies('PHPSESSID=abc123; clientid=42', 'https://example.test/app');

    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatchObject({ name: 'PHPSESSID', value: 'abc123' });
    expect(cookies[1]).toMatchObject({ name: 'clientid', value: '42' });
  });
});

describe('public API: capture and network control', () => {
  it('exposes screenshot capture', () => {
    expect(fba.capture).toBeTypeOf('function');
    expect(fba.describeCapture).toBeTypeOf('function');
  });

  it('exposes runtime network control', () => {
    expect(fba.NetControl).toBeTypeOf('function');
    expect(fba.patternMatches).toBeTypeOf('function');
    // Same stub check as above, on the one pure function of the module.
    expect(fba.patternMatches('**/api/*', 'https://example.test/api/orders')).toBe(true);
  });
});

describe('public API: no capability is MCP-only', () => {
  // The specific assertions above pin today's gap. This one pins the rule that
  // produced it: every building block the tool layer reaches for has to be
  // reachable from the library too, or an embedded integration silently gets a
  // weaker product than the MCP server.
  const usedByToolLayer = [
    'setCookies',
    'importState',
    'exportState',
    'capture',
    'NetControl',
    'targetResolver',
    'originOf',
    'replayEndpoint',
    'serializeObservation',
    'FsCodeIndexer',
    'FsSiteMemoryStore',
    'FsSkillStore',
  ] as const;

  it.each(usedByToolLayer)('exports %s', (name) => {
    expect(fba).toHaveProperty(name);
    expect(fba[name]).toBeDefined();
  });
});
