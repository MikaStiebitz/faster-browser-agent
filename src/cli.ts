#!/usr/bin/env node
/**
 * `fba` — the command line entry point.
 *
 * Two audiences, one binary:
 *
 *   - agent hosts run `fba mcp`, which speaks MCP over stdio and must therefore
 *     never write a single byte to stdout that is not protocol,
 *   - humans run everything else to see what the agent sees, to find out why it
 *     is broken (`doctor`), and to check the performance claims (`bench`).
 *
 * There are deliberately no CLI dependencies. A tool whose pitch is startup
 * latency should not spend 40-80ms of every invocation requiring an argument
 * parser, a colour library and a table renderer; all three are a few dozen lines
 * each and are inlined below.
 */

import { createServer, type Server } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DefaultBrowserPool, getSharedPool, shutdownSharedPool } from './browser/pool.js';
import { browserSearchPaths, checkBrowser, resolveExecutablePath } from './browser/launcher.js';
import { FsProfileManager, detectWorkspace } from './browser/profile.js';
import { FsCodeIndexer } from './code/indexer.js';
import { absoluteUrl } from './code/match.js';
import { loadConfig, paths } from './config.js';
import type { Session } from './contracts.js';
import { DefaultExecutor } from './executor/act.js';
import { serializeObservation, serializeSnapshot } from './runtime/serialize.js';
import { DefaultSkillRunner } from './skills/runner.js';
import { FsSkillStore, normalizeOrigin } from './skills/store.js';
import type {
  ActionStep,
  CodeIndex,
  CodeMatch,
  FbaConfig,
  LogLevel,
  Observation,
  RouteEntry,
  SkillRecord,
  StepResult,
  WorkspaceInfo,
} from './types.js';
import { FbaError, errorMessage, isFbaError } from './util/errors.js';
import { setLogLevel } from './util/logger.js';
import { plural, truncate } from './util/text.js';

// ---------------------------------------------------------------------------
// Package metadata
// ---------------------------------------------------------------------------

/**
 * Read our own version with `createRequire` rather than `import ... with { type:
 * 'json' }`: import attributes still require a flag on some Node 20.x releases
 * and change the emitted module shape under NodeNext, while `createRequire` has
 * behaved identically since Node 12. `../package.json` resolves correctly both
 * from `dist/cli.js` and from `src/cli.ts` during development.
 */
const packageJson = createRequire(import.meta.url)('../package.json') as {
  version?: string;
  engines?: { node?: string };
};

const VERSION = packageJson.version ?? '0.0.0';
const REQUIRED_NODE = (packageJson.engines?.node ?? '>=20.10.0').replace(/^[^\d]*/, '');

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

export interface ParsedArgv {
  command: string;
  args: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Flags that take a value.
 *
 * Knowing this up front is what removes the classic `--flag value` ambiguity:
 * without it, `fba open --headed /settings` would swallow `/settings` as the
 * value of `--headed`. Anything not listed here is a boolean unless written as
 * `--flag=value`.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  'workspace',
  'home',
  'log-level',
  'timeout',
  'limit',
  'chars',
  'scope',
  'max-nodes',
  'url',
  'origin',
  'on-failure',
  'param',
  'from',
  'to',
  'runs',
]);

/** Short flags. Only the two that every CLI is expected to answer to. */
const SHORT_FLAGS: Readonly<Record<string, string>> = {
  h: 'help',
  v: 'version',
};

/**
 * Separator used to keep repeated occurrences of one flag in a
 * `Record<string, string | boolean>`. NUL can never appear in an argv entry —
 * the kernel's argument strings are NUL-terminated — so it is the one byte that
 * is guaranteed not to collide with a user-supplied value.
 */
const MULTI_SEP = '\u0000';

/** `--logLevel` and `--log-level` should not be two different flags. */
function normalizeFlagName(raw: string): string {
  return raw.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

export function parseArgv(argv: string[]): ParsedArgv {
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let positionalOnly = false;

  const set = (name: string, value: string | boolean): void => {
    const existing = flags[name];
    // Repeated string flags accumulate (`--param a=1 --param b=2`); repeated
    // booleans are idempotent, and a boolean followed by a value is replaced.
    if (typeof existing === 'string' && typeof value === 'string') {
      flags[name] = `${existing}${MULTI_SEP}${value}`;
      return;
    }
    flags[name] = value;
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (positionalOnly) {
      args.push(token);
      continue;
    }
    if (token === '--') {
      positionalOnly = true;
      continue;
    }

    if (token.startsWith('--') && token.length > 2) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        set(normalizeFlagName(body.slice(0, eq)), body.slice(eq + 1));
        continue;
      }
      const name = normalizeFlagName(body);
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(name) && next !== undefined) {
        i += 1;
        set(name, next);
        continue;
      }
      // A value flag with nothing after it stays `true`; the command-level
      // accessor turns that into a usage error with a precise message.
      set(name, true);
      continue;
    }

    if (token.length > 1 && token.startsWith('-')) {
      for (const ch of token.slice(1)) {
        set(SHORT_FLAGS[ch] ?? ch, true);
      }
      continue;
    }

    args.push(token);
  }

  const command = args.shift() ?? '';
  return { command, args, flags };
}

/** Every value a repeatable flag was given, in order. */
export function flagList(flags: Record<string, string | boolean>, name: string): string[] {
  const raw = flags[name];
  if (typeof raw !== 'string') return [];
  return raw.split(MULTI_SEP).filter((value) => value.length > 0);
}

// ---------------------------------------------------------------------------
// Errors and exit codes
// ---------------------------------------------------------------------------

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

class UsageError extends Error {
  readonly usage: string | undefined;
  constructor(message: string, usage?: string) {
    super(message);
    this.name = 'UsageError';
    this.usage = usage;
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const processIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const ANSI = /\u001B\[[0-9;]*m/g;

interface Style {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

const PLAIN_STYLE: Style = {
  bold: (t) => t,
  dim: (t) => t,
  red: (t) => t,
  green: (t) => t,
  yellow: (t) => t,
  cyan: (t) => t,
};

function makeStyle(enabled: boolean): Style {
  if (!enabled) return PLAIN_STYLE;
  const wrap = (code: string) => (text: string): string => `\u001B[${code}m${text}\u001B[0m`;
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    cyan: wrap('36'),
  };
}

/**
 * Colour is opt-out in three independent ways because all three happen in
 * practice: piping into a file, the NO_COLOR convention, and an explicit flag.
 */
function colorEnabled(flags: Record<string, string | boolean>): boolean {
  if (flags['no-color'] !== undefined) return !parseBoolish(flags['no-color']);
  const color = flags['color'];
  if (color !== undefined) return parseBoolish(color);
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') return false;
  if (process.env['FORCE_COLOR'] !== undefined && process.env['FORCE_COLOR'] !== '0') return true;
  return process.stdout.isTTY === true;
}

function width(text: string): number {
  return text.replace(ANSI, '').length;
}

function pad(text: string, to: number, align: 'l' | 'r'): string {
  const gap = Math.max(0, to - width(text));
  return align === 'r' ? ' '.repeat(gap) + text : text + ' '.repeat(gap);
}

interface TableOptions {
  head?: readonly string[];
  align?: readonly ('l' | 'r')[];
  style?: Style;
  indent?: string;
}

/** Aligned columns, two spaces of gutter, no trailing whitespace. */
function renderTable(rows: readonly (readonly string[])[], options: TableOptions = {}): string[] {
  const style = options.style ?? PLAIN_STYLE;
  const indent = options.indent ?? '';
  const all = options.head ? [options.head, ...rows] : rows;
  if (all.length === 0) return [];

  const columns = all.reduce((max, row) => Math.max(max, row.length), 0);
  const widths: number[] = [];
  for (let c = 0; c < columns; c++) {
    widths[c] = all.reduce((max, row) => Math.max(max, width(row[c] ?? '')), 0);
  }

  const line = (row: readonly string[]): string => {
    const cells: string[] = [];
    for (let c = 0; c < columns; c++) {
      const cell = row[c] ?? '';
      // The last column is never padded — trailing spaces are pure noise when
      // the output is copied out of a terminal.
      cells.push(c === columns - 1 ? cell : pad(cell, widths[c] ?? 0, options.align?.[c] ?? 'l'));
    }
    return (indent + cells.join('  ')).replace(/\s+$/, '');
  };

  const out: string[] = [];
  if (options.head) out.push(style.dim(line(options.head)));
  for (const row of rows) out.push(line(row));
  return out;
}

function formatMs(ms: number): string {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 100) return `${Math.round(ms)}ms`;
  return `${ms.toFixed(1)}ms`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}${units[unit] ?? 'B'}`;
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

// ---------------------------------------------------------------------------
// Command context
// ---------------------------------------------------------------------------

const LOG_LEVELS: readonly LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug', 'trace'];

interface Ctx {
  io: Io;
  style: Style;
  json: boolean;
  debug: boolean;
  config: FbaConfig;
  /**
   * Just the settings the CLI itself decided, before the config file and
   * environment layers were folded in. Handed to components that resolve their
   * own config (the MCP server) so they apply the user's flags without
   * re-merging an already-merged config on top of itself.
   */
  overrides: Partial<FbaConfig>;
  workspace: WorkspaceInfo;
  args: string[];
  flags: Record<string, string | boolean>;
}

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new UsageError(`--${name} needs a value`);
  const first = raw.split(MULTI_SEP)[0];
  return first === undefined || first === '' ? undefined : first;
}

function flagNumber(flags: Record<string, string | boolean>, name: string): number | undefined {
  const raw = flagString(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${name} must be a number, got ${JSON.stringify(raw)}`);
  return value;
}

