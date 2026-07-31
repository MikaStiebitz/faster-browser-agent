import { describe, expect, it } from 'vitest';

import type { Page, Request, Response } from 'playwright-core';

import { NetworkObserver, describeShape, urlPattern } from '../src/net/observer.js';

// ---------------------------------------------------------------------------
// urlPattern
// ---------------------------------------------------------------------------

describe('urlPattern', () => {
  it('replaces numeric path segments', () => {
    expect(urlPattern('https://app.test/api/users/42')).toBe('https://app.test/api/users/:id');
    expect(urlPattern('https://app.test/api/users/42/posts/7')).toBe('https://app.test/api/users/:id/posts/:id');
  });

  it('replaces uuid and mongo-style hex ids', () => {
    expect(urlPattern('https://app.test/api/orders/3f6b2a1c-1111-4222-8333-444455556666/items')).toBe(
      'https://app.test/api/orders/:id/items',
    );
    expect(urlPattern('https://app.test/api/docs/507f1f77bcf86cd799439011')).toBe('https://app.test/api/docs/:id');
  });

  it('replaces date-like and opaque token segments', () => {
    expect(urlPattern('https://app.test/api/reports/2024-05-17')).toBe('https://app.test/api/reports/:id');
    expect(urlPattern('https://app.test/api/reports/2024-05')).toBe('https://app.test/api/reports/:id');
    expect(urlPattern('https://app.test/s/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe('https://app.test/s/:id');
  });

  it('keeps human-authored slugs, short segments and version prefixes', () => {
    expect(urlPattern('https://app.test/blog/getting-started-with-webhooks')).toBe(
      'https://app.test/blog/getting-started-with-webhooks',
    );
    expect(urlPattern('https://app.test/api/v1/settings')).toBe('https://app.test/api/v1/settings');
  });

  it('drops query values but keeps sorted parameter names', () => {
    expect(urlPattern('https://app.test/api/users?page=2')).toBe(urlPattern('https://app.test/api/users?page=3'));
    expect(urlPattern('https://app.test/api/users?page=2')).toBe('https://app.test/api/users?page');
    expect(urlPattern('https://app.test/api/users?sort=name&page=2')).toBe('https://app.test/api/users?page&sort');
    expect(urlPattern('https://app.test/api/users?tag=a&tag=b')).toBe('https://app.test/api/users?tag');
  });

  it('keeps endpoints with different parameter names distinct', () => {
    expect(urlPattern('https://app.test/api/users?q=')).toBe('https://app.test/api/users?q');
    expect(urlPattern('https://app.test/api/users?q=')).not.toBe(urlPattern('https://app.test/api/users?page=2'));
    expect(urlPattern('https://app.test/api/users')).not.toBe(urlPattern('https://app.test/api/users?page=1'));
  });

  it('preserves origin (including port) and drops the fragment', () => {
    expect(urlPattern('http://localhost:3000/api/x')).toBe('http://localhost:3000/api/x');
    expect(urlPattern('https://app.test/api/users#section')).toBe('https://app.test/api/users');
  });

  it('handles relative urls without inventing an origin', () => {
    expect(urlPattern('/api/users/12?page=2')).toBe('/api/users/:id?page');
    expect(urlPattern('/api/users/12/')).toBe('/api/users/:id/');
  });
});

// ---------------------------------------------------------------------------
// describeShape
// ---------------------------------------------------------------------------

describe('describeShape', () => {
  it('sketches primitives', () => {
    expect(describeShape('x')).toBe('string');
    expect(describeShape(3)).toBe('number');
    expect(describeShape(true)).toBe('boolean');
    expect(describeShape(null)).toBe('null');
    expect(describeShape({})).toBe('{}');
    expect(describeShape([])).toBe('[]');
  });

  it('renders nested objects and arrays compactly', () => {
    expect(describeShape({ items: [{ id: 1, name: 'a', tags: ['x', 'y'] }], total: 5, next: null })).toBe(
      '{ items: [{ id: number, name: string, tags: string[] }], total: number, next: null }',
    );
  });

  it('does not repeat array elements', () => {
    expect(describeShape([1, 2, 3])).toBe('number[]');
    expect(describeShape([{ id: 1 }, { id: 2 }, { id: 3 }])).toBe('[{ id: number }]');
  });

  it('unions heterogeneous array elements', () => {
    expect(describeShape({ next: ['a', null] })).toBe('{ next: (string|null)[] }');
    expect(describeShape([1, 'a', true, 9])).toBe('[number|string|…]');
  });

  it('caps depth, defaulting to 3 levels', () => {
    expect(describeShape({ a: { b: { c: { d: 1 } } } })).toBe('{ a: { b: { c: {…} } } }');
    expect(describeShape({ a: { b: 1 } }, 1)).toBe('{ a: {…} }');
    expect(describeShape({ a: [{ b: 1 }] }, 1)).toBe('{ a: [{…}] }');
  });

  it('does not charge a depth level for the array wrapper', () => {
    // `{ items: [...] }` is two conceptual levels, not three — otherwise the
    // element shape (the useful part) is the first thing to get truncated.
    expect(describeShape({ items: [{ tags: ['x'] }] }, 2)).toBe('{ items: [{ tags: string[] }] }');
  });

  it('caps object keys at 12', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 15; i++) wide[`k${i}`] = i;
    const out = describeShape(wide);
    expect(out).toContain('k11: number');
    expect(out).not.toContain('k12');
    expect(out.endsWith(', … }')).toBe(true);
  });

  it('caps total output length', () => {
    const inner: Record<string, string> = {};
    for (let i = 0; i < 12; i++) inner[`field${i}`] = 'value';
    const out = describeShape({ a: inner, b: inner, c: inner });
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith('…')).toBe(true);
  });

  it('survives cyclic input', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic['self'] = cyclic;
    expect(describeShape(cyclic)).toBe('{ name: string, self: <circular> }');
  });
});

