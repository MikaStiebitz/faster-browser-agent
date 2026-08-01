/**
 * Browser pool (L0).
 *
 * One persistent Chromium context per *workspace*, keyed by `WorkspaceInfo.id`.
 * That single decision is the whole workspace-isolation guarantee: two agents
 * working in two git worktrees get two profile directories, therefore two cookie
 * jars, two localStorages and two sets of logins, and neither can invalidate the
 * other's session by logging out.
 *
 * Everything else here exists to make that cheap:
 *   - contexts are launched lazily and kept warm,
 *   - concurrent acquisitions for one workspace share a single launch,
 *   - idle contexts are reaped so a long-lived MCP server does not accumulate
 *     browsers,
 *   - `maxContexts` bounds memory by evicting the least-recently-used context
 *     that nobody is using.
 */

import { clearInterval, setInterval } from 'node:timers';

import type { BrowserContext, Page } from 'playwright-core';

import type { AcquireOptions, BrowserPool, ProfileManager, Session } from '../contracts.js';
import type { FbaConfig, SessionInfo, WorkspaceInfo } from '../types.js';
import { FbaError, errorMessage } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { applyBlocking, type BlockingHandle } from './blocking.js';
import { launchPersistentContext } from './launcher.js';
import { FsProfileManager } from './profile.js';
import type { SiteMemoryStore } from '../site/memory.js';
import { PageSession, createSession } from './session.js';

const logger = createLogger('pool');

/**
 * How often the reaper runs. Deliberately coarse — closing an idle browser a
 * few seconds late costs nothing, and a frequent timer in a long-lived server
 * is pure overhead.
 */
const REAP_INTERVAL_MS = 30_000;

export interface PoolDeps {
  config: FbaConfig;
  profiles?: ProfileManager;
  /**
   * Per-origin site memory. Shared across every session in the pool on purpose:
   * what one tab learns about a site is immediately useful to the next, and to
   * the next agent that opens the same origin.
   */
  memory?: SiteMemoryStore;
}

interface ContextEntry {
  workspace: WorkspaceInfo;
  context: BrowserContext;
  profileDir: string;
  release: () => Promise<void>;
  blocking: BlockingHandle;
  sessions: Map<string, PageSession>;
  createdAt: number;
  lastUsedAt: number;
  /** Set while we are tearing it down, so the `close` event does not re-enter. */
  closing: boolean;
}

export class DefaultBrowserPool implements BrowserPool {
  private readonly config: FbaConfig;
  private readonly profiles: ProfileManager;
  private readonly memory: SiteMemoryStore | undefined;

  private readonly contexts = new Map<string, ContextEntry>();
  /**
   * In-flight launches, keyed by workspace id.
   *
   * Two `acquire()` calls for the same workspace arriving before the browser is
   * up must NOT launch two Chromiums: the second would find the profile
   * directory locked and silently fall back to an ephemeral clone, giving the
   * agent a second browser with no cookies. Memoising the promise makes the
   * second caller await the first launch instead.
   */
  private readonly launching = new Map<string, Promise<ContextEntry>>();
  /** session id -> owning context, so `closeSession` is O(1). */
  private readonly sessionIndex = new Map<string, ContextEntry>();

  private reaper: NodeJS.Timeout | undefined;
  private shuttingDown: Promise<void> | undefined;