/** For the "how many" flags, where 0 or -1 would silently truncate output. */
function flagCount(flags: Record<string, string | boolean>, name: string): number | undefined {
  const value = flagNumber(flags, name);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`--${name} must be a positive whole number, got ${value}`);
  }
  return value;
}

function parseBoolish(value: string | boolean): boolean {
  if (typeof value === 'boolean') return value;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

function flagBool(flags: Record<string, string | boolean>, name: string): boolean | undefined {
  const raw = flags[name];
  return raw === undefined ? undefined : parseBoolish(raw);
}

const GLOBAL_FLAGS: readonly string[] = [
  'workspace',
  'home',
  'headless',
  'headed',
  'log-level',
  'json',
  'timeout',
  'no-color',
  'color',
  'help',
  'version',
];

/** Reject typos rather than silently ignoring them. */
function rejectUnknownFlags(flags: Record<string, string | boolean>, allowed: readonly string[], usage: string): void {
  const known = new Set([...GLOBAL_FLAGS, ...allowed]);
  const unknown = Object.keys(flags).filter((name) => !known.has(name));
  if (unknown.length > 0) {
    const label = unknown.length === 1 ? 'unknown flag' : 'unknown flags';
    throw new UsageError(`${label}: ${unknown.map((f) => `--${f}`).join(', ')}`, usage);
  }
}

async function buildContext(parsed: ParsedArgv, io: Io): Promise<Ctx> {
  const { flags } = parsed;

  const homeFlag = flagString(flags, 'home');
  // Routed through the environment on purpose: `loadConfig` reads
  // `<home>/config.json` *before* applying overrides, so a `--home` passed only
  // as an override would silently skip that file. FBA_HOME is read first.
  if (homeFlag) process.env['FBA_HOME'] = resolvePath(homeFlag);

  const workspaceFlag = flagString(flags, 'workspace');
  const workspace = await detectWorkspace(workspaceFlag ? resolvePath(workspaceFlag) : undefined);

  const overrides: Partial<FbaConfig> = { workspace: workspace.root };

  const headed = flagBool(flags, 'headed');
  const headless = flagBool(flags, 'headless');
  if (headed !== undefined) overrides.headless = !headed;
  if (headless !== undefined) overrides.headless = headless;

  const timeout = flagNumber(flags, 'timeout');
  if (timeout !== undefined) {
    if (timeout <= 0) throw new UsageError('--timeout must be a positive number of milliseconds');
    overrides.timeoutMs = timeout;
  }

  const levelFlag = flagString(flags, 'log-level');
  if (levelFlag !== undefined) {
    if (!LOG_LEVELS.includes(levelFlag as LogLevel)) {
      throw new UsageError(`--log-level must be one of ${LOG_LEVELS.join(', ')}`);
    }
    overrides.logLevel = levelFlag as LogLevel;
  }

  const config = loadConfig({ workspace: workspace.root, overrides });
  setLogLevel(config.logLevel);

  return {
    io,
    style: makeStyle(colorEnabled(flags)),
    json: flags['json'] === true,
    debug: config.logLevel === 'debug' || config.logLevel === 'trace',
    config,
    overrides,
    workspace,
    args: parsed.args,
    flags,
  };
}

function emitJson(ctx: Ctx, payload: unknown): void {
  ctx.io.out(JSON.stringify(payload, null, 2));
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const COMMANDS: ReadonlyArray<{ name: string; summary: string; usage: string }> = [
  {
    name: 'mcp',
    summary: 'start the MCP stdio server (what an agent host launches)',
    usage: 'fba mcp',
  },
  {
    name: 'doctor',
    summary: 'diagnose the install: node, chromium, home, workspace, profiles, index',
    usage: 'fba doctor [--json]',
  },
  {
    name: 'index',
    summary: 'build or refresh the code index for this workspace',
    usage: 'fba index [--force] [--json]',
  },
  {
    name: 'map',
    summary: 'search the code index and print ranked matches',
    usage: 'fba map [query] [--limit <n>] [--json]',
  },
  {
    name: 'open',
    summary: 'open a url or route and print the observation the agent would see',
    usage:
      'fba open <url|route> [--headed] [--full] [--scope viewport|page] [--max-nodes <n>] [--chars <n>] [--json]',
  },
  {
    name: 'act',
    summary: 'run an action program (JSON array of steps) and print the result',
    usage: 'fba act <json|@file|-> [--url <start-url>] [--on-failure stop|continue|retry] [--json]',
  },
  {
    name: 'skill',
    summary: 'manage and replay compiled trajectories',
    usage: 'fba skill list|show|run|delete [name] [--param k=v ...] [--origin <origin>] [--url <url>]',
  },
  {
    name: 'profiles',
    summary: 'manage per-workspace browser profiles',
    usage: 'fba profiles list|reset|seed [id] [--from <id> --to <id>]',
  },
  {
    name: 'warm',
    summary: 'pre-launch the browser for this workspace',
    usage: 'fba warm',
  },
  {
    name: 'bench',
    summary: 'micro-benchmark launch, navigation, snapshot, settle and serialize',
    usage: 'fba bench [url] [--runs <n>] [--json]',
  },
];

function helpText(style: Style): string[] {
  const lines: string[] = [
    `${style.bold('fba')} ${VERSION} — fast, code-aware browser automation for AI agents`,
    '',
    style.bold('USAGE'),
    '  fba <command> [args] [flags]',
    '',
    style.bold('COMMANDS'),
    ...renderTable(
      COMMANDS.map((c) => [c.name, c.summary]),
      { indent: '  ', style },
    ),
    '',
    style.bold('GLOBAL FLAGS'),
    ...renderTable(
      [
        ['--workspace <path>', 'workspace root (default: git root of the cwd)'],
        ['--home <path>', 'fba state directory (default: ~/.faster-browser-agent)'],
        ['--headed / --headless', 'run the browser with or without a window'],
        ['--log-level <level>', LOG_LEVELS.join(' | ')],
        ['--timeout <ms>', 'default navigation and action timeout'],
        ['--json', 'machine-readable output where it makes sense'],
        ['--no-color', 'disable colour (also honours NO_COLOR)'],
        ['-h, --help', 'show this help, or `fba help <command>`'],
        ['-v, --version', 'print the version'],
      ],
      { indent: '  ', style },
    ),
    '',
    `Run ${style.cyan('fba doctor')} first if anything misbehaves.`,
  ];
  return lines;
}

function commandHelp(name: string, style: Style): string[] | undefined {
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) return undefined;
  return [`${style.bold(command.name)} — ${command.summary}`, '', `  ${command.usage}`];
}

/** The one-line usage string for a command, used in usage errors. */
function usageFor(name: string): string {
  return COMMANDS.find((c) => c.name === name)?.usage ?? `fba ${name}`;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function indexerFor(config: FbaConfig): FsCodeIndexer {
  return new FsCodeIndexer(config);
}

/**
 * Turn whatever the user typed into a navigable URL.
 *
 * The precedence is chosen so that the more specific the input, the less we
 * second-guess it:
 *
 *  1. A full URL is used verbatim.
 *  2. An absolute *path* (`/settings/advanced`) is joined onto the base URL as
 *     written. It deliberately does NOT go through the route index first: the
 *     index's last-resort strategy is a fuzzy match on route labels, and on a
 *     short path (`/`, `/api`) that happily matches something unrelated. A user
 *     who typed a path meant that path.
 *  3. Anything else is a name — `settings`, `Advanced networking` — and that is
 *     exactly what the route index is for.
 */
function resolveTargetUrl(
  raw: string,
  index: CodeIndex,
  indexer: FsCodeIndexer,
  config: FbaConfig,
): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new UsageError('a url or route is required');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  // `localhost:3000/x` — common to type, and `new URL` misreads it as a scheme.
  if (/^[a-z0-9.-]+:\d+(\/|$)/i.test(trimmed)) return `http://${trimmed}`;

  const baseUrl = config.baseUrl ?? index.baseUrl;
  if (trimmed.startsWith('/')) {
    const joined = absoluteUrl(baseUrl, trimmed);
    if (joined) return joined;
  }

  const viaIndex = indexer.resolveRoute(index, trimmed);
  // The indexer falls back to returning a bare path when it knows the route but
  // not the origin; that is not navigable, so it is treated as "unresolved".
  if (viaIndex && /^[a-z][a-z0-9+.-]*:\/\//i.test(viaIndex)) return viaIndex;

  const joined = absoluteUrl(baseUrl, `/${trimmed.replace(/^\/+/, '')}`);
  if (joined) return joined;

  throw new FbaError('ROUTE_NOT_FOUND', `cannot turn "${trimmed}" into a URL`, {
    hint:
      'no matching route in the code index and no base URL is known — pass a full URL, ' +
      'set FBA_BASE_URL in the environment, or run `fba index` to (re)build the route map',
  });
}

function printObservation(ctx: Ctx, observation: Observation): void {
  const maxChars = flagCount(ctx.flags, 'chars');
  ctx.io.out(ctx.style.bold(observation.summary));
  ctx.io.out(serializeObservation(observation, maxChars !== undefined ? { maxChars } : undefined));
}

function stepStatusStyle(style: Style, status: StepResult['status']): string {
  switch (status) {
    case 'ok':
      return style.green('ok');
    case 'healed':
      return style.yellow('healed');
    case 'skipped':
      return style.dim('skipped');
    case 'failed':
      return style.red('failed');
  }
}

function printSteps(ctx: Ctx, steps: readonly StepResult[]): void {
  if (steps.length === 0) {
    ctx.io.out(ctx.style.dim('(no steps)'));
    return;
  }
  const rows = steps.map((step) => [
    String(step.index + 1),
    step.step,
    stepStatusStyle(ctx.style, step.status),
    formatMs(step.ms),
    step.error ?? step.detail ?? '',
  ]);
  for (const line of renderTable(rows, {
    head: ['#', 'step', 'status', 'ms', 'detail'],
    align: ['r', 'l', 'l', 'r', 'l'],
    style: ctx.style,
  })) {
    ctx.io.out(line);
  }
}

/** Params supplied as repeated `--param key=value`. */
function collectParams(flags: Record<string, string | boolean>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const entry of flagList(flags, 'param')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new UsageError(`--param expects key=value, got ${JSON.stringify(entry)}`);
    }
    params[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return params;
}

/**
 * The complete `ActionStep['do']` vocabulary.
 *
 * Duplicated from the skill store's list on purpose: that one rejects `eval`
 * because captured JavaScript cannot be verified on replay, while `fba act`
 * runs a program the user is watching and may legitimately use it. The
 * executor's `switch` has no `default` (it relies on TypeScript exhaustiveness),
 * so an unrecognised `do` coming from a JSON file would be a silent no-op —
 * hence validating here, at the trust boundary.
 */
const ACTION_KINDS: ReadonlySet<string> = new Set([
  'click', 'dblclick', 'hover', 'focus', 'blur', 'type', 'setValue', 'select', 'check', 'upload',
  'press', 'scroll', 'goto', 'back', 'forward', 'reload', 'waitFor', 'settle', 'assert', 'dialog',
  'selectTab', 'expand', 'eval',
]);

function parseActionProgram(source: string): ActionStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (e) {
    throw new UsageError(`action program is not valid JSON: ${errorMessage(e)}`);
  }
  // A single step object is accepted as a one-step program; typing the brackets
  // is pure ceremony at a shell prompt.
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const steps: ActionStep[] = [];
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new UsageError(`step ${i + 1} is not an object`);
    }
    const kind: unknown = (raw as { do?: unknown }).do;
    if (typeof kind !== 'string' || !ACTION_KINDS.has(kind)) {
      throw new UsageError(
        `step ${i + 1}: unknown action ${JSON.stringify(kind)} — expected one of ${[...ACTION_KINDS].join(', ')}`,
      );
    }
    steps.push(raw as ActionStep);
  });
  if (steps.length === 0) throw new UsageError('action program is empty');
  return steps;
}

