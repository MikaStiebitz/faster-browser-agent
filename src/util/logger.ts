/**
 * Minimal leveled logger.
 *
 * Everything goes to stderr, never stdout: when running as an MCP server over
 * stdio, stdout is the protocol channel and a stray `console.log` corrupts it.
 */

import type { LogLevel } from '../types.js';

const ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

let currentLevel: LogLevel = (process.env.FBA_LOG_LEVEL as LogLevel) ?? 'warn';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function enabled(level: LogLevel): boolean {
  return ORDER[level] <= ORDER[currentLevel];
}

function write(level: LogLevel, scope: string, args: unknown[]): void {
  if (!enabled(level)) return;
  const parts = args.map((a) =>
    typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : safeStringify(a),
  );
  process.stderr.write(`[fba:${scope}] ${level === 'info' ? '' : level + ' '}${parts.join(' ')}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
  /** Time a promise and log its duration at debug level. */
  time<T>(label: string, fn: () => Promise<T>): Promise<T>;
  child(subScope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    error: (...a) => write('error', scope, a),
    warn: (...a) => write('warn', scope, a),
    info: (...a) => write('info', scope, a),
    debug: (...a) => write('debug', scope, a),
    trace: (...a) => write('trace', scope, a),
    async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
      if (!enabled('debug')) return fn();
      const t0 = Date.now();
      try {
        return await fn();
      } finally {
        write('debug', scope, [`${label} took ${Date.now() - t0}ms`]);
      }
    },
    child: (sub: string) => createLogger(`${scope}:${sub}`),
  };
}

export const log = createLogger('core');
