/**
 * Error taxonomy.
 *
 * Every error that can reach a tool result carries a machine-readable `code`
 * and, where possible, a `hint` telling the agent what to try next. A failed
 * tool call that explains its own recovery path costs one round trip; one that
 * just says "Error" costs several.
 */

export type FbaErrorCode =
  | 'NO_SESSION'
  | 'NO_BROWSER'
  | 'BROWSER_LAUNCH_FAILED'
  | 'PROFILE_LOCKED'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'
  | 'TARGET_NOT_ACTIONABLE'
  | 'NAVIGATION_FAILED'
  | 'TIMEOUT'
  | 'STEP_FAILED'
  | 'ASSERTION_FAILED'
  | 'SKILL_NOT_FOUND'
  | 'SKILL_REPLAY_FAILED'
  | 'INDEX_FAILED'
  | 'ROUTE_NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'PAGE_CRASHED'
  | 'INTERNAL';

export class FbaError extends Error {
  readonly code: FbaErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: FbaErrorCode,
    message: string,
    options?: { hint?: string; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'FbaError';
    this.code = code;
    this.hint = options?.hint;
    this.details = options?.details;
  }

  /** Compact single-object form used in tool results. */
  toJSON(): { code: FbaErrorCode; message: string; hint?: string; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }

  /** One-line rendering: `TARGET_NOT_FOUND: no "Save" button — hint: ...`. */
  toLine(): string {
    return `${this.code}: ${this.message}${this.hint ? ` — ${this.hint}` : ''}`;
  }
}

export function isFbaError(e: unknown): e is FbaError {
  return e instanceof FbaError;
}

/** Normalise anything thrown into an FbaError. */
export function toFbaError(e: unknown, fallbackCode: FbaErrorCode = 'INTERNAL'): FbaError {
  if (isFbaError(e)) return e;
  const message = e instanceof Error ? e.message : String(e);
  // Playwright timeouts are extremely common; give them a precise code.
  if (/Timeout .* exceeded|waiting for .* exceeded/i.test(message)) {
    return new FbaError('TIMEOUT', message, { cause: e });
  }
  if (/Target (page|closed)|Execution context was destroyed/i.test(message)) {
    return new FbaError('NO_SESSION', message, {
      hint: 'the page navigated or closed — take a fresh snapshot',
      cause: e,
    });
  }
  return new FbaError(fallbackCode, message, { cause: e });
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