async function readProgramSource(spec: string): Promise<string> {
  if (spec === '-') return readStdin();
  if (spec.startsWith('@')) {
    const file = spec.slice(1);
    const path = isAbsolute(file) ? file : resolvePath(process.cwd(), file);
    try {
      return await readFile(path, 'utf8');
    } catch (e) {
      throw new UsageError(`cannot read ${path}: ${errorMessage(e)}`);
    }
  }
  return spec;
}

function readStdin(): Promise<string> {
  return new Promise((resolveStdin, rejectStdin) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolveStdin(data));
    process.stdin.on('error', rejectStdin);
  });
}

/**
 * An executor wired to the code index so `{ do: 'goto', route: 'settings' }`
 * works from the CLI exactly as it does from the MCP tools.
 */
function executorWithRoutes(config: FbaConfig, indexer: FsCodeIndexer, index: CodeIndex): DefaultExecutor {
  return new DefaultExecutor({
    onNavigate: async (session, target) => {
      const raw = target.url ?? target.route;
      if (!raw) throw new FbaError('INVALID_ARGUMENT', 'goto needs a url or a route');
      await session.goto(resolveTargetUrl(raw, index, indexer, config));
    },
  });
}

// ---------------------------------------------------------------------------
// fba mcp
// ---------------------------------------------------------------------------

async function cmdMcp(ctx: Ctx): Promise<number> {
  rejectUnknownFlags(ctx.flags, [], usageFor('mcp'));
  // Loaded lazily: the MCP server pulls in the protocol SDK and its schema
  // validation, which is a large chunk of module-init time that `fba map` or
  // `fba doctor` should never pay for.
  const { startStdioServer } = await import('./mcp/server.js');
  // Resolves when the client disconnects; nothing is written to stdout in
  // between, because stdout *is* the protocol channel.
  await startStdioServer(ctx.overrides);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// fba doctor
// ---------------------------------------------------------------------------

type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
  /** A failure here means the tool cannot work at all. */
  required: boolean;
  ms?: number;
}

function compareVersions(actual: string, minimum: string): boolean {
  const a = actual.split('.');
  const b = minimum.split('.');
  for (let i = 0; i < 3; i++) {
    const x = Number.parseInt(a[i] ?? '0', 10) || 0;
    const y = Number.parseInt(b[i] ?? '0', 10) || 0;
    if (x !== y) return x > y;
  }
  return true;
}

