/**
 * Configuration resolution.
 *
 * Precedence (highest first):
 *   1. explicit overrides passed in code / on the CLI
 *   2. environment variables (FBA_*)
 *   3. `.fbarc.json` or `fba.config.json` in the workspace root
 *   4. `config.json` in the FBA home directory
 *   5. built-in defaults
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  DEFAULT_BLOCKING,
  DEFAULT_SETTLE_OPTIONS,
  DEFAULT_SNAPSHOT_OPTIONS,
  type BlockingPolicy,
  type FbaConfig,
  type LogLevel,
} from './types.js';
import { createLogger } from './util/logger.js';

const logger = createLogger('config');

const CONFIG_FILENAMES = ['.fbarc.json', 'fba.config.json', '.fba/config.json'];

export function defaultHome(): string {
  const home = envPath('FBA_HOME');
  return home ? resolve(home) : join(homedir(), '.faster-browser-agent');
}

export function defaultConfig(): FbaConfig {
  return {
    home: defaultHome(),
    headless: true,
    browserArgs: [],
    blocking: { ...DEFAULT_BLOCKING, categories: [...DEFAULT_BLOCKING.categories], patterns: [...DEFAULT_BLOCKING.patterns], allow: [] },
    snapshot: { ...DEFAULT_SNAPSHOT_OPTIONS },
    settle: { ...DEFAULT_SETTLE_OPTIONS },
    timeoutMs: 15_000,
    idleTimeoutMs: 5 * 60_000,
    maxContexts: 8,
    viewport: { width: 1440, height: 900 },
    codeIndex: true,
    skills: true,
    siteMemory: true,
    networkObserver: true,
    logLevel: 'warn',
  };
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    logger.warn(`ignoring ${path}: expected a JSON object`);
  } catch (e) {
    logger.warn(`ignoring ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return undefined;
}

/**
 * Read an env var, ignoring values a host failed to expand.
 *
 * MCP configs are templated (`${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_DATA}`),
 * and a host that does not define one passes the placeholder through verbatim.
 * Taking it literally is how a 7MB Chromium profile once ended up in a
 * directory named `${CLAUDE_PLUGIN_DATA}` inside a git repository. Treating an
 * unexpanded placeholder as "unset" falls back to the correct default instead.
 */
function envPath(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  if (/\$\{[^}]*\}/.test(raw) || /^%\w+%$/.test(raw)) {
    logger.warn(`ignoring ${name}: "${raw}" looks like an unexpanded placeholder`);
    return undefined;
  }
  return raw;
}

function envBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  return !/^(0|false|no|off)$/i.test(raw);
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function envList(name: string): string[] | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Shallow-merge that treats `undefined` as "not specified". */
function assign<T extends object>(base: T, patch: Partial<T> | undefined): T {
  if (!patch) return base;
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (base as Record<string, unknown>)[k] = v;
  }
  return base;
}

function mergeBlocking(base: BlockingPolicy, patch: unknown): BlockingPolicy {
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as Partial<BlockingPolicy>;
  return {
    enabled: p.enabled ?? base.enabled,
    categories: p.categories ?? base.categories,
    // Extra patterns add to the built-in list rather than replacing it, which
    // is almost always what a user editing config actually wants.
    patterns: p.patterns ? [...base.patterns, ...p.patterns] : base.patterns,
    allow: p.allow ?? base.allow,
  };
}

export interface LoadConfigOptions {
  /** Workspace root used to look for project-level config files. */
  workspace?: string;
  /** Highest-precedence overrides. */
  overrides?: Partial<FbaConfig>;
}

export function loadConfig(options: LoadConfigOptions = {}): FbaConfig {
  const config = defaultConfig();

  // (4) home config
  assign(config, readJsonFile(join(config.home, 'config.json')) as Partial<FbaConfig>);

  // (3) workspace config
  const workspace = options.workspace ?? options.overrides?.workspace ?? envPath('FBA_WORKSPACE');
  if (workspace) {
    for (const name of CONFIG_FILENAMES) {
      const found = readJsonFile(join(workspace, name));
      if (found) {
        const { blocking, ...rest } = found as Partial<FbaConfig> & { blocking?: unknown };
        assign(config, rest);
        config.blocking = mergeBlocking(config.blocking, blocking);
        break;
      }
    }
    config.workspace = workspace;
  }

  // (2) environment
  assign(config, {
    home: envPath('FBA_HOME') ? resolve(envPath('FBA_HOME')!) : undefined,
    workspace: envPath('FBA_WORKSPACE') ? resolve(envPath('FBA_WORKSPACE')!) : config.workspace,
    headless: envBool('FBA_HEADLESS'),
    executablePath: envPath('FBA_CHROMIUM_PATH') ?? envPath('FBA_EXECUTABLE_PATH'),
    browserArgs: envList('FBA_BROWSER_ARGS'),
    timeoutMs: envInt('FBA_TIMEOUT_MS'),
    idleTimeoutMs: envInt('FBA_IDLE_TIMEOUT_MS'),
    maxContexts: envInt('FBA_MAX_CONTEXTS'),
    codeIndex: envBool('FBA_CODE_INDEX'),
    skills: envBool('FBA_SKILLS'),
    siteMemory: envBool('FBA_SITE_MEMORY'),
    networkObserver: envBool('FBA_NETWORK_OBSERVER'),
    baseUrl: envPath('FBA_BASE_URL'),
    locale: process.env.FBA_LOCALE,
    timezone: process.env.FBA_TIMEZONE,
    userAgent: process.env.FBA_USER_AGENT,
    logLevel: process.env.FBA_LOG_LEVEL as LogLevel | undefined,
  });

  const blockEnabled = envBool('FBA_BLOCKING');
  if (blockEnabled !== undefined) config.blocking.enabled = blockEnabled;
  const extraPatterns = envList('FBA_BLOCK_PATTERNS');
  if (extraPatterns) config.blocking.patterns = [...config.blocking.patterns, ...extraPatterns];
  const allowPatterns = envList('FBA_ALLOW_PATTERNS');
  if (allowPatterns) config.blocking.allow = [...config.blocking.allow, ...allowPatterns];

  const vpWidth = envInt('FBA_VIEWPORT_WIDTH');
  const vpHeight = envInt('FBA_VIEWPORT_HEIGHT');
  if (vpWidth) config.viewport.width = vpWidth;
  if (vpHeight) config.viewport.height = vpHeight;

  const maxNodes = envInt('FBA_MAX_NODES');
  if (maxNodes) config.snapshot.maxNodes = maxNodes;

  // (1) explicit overrides
  const { blocking: overrideBlocking, snapshot, settle, viewport, ...restOverrides } = options.overrides ?? {};
  assign(config, restOverrides);
  if (overrideBlocking) config.blocking = mergeBlocking(config.blocking, overrideBlocking);
  if (snapshot) assign(config.snapshot, snapshot);
  if (settle) assign(config.settle, settle);
  if (viewport) assign(config.viewport, viewport);

  return config;
}

/** Directory holding profiles, skills and indexes for a given home. */
export function paths(config: FbaConfig) {
  return {
    home: config.home,
    profiles: join(config.home, 'profiles'),
    skills: join(config.home, 'skills'),
    indexes: join(config.home, 'indexes'),
    sites: join(config.home, 'sites'),
    logs: join(config.home, 'logs'),
  };
}