  constructor(deps: PoolDeps) {
    this.config = deps.config;
    this.profiles = deps.profiles ?? new FsProfileManager(deps.config);
    this.memory = deps.memory;
    livePools.add(this);
    installExitHandlers();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async acquire(options: AcquireOptions = {}): Promise<Session> {
    if (this.shuttingDown) {
      throw new FbaError('NO_BROWSER', 'the browser pool is shutting down');
    }

    if (options.sessionId) {
      const existing = this.get(options.sessionId);
      if (existing) return existing;
      // Falling through rather than throwing: a stale session id after a reap
      // or a crash should transparently get the agent a working tab back.
      logger.debug(`session ${options.sessionId} is gone; opening a new one`);
    }

    const workspace = await this.profiles.describe(options.workspace ?? this.config.workspace);
    const entry = await this.contextFor(workspace);
    entry.lastUsedAt = Date.now();

    if (!options.fresh) {
      const reusable = mostRecentlyUsed(entry.sessions);
      if (reusable) return reusable;
    }
    return this.openSession(entry, options.fresh === true);
  }

  get(sessionId: string): Session | undefined {
    const entry = this.sessionIndex.get(sessionId);
    const session = entry?.sessions.get(sessionId);
    if (!session) return undefined;
    if (session.isClosed()) {
      this.forgetSession(sessionId);
      return undefined;
    }
    if (entry) entry.lastUsedAt = Date.now();
    return session;
  }

  list(): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const entry of this.contexts.values()) {
      for (const session of entry.sessions.values()) out.push(session.info());
    }
    return out.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  async closeSession(sessionId: string): Promise<void> {
    const entry = this.sessionIndex.get(sessionId);
    const session = entry?.sessions.get(sessionId);
    this.forgetSession(sessionId);
    // The context stays warm on purpose: reopening a tab costs milliseconds,
    // relaunching a browser costs seconds.
    if (session) await session.close().catch(() => undefined);
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    const pending = this.launching.get(workspaceId);
    if (pending) {
      // A launch in flight would otherwise register its context right after we
      // finished tearing everything down.
      await pending.catch(() => undefined);
    }
    const entry = this.contexts.get(workspaceId);
    if (!entry) return;
    await this.teardown(entry);
  }

  /**
   * Pre-launch a browser and open one blank tab.
   *
   * Cold start is 0.3-8s in practice: ~300ms when the binary is already in the
   * page cache and the profile exists (measured here), 1-3s on a typical laptop
   * launch, and up to ~8s for the first launch in a cold container, where
   * process spawn, profile initialisation and sandbox setup all pay full price.
   * Paying that while
   * the agent is still deciding what to do — rather than inside its first tool
   * call — is one of the largest perceived-latency wins available to us, and it
   * costs nothing when the agent never shows up beyond an idle browser that the
   * reaper collects.
   */
  async warm(workspace?: string): Promise<void> {
    if (this.shuttingDown) return;
    const info = await this.profiles.describe(workspace ?? this.config.workspace);
    const entry = await this.contextFor(info);
    entry.lastUsedAt = Date.now();
    // Already warm: a live session (or a spare tab from an earlier warm) means
    // there is nothing left to prepay, and opening more tabs would just leak.
    if (entry.sessions.size > 0 || unclaimedPage(entry)) return;
    try {
      // Left unclaimed so the next `acquire()` adopts it instead of opening
      // another tab.
      await entry.context.newPage();
    } catch (e) {
      logger.debug(`warm page failed: ${errorMessage(e)}`);
    }
  }

  async shutdown(): Promise<void> {
    // Idempotent, and a second caller awaits the first shutdown rather than
    // racing it — closing the same context twice throws inside playwright.
    if (this.shuttingDown) return this.shuttingDown;
    this.shuttingDown = this.doShutdown();
    return this.shuttingDown;
  }