async function checkHome(config: FbaConfig): Promise<Check> {
  const home = paths(config);
  const probe = join(home.home, `.fba-write-probe-${process.pid}`);
  try {
    for (const dir of [home.home, home.profiles, home.skills, home.indexes]) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(probe, 'ok', 'utf8');
    await rm(probe, { force: true });
    return { name: 'fba home', status: 'pass', detail: `${home.home} (writable)`, required: true };
  } catch (e) {
    return {
      name: 'fba home',
      status: 'fail',
      detail: `${home.home}: ${errorMessage(e)}`,
      hint: 'point FBA_HOME (or --home) at a writable directory',
      required: true,
    };
  }
}

async function runDoctorChecks(ctx: Ctx): Promise<Check[]> {
  const checks: Check[] = [];

  // 1. Node.
  const nodeVersion = process.versions.node;
  checks.push(
    compareVersions(nodeVersion, REQUIRED_NODE)
      ? { name: 'node', status: 'pass', detail: `v${nodeVersion} (requires >=${REQUIRED_NODE})`, required: true }
      : {
          name: 'node',
          status: 'fail',
          detail: `v${nodeVersion} is older than the required >=${REQUIRED_NODE}`,
          hint: 'upgrade node, or run fba through a newer runtime (nvm, volta, mise)',
          required: true,
        },
  );

  // 2. Home directory.
  checks.push(await checkHome(ctx.config));

  // 3. Chromium binary.
  const executablePath = resolveExecutablePath(ctx.config);
  const search = browserSearchPaths();
  checks.push(
    executablePath
      ? { name: 'chromium', status: 'pass', detail: executablePath, required: true }
      : {
          name: 'chromium',
          status: 'fail',
          detail: `no binary found (looked in ${search.browsersRoot}${search.exists ? '' : ' — which does not exist'} and ${plural(search.system.length, 'system location')})`,
          hint: 'run `npx playwright install chromium`, or set FBA_CHROMIUM_PATH=/path/to/chrome',
          required: true,
        },
  );

  // 4. Actually launch one. Stat-ing the binary proves nothing: the interesting
  //    failures (missing libnss3, no /dev/shm, sandbox refusal) happen here.
  if (executablePath) {
    const started = performance.now();
    const result = await checkBrowser(ctx.config);
    const ms = performance.now() - started;
    checks.push(
      result.ok
        ? {
            name: 'browser launch',
            status: 'pass',
            detail: `${result.version ?? 'chromium'} launched and closed`,
            required: true,
            ms,
          }
        : {
            name: 'browser launch',
            status: 'fail',
            detail: result.error ?? 'launch failed',
            hint: 'in a container try FBA_NO_SANDBOX=1; for missing libraries `npx playwright install-deps chromium`',
            required: true,
            ms,
          },
    );
  } else {
    checks.push({
      name: 'browser launch',
      status: 'skip',
      detail: 'skipped — no chromium binary to launch',
      required: true,
    });
  }

  // 5. Workspace.
  const ws = ctx.workspace;
  const gitPart = ws.gitRoot ? `git ${ws.gitRoot}` : 'not a git repository';
  const branchPart = ws.branch ? `, branch ${ws.branch}` : '';
  const worktreePart = ws.isWorktree ? ', linked worktree' : '';
  checks.push({
    name: 'workspace',
    status: 'pass',
    detail: `${ws.root} [${ws.id}] (${gitPart}${branchPart}${worktreePart})`,
    required: false,
  });

  // 6. Profiles.
  try {
    const profiles = await new FsProfileManager(ctx.config).list();
    const locked = profiles.filter((p) => p.lockedBy !== undefined);
    checks.push({
      name: 'profiles',
      status: 'pass',
      detail:
        profiles.length === 0
          ? 'none yet (one is created on first use)'
          : `${plural(profiles.length, 'profile')}, ${locked.length} in use — see \`fba profiles list\``,
      required: false,
    });
  } catch (e) {
    checks.push({
      name: 'profiles',
      status: 'warn',
      detail: errorMessage(e),
      hint: `check permissions on ${paths(ctx.config).profiles}`,
      required: false,
    });
  }

  // 7. Code index.
  if (!ctx.config.codeIndex) {
    checks.push({ name: 'code index', status: 'skip', detail: 'disabled by configuration', required: false });
  } else {
    const started = performance.now();
    const index = await indexerFor(ctx.config).get(ws.root);
    const ms = performance.now() - started;
    const frameworks = index.frameworks.length > 0 ? index.frameworks.join(', ') : 'none detected';
    if (index.routes.length === 0 && index.selectors.length === 0 && index.configFields.length === 0) {
      checks.push({
        name: 'code index',
        status: 'warn',
        detail: `empty — ${index.stats.filesScanned} files scanned, frameworks: ${frameworks}`,
        hint:
          'deep-linking and code-aware targeting will be unavailable; point --workspace at the app source ' +
          'if this is a monorepo root',
        required: false,
        ms,
      });
    } else {
      checks.push({
        name: 'code index',
        status: 'pass',
        detail:
          `${plural(index.routes.length, 'route')}, ${plural(index.selectors.length, 'selector')}, ` +
          `${plural(index.configFields.length, 'config field')} — ${frameworks}; built ${formatAge(index.builtAt)}`,
        required: false,
        ms,
      });
    }
  }

  return checks;
}

