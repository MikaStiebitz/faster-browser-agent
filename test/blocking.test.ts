import { describe, expect, it } from 'vitest';

import { blockingStats, categoryFor, resetBlockingStats, shouldBlock } from '../src/browser/blocking.js';
import { DEFAULT_BLOCKING, type BlockingPolicy } from '../src/types.js';

function policy(overrides: Partial<BlockingPolicy> = {}): BlockingPolicy {
  return {
    enabled: true,
    categories: [...DEFAULT_BLOCKING.categories],
    patterns: [...DEFAULT_BLOCKING.patterns],
    allow: [],
    ...overrides,
  };
}

describe('categoryFor', () => {
  it('maps playwright resource types onto the closed vocabulary', () => {
    expect(categoryFor('document')).toBe('document');
    expect(categoryFor('image')).toBe('image');
    expect(categoryFor('font')).toBe('font');
    expect(categoryFor('stylesheet')).toBe('stylesheet');
    expect(categoryFor('script')).toBe('script');
    expect(categoryFor('media')).toBe('media');
    expect(categoryFor('texttrack')).toBe('media');
  });

  it('folds every app-data transport into xhr', () => {
    expect(categoryFor('xhr')).toBe('xhr');
    expect(categoryFor('fetch')).toBe('xhr');
    expect(categoryFor('eventsource')).toBe('xhr');
    expect(categoryFor('websocket')).toBe('xhr');
  });

  it('falls back to other for unknown types', () => {
    expect(categoryFor('manifest')).toBe('other');
    expect(categoryFor('ping')).toBe('other');
    expect(categoryFor('')).toBe('other');
  });
});

describe('shouldBlock', () => {
  it('never blocks the main document, even when it matches a block pattern', () => {
    const p = policy({ patterns: ['localhost'], categories: ['document', 'image'] });
    expect(shouldBlock('http://localhost:3000/settings', 'document', p)).toBe(false);
  });

  it('never blocks xhr/fetch/websocket — that is the app talking to its backend', () => {
    const p = policy({ patterns: ['api'], categories: ['xhr'] });
    expect(shouldBlock('http://localhost:3000/api/users', 'xhr', p)).toBe(false);
    expect(shouldBlock('http://localhost:3000/api/users', 'fetch', p)).toBe(false);
    expect(shouldBlock('ws://localhost:3000/socket', 'websocket', p)).toBe(false);
  });

  it('blocks configured categories', () => {
    const p = policy();
    expect(shouldBlock('http://localhost:3000/hero.png', 'image', p)).toBe(true);
    expect(shouldBlock('http://localhost:3000/inter.woff2', 'font', p)).toBe(true);
    expect(shouldBlock('http://localhost:3000/promo.mp4', 'media', p)).toBe(true);
  });

  it('leaves scripts and stylesheets alone by default — apps do not render without them', () => {
    const p = policy();
    expect(shouldBlock('http://localhost:3000/app.js', 'script', p)).toBe(false);
    expect(shouldBlock('http://localhost:3000/app.css', 'stylesheet', p)).toBe(false);
  });

  it('blocks pattern matches regardless of category', () => {
    const p = policy();
    expect(shouldBlock('https://www.google-analytics.com/analytics.js', 'script', p)).toBe(true);
    expect(shouldBlock('https://cdn.segment.com/analytics.js/v1/x/analytics.min.js', 'script', p)).toBe(true);
    expect(shouldBlock('https://static.hotjar.com/c/hotjar-1.js', 'script', p)).toBe(true);
  });

  it('matches patterns case-insensitively and anywhere in the url', () => {
    const p = policy({ patterns: ['TRACKER.io'], categories: [] });
    expect(shouldBlock('https://cdn.tracker.io/a.js', 'script', p)).toBe(true);
    expect(shouldBlock('https://example.com/?ref=tracker.io', 'script', p)).toBe(true);
  });

  it('supports glob and explicit regex patterns', () => {
    const glob = policy({ patterns: ['*.ads.example.com/*'], categories: [] });
    expect(shouldBlock('https://a.ads.example.com/tag.js', 'script', glob)).toBe(true);
    expect(shouldBlock('https://ads.example.org/tag.js', 'script', glob)).toBe(false);

    const re = policy({ patterns: ['/beacon-\\d+\\.js/'], categories: [] });
    expect(shouldBlock('https://x.test/beacon-42.js', 'script', re)).toBe(true);
    expect(shouldBlock('https://x.test/beacon-abc.js', 'script', re)).toBe(false);
  });

  it('ignores an invalid pattern instead of disabling blocking entirely', () => {
    const p = policy({ patterns: ['/[unterminated/', 'tracker.io'], categories: [] });
    expect(shouldBlock('https://tracker.io/a.js', 'script', p)).toBe(true);
    expect(shouldBlock('https://example.com/a.js', 'script', p)).toBe(false);
  });

  it('lets the allow-list win over both patterns and categories', () => {
    const p = policy({ allow: ['google-analytics.com/debug', 'localhost:3000'] });
    expect(shouldBlock('https://www.google-analytics.com/debug/bootstrap.js', 'script', p)).toBe(false);
    expect(shouldBlock('http://localhost:3000/hero.png', 'image', p)).toBe(false);
    // ...while everything else is still blocked.
    expect(shouldBlock('http://cdn.example.com/hero.png', 'image', p)).toBe(true);
  });

  it('blocks nothing when disabled', () => {
    const p = policy({ enabled: false });
    expect(shouldBlock('http://localhost:3000/hero.png', 'image', p)).toBe(false);
    expect(shouldBlock('https://www.google-analytics.com/analytics.js', 'script', p)).toBe(false);
  });

  it('handles an empty policy without matching everything', () => {
    const p = policy({ categories: [], patterns: [], allow: [] });
    expect(shouldBlock('http://localhost:3000/hero.png', 'image', p)).toBe(false);
    expect(shouldBlock('http://localhost:3000/app.js', 'script', p)).toBe(false);
  });

  it('re-reads a policy whose arrays changed after the first compile', () => {
    const p = policy({ categories: [], patterns: [], allow: [] });
    expect(shouldBlock('https://tracker.io/a.js', 'script', p)).toBe(false);
    p.patterns.push('tracker.io');
    expect(shouldBlock('https://tracker.io/a.js', 'script', p)).toBe(true);
  });
});

describe('blockingStats', () => {
  it('exposes resettable process-wide counters', () => {
    resetBlockingStats();
    expect(blockingStats()).toEqual({ blocked: 0, allowed: 0 });
  });
});
