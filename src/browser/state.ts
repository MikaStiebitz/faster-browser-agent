/**
 * Session-state injection: cookies, web storage, Playwright storage state.
 *
 * The reason this exists: a great many internal tools authenticate with a
 * server-set session cookie (`PHPSESSID`, a tenant id, a database selector).
 * Driving their login UI to obtain one is slow, brittle, and often impossible
 * from an agent (SSO, MFA). Injecting the cookies an operator already has turns
 * "log in first" into a single call — and it is the difference between this
 * driver being able to replace a bespoke automation script or not.
 *
 * Everything here is deliberately forgiving about input shape: an agent has a
 * cookie header string, or a `{name: value}` map, or a full Playwright cookie
 * array, and should not have to convert between them.
 */

import { readFile, writeFile } from 'node:fs/promises';

import type { BrowserContext, Page } from 'playwright-core';

import { FbaError, errorMessage, toFbaError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';

const logger = createLogger('state');

/** A cookie in Playwright's shape, with everything optional but name/value. */
export interface CookieSpec {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  url?: string;
}

export type CookieInput = string | Record<string, string> | CookieSpec[];

/**
 * Normalise any of the three shapes an agent might have into Playwright's.
 *
 * `url` is what lets Playwright derive domain and path, so a bare `{name:
 * value}` map works without the caller knowing cookie mechanics. An explicit
 * `domain` on an entry always wins — that is the escape hatch for a cookie that
 * has to span subdomains.
 */
export function normalizeCookies(input: CookieInput, url?: string): CookieSpec[] {
  const withScope = (cookie: CookieSpec): CookieSpec => {
    if (cookie.domain || cookie.url) return cookie;
    if (!url) {
      throw new FbaError('INVALID_ARGUMENT', `cookie "${cookie.name}" needs a domain or a url to scope it`, {
        hint: 'pass url (e.g. "https://app.example.com") alongside the cookies',
      });
    }
    return { ...cookie, url };
  };

  if (typeof input === 'string') {
    // A raw Cookie header: "a=1; b=2". This is what a browser devtools copy
    // produces, so accepting it verbatim saves a conversion step.
    return input
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf('=');
        if (eq <= 0) {
          throw new FbaError('INVALID_ARGUMENT', `malformed cookie fragment: "${part}"`);
        }
        return withScope({ name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() });
      });
  }

  if (Array.isArray(input)) {
    return input.map((cookie) => {
      if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') {
        throw new FbaError('INVALID_ARGUMENT', 'each cookie needs a name and a value');
      }
      return withScope(cookie);
    });
  }

  return Object.entries(input).map(([name, value]) => withScope({ name, value: String(value) }));
}

export async function setCookies(context: BrowserContext, input: CookieInput, url?: string): Promise<CookieSpec[]> {
  const cookies = normalizeCookies(input, url);
  try {
    await context.addCookies(cookies as Parameters<BrowserContext['addCookies']>[0]);
  } catch (e) {
    throw toFbaError(e, 'INVALID_ARGUMENT');
  }
  return cookies;
}

export async function getCookies(context: BrowserContext, url?: string): Promise<CookieSpec[]> {
  const cookies = await context.cookies(url ? [url] : undefined);
  return cookies as CookieSpec[];
}

export async function clearCookies(context: BrowserContext): Promise<void> {
  await context.clearCookies();
}

export interface StorageSnapshot {
  local: Record<string, string>;
  session: Record<string, string>;
}

/**
 * Read both web storages for the page's current origin.
 *
 * Storage is origin-scoped and only reachable from a document on that origin,
 * so unlike cookies this cannot be done on the context — the page has to be
 * there already.
 */
export async function getStorage(page: Page): Promise<StorageSnapshot> {
  return page.evaluate(() => {
    const dump = (store: Storage): Record<string, string> => {
      const out: Record<string, string> = {};
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key !== null) out[key] = store.getItem(key) ?? '';
      }
      return out;
    };
    return { local: dump(window.localStorage), session: dump(window.sessionStorage) };
  });
}

export async function setStorage(
  page: Page,
  values: { local?: Record<string, string>; session?: Record<string, string> },
): Promise<{ local: number; session: number }> {
  return page.evaluate((input) => {
    let local = 0;
    let session = 0;
    for (const [key, value] of Object.entries(input.local ?? {})) {
      window.localStorage.setItem(key, value);
      local += 1;
    }
    for (const [key, value] of Object.entries(input.session ?? {})) {
      window.sessionStorage.setItem(key, value);
      session += 1;
    }
    return { local, session };
  }, values);
}

/**
 * Playwright's `storageState` shape — cookies plus per-origin localStorage.
 * Supporting it verbatim means an operator can reuse a state file their
 * existing Playwright setup already produces.
 */
export interface StorageState {
  cookies?: CookieSpec[];
  origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
}

export async function exportState(context: BrowserContext, path?: string): Promise<StorageState> {
  const state = (await context.storageState()) as StorageState;
  if (path) {
    await writeFile(path, JSON.stringify(state, null, 2), 'utf8');
  }
  return state;
}

/**
 * Apply a storage state to a live context.
 *
 * Playwright can only accept `storageState` at context *creation*, which is no
 * use to an agent holding an already-open browser — so cookies go in directly
 * and localStorage is applied per origin by visiting it. Origins other than the
 * page's current one are skipped rather than navigated to: silently moving the
 * agent's tab somewhere else would be a far worse surprise than a partial
 * restore, and the result says which origins were skipped.
 */
export async function importState(
  context: BrowserContext,
  page: Page,
  state: StorageState,
): Promise<{ cookies: number; origins: string[]; skipped: string[] }> {
  const cookies = state.cookies ?? [];
  if (cookies.length > 0) {
    await context.addCookies(cookies as Parameters<BrowserContext['addCookies']>[0]);
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  let currentOrigin = '';
  try {
    currentOrigin = new URL(page.url()).origin;
  } catch {
    /* about:blank has no origin; every origin will be skipped */
  }

  for (const entry of state.origins ?? []) {
    if (!entry.localStorage || entry.localStorage.length === 0) continue;
    if (entry.origin !== currentOrigin) {
      skipped.push(entry.origin);
      continue;
    }
    try {
      await page.evaluate((items) => {
        for (const item of items) window.localStorage.setItem(item.name, item.value);
      }, entry.localStorage);
      applied.push(entry.origin);
    } catch (e) {
      logger.debug(`localStorage restore failed for ${entry.origin}: ${errorMessage(e)}`);
      skipped.push(entry.origin);
    }
  }

  return { cookies: cookies.length, origins: applied, skipped };
}

export async function readStateFile(path: string): Promise<StorageState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed as StorageState;
  } catch (e) {
    throw new FbaError('INVALID_ARGUMENT', `cannot read storage state from ${path}: ${errorMessage(e)}`, {
      hint: 'expected a Playwright storageState JSON file',
    });
  }
}