async function cmdDoctor(ctx: Ctx): Promise<number> {
  rejectUnknownFlags(ctx.flags, [], usageFor('doctor'));
  const checks = await runDoctorChecks(ctx);
  const failed = checks.filter((c) => c.required && c.status !== 'pass');
  const warned = checks.filter((c) => c.status === 'warn');

  if (ctx.json) {
    emitJson(ctx, { ok: failed.length === 0, version: VERSION, home: ctx.config.home, checks });
    return failed.length === 0 ? EXIT_OK : EXIT_FAILURE;
  }

  const { style } = ctx;
  const badge = (status: CheckStatus): string => {
    switch (status) {
      case 'pass':
        return style.green('PASS');
      case 'fail':
        return style.red('FAIL');
      case 'warn':
        return style.yellow('WARN');
      case 'skip':
        return style.dim('SKIP');
    }
  };

  ctx.io.out(`${style.bold('fba doctor')} — faster-browser-agent ${VERSION}`);
  ctx.io.out('');
  const nameWidth = checks.reduce((max, c) => Math.max(max, c.name.length), 0);
  for (const check of checks) {
    const timing = check.ms !== undefined ? style.dim(` (${formatMs(check.ms)})`) : '';
    ctx.io.out(`${badge(check.status)}  ${pad(check.name, nameWidth, 'l')}  ${check.detail}${timing}`);
    if (check.hint && check.status !== 'pass') {
      ctx.io.out(`      ${pad('', nameWidth, 'l')}  ${style.dim(`↳ ${check.hint}`)}`);
    }
  }
  ctx.io.out('');

  if (failed.length > 0) {
    ctx.io.out(style.red(`${plural(failed.length, 'required check')} failed.`));
    return EXIT_FAILURE;
  }
  ctx.io.out(
    warned.length > 0
      ? style.yellow(`All required checks passed, with ${plural(warned.length, 'warning')}.`)
      : style.green('All checks passed.'),
  );
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// fba index
// ---------------------------------------------------------------------------

const ROUTE_PREVIEW = 15;

function routeLine(route: RouteEntry): string[] {
  return [route.pattern, route.label ?? '', route.framework, route.source];
}

async function cmdIndex(ctx: Ctx): Promise<number> {
  rejectUnknownFlags(ctx.flags, ['force'], usageFor('index'));
  if (!ctx.config.codeIndex) {
    ctx.io.err('the code index is disabled (config.codeIndex = false)');
    return EXIT_FAILURE;
  }

  const force = ctx.flags['force'] === true;
  const started = performance.now();
  const startedAt = Date.now();
  const index = await indexerFor(ctx.config).get(ctx.workspace.root, { force });
  const elapsed = performance.now() - started;
  // `stats.buildMs` is recorded at build time and travels with the cached
  // index, so it cannot distinguish a rebuild from a cache hit — the build
  // timestamp can.
  const rebuilt = index.builtAt >= startedAt;

  if (ctx.json) {
    emitJson(ctx, {
      workspaceRoot: index.workspaceRoot,
      builtAt: index.builtAt,
      frameworks: index.frameworks,
      baseUrl: index.baseUrl ?? null,
      counts: {
        routes: index.routes.length,
        navGroups: index.navGroups.length,
        configFields: index.configFields.length,
        selectors: index.selectors.length,
        filesScanned: index.stats.filesScanned,
      },
      buildMs: index.stats.buildMs,
      elapsedMs: Math.round(elapsed),
      rebuilt,
      routes: index.routes.map((r) => ({
        pattern: r.pattern,
        params: r.params,
        framework: r.framework,
        source: r.source,
        label: r.label ?? null,
      })),
      navGroups: index.navGroups,
    });
    return EXIT_OK;
  }

  const { style } = ctx;
  ctx.io.out(`${style.bold('code index')}  ${index.workspaceRoot}`);
  ctx.io.out('');
  for (const line of renderTable(
    [
      ['frameworks', index.frameworks.length > 0 ? index.frameworks.join(', ') : style.dim('none detected')],
      ['base url', index.baseUrl ?? style.dim('unknown (set FBA_BASE_URL to deep-link)')],
      ['routes', String(index.routes.length)],
      ['nav groups', String(index.navGroups.length)],
      ['config fields', String(index.configFields.length)],
      ['selectors', String(index.selectors.length)],
      ['files scanned', String(index.stats.filesScanned)],
      [
        'build',
        rebuilt
          ? `${formatMs(index.stats.buildMs)}`
          : style.dim(`cached (built ${formatAge(index.builtAt)} in ${formatMs(index.stats.buildMs)})`),
      ],
      ['total', formatMs(elapsed)],
    ],
    { indent: '  ', style },
  )) {
    ctx.io.out(line);
  }

  if (index.routes.length > 0) {
    ctx.io.out('');
    ctx.io.out(style.bold(`routes (${Math.min(ROUTE_PREVIEW, index.routes.length)} of ${index.routes.length})`));
    for (const line of renderTable(index.routes.slice(0, ROUTE_PREVIEW).map(routeLine), {
      head: ['pattern', 'label', 'framework', 'source'],
      indent: '  ',
      style,
    })) {
      ctx.io.out(line);
    }
    if (index.routes.length > ROUTE_PREVIEW) {
      ctx.io.out(style.dim(`  … ${index.routes.length - ROUTE_PREVIEW} more — use --json for the full list`));
    }
  }

  if (index.navGroups.length > 0) {
    ctx.io.out('');
    ctx.io.out(style.bold(`nav groups (${index.navGroups.length})`));
    for (const line of renderTable(
      index.navGroups.slice(0, ROUTE_PREVIEW).map((group) => [
        group.label ?? style.dim('(unnamed)'),
        truncate(group.items.map((item) => item.label).join(', '), 72),
        group.source,
      ]),
      { head: ['group', 'items', 'source'], indent: '  ', style },
    )) {
      ctx.io.out(line);
    }
  }

  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// fba map
// ---------------------------------------------------------------------------

function matchTargetText(match: CodeMatch): string {
  if (match.url) return match.url;
  const target = match.target;
  if (!target) return '';
  if (target.testId) return `[data-testid=${target.testId}]`;
  if (target.css) return truncate(target.css, 48);
  if (target.name) return `name "${target.name}"`;
  if (target.label) return `label "${target.label}"`;
  return '';
}

async function cmdMap(ctx: Ctx): Promise<number> {
  rejectUnknownFlags(ctx.flags, ['limit'], usageFor('map'));
  // Argument validation before the index build: failing fast on a typo beats
  // spending a few hundred milliseconds scanning the workspace first.
  const limit = flagCount(ctx.flags, 'limit') ?? 20;
  const query = ctx.args.join(' ').trim();

  const indexer = indexerFor(ctx.config);
  const index = await indexer.get(ctx.workspace.root);

  if (!query) {
    // No query: the useful default is "show me what you found", i.e. the routes
    // the agent can deep-link to.
    const routes = index.routes.slice(0, limit);
    if (ctx.json) {
      emitJson(ctx, { query: null, routes });
      return EXIT_OK;
    }
    if (routes.length === 0) {
      ctx.io.out(ctx.style.dim('the code index is empty — run `fba index --force`, or `fba doctor` to find out why'));
      return EXIT_OK;
    }
    ctx.io.out(ctx.style.bold(`routes (${routes.length} of ${index.routes.length})`));
    for (const line of renderTable(routes.map(routeLine), {
      head: ['pattern', 'label', 'framework', 'source'],
      style: ctx.style,
    })) {
      ctx.io.out(line);
    }
    return EXIT_OK;
  }

  const matches = indexer.search(index, query, limit);
  if (ctx.json) {
    emitJson(ctx, { query, matches });
    return matches.length > 0 ? EXIT_OK : EXIT_FAILURE;
  }

  if (matches.length === 0) {
    ctx.io.out(`no match for ${JSON.stringify(query)} in ${plural(index.routes.length, 'route')} + ${plural(index.selectors.length, 'selector')}`);
    return EXIT_FAILURE;
  }

  for (const line of renderTable(
    matches.map((match) => [
      match.score.toFixed(2),
      match.kind,
      truncate(match.label, 48),
      truncate(matchTargetText(match), 56),
      match.source,
    ]),
    { head: ['score', 'kind', 'label', 'url / target', 'source'], align: ['r'], style: ctx.style },
  )) {
    ctx.io.out(line);
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// fba open
// ---------------------------------------------------------------------------

async function cmdOpen(ctx: Ctx): Promise<number> {
  rejectUnknownFlags(ctx.flags, ['full', 'scope', 'max-nodes', 'chars'], usageFor('open'));
  const raw = ctx.args[0];
  if (!raw) throw new UsageError('fba open needs a url or a route', usageFor('open'));

  const scope = flagString(ctx.flags, 'scope');
  if (scope !== undefined && scope !== 'viewport' && scope !== 'page') {
    throw new UsageError('--scope must be `viewport` or `page`');
  }
  const maxNodes = flagCount(ctx.flags, 'max-nodes');

  const indexer = indexerFor(ctx.config);
  const index = await indexer.get(ctx.workspace.root);
  const url = resolveTargetUrl(raw, index, indexer, ctx.config);

  const pool = getSharedPool(ctx.config);
  const session = await pool.acquire({ workspace: ctx.workspace.root });

  const navStarted = performance.now();
  await session.goto(url);
  const navMs = performance.now() - navStarted;

  const observation = await session.observe({
    full: ctx.flags['full'] === true,
    ...(scope ? { scope } : {}),
    ...(maxNodes !== undefined ? { maxNodes } : {}),
  });

  if (ctx.json) {
    emitJson(ctx, { url, navigationMs: Math.round(navMs), observation });
    return EXIT_OK;
  }

  ctx.io.out(ctx.style.dim(`${url}  (navigated in ${formatMs(navMs)})`));
  printObservation(ctx, observation);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// fba act
// ---------------------------------------------------------------------------

async function cmdAct(ctx: Ctx): Promise<number> {
  rejectUnknownFlags(ctx.flags, ['url', 'on-failure', 'full', 'chars'], usageFor('act'));
  const spec = ctx.args[0];
  if (!spec) {
    throw new UsageError('fba act needs an action program', usageFor('act'));
  }

  const onFailure = flagString(ctx.flags, 'on-failure') ?? 'stop';
  if (onFailure !== 'stop' && onFailure !== 'continue' && onFailure !== 'retry') {
    throw new UsageError('--on-failure must be one of stop, continue, retry');
  }

  const steps = parseActionProgram(await readProgramSource(spec));

  const indexer = indexerFor(ctx.config);
  const index = await indexer.get(ctx.workspace.root);

  const pool = getSharedPool(ctx.config);
  const session = await pool.acquire({ workspace: ctx.workspace.root });

  const startUrl = flagString(ctx.flags, 'url');
  if (startUrl) {
    await session.goto(resolveTargetUrl(startUrl, index, indexer, ctx.config));
  } else if (steps[0]?.do !== 'goto' && isBlank(session)) {
    ctx.io.err('warning: the page is blank and the program does not start with a `goto` — pass --url to open one first');
  }

  const result = await executorWithRoutes(ctx.config, indexer, index).run(session, steps, {
    onFailure,
    full: ctx.flags['full'] === true,
  });

  if (ctx.json) {
    emitJson(ctx, result);
    return result.ok ? EXIT_OK : EXIT_FAILURE;
  }

  printSteps(ctx, result.steps);
  ctx.io.out('');
  printObservation(ctx, result.observation);
  if (!result.ok) {
    ctx.io.out('');
    ctx.io.out(ctx.style.red(`program failed at step ${(result.failedAt ?? 0) + 1}`));
  }
  return result.ok ? EXIT_OK : EXIT_FAILURE;
}

function isBlank(session: Session): boolean {
  const url = session.info().url;
  return url === '' || url === 'about:blank';
}

// ---------------------------------------------------------------------------
// fba skill
// ---------------------------------------------------------------------------

async function cmdSkill(ctx: Ctx): Promise<number> {
  const usage = usageFor('skill');
  rejectUnknownFlags(ctx.flags, ['param', 'origin', 'url', 'full', 'chars'], usage);

  const sub = ctx.args[0] ?? 'list';
  const store = new FsSkillStore(ctx.config);
  const origin = flagString(ctx.flags, 'origin');

  switch (sub) {
    case 'list':
      return skillList(ctx, store, origin);
    case 'show':
      return skillShow(ctx, store, ctx.args[1], origin);
    case 'run':
      return skillRun(ctx, store, ctx.args[1], origin);
    case 'delete':
    case 'rm':
      return skillDelete(ctx, store, ctx.args[1], origin);
    default:
      throw new UsageError(`unknown skill subcommand ${JSON.stringify(sub)}`, usage);
  }
}

function skillHealth(style: Style, record: SkillRecord): string {
  if (record.runs === 0) return style.dim('unproven');
  const rate = (record.runs - record.failures) / record.runs;
  const text = `${Math.round(rate * 100)}%`;
  if (rate >= 0.9) return style.green(text);
  return rate >= 0.6 ? style.yellow(text) : style.red(text);
}

async function skillList(ctx: Ctx, store: FsSkillStore, origin: string | undefined): Promise<number> {
  const records = await store.list(origin);
  if (ctx.json) {
    emitJson(ctx, { skills: records });
    return EXIT_OK;
  }
  if (records.length === 0) {
    ctx.io.out(ctx.style.dim('no skills recorded yet — record one with the act tool\'s `record` option'));
    return EXIT_OK;
  }
  for (const line of renderTable(
    records.map((record) => [
      record.name,
      record.origin,
      String(record.steps.length),
      record.params.length > 0 ? record.params.join(',') : ctx.style.dim('—'),
      String(record.runs),
      skillHealth(ctx.style, record),
      record.lastMs !== undefined ? formatMs(record.lastMs) : ctx.style.dim('—'),
      formatAge(record.updatedAt),
    ]),
    {
      head: ['name', 'origin', 'steps', 'params', 'runs', 'success', 'last', 'updated'],
      align: ['l', 'l', 'r', 'l', 'r', 'r', 'r', 'l'],
      style: ctx.style,
    },
  )) {
    ctx.io.out(line);
  }
  return EXIT_OK;
}

async function skillShow(
  ctx: Ctx,
  store: FsSkillStore,
  name: string | undefined,
  origin: string | undefined,
): Promise<number> {
  if (!name) throw new UsageError('fba skill show needs a skill name', 'fba skill show <name> [--origin <origin>]');
  const record = await store.get(name, origin);
  if (!record) {
    ctx.io.err(`no skill named ${JSON.stringify(name)}${origin ? ` for ${origin}` : ''}`);
    return EXIT_FAILURE;
  }
  if (ctx.json) {
    emitJson(ctx, record);
    return EXIT_OK;
  }

  const { style } = ctx;
  ctx.io.out(`${style.bold(record.name)}  ${style.dim(record.origin)}`);
  if (record.description) ctx.io.out(record.description);
  ctx.io.out('');
  for (const line of renderTable(
    [
      ['params', record.params.length > 0 ? record.params.join(', ') : style.dim('none')],
      ['steps', String(record.steps.length)],
      ['runs', `${record.runs} (${record.failures} failed)`],
      ['last duration', record.lastMs !== undefined ? formatMs(record.lastMs) : style.dim('—')],
      ['recorded in', record.recordedIn ?? style.dim('unknown')],
      ['updated', `${formatAge(record.updatedAt)}`],
    ],
    { indent: '  ', style },
  )) {
    ctx.io.out(line);
  }
  ctx.io.out('');
  ctx.io.out(style.bold('program'));
  record.steps.forEach((step, i) => {
    const { do: kind, ...rest } = step as { do: string } & Record<string, unknown>;
    const detail = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
    ctx.io.out(`  ${pad(String(i + 1), 3, 'r')}  ${kind}${style.dim(detail)}`);
  });
  return EXIT_OK;
}

async function skillRun(
  ctx: Ctx,
  store: FsSkillStore,
  name: string | undefined,
  origin: string | undefined,
): Promise<number> {
  if (!name) {
    throw new UsageError('fba skill run needs a skill name', 'fba skill run <name> [--param k=v ...] [--url <url>]');
  }
  const params = collectParams(ctx.flags);
  const record = await store.get(name, origin);
  if (!record) {
    ctx.io.err(`no skill named ${JSON.stringify(name)}${origin ? ` for ${origin}` : ''}`);
    return EXIT_FAILURE;
  }

  const indexer = indexerFor(ctx.config);
  const index = await indexer.get(ctx.workspace.root);

  const pool = getSharedPool(ctx.config);
  const session = await pool.acquire({ workspace: ctx.workspace.root });

  // A skill's steps are relative to the page it was recorded on. An explicit
  // --url always wins; otherwise a blank tab is sent to the recorded origin,
  // and a tab that is already somewhere is left alone (the caller may have
  // navigated there deliberately with `fba open`).
  const startUrl = flagString(ctx.flags, 'url');
  const target = startUrl
    ? resolveTargetUrl(startUrl, index, indexer, ctx.config)
    : normalizeOrigin(record.origin);
  if ((startUrl || isBlank(session)) && /^https?:\/\//i.test(target)) {
    await session.goto(target);
  }

  const runner = new DefaultSkillRunner(store, executorWithRoutes(ctx.config, indexer, index));
  const result = await runner.replay(session, record.name, params);

  if (ctx.json) {
    emitJson(ctx, result);
    return result.ok ? EXIT_OK : EXIT_FAILURE;
  }

  ctx.io.out(`${ctx.style.bold(result.name)} ${result.ok ? ctx.style.green('ok') : ctx.style.red('failed')} in ${formatMs(result.ms)}`);
  printSteps(ctx, result.steps);
  if (result.fallbackReason) {
    ctx.io.out('');
    ctx.io.out(ctx.style.yellow(result.fallbackReason));
  }
  ctx.io.out('');
  printObservation(ctx, result.observation);
  return result.ok ? EXIT_OK : EXIT_FAILURE;
}

async function skillDelete(
  ctx: Ctx,
  store: FsSkillStore,
  name: string | undefined,
  origin: string | undefined,
): Promise<number> {
  if (!name) throw new UsageError('fba skill delete needs a skill name', 'fba skill delete <name> [--origin <origin>]');
  const removed = await store.delete(name, origin);
  if (ctx.json) {
    emitJson(ctx, { name, origin: origin ?? null, deleted: removed });
    return removed ? EXIT_OK : EXIT_FAILURE;
  }
  if (!removed) {
    ctx.io.err(`no skill named ${JSON.stringify(name)}${origin ? ` for ${origin}` : ''}`);
    return EXIT_FAILURE;
  }
  ctx.io.out(`deleted skill ${name}`);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// fba profiles
// ---------------------------------------------------------------------------

async function cmdProfiles(ctx: Ctx): Promise<number> {
  const usage = usageFor('profiles');
  rejectUnknownFlags(ctx.flags, ['from', 'to'], usage);

  const manager = new FsProfileManager(ctx.config);
  const sub = ctx.args[0] ?? 'list';

  switch (sub) {
    case 'list': {
      const profiles = await manager.list();
      if (ctx.json) {
        emitJson(ctx, { profiles });
        return EXIT_OK;
      }
      if (profiles.length === 0) {
        ctx.io.out(ctx.style.dim(`no profiles in ${paths(ctx.config).profiles} yet`));
        return EXIT_OK;
      }
      for (const line of renderTable(
        profiles.map((profile) => [
          profile.id,
          profile.lockedBy !== undefined ? ctx.style.yellow(`pid ${profile.lockedBy}`) : ctx.style.dim('free'),
          formatBytes(profile.sizeBytes ?? 0),
          profile.root ?? ctx.style.dim('unknown'),
        ]),
        { head: ['id', 'lock', 'size', 'workspace'], align: ['l', 'l', 'r', 'l'], style: ctx.style },
      )) {
        ctx.io.out(line);
      }
      // The size is deliberately approximate (profile.ts caps the walk); saying
      // so keeps a diagnostic from reading like an accounting figure.
      ctx.io.out(ctx.style.dim('sizes are approximate (the directory walk is capped)'));
      return EXIT_OK;
    }

    case 'reset': {
      const id = ctx.args[1] ?? ctx.workspace.id;
      await manager.reset(id);
      if (ctx.json) {
        emitJson(ctx, { reset: id });
        return EXIT_OK;
      }
      ctx.io.out(`reset profile ${id} — the next run starts logged out`);
      return EXIT_OK;
    }

    case 'seed': {
      const from = flagString(ctx.flags, 'from') ?? ctx.args[1];
      const to = flagString(ctx.flags, 'to') ?? ctx.args[2] ?? ctx.workspace.id;
      if (!from) {
        throw new UsageError('fba profiles seed needs a source profile', 'fba profiles seed --from <id> --to <id>');
      }
      await manager.seed(from, to);
      if (ctx.json) {
        emitJson(ctx, { from, to });
        return EXIT_OK;
      }
      ctx.io.out(`seeded ${to} from ${from} — the next browser in that workspace starts logged in`);
      return EXIT_OK;
    }

    default:
      throw new UsageError(`unknown profiles subcommand ${JSON.stringify(sub)}`, usage);
  }
}

// ---------------------------------------------------------------------------
// fba warm
// ---------------------------------------------------------------------------

async function cmdWarm(ctx: Ctx): Promise<number> {
  rejectUnknownFlags(ctx.flags, [], usageFor('warm'));
  const pool = getSharedPool(ctx.config);
  const started = performance.now();
  await pool.warm(ctx.workspace.root);
  const ms = performance.now() - started;

  if (ctx.json) {
    emitJson(ctx, { workspaceId: ctx.workspace.id, ms: Math.round(ms) });
    return EXIT_OK;
  }
  ctx.io.out(`browser ready for ${ctx.workspace.id} in ${formatMs(ms)}`);
  // Warming from a short-lived CLI process only helps if the browser outlives
  // it, and it does not: the pool shuts down on exit and the profile lock is
  // released. Say so rather than let the user believe in a phantom speedup.
  ctx.io.out(
    ctx.style.dim(
      'note: this warms the OS page cache and the profile directory, not a live browser — ' +
        'the process exits, so the browser closes with it',
    ),
  );
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// fba bench
// ---------------------------------------------------------------------------

interface Phase {
  name: string;
  samples: number[];
  note?: string;
}

/** Serialisation samples per navigation; see the comment at the call site. */
const SERIALIZE_ITERATIONS = 25;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * A deterministic, moderately heavy page to benchmark against.
 *
 * Served from a local http server rather than a `data:` URL so that navigation,
 * request accounting and the settle heuristic all see a normal http document —
 * benchmarking against a page the browser treats specially would flatter the
 * numbers.
 */
function syntheticPage(): string {
  const sections: string[] = [];
  for (let s = 0; s < 8; s++) {
    const rows: string[] = [];
    for (let f = 0; f < 12; f++) {
      const id = `s${s}f${f}`;
      rows.push(
        `<div class="row"><label for="${id}">Setting ${s}.${f}</label>` +
          `<input id="${id}" name="${id}" data-testid="${id}" placeholder="value ${f}" value="${f}"></div>`,
      );
    }
    rows.push(
      `<div class="row"><label for="sel${s}">Mode ${s}</label>` +
        `<select id="sel${s}" name="mode${s}"><option>auto</option><option>manual</option><option>off</option></select></div>`,
    );
    rows.push(`<div class="row"><label><input type="checkbox" id="chk${s}"> Enable section ${s}</label></div>`);
    rows.push(`<button type="button" data-testid="save-${s}">Save section ${s}</button>`);
    sections.push(`<section role="region" aria-label="Section ${s}"><h2>Section ${s}</h2>${rows.join('')}</section>`);
  }
  const tabs = Array.from(
    { length: 6 },
    (_unused, i) => `<button role="tab" aria-selected="${i === 0}" id="tab${i}">Tab ${i}</button>`,
  ).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>fba bench</title>
<style>body{font:14px system-ui;margin:0;padding:16px}.row{display:flex;gap:8px;padding:2px 0}</style>
</head><body>
<header role="banner"><h1>fba synthetic benchmark page</h1></header>
<nav role="navigation" aria-label="Main"><a href="/">Home</a><a href="/settings">Settings</a><a href="/about">About</a></nav>
<div role="tablist" aria-label="Sections">${tabs}</div>
<main role="main">${sections.join('')}</main>
<footer role="contentinfo">generated for benchmarking</footer>
</body></html>`;
}

async function startBenchServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const body = syntheticPage();
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(body);
  });
  await new Promise<void>((ready, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ready);
  });
  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

async function cmdBench(ctx: Ctx): Promise<number> {
  rejectUnknownFlags(ctx.flags, ['runs', 'url'], usageFor('bench'));
  const runs = Math.min(20, flagCount(ctx.flags, 'runs') ?? 3);

  const indexer = indexerFor(ctx.config);
  const index = await indexer.get(ctx.workspace.root);
  const requested = ctx.args[0] ?? flagString(ctx.flags, 'url');

  let server: { url: string; close: () => Promise<void> } | undefined;
  let url: string;
  let synthetic = false;
  if (requested) {
    url = resolveTargetUrl(requested, index, indexer, ctx.config);
  } else {
    server = await startBenchServer();
    url = server.url;
    synthetic = true;
  }

  const phases: Phase[] = [];
  const pools: DefaultBrowserPool[] = [];
  // Headless regardless of the ambient config: a visible window adds compositor
  // work that has nothing to do with what we are measuring.
  const benchConfig: FbaConfig = { ...ctx.config, headless: true };

  try {
    // -- cold launch: a brand-new pool each time, so nothing is reused.
    const cold: number[] = [];
    for (let i = 0; i < runs; i++) {
      const pool = new DefaultBrowserPool({ config: benchConfig });
      pools.push(pool);
      const started = performance.now();
      await pool.warm(ctx.workspace.root);
      cold.push(performance.now() - started);
      await pool.shutdown();
    }

    // -- everything else runs against one warm pool.
    const pool = new DefaultBrowserPool({ config: benchConfig });
    pools.push(pool);
    await pool.warm(ctx.workspace.root);

    const acquire: number[] = [];
    for (let i = 0; i < runs; i++) {
      const started = performance.now();
      const opened = await pool.acquire({ workspace: ctx.workspace.root, fresh: true });
      acquire.push(performance.now() - started);
      await pool.closeSession(opened.id);
    }

    const session = await pool.acquire({ workspace: ctx.workspace.root, fresh: true });
    const navigate: number[] = [];
    const settle: number[] = [];
    const snapshot: number[] = [];
    const serialize: number[] = [];
    let serializedChars = 0;
    let interactive = 0;

    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      // `noSettle` keeps the navigation number honest — settling is measured on
      // its own line and would otherwise be counted twice.
      await session.goto(url, { noSettle: true });
      navigate.push(performance.now() - t0);

      const t1 = performance.now();
      await session.settle();
      settle.push(performance.now() - t1);

      const t2 = performance.now();
      const snap = await session.snapshot({ scope: 'page' });
      snapshot.push(performance.now() - t2);
      interactive = snap.stats.interactive;

      // Serialisation is pure CPU and lands well under a millisecond, so it
      // needs far more iterations than the I/O phases before the median stops
      // being timer noise. Measuring it once per navigation (rather than only
      // at the end) keeps every phase sampled over the same page states.
      for (let j = 0; j < SERIALIZE_ITERATIONS; j++) {
        const t3 = performance.now();
        const text = serializeSnapshot(snap);
        serialize.push(performance.now() - t3);
        serializedChars = text.length;
      }
    }

    phases.push(
      { name: 'cold launch', samples: cold, note: 'new browser process + profile' },
      { name: 'warm acquire', samples: acquire, note: 'new tab in a live browser' },
      { name: 'navigate', samples: navigate, note: 'goto, no settle' },
      { name: 'settle', samples: settle, note: 'dom + network quiet' },
      { name: 'snapshot', samples: snapshot, note: `whole page, ${interactive} interactive elements` },
      { name: 'serialize', samples: serialize, note: `${serializedChars} chars, in-process and JIT-warm` },
    );

    if (ctx.json) {
      emitJson(ctx, {
        url,
        synthetic,
        runs,
        phases: phases.map((phase) => ({
          name: phase.name,
          note: phase.note ?? null,
          samples: phase.samples.map((ms) => Number(ms.toFixed(3))),
          medianMs: Number(median(phase.samples).toFixed(3)),
          minMs: Number(Math.min(...phase.samples).toFixed(3)),
          maxMs: Number(Math.max(...phase.samples).toFixed(3)),
        })),
      });
      return EXIT_OK;
    }

    const { style } = ctx;
    ctx.io.out(`${style.bold('fba bench')}  ${url}${synthetic ? style.dim('  (synthetic page)') : ''}`);
    ctx.io.out('');
    for (const line of renderTable(
      phases.map((phase) => [
        phase.name,
        String(phase.samples.length),
        formatMs(median(phase.samples)),
        formatMs(Math.min(...phase.samples)),
        formatMs(Math.max(...phase.samples)),
        style.dim(phase.note ?? ''),
      ]),
      {
        head: ['phase', 'n', 'median', 'min', 'max', ''],
        align: ['l', 'r', 'r', 'r', 'r', 'l'],
        style,
      },
    )) {
      ctx.io.out(line);
    }
    ctx.io.out('');
    ctx.io.out(
      style.dim(
        'medians over the runs above, on this machine, right now — cold launch in particular ' +
          'varies by an order of magnitude between a warm page cache and a cold container',
      ),
    );
    return EXIT_OK;
  } finally {
    for (const pool of pools) await pool.shutdown().catch(() => undefined);
    if (server) await server.close();
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

type CommandFn = (ctx: Ctx) => Promise<number>;

const HANDLERS: Readonly<Record<string, CommandFn>> = {
  mcp: cmdMcp,
  doctor: cmdDoctor,
  index: cmdIndex,
  map: cmdMap,
  open: cmdOpen,
  act: cmdAct,
  skill: cmdSkill,
  skills: cmdSkill,
  profiles: cmdProfiles,
  profile: cmdProfiles,
  warm: cmdWarm,
  bench: cmdBench,
};

/**
 * Parse, dispatch and translate the outcome into an exit code.
 *
 * Exported so tests can exercise dispatch without spawning a process; it never
 * calls `process.exit` itself.
 */
export async function run(argv: string[], io: Io = processIo): Promise<number> {
  const parsed = parseArgv(argv);
  const style = makeStyle(colorEnabled(parsed.flags));
  const wantsHelp = parsed.flags['help'] === true;

  if (parsed.flags['version'] === true && !wantsHelp) {
    io.out(VERSION);
    return EXIT_OK;
  }

  // `fba help <topic>` and `fba <command> --help` are the same request.
  const helpTopic = parsed.command === 'help' ? parsed.args[0] : wantsHelp ? parsed.command : undefined;
  if (helpTopic) {
    const help = commandHelp(helpTopic, style);
    if (!help) {
      io.err(`unknown command ${JSON.stringify(helpTopic)}`);
      io.err(`known commands: ${COMMANDS.map((c) => c.name).join(', ')}`);
      return EXIT_USAGE;
    }
    for (const line of help) io.out(line);
    return EXIT_OK;
  }

  if (parsed.command === '' || parsed.command === 'help') {
    for (const line of helpText(style)) io.out(line);
    // `fba help` is a request that succeeded; a bare `fba` in a script is not.
    return parsed.command === 'help' || wantsHelp ? EXIT_OK : EXIT_USAGE;
  }

  const handler = HANDLERS[parsed.command];
  if (!handler) {
    io.err(`unknown command ${JSON.stringify(parsed.command)}`);
    io.err(`run \`fba --help\` — known commands: ${COMMANDS.map((c) => c.name).join(', ')}`);
    return EXIT_USAGE;
  }

  let ctx: Ctx | undefined;
  try {
    ctx = await buildContext(parsed, io);
    return await handler(ctx);
  } catch (e) {
    return reportError(e, io, style, ctx?.debug === true);
  }
}

function reportError(e: unknown, io: Io, style: Style, debug: boolean): number {
  if (e instanceof UsageError) {
    io.err(style.red(e.message));
    if (e.usage) io.err(`usage: ${e.usage}`);
    return EXIT_USAGE;
  }
  if (isFbaError(e)) {
    io.err(style.red(e.toLine()));
    if (debug && e.stack) io.err(e.stack);
    return EXIT_FAILURE;
  }
  // A raw stack is noise for the 99% case; --log-level debug is the escape
  // hatch for the other 1%.
  io.err(style.red(errorMessage(e)));
  if (debug && e instanceof Error && e.stack) io.err(e.stack);
  return EXIT_FAILURE;
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

const EXIT_INTERRUPTED = 130;

/**
 * Close browsers on Ctrl-C.
 *
 * The pool installs its own signal handlers, but only once a pool exists — for
 * commands that never launch a browser this handler is what keeps Ctrl-C
 * behaving. It removes itself before re-raising so the default disposition
 * (terminate) applies on the second delivery instead of looping.
 */
function installSignalHandlers(): void {
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.exitCode = EXIT_INTERRUPTED;
      void shutdownSharedPool()
        .catch(() => undefined)
        .finally(() => {
          process.off(signal, handler);
          process.kill(process.pid, signal);
        });
    };
    process.on(signal, handler);
  }
}

/** Give a piped stdout a chance to drain before the process goes away. */
function flush(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.writableLength === 0) return Promise.resolve();
  return new Promise<void>((done) => {
    stream.write('', () => done());
  });
}

async function main(): Promise<void> {
  installSignalHandlers();
  let code = EXIT_FAILURE;
  try {
    code = await run(process.argv.slice(2));
  } catch (e) {
    // `run` catches command errors; anything reaching here is a bug in the CLI
    // itself, so print it plainly rather than pretending it is a usage problem.
    process.stderr.write(`${errorMessage(e)}\n`);
  } finally {
    await shutdownSharedPool().catch(() => undefined);
  }
  await flush(process.stdout);
  await flush(process.stderr);
  // Explicit exit: playwright's driver keeps handles alive for a short while
  // after the browser closes, and a CLI that lingers for seconds after printing
  // its output looks broken. Everything we own is already shut down above.
  process.exit(code);
}

/**
 * Only run when invoked as the binary. Importing this module (tests, embedding
 * `parseArgv`) must not start a CLI.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) void main();
