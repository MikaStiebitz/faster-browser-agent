/**
 * faster-browser-agent — public API.
 *
 * The MCP server is one consumer of this library, not the library itself:
 * everything the tools do (deep-linking from the code index, one-round-trip
 * perception, action programs, skill replay, per-workspace profiles) is
 * available directly from Node through `createAgentBrowser`.
 *
 * The MCP entry points live behind the `faster-browser-agent/mcp` subpath so
 * that importing the library does not drag in the protocol SDK.
 */

// --- data contracts --------------------------------------------------------

export * from './types.js';
export * from './contracts.js';

// --- configuration ---------------------------------------------------------

export { defaultConfig, defaultHome, loadConfig, paths, type LoadConfigOptions } from './config.js';

// --- L0: browsers, profiles, workspaces ------------------------------------

export {
  DefaultBrowserPool,
  getSharedPool,
  shutdownSharedPool,
  type PoolDeps,
} from './browser/pool.js';

export { PageSession, createSession, type SessionDeps } from './browser/session.js';

export { FsProfileManager, detectWorkspace, workspaceIdFor } from './browser/profile.js';

export {
  browserLaunchArgs,
  browserSearchPaths,
  checkBrowser,
  contextOptions,
  launchPersistentContext,
  resolveExecutablePath,
} from './browser/launcher.js';

export {
  applyBlocking,
  blockingStats,
  categoryFor,
  resetBlockingStats,
  shouldBlock,
  type BlockingHandle,
} from './browser/blocking.js';

// Session injection. An embedded integration needs these before it can browse
// anything real, so they belong on the public surface, not only behind the MCP
// `browser_session` tool.
export {
  clearCookies,
  exportState,
  getCookies,
  getStorage,
  importState,
  normalizeCookies,
  readStateFile,
  setCookies,
  setStorage,
  type CookieInput,
  type CookieSpec,
  type StorageSnapshot,
  type StorageState,
} from './browser/state.js';

// --- L1: perception --------------------------------------------------------

export { PAGE_RUNTIME_SOURCE, RUNTIME_VERSION } from './runtime/index.js';

export {
  capture,
  describeCapture,
  type CaptureOptions,
  type CaptureResult,
} from './browser/capture.js';

// --- L3: what the agent learns by browsing ---------------------------------

export {
  FsSiteMemoryStore,
  digestSnapshot,
  originOf,
  originSlug,
  pagePattern,
  urlForPattern,
  type PageDigest,
  type SiteMemoryStore,
} from './site/index.js';

export {
  diffCost,
  diffSnapshots,
  flattenSnapshot,
  preferDiff,
  snapshotCost,
} from './runtime/diff.js';

export {
  serializeDiff,
  serializeObservation,
  serializeSnapshot,
  serializeTree,
  summarize,
  type SerializeOptions,
} from './runtime/serialize.js';

export {
  NetworkObserver,
  describeShape,
  replayEndpoint,
  urlPattern,
  type NetworkObserverOptions,
  type ReplayResult,
} from './net/observer.js';

// --- L2: acting ------------------------------------------------------------

// Mocking, blocking and going offline are things the agent does *to* the page,
// which is why they sit here rather than beside the observer above.
export {
  NetControl,
  patternMatches,
  type BlockRule,
  type MockRule,
} from './net/control.js';

export * from './executor/index.js';

// --- L3: code index and skills ---------------------------------------------

export * from './code/index.js';
export * from './skills/index.js';

// --- utilities -------------------------------------------------------------

export { FbaError, errorMessage, isFbaError, toFbaError } from './util/errors.js';
export { createLogger, getLogLevel, log, setLogLevel, type Logger } from './util/logger.js';
export {
  bestMatch,
  cssEscapeValue,
  fuzzyScore,
  matchKey,
  normalizeText,
  plural,
  rankMatches,
  shortHash,
  tokenize,
  truncate,
  type ScoredMatch,
} from './util/text.js';

// ---------------------------------------------------------------------------
// Convenience wiring
// ---------------------------------------------------------------------------

import { getSharedPool, shutdownSharedPool } from './browser/pool.js';
import { detectWorkspace } from './browser/profile.js';
import { FsCodeIndexer } from './code/indexer.js';
import { loadConfig } from './config.js';
import type { BrowserPool, CodeIndexer, Executor, Session, SkillRunner, SkillStore } from './contracts.js';
import { DefaultExecutor } from './executor/act.js';
import { resolveNavigation } from './mcp/tools.js';
import { FsSiteMemoryStore, type SiteMemoryStore } from './site/memory.js';
import { DefaultSkillRunner } from './skills/runner.js';
import { FsSkillStore } from './skills/store.js';
import type { FbaConfig } from './types.js';
import { setLogLevel } from './util/logger.js';

export interface AgentBrowser {
  config: FbaConfig;
  pool: BrowserPool;
  indexer: CodeIndexer;
  skills: SkillStore;
  runner: SkillRunner;
  executor: Executor;
  /** Per-origin knowledge accumulated by browsing; undefined when disabled. */
  memory?: SiteMemoryStore;
  /** Close every browser this process opened and release the profile locks. */
  shutdown(): Promise<void>;
}

/**
 * Assemble the whole stack with sane defaults.
 *
 * The only non-obvious part is `onNavigate`: the executor deliberately has no
 * dependency on the code index, so route resolution for `{ do: 'goto', route }`
 * steps is injected here. Without it a `route` step would have nothing to
 * resolve against and would fail with INVALID_ARGUMENT.
 */
export async function createAgentBrowser(overrides?: Partial<FbaConfig>): Promise<AgentBrowser> {
  const config = loadConfig(overrides ? { overrides } : {});
  setLogLevel(config.logLevel);

  const indexer = new FsCodeIndexer(config);
  const skills = new FsSkillStore(config);
  const memory = config.siteMemory ? new FsSiteMemoryStore(config) : undefined;
  const pool = getSharedPool(config, memory);

  const executor = new DefaultExecutor({
    ...(memory ? { memory } : {}),
    onNavigate: async (session: Session, spec: { url?: string; route?: string }): Promise<void> => {
      const workspace = await detectWorkspace(config.workspace ?? process.cwd());
      const resolved = await resolveNavigation({ config, indexer }, workspace.root, spec);
      await session.goto(resolved.url);
    },
  });
  const runner = new DefaultSkillRunner(skills, executor);

  // Async only so callers can `await` a single factory and so future eager work
  // (index prebuild, browser warm) can move in here without a signature change.
  return {
    config,
    pool,
    indexer,
    skills,
    runner,
    executor,
    ...(memory ? { memory } : {}),
    shutdown: shutdownSharedPool,
  };
}