  private async doShutdown(): Promise<void> {
    livePools.delete(this);
    // Buffered learning is written before the browsers go away; losing it would
    // silently undo the whole point of the memory layer.
    await this.memory?.close().catch(() => undefined);
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }
    for (const pending of [...this.launching.values()]) await pending.catch(() => undefined);
    for (const entry of [...this.contexts.values()]) {
      await this.teardown(entry);
    }
    this.contexts.clear();
    this.sessionIndex.clear();
  }

  // -------------------------------------------------------------------------
  // Contexts
  // -------------------------------------------------------------------------

  private contextFor(workspace: WorkspaceInfo): Promise<ContextEntry> {
    const existing = this.contexts.get(workspace.id);
    if (existing && !existing.closing) return Promise.resolve(existing);

    const pending = this.launching.get(workspace.id);
    if (pending) return pending;

    const launch = this.launch(workspace);
    this.launching.set(workspace.id, launch);
    // `finally` on the stored promise, not on the returned one: the entry must
    // be cleared exactly once, whichever caller happens to await it.
    void launch.catch(() => undefined).finally(() => {
      this.launching.delete(workspace.id);
    });
    return launch;
  }

  private async launch(workspace: WorkspaceInfo): Promise<ContextEntry> {
    await this.enforceContextCap();

    const profile = await this.profiles.acquire(workspace);
    let context: BrowserContext;
    try {
      context = await launchPersistentContext(profile.dir, this.config);
    } catch (e) {
      // Never strand the lock on a launch failure — the next attempt would get
      // an ephemeral clone and no cookies.
      await profile.release().catch(() => undefined);
      throw e;
    }

    let blocking: BlockingHandle;
    try {
      blocking = await applyBlocking(context, this.config.blocking);
    } catch (e) {
      await context.close().catch(() => undefined);
      await profile.release().catch(() => undefined);
      throw e;
    }

    const entry: ContextEntry = {
      workspace,
      context,
      profileDir: profile.dir,
      release: () => profile.release(),
      blocking,
      sessions: new Map<string, PageSession>(),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      closing: false,
    };

    context.on('close', () => {
      // The browser died on its own (crash, or a human closing the window).
      if (entry.closing) return;
      logger.debug(`context for ${workspace.id} closed externally`);
      void this.teardown(entry);
    });

    this.contexts.set(workspace.id, entry);
    this.startReaper();
    logger.info(
      `browser ready for workspace ${workspace.id}${profile.ephemeral ? ' (ephemeral profile)' : ''} at ${profile.dir}`,
    );
    return entry;
  }

  /**
   * Keep the number of live contexts under `maxContexts`.
   *
   * Only contexts with no live sessions are eligible: evicting one that an agent
   * is mid-flow in would destroy its refs and its login. If nothing is
   * evictable we exceed the cap rather than fail the call — the cap is a memory
   * hint, and refusing to open a browser is a much worse outcome than one extra
   * browser.
   */
  private async enforceContextCap(): Promise<void> {
    const cap = Math.max(1, this.config.maxContexts);
    while (this.contexts.size >= cap) {
      let victim: ContextEntry | undefined;
      for (const entry of this.contexts.values()) {
        if (entry.closing || entry.sessions.size > 0) continue;
        if (!victim || entry.lastUsedAt < victim.lastUsedAt) victim = entry;
      }
      if (!victim) {
        logger.warn(
          `all ${this.contexts.size} browser contexts are in use; exceeding maxContexts=${cap} for workspace isolation`,
        );
        return;
      }
      logger.debug(`evicting idle context ${victim.workspace.id} to stay under maxContexts=${cap}`);
      await this.teardown(victim);
    }
  }

  /** Close a context and everything hanging off it. Safe to call twice. */
  private async teardown(entry: ContextEntry): Promise<void> {
    if (entry.closing) return;
    entry.closing = true;
    this.contexts.delete(entry.workspace.id);

    for (const session of [...entry.sessions.values()]) {
      this.sessionIndex.delete(session.id);
      await session.close().catch(() => undefined);
    }
    entry.sessions.clear();

    await entry.blocking.detach().catch(() => undefined);
    await entry.context.close().catch((e: unknown) => {
      logger.debug(`context close failed: ${errorMessage(e)}`);
    });
    // The lock must be released after the browser is really gone, otherwise
    // another process could grab the profile dir while Chromium still holds it.
    await entry.release().catch((e: unknown) => {
      logger.warn(`could not release profile ${entry.workspace.id}: ${errorMessage(e)}`);
    });
    logger.debug(`closed context for ${entry.workspace.id}`);
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  private async openSession(entry: ContextEntry, fresh: boolean): Promise<PageSession> {
    let page: Page | undefined;
    if (!fresh) {
      // A persistent context always starts with one blank page, and `warm()`
      // may have opened another. Adopting one avoids an extra tab (and, for the
      // very first session, an extra round trip).
      page = unclaimedPage(entry);
    }
    if (!page) page = await entry.context.newPage();

    const session = await createSession(page, {
      config: this.config,
      workspaceId: entry.workspace.id,
      ...(this.memory ? { memory: this.memory } : {}),
      onClose: (id) => {
        entry.sessions.delete(id);
        this.sessionIndex.delete(id);
      },
    });

    entry.sessions.set(session.id, session);
    this.sessionIndex.set(session.id, entry);
    entry.lastUsedAt = Date.now();
    return session;
  }

  private forgetSession(sessionId: string): void {
    const entry = this.sessionIndex.get(sessionId);
    this.sessionIndex.delete(sessionId);
    entry?.sessions.delete(sessionId);
  }

  // -------------------------------------------------------------------------
  // Idle reaping
  // -------------------------------------------------------------------------

  private startReaper(): void {
    if (this.reaper || this.config.idleTimeoutMs <= 0) return;
    const period = Math.max(1_000, Math.min(REAP_INTERVAL_MS, this.config.idleTimeoutMs));
    this.reaper = setInterval(() => {
      void this.reapIdle();
    }, period);
    // An idle-cleanup timer must never be the reason a CLI process refuses to
    // exit.
    this.reaper.unref();
  }

  private async reapIdle(): Promise<void> {
    if (this.shuttingDown) return;
    const now = Date.now();
    for (const entry of [...this.contexts.values()]) {
      if (entry.closing) continue;
      // Idleness is measured across the context AND its sessions: a session
      // that was acquired an hour ago and never used again must not pin a
      // browser open forever, but one being actively driven must not be reaped
      // just because nothing new was acquired.
      let idleSince = entry.lastUsedAt;
      for (const session of entry.sessions.values()) {
        idleSince = Math.max(idleSince, session.info().lastUsedAt);
      }
      if (now - idleSince < this.config.idleTimeoutMs) continue;
      logger.info(`closing idle browser for ${entry.workspace.id} after ${Math.round((now - idleSince) / 1000)}s`);
      await this.teardown(entry);
    }
    if (this.contexts.size === 0 && this.reaper) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Reuse helpers
// ---------------------------------------------------------------------------

function mostRecentlyUsed(sessions: Map<string, PageSession>): PageSession | undefined {
  let best: PageSession | undefined;
  let bestAt = -1;
  for (const session of sessions.values()) {
    if (session.isClosed()) continue;
    const at = session.info().lastUsedAt;
    if (at > bestAt) {
      best = session;
      bestAt = at;
    }
  }
  return best;
}

/** A page in the context that no session has taken ownership of. */
function unclaimedPage(entry: ContextEntry): Page | undefined {
  const claimed = new Set<Page>();
  for (const session of entry.sessions.values()) claimed.add(session.page);
  for (const page of entry.context.pages()) {
    if (!page.isClosed() && !claimed.has(page)) return page;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

let sharedPool: DefaultBrowserPool | undefined;

/**
 * The pool the MCP server and the CLI share.
 *
 * A singleton because the profile lock is per *process*: two pools in one
 * process would fight over the same profile directories and the loser would
 * silently get ephemeral clones.
 */
export function getSharedPool(config: FbaConfig, memory?: SiteMemoryStore): DefaultBrowserPool {
  if (!sharedPool) sharedPool = new DefaultBrowserPool({ config, ...(memory ? { memory } : {}) });
  return sharedPool;
}

export async function shutdownSharedPool(): Promise<void> {
  const pool = sharedPool;
  sharedPool = undefined;
  if (pool) await pool.shutdown();
}

// ---------------------------------------------------------------------------
// Process exit
// ---------------------------------------------------------------------------

const livePools = new Set<DefaultBrowserPool>();
let exitHandlersInstalled = false;
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Close browsers on the way out.
 *
 * We never call `process.exit()`: another layer may still be flushing, and the
 * profile lock cleanup in `profile.ts` runs on the same signals. Instead we
 * shut the pools down, remove our own listener, and re-raise the signal so
 * whatever disposition would have applied without us applies again.
 */
function installExitHandlers(): void {
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;

  for (const signal of SIGNALS) {
    const handler = (): void => {
      void Promise.all([...livePools].map((pool) => pool.shutdown().catch(() => undefined))).finally(() => {
        sharedPool = undefined;
        process.off(signal, handler);
        process.kill(process.pid, signal);
      });
    };
    process.on(signal, handler);
  }
}
