/**
 * Network control — pattern matching is pure and pinned here; the routing
 * behaviour itself is covered by the browser-backed test in
 * capture-and-net.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { patternMatches } from '../src/net/control.js';

describe('patternMatches', () => {
  it('matches plain substrings anywhere in the url', () => {
    expect(patternMatches('/api/users', 'http://x/api/users?page=2')).toBe(true);
    expect(patternMatches('api', 'http://x/api/users')).toBe(true);
    expect(patternMatches('/api/orders', 'http://x/api/users')).toBe(false);
  });

  it('treats * as a glob wildcard', () => {
    expect(patternMatches('/api/*/comments', 'http://x/api/posts/17/comments')).toBe(true);
    expect(patternMatches('*.png', 'http://cdn.x/img/logo.png')).toBe(true);
    expect(patternMatches('/api/*/comments', 'http://x/api/posts')).toBe(false);
  });

  it('escapes regex metacharacters in the literal parts', () => {
    // A dot must mean a dot — 'a.b' must not match 'aXb'.
    expect(patternMatches('a.b*', 'http://x/aXb/c')).toBe(false);
    expect(patternMatches('a.b*', 'http://x/a.b/c')).toBe(true);
    expect(patternMatches('price(1)', 'http://x/price(1)')).toBe(true);
  });

  it('rejects the empty pattern rather than matching everything', () => {
    expect(patternMatches('', 'http://x/anything')).toBe(false);
  });
});
