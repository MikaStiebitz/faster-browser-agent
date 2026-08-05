/**
 * Runtime network control: mock, block, headers, offline.
 *
 * This exposes the useful half of Playwright's network API as agent-shaped
 * operations. The other half (HAR replay, websocket routing, throttling via
 * CDP) is deliberately left out — it is test-suite machinery, and every unused
 * capability would still cost schema tokens on every model turn.
 *
 * Why an agent wants this at all:
 *   - mock:  develop a UI against an API that does not exist yet, or force an
 *            error state ("what does the page do on a 500?") without touching
 *            the backend
 *   - block: kill a third-party script that slows or breaks automation
 *   - headers: inject an auth token once instead of driving a login UI
 *   - offline: test offline behaviour
 *
 * One route handler for everything: Playwright routes stack per call and
 * unrouting individual patterns is fiddly; a single '**' route consulting our
 * own rule tables makes add/remove/list trivially correct and keeps the
 * per-request overhead at one array scan.
 */

import type { Page } from 'playwright-core';

import { toFbaError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';

const logger = createLogger('net:control');

export interface MockRule {
  /** Substring or `*`-glob matched against the full URL. */
  pattern: string;
  method?: string;
  status: number;
  contentType: string;
  body: string;
  hits: number;
}

export interface BlockRule {
  pattern: string;
  hits: number;
}

/**
 * Match a rule pattern against a URL: plain substring, or a `*`-glob when the
 * pattern contains `*`. Anchoring is intentionally loose — agents paste path
 * fragments, not canonical URLs.
 */
export function patternMatches(pattern: string, url: string): boolean {
  if (!pattern) return false;
  if (!pattern.includes('*')) return url.includes(pattern);
  const regex = new RegExp(
    pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*'),
  );
  return regex.test(url);
}

export class NetControl {
  private readonly page: Page;
  private mocks: MockRule[] = [];
  private blocks: BlockRule[] = [];
  private extraHeaders: Record<string, string> = {};
  private routed = false;
  private offline = false;

  constructor(page: Page) {
    this.page = page;
  }

  /** Install the single catch-all route, once, on first use. */
  private async ensureRouted(): Promise<void> {
    if (this.routed) return;
    this.routed = true;
    await this.page.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      try {
        // Documents are never mocked or blocked — breaking the page's own
        // navigation is never what a mock rule meant.
        if (request.resourceType() !== 'document') {
          const mock = this.mocks.find(
            (m) => patternMatches(m.pattern, url) && (!m.method || m.method === request.method()),
          );
          if (mock) {
            mock.hits += 1;
            await route.fulfill({ status: mock.status, contentType: mock.contentType, body: mock.body });
            return;
          }
          const block = this.blocks.find((b) => patternMatches(b.pattern, url));
          if (block) {
            block.hits += 1;
            await route.abort('blockedbyclient');
            return;
          }
        }
        await route.continue();
      } catch (e) {
        // A route that throws mid-navigation is normal (page closed, request
        // already handled). Never let network control break the page.
        logger.debug(`route handler: ${toFbaError(e).message}`);
      }
    });
  }

  async mock(rule: { pattern: string; method?: string; status?: number; body?: unknown; contentType?: string }): Promise<MockRule> {
    await this.ensureRouted();
    // Replace an existing rule for the same pattern+method instead of
    // shadow-stacking — "mock it again" always means "with this new body".
    this.mocks = this.mocks.filter((m) => !(m.pattern === rule.pattern && m.method === rule.method?.toUpperCase()));
    const body = typeof rule.body === 'string' ? rule.body : JSON.stringify(rule.body ?? {});
    const entry: MockRule = {
      pattern: rule.pattern,
      ...(rule.method ? { method: rule.method.toUpperCase() } : {}),
      status: rule.status ?? 200,
      contentType: rule.contentType ?? 'application/json',
      body,
      hits: 0,
    };
    this.mocks.push(entry);
    return entry;
  }

  unmock(pattern?: string): number {
    const before = this.mocks.length;
    this.mocks = pattern ? this.mocks.filter((m) => m.pattern !== pattern) : [];
    return before - this.mocks.length;
  }

  async block(pattern: string): Promise<BlockRule> {
    await this.ensureRouted();
    let entry = this.blocks.find((b) => b.pattern === pattern);
    if (!entry) {
      entry = { pattern, hits: 0 };
      this.blocks.push(entry);
    }
    return entry;
  }

  allow(pattern?: string): number {
    const before = this.blocks.length;
    this.blocks = pattern ? this.blocks.filter((b) => b.pattern !== pattern) : [];
    return before - this.blocks.length;
  }

  async setHeaders(headers: Record<string, string>): Promise<void> {
    // Merge rather than replace: setting an auth header must not silently drop
    // a language header set a call earlier.
    this.extraHeaders = { ...this.extraHeaders, ...headers };
    // Empty-string value removes a header.
    for (const [k, v] of Object.entries(this.extraHeaders)) {
      if (v === '') delete this.extraHeaders[k];
    }
    await this.page.setExtraHTTPHeaders(this.extraHeaders);
  }

  async setOffline(offline: boolean): Promise<void> {
    this.offline = offline;
    await this.page.context().setOffline(offline);
  }

  async clear(): Promise<void> {
    this.mocks = [];
    this.blocks = [];
    if (Object.keys(this.extraHeaders).length > 0) {
      this.extraHeaders = {};
      await this.page.setExtraHTTPHeaders({});
    }
    if (this.offline) await this.setOffline(false);
  }

  /** Compact state report for the tool result. */
  describe(): string[] {
    const lines: string[] = [];
    if (this.offline) lines.push('OFFLINE mode active');
    for (const m of this.mocks) {
      lines.push(`mock  ${m.method ?? 'ANY'} ${m.pattern} -> ${m.status} ${m.contentType} (${m.hits} hits)`);
    }
    for (const b of this.blocks) lines.push(`block ${b.pattern} (${b.hits} hits)`);
    const headerNames = Object.keys(this.extraHeaders);
    if (headerNames.length > 0) lines.push(`headers set: ${headerNames.join(', ')}`);
    if (lines.length === 0) lines.push('no active rules');
    return lines;
  }
}