// ---------------------------------------------------------------------------
// NetworkObserver — driven through a fake page, no browser required
// ---------------------------------------------------------------------------

class FakePage {
  private readonly listeners = new Map<string, Set<(arg: unknown) => void>>();

  url(): string {
    return 'https://app.test/dashboard';
  }

  on(event: string, fn: (arg: never) => void): this {
    const set = this.listeners.get(event) ?? new Set<(arg: unknown) => void>();
    set.add(fn as (arg: unknown) => void);
    this.listeners.set(event, set);
    return this;
  }

  off(event: string, fn: (arg: never) => void): this {
    this.listeners.get(event)?.delete(fn as (arg: unknown) => void);
    return this;
  }

  emit(event: string, arg: unknown): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(arg);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

interface ResponseSpec {
  url: string;
  method?: string;
  status?: number;
  contentType?: string | null;
  contentLength?: number;
  resourceType?: string;
  body?: string;
  postData?: string;
  navigation?: boolean;
  bodyFails?: boolean;
  onBody?: () => void;
}

function fakeResponse(spec: ResponseSpec): Response {
  const headers: Record<string, string> = {};
  if (spec.contentType !== null) headers['content-type'] = spec.contentType ?? 'application/json; charset=utf-8';
  if (spec.contentLength !== undefined) headers['content-length'] = String(spec.contentLength);

  const request = {
    method: () => spec.method ?? 'GET',
    url: () => spec.url,
    resourceType: () => spec.resourceType ?? 'fetch',
    isNavigationRequest: () => spec.navigation ?? false,
    postData: () => spec.postData ?? null,
    failure: () => null,
  };

  return {
    url: () => spec.url,
    status: () => spec.status ?? 200,
    headers: () => headers,
    request: () => request,
    body: () => {
      spec.onBody?.();
      return spec.bodyFails ? Promise.reject(new Error('no body')) : Promise.resolve(Buffer.from(spec.body ?? '{}'));
    },
  } as unknown as Response;
}

function fakeFailedRequest(url: string, errorText: string, resourceType = 'fetch'): Request {
  return {
    method: () => 'GET',
    url: () => url,
    resourceType: () => resourceType,
    isNavigationRequest: () => false,
    failure: () => ({ errorText }),
  } as unknown as Request;
}

/** Let the deferred (never awaited) body reads run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('NetworkObserver', () => {
  it('groups responses by method + pattern and counts hits', async () => {
    const page = new FakePage();
    const observer = new NetworkObserver(page as unknown as Page);
    observer.attach();

    page.emit('response', fakeResponse({ url: 'https://app.test/api/users?page=1', body: '{"items":[{"id":1}]}' }));
    page.emit('response', fakeResponse({ url: 'https://app.test/api/users?page=2', body: '{"items":[{"id":2}]}' }));
    page.emit('response', fakeResponse({ url: 'https://app.test/api/users/7', body: '{"id":7,"name":"a"}' }));
    await flush();

    const endpoints = observer.endpoints();
    expect(endpoints).toHaveLength(2);
    expect(endpoints[0]?.pattern).toBe('https://app.test/api/users?page');
    expect(endpoints[0]?.hits).toBe(2);
    expect(endpoints[0]?.contentType).toBe('application/json');
    expect(endpoints[0]?.responseShape).toBe('{ items: [{ id: number }] }');
    expect(endpoints[1]?.pattern).toBe('https://app.test/api/users/:id');
    expect(endpoints[1]?.responseShape).toBe('{ id: number, name: string }');
    expect(observer.pendingCount()).toBe(0);

    observer.detach();
    expect(page.listenerCount('response')).toBe(0);
  });

  it('records the request body shape for writes', async () => {
    const page = new FakePage();
    const observer = new NetworkObserver(page as unknown as Page);
    observer.attach();

    page.emit(
      'response',
      fakeResponse({
        url: 'https://app.test/api/users',
        method: 'POST',
        status: 201,
        postData: '{"name":"a","admin":false}',
        body: '{"id":1}',
      }),
    );
    await flush();

    const endpoint = observer.endpoints()[0];
    expect(endpoint?.method).toBe('POST');
    expect(endpoint?.status).toBe(201);
    expect(endpoint?.requestBodyShape).toBe('{ name: string, admin: boolean }');
    expect(endpoint?.responseShape).toBe('{ id: number }');
  });

  it('ignores navigations, static assets and oversized bodies', async () => {
    const page = new FakePage();
    const observer = new NetworkObserver(page as unknown as Page, { maxBodyBytes: 100 });
    observer.attach();

    page.emit('response', fakeResponse({ url: 'https://app.test/dashboard', resourceType: 'document', navigation: true }));
    page.emit('response', fakeResponse({ url: 'https://app.test/app.js', resourceType: 'script', contentType: 'text/javascript' }));
    page.emit('response', fakeResponse({ url: 'https://app.test/logo.png', resourceType: 'image', contentType: 'image/png' }));
    page.emit('response', fakeResponse({ url: 'https://app.test/api/huge', contentLength: 5_000 }));
    await flush();

    expect(observer.endpoints()).toHaveLength(0);
  });

  it('records the endpoint but no shape when the body is unavailable or not json', async () => {
    const page = new FakePage();
    const observer = new NetworkObserver(page as unknown as Page);
    observer.attach();

    page.emit('response', fakeResponse({ url: 'https://app.test/api/redirected', bodyFails: true }));
    page.emit('response', fakeResponse({ url: 'https://app.test/api/csv', contentType: 'text/csv', body: 'a,b\n1,2' }));
    await flush();

    const endpoints = observer.endpoints();
    expect(endpoints).toHaveLength(2);
    expect(endpoints.every((e) => e.responseShape === undefined)).toBe(true);
    // A rejected body read must not leave the pending counter stuck.
    expect(observer.pendingCount()).toBe(0);
  });

  it('reads a body once per endpoint, and gives up after a second failure', async () => {
    const page = new FakePage();
    const observer = new NetworkObserver(page as unknown as Page);
    observer.attach();

    let polled = 0;
    for (let i = 0; i < 5; i++) {
      page.emit('response', fakeResponse({ url: 'https://app.test/api/status', body: '{"ok":true}', onBody: () => (polled += 1) }));
      await flush();
    }
    // Shape learned on the first read; the other four hits cost nothing.
    expect(polled).toBe(1);
    expect(observer.endpoints()[0]?.responseShape).toBe('{ ok: boolean }');

    let stuck = 0;
    for (let i = 0; i < 5; i++) {
      page.emit('response', fakeResponse({ url: 'https://app.test/api/stream', bodyFails: true, onBody: () => (stuck += 1) }));
      await flush();
    }
    expect(stuck).toBe(2);
  });

  it('evicts the least recently seen endpoint past the cap', async () => {
    const page = new FakePage();
    const observer = new NetworkObserver(page as unknown as Page, { maxEndpoints: 2, captureBodies: false });
    observer.attach();

    page.emit('response', fakeResponse({ url: 'https://app.test/api/a' }));
    page.emit('response', fakeResponse({ url: 'https://app.test/api/b' }));
    // Touching /api/a again makes /api/b the least recently seen.
    page.emit('response', fakeResponse({ url: 'https://app.test/api/a' }));
    page.emit('response', fakeResponse({ url: 'https://app.test/api/c' }));
    await flush();

    const patterns = observer.endpoints().map((e) => e.pattern);
    expect(patterns).toHaveLength(2);
    expect(patterns).toContain('https://app.test/api/a');
    expect(patterns).toContain('https://app.test/api/c');
  });

  it('captures problems, dedupes consecutive ones and clears on drain', () => {
    const page = new FakePage();
    const observer = new NetworkObserver(page as unknown as Page);
    observer.attach();

    page.emit('console', { type: () => 'error', text: () => 'boom' });
    page.emit('console', { type: () => 'error', text: () => 'boom' });
    page.emit('console', { type: () => 'error', text: () => 'boom' });
    page.emit('console', { type: () => 'warning', text: () => 'ignored' });
    page.emit('pageerror', new Error('TypeError: x is not a function'));
    page.emit('requestfailed', fakeFailedRequest('https://app.test/api/x', 'net::ERR_CONNECTION_REFUSED'));
    // Self-inflicted (our blocking layer) and navigation-cancelled requests are noise.
    page.emit('requestfailed', fakeFailedRequest('https://app.test/pixel.gif', 'net::ERR_BLOCKED_BY_CLIENT', 'image'));
    page.emit('requestfailed', fakeFailedRequest('https://app.test/api/y', 'net::ERR_ABORTED'));

    expect(observer.drainProblems()).toEqual([
      'console.error: boom (x3)',
      'pageerror: TypeError: x is not a function',
      'request failed: GET /api/x — net::ERR_CONNECTION_REFUSED',
    ]);
    expect(observer.drainProblems()).toEqual([]);
  });

  it('caps the problem list and says how many were suppressed', () => {
    const page = new FakePage();
    const observer = new NetworkObserver(page as unknown as Page);
    observer.attach();

    for (let i = 0; i < 25; i++) {
      page.emit('console', { type: () => 'error', text: () => `boom ${i}` });
    }

    const problems = observer.drainProblems();
    expect(problems).toHaveLength(20);
    expect(problems[18]).toBe('console.error: boom 18');
    expect(problems[19]).toBe('… 5 more problems suppressed');
  });

  it('truncates long problem lines', () => {
    const page = new FakePage();
    const observer = new NetworkObserver(page as unknown as Page);
    observer.attach();

    page.emit('console', { type: () => 'error', text: () => 'x'.repeat(500) });
    const line = observer.drainProblems()[0] ?? '';
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line.endsWith('…')).toBe(true);
  });

  it('reset clears endpoints and problems', async () => {
    const page = new FakePage();
    const observer = new NetworkObserver(page as unknown as Page);
    observer.attach();

    page.emit('response', fakeResponse({ url: 'https://app.test/api/a' }));
    page.emit('console', { type: () => 'error', text: () => 'boom' });
    await flush();
    expect(observer.endpoints()).toHaveLength(1);

    observer.reset();
    expect(observer.endpoints()).toHaveLength(0);
    expect(observer.drainProblems()).toEqual([]);
  });

  it('attach is idempotent', () => {
    const page = new FakePage();
    const observer = new NetworkObserver(page as unknown as Page);
    observer.attach();
    observer.attach();
    expect(page.listenerCount('response')).toBe(1);
    observer.detach();
    expect(page.listenerCount('response')).toBe(0);
  });
});
