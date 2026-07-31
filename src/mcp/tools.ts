/**
 * The MCP tool surface (L4).
 *
 * Two economics govern every decision in this file.
 *
 *  1. **Tool definitions are resident context.** Their names, descriptions and
 *     JSON schemas are re-sent to the model on every single turn, so the tool
 *     surface is itself a latency and token cost. That is why there are nine
 *     coarse tools instead of thirty fine-grained ones: `click`, `type` and
 *     `press` are *steps inside* `browser_act`, not tools, and roles are typed
 *     as free strings rather than a forty-member enum that would be re-encoded
 *     into every request.
 *
 *  2. **Results are the other half of the bill.** Every successful result ends
 *     with the compact serializer rendering — never HTML, never JSON dumps of
 *     the DOM. Read-only tools (`find`, `map`, `extract`, `skill list`) end with
 *     a one-line page locator instead of a tree, because appending a full
 *     observation to a lookup would cost more than the lookup saves.
 *
 * Handlers never throw: everything is converted with `toFbaError` and returned
 * as `{ text: err.toLine(), isError: true }`. An error that explains its own
 * recovery path costs one round trip; one that says "Error" costs several.
 */

import { resolve as resolvePath } from 'node:path';

import { z } from 'zod';

import { FsProfileManager, detectWorkspace } from '../browser/profile.js';
import type {
  BrowserPool,
  CodeIndexer,
  Executor,
  FindCandidate,
  ProfileManager,
  Session,
  SkillRunner,
  SkillStore,
} from '../contracts.js';
import { replayEndpoint } from '../net/observer.js';
import { serializeObservation } from '../runtime/serialize.js';
import { compileFromSteps } from '../skills/runner.js';
import { normalizeOrigin } from '../skills/store.js';
import type {
  ActionStep,
  CodeIndex,
  CodeMatch,
  FbaConfig,
  FieldFillResult,
  FormFillRequest,
  Observation,
  ObservedEndpoint,
  SkillRecord,
  StepResult,
  Target,
  WorkspaceInfo,
} from '../types.js';
import { FbaError, toFbaError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { normalizeText, truncate } from '../util/text.js';

const logger = createLogger('mcp:tools');

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface ToolContext {
  config: FbaConfig;
  pool: BrowserPool;
  indexer: CodeIndexer;
  skills: SkillStore;
  runner: SkillRunner;
  executor: Executor;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler(args: unknown): Promise<{ text: string; isError?: boolean }>;
}

/** Canonical tool names, in registration order. */
export const TOOL_NAMES = [
  'browser_open',
  'browser_snapshot',
  'browser_act',
  'browser_form',
  'browser_find',
  'browser_map',
  'browser_extract',
  'browser_skill',
  'browser_session',
] as const;

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const sessionId = z.string().optional().describe('session id; defaults to the workspace\'s current session');
const workspaceArg = z.string().optional().describe('workspace root; defaults to cwd/git root');

/**
 * How to find an element.
 *
 * Two size decisions, because this schema is inlined into ~20 step variants and
 * every byte of it is re-sent on every turn:
 *  - `role` is a free string, not an enum of all 40 `SnapRole` values. It is
 *    only ever a disambiguator, and the resolver falls back through testId,
 *    name, label and text anyway.
 *  - the guidance lives in ONE object-level description instead of ten
 *    field-level ones.
 */
const targetSchema = z
  .object({
    ref: z.string().optional(),
    testId: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    text: z.string().optional(),
    placeholder: z.string().optional(),
    css: z.string().optional(),
    nth: z.number().int().min(0).optional(),
    within: z.string().optional(),
  })
  .describe('element: ref (e12, from a snapshot) or testId/role+name/label/text/placeholder/css; nth+within disambiguate')
  .refine((t) => Object.values(t).some((v) => v !== undefined), {
    message: 'target needs at least one of ref/testId/role/name/label/text/placeholder/css',
  });

const settleSchema = z.object({
  networkQuietMs: z.number().int().positive().optional(),
  domQuietMs: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const modifierSchema = z.enum(['Alt', 'Control', 'Meta', 'Shift']);

/**
 * The `ActionStep` union, mirrored faithfully so a malformed program is
 * rejected here — in the model's own turn, with a message naming the step —
 * rather than half-executing in the browser.
 */
const stepSchema = z.discriminatedUnion('do', [
  z.object({
    do: z.literal('click'),
    target: targetSchema,
    button: z.enum(['left', 'right', 'middle']).optional(),
    clickCount: z.number().int().positive().optional(),
    modifiers: z.array(modifierSchema).optional(),
  }),
  z.object({ do: z.literal('dblclick'), target: targetSchema }),
  z.object({ do: z.literal('hover'), target: targetSchema }),
  z.object({ do: z.literal('focus'), target: targetSchema }),
  z.object({ do: z.literal('blur'), target: targetSchema.optional() }),
  z.object({
    do: z.literal('type'),
    target: targetSchema,
    text: z.string(),
    clear: z.boolean().optional(),
    pressEnter: z.boolean().optional(),
  }),
  z.object({ do: z.literal('setValue'), target: targetSchema, value: z.string() }),
  z.object({ do: z.literal('select'), target: targetSchema, option: z.union([z.string(), z.array(z.string())]) }),
  z.object({ do: z.literal('check'), target: targetSchema, checked: z.boolean().optional() }),
  z.object({ do: z.literal('upload'), target: targetSchema, files: z.array(z.string()).min(1) }),
  z.object({ do: z.literal('press'), keys: z.string(), target: targetSchema.optional() }),
  z.object({
    do: z.literal('scroll'),
    target: targetSchema.optional(),
    to: z.enum(['top', 'bottom']).optional(),
    by: z.number().optional(),
  }),
  z.object({ do: z.literal('goto'), url: z.string().optional(), route: z.string().optional() }),
  z.object({ do: z.literal('back') }),
  z.object({ do: z.literal('forward') }),
  z.object({ do: z.literal('reload') }),
  z.object({
    do: z.literal('waitFor'),
    target: targetSchema.optional(),
    state: z.enum(['visible', 'hidden', 'enabled']).optional(),
    text: z.string().optional(),
    urlContains: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({ do: z.literal('settle'), options: settleSchema.optional() }),
  z.object({
    do: z.literal('assert'),
    target: targetSchema.optional(),
    exists: z.boolean().optional(),
    text: z.string().optional(),
    value: z.string().optional(),
    urlContains: z.string().optional(),
  }),
  z.object({ do: z.literal('dialog'), accept: z.boolean(), promptText: z.string().optional() }),
  z.object({ do: z.literal('selectTab'), path: z.array(z.string()).min(1) }),
  z.object({ do: z.literal('expand'), target: targetSchema }),
  z.object({ do: z.literal('eval'), fn: z.string(), args: z.array(z.unknown()).optional() }),
]);

const fieldValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

const scopeSchema = z.enum(['viewport', 'page', 'region']).optional();

// ---------------------------------------------------------------------------
// Argument schemas
// ---------------------------------------------------------------------------

const openArgs = z
  .object({
    url: z.string().optional().describe('absolute or app-relative url'),
    route: z.string().optional().describe('route pattern, path or nav label resolved from the code index'),
    params: z.record(z.string()).optional().describe('values for dynamic route segments'),
    workspace: workspaceArg,
    sessionId,
    fresh: z.boolean().optional().describe('open a new tab instead of reusing one'),
    scope: scopeSchema,
    full: z.boolean().optional(),
  })
  .refine((a) => (a.url === undefined) !== (a.route === undefined), {
    message: 'pass exactly one of url or route',
  });

const snapshotArgs = z.object({
  sessionId,
  scope: scopeSchema,
  root: z.string().optional().describe('ref to scope a region snapshot to'),
  filter: z.string().optional().describe('substring filter on names/values'),
  maxNodes: z.number().int().positive().max(2000).optional(),
  full: z.boolean().optional().describe('full tree instead of a diff'),
  expandCollapsed: z.boolean().optional(),
});

const actArgs = z.object({
  sessionId,
  steps: z.array(stepSchema).min(1),
  onFailure: z.enum(['stop', 'continue', 'retry']).optional(),
  full: z.boolean().optional(),
  record: z.string().optional().describe('save the program as a replayable skill under this name'),
  timeoutMs: z.number().int().positive().optional(),
});

const formArgs = z.object({
  sessionId,
  fields: z.record(fieldValueSchema).describe('label/name -> value'),
  within: z.string().optional().describe('ref of a dialog/panel to fill inside'),
  tabPath: z.array(z.string()).optional().describe('switch to this tab path first'),
  submit: z.union([z.boolean(), targetSchema]).optional(),
  strict: z.boolean().optional().describe('fail if any field is unmatched'),
});

const findArgs = z.object({
  query: z.string().min(1),
  sessionId,
  kind: z.enum(['any', 'element', 'route', 'config', 'selector', 'nav']).optional(),
  limit: z.number().int().positive().max(50).optional(),
  within: z.string().optional(),
});

const mapArgs = z.object({
  workspace: workspaceArg,
  query: z.string().optional().describe('filter routes/nav by text'),
  refresh: z.boolean().optional().describe('rebuild the code index'),
  sessionId,
});

const extractArgs = z.object({
  sessionId,
  schema: z.record(z.string()).optional().describe('field -> css selector or visible label'),
  selector: z.string().optional().describe('css selector; each match yields one row'),
  endpoint: z.string().optional().describe('observed endpoint to replay instead of reading the DOM'),
});

const skillArgs = z.object({
  action: z.enum(['list', 'save', 'replay', 'delete', 'show']),
  name: z.string().optional(),
  params: z.record(z.string()).optional(),
  steps: z.array(stepSchema).optional(),
  description: z.string().optional(),
  sessionId,
});

const sessionArgs = z.object({
  action: z.enum(['list', 'close', 'new', 'warm', 'reset', 'seed', 'profiles']),
  workspace: workspaceArg,
  sessionId,
  from: z.string().optional().describe('seed source: workspace path or profile id'),
  to: z.string().optional().describe('seed target: workspace path or profile id'),
});

// ---------------------------------------------------------------------------
// Session defaulting
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace a call belongs to.
 *
 * Everything is keyed off this: the profile directory, the browser context, the
 * code index and the session lookup. It walks up to the git root rather than
 * using the raw path, so a call made from `packages/web` lands on the same
 * workspace — and therefore the same logged-in browser — as one made from the
 * repository root. `detectWorkspace` reads three small files and never shells
 * out, so this is free enough to do per call.
 */
async function workspaceFor(ctx: ToolContext, workspace?: string): Promise<WorkspaceInfo> {
  return detectWorkspace(resolvePath(workspace ?? ctx.config.workspace ?? process.cwd()));
}

/**
 * Get a session for a call, creating one if necessary.
 *
 * `sessionId` is optional on every tool on purpose: an agent should never have
 * to thread a session id through a simple flow. The pool already resolves an
 * absent (or stale) id to the most recently used session of the workspace, and
 * opens one when the workspace has none — so a three-call flow works with no
 * bookkeeping at all, while a parallel agent driving two tabs can still be
 * explicit.
 */
async function sessionFor(
  ctx: ToolContext,
  args: { sessionId?: string; workspace?: string; fresh?: boolean },
): Promise<Session> {
  return ctx.pool.acquire({
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.workspace ? { workspace: args.workspace } : {}),
    ...(args.fresh ? { fresh: true } : {}),
  });
}

/**
 * The session a call *would* use, without launching a browser.
 *
 * Used by the read-only tools: answering "what does this app look like?" from
 * the code index must not cost a Chromium launch.
 */
async function existingSession(
  ctx: ToolContext,
  args: { sessionId?: string; workspace?: string },
): Promise<Session | undefined> {
  if (args.sessionId) return ctx.pool.get(args.sessionId);
  const wanted = (await workspaceFor(ctx, args.workspace)).id;
  // `pool.list()` is already sorted most-recently-used first.
  for (const info of ctx.pool.list()) {
    if (info.workspaceId !== wanted) continue;
    const session = ctx.pool.get(info.id);
    if (session) return session;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// URL / route resolution
// ---------------------------------------------------------------------------

export interface NavigationSpec {
  url?: string;
  route?: string;
  params?: Record<string, string>;
}

export interface ResolvedNavigation {
  url: string;
  /** How we got there, for the provenance line in the result. */
  via: string;
}

function baseUrlOf(config: FbaConfig, index: CodeIndex | undefined): string | undefined {
  return config.baseUrl ?? index?.baseUrl;
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

/**
 * Turn `{ url }` or `{ route }` into something the browser can navigate to.
 *
 * This is the deep-link shortcut: a route resolved from source skips the whole
 * click-through-the-menus sequence (three navigations, three snapshots, three
 * model turns) and replaces it with one navigation.
 */
export async function resolveNavigation(
  ctx: Pick<ToolContext, 'config' | 'indexer'>,
  workspaceRoot: string,
  spec: NavigationSpec,
): Promise<ResolvedNavigation> {
  if (spec.url !== undefined) {
    const raw = spec.url.trim();
    if (!raw) throw new FbaError('INVALID_ARGUMENT', 'url is empty');
    if (isAbsoluteUrl(raw)) return { url: raw, via: 'url' };

    const index = await ctx.indexer.get(workspaceRoot).catch(() => undefined);
    const base = baseUrlOf(ctx.config, index);
    if (!base) {
      throw new FbaError('INVALID_ARGUMENT', `"${raw}" is not an absolute url and no base url is known`, {
        hint: 'pass an absolute url, or set baseUrl in .fbarc.json / FBA_BASE_URL',
      });
    }
    return { url: new URL(raw, base).toString(), via: `${raw} on ${base}` };
  }

  const route = (spec.route ?? '').trim();
  if (!route) throw new FbaError('INVALID_ARGUMENT', 'route is empty');

  const index = await ctx.indexer.get(workspaceRoot);
  const resolved = ctx.indexer.resolveRoute(index, route, spec.params);
  if (!resolved) {
    const near = ctx.indexer.search(index, route, 5);
    throw new FbaError('ROUTE_NOT_FOUND', `no route matches "${route}" in ${workspaceRoot}`, {
      hint: near.length
        ? `closest: ${near.map((m) => m.url ?? m.label).join(', ')} — or call browser_map to list routes`
        : 'call browser_map to list the routes found in this workspace, or pass an absolute url',
      details: { route, candidates: near.map((m) => ({ label: m.label, url: m.url, source: m.source })) },
    });
  }
  if (!isAbsoluteUrl(resolved)) {
    const base = baseUrlOf(ctx.config, index);
    if (!base) {
      throw new FbaError('INVALID_ARGUMENT', `route "${route}" resolved to ${resolved} but no base url is known`, {
        hint: 'set baseUrl in .fbarc.json or FBA_BASE_URL so routes can become absolute urls',
      });
    }
    return { url: new URL(resolved, base).toString(), via: `route ${route} -> ${resolved}` };
  }
  return { url: resolved, via: `route ${route}` };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function observationText(observation: Observation): string {
  return `${observation.summary}\n${serializeObservation(observation)}`;
}

/** One cheap line telling a read-only result which page it was answered from. */
function pageLine(session: Session | undefined): string | undefined {
  if (!session) return undefined;
  const info = session.info();
  const title = normalizeText(info.title);
  return `page: ${info.url}${title ? `  |  ${truncate(title, 60)}` : ''}  [session ${info.id}]`;
}

function join(parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => p !== undefined && p !== '').join('\n');
}

function stepLines(steps: readonly StepResult[]): string[] {
  return steps.map((step) => {
    const parts = [`${step.index + 1}. ${step.step} ${step.status}`];
    if (step.resolution) {
      parts.push(step.resolution.healed ? `(healed: ${step.resolution.strategy})` : `(${step.resolution.strategy})`);
    }
    if (step.detail) parts.push(`— ${step.detail}`);
    if (step.error) parts.push(`— ${step.error}`);
    parts.push(`[${step.ms}ms]`);
    return parts.join(' ');
  });
}

function fieldLines(fields: readonly FieldFillResult[]): string[] {
  return fields.map((field) => {
    const parts = [`${field.key}: ${field.status}`];
    if (field.matchedName) parts.push(`-> "${truncate(field.matchedName, 60)}"`);
    if (field.ref) parts.push(field.ref);
    if (field.confidence !== undefined && field.confidence < 0.85) parts.push(`(${field.confidence.toFixed(2)})`);
    if (field.error) parts.push(`— ${field.error}`);
    return parts.join(' ');
  });
}

/**
 * Render an error for a tool result.
 *
 * `toLine()` already carries the hint; candidate lists live in `details` and are
 * worth their tokens because they turn a dead end into a retryable call.
 */
function errorText(error: FbaError): string {
  const lines = [error.toLine()];
  const candidates = error.details?.['candidates'];
  if (Array.isArray(candidates) && candidates.length > 0 && !error.toLine().includes('closest')) {
    lines.push(`candidates: ${candidates.map((c) => compactJson(c, 120)).join(' | ')}`);
  }
  return lines.join('\n');
}

function compactJson(value: unknown, max: number): string {
  try {
    return truncate(JSON.stringify(value) ?? String(value), max);
  } catch {
    return truncate(String(value), max);
  }
}

// ---------------------------------------------------------------------------
// Tool construction
// ---------------------------------------------------------------------------

type Handler<S extends z.ZodTypeAny> = (args: z.output<S>) => Promise<string | { text: string; isError?: boolean }>;

function define<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  run: Handler<S>,
): ToolDefinition {
  return {
    name,
    description,
    schema,
    async handler(raw: unknown): Promise<{ text: string; isError?: boolean }> {
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        return {
          text: new FbaError('INVALID_ARGUMENT', `bad arguments for ${name}: ${issues}`, {
            hint: 'fix the arguments and call again',
          }).toLine(),
          isError: true,
        };
      }
      try {
        const result = await run(parsed.data as z.output<S>);
        return typeof result === 'string' ? { text: result } : result;
      } catch (e) {
        const error = toFbaError(e);
        logger.debug(`${name} failed: ${error.toLine()}`);
        return { text: errorText(error), isError: true };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export function createTools(ctx: ToolContext): ToolDefinition[] {
  // Created lazily-but-once: it only touches the filesystem when a
  // browser_session call actually asks about profiles.
  const profiles: ProfileManager = new FsProfileManager(ctx.config);

  return [
    define(
      'browser_open',
      'Open a url, or deep-link to a route from the code index (skips clicking through menus). Returns a page observation.',
      openArgs,
      async (args) => {
        const root = (await workspaceFor(ctx, args.workspace)).root;
        const nav = await resolveNavigation(ctx, root, {
          ...(args.url !== undefined ? { url: args.url } : {}),
          ...(args.route !== undefined ? { route: args.route } : {}),
          ...(args.params ? { params: args.params } : {}),
        });
        const session = await sessionFor(ctx, args);
        await session.goto(nav.url);
        const observation = await session.observe({
          summaryPrefix: `opened ${nav.via}`,
          ...(args.scope ? { scope: args.scope } : {}),
          ...(args.full ? { full: true } : {}),
        });
        return join([`session: ${session.id}`, observationText(observation)]);
      },
    ),

    define(
      'browser_snapshot',
      'Observe the current page: a diff since the last observation by default, a full tree with full:true.',
      snapshotArgs,
      async (args) => {
        const session = await sessionFor(ctx, args);
        const observation = await session.observe({
          ...(args.scope ? { scope: args.scope } : {}),
          ...(args.root ? { root: args.root } : {}),
          ...(args.filter ? { filter: args.filter } : {}),
          ...(args.maxNodes ? { maxNodes: args.maxNodes } : {}),
          ...(args.full ? { full: true } : {}),
          ...(args.expandCollapsed ? { expandCollapsed: true } : {}),
        });
        // A filter that matches nothing is a dead end unless we say why. The
        // usual cause is that the control lives in a tab panel or accordion
        // that is currently closed, so it is genuinely not in the page — and
        // browser_find is the tool that sees across those.
        if (args.filter && (observation.stats?.emitted ?? 0) <= 1) {
          observation.notes = [
            ...(observation.notes ?? []),
            `no visible match for filter "${args.filter}" — controls inside unopened tabs or collapsed sections are not in the snapshot; use browser_find to locate them across tabs, or retry with expandCollapsed:true`,
          ];
        }
        return join([`session: ${session.id}`, observationText(observation)]);
      },
    ),

    define(
      'browser_act',
      'Run an action program: many guarded steps (click/type/select/waitFor/assert/goto/...) in ONE call. Stops at the first divergence.',
      actArgs,
      async (args) => {
        const session = await sessionFor(ctx, args);
        // The zod union mirrors ActionStep exactly; `role` is the one widened
        // field (string vs SnapRole) and the resolver treats it as a hint.
        const steps = args.steps as unknown as ActionStep[];
        const result = await ctx.executor.run(session, steps, {
          ...(args.onFailure ? { onFailure: args.onFailure } : {}),
          ...(args.full ? { full: true } : {}),
          ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
        });

        const lines = [`session: ${session.id}`, ...stepLines(result.steps)];
        if (args.record) {
          lines.push(await recordSkill(ctx, session, args.record, steps, result.ok));
        }
        if (!result.ok) {
          const failed = result.steps.find((s) => s.status === 'failed');
          lines.unshift(
            new FbaError(
              'STEP_FAILED',
              `step ${(result.failedAt ?? 0) + 1} (${failed?.step ?? 'unknown'}) failed: ${failed?.error ?? 'no detail'}`,
              { hint: 'the observation below shows the page as it actually is; re-target from it' },
            ).toLine(),
          );
        }
        lines.push(observationText(result.observation));
        return { text: join(lines), ...(result.ok ? {} : { isError: true }) };
      },
    ),

    define(
      'browser_form',
      'Fill many fields at once by label/name, optionally after switching tabs, then submit. One round trip for a whole form.',
      formArgs,
      async (args) => {
        const session = await sessionFor(ctx, args);
        const request: FormFillRequest = {
          fields: args.fields,
          ...(args.within ? { within: args.within } : {}),
          ...(args.tabPath && args.tabPath.length > 0 ? { tabPath: args.tabPath } : {}),
          ...(args.submit !== undefined
            ? { submit: typeof args.submit === 'boolean' ? args.submit : (args.submit as Target) }
            : {}),
          ...(args.strict ? { strict: true } : {}),
        };
        const result = await ctx.executor.fillForm(session, request);
        const lines = [`session: ${session.id}`, ...fieldLines(result.fields)];
        if (result.submitted) lines.push('submitted');
        if (!result.ok) {
          const unmatched = result.fields.filter((f) => f.status !== 'ok' && f.status !== 'unchanged');
          lines.unshift(
            new FbaError('STEP_FAILED', `${unmatched.length} field(s) did not fill`, {
              hint: 'check the observation for the real labels, or pass within/tabPath to narrow the search',
            }).toLine(),
          );
        }
        lines.push(observationText(result.observation));
        return { text: join(lines), ...(result.ok ? {} : { isError: true }) };
      },
    ),

    define(
      'browser_find',
      'Locate something by meaning across the live page AND the source code index, and say how to reach it (tab path, deep link, target).',
      findArgs,
      async (args) => {
        const kind = args.kind ?? 'any';
        const limit = args.limit ?? 8;
        return findText(ctx, args, kind, limit, (await workspaceFor(ctx)).root);
      },
    ),

    define(
      'browser_map',
      'Map the app: routes, nav/tab groups and config fields from the source code, plus the live tab structure if a page is open. No clicks.',
      mapArgs,
      async (args) => {
        const root = (await workspaceFor(ctx, args.workspace)).root;
        const index = await ctx.indexer.get(root, args.refresh ? { force: true } : {});
        const lines = mapLines(ctx, index, args.query);

        // Deliberately `existingSession`: mapping an app must never be the
        // reason a browser gets launched.
        const session = await existingSession(ctx, args);
        if (session) {
          const structure = await session.structure().catch(() => undefined);
          if (structure && structure.tabs.length > 0) {
            lines.push('', 'live tabs:');
            for (const tab of structure.tabs) {
              lines.push(
                `  ${tab.ref} ${tab.label}${tab.selected ? ' [selected]' : ''}${tab.group ? ` (${tab.group})` : ''}`,
              );
            }
          }
          const line = pageLine(session);
          if (line) lines.push('', line);
        }
        return join(lines);
      },
    ),

    define(
      'browser_extract',
      'Extract structured data: replay an observed API endpoint (no rendering), or read fields/rows from the DOM. No args lists observed endpoints.',
      extractArgs,
      async (args) => extractText(ctx, args),
    ),

    define(
      'browser_skill',
      'Replayable action programs: list | show | save | replay | delete. Replay costs zero model calls.',
      skillArgs,
      async (args) => skillText(ctx, args),
    ),

    define(
      'browser_session',
      'Manage per-workspace browser state: list | new | close | warm | reset | seed | profiles. Seed copies a logged-in profile into a fresh worktree.',
      sessionArgs,
      async (args) => sessionText(ctx, profiles, args),
    ),
  ];
}

// ---------------------------------------------------------------------------
// browser_find
// ---------------------------------------------------------------------------

/**
 * True when every tab panel enclosing a candidate is currently selected.
 *
 * Both paths run outermost-first, so "reachable right now" is exactly
 * "the candidate's path is a prefix of the page's selected path".
 */
function sameTabPath(candidate: readonly string[], current: readonly string[] | undefined): boolean {
  if (!current || current.length < candidate.length) return false;
  for (let i = 0; i < candidate.length; i += 1) {
    if (candidate[i] !== current[i]) return false;
  }
  return true;
}

async function findText(
  ctx: ToolContext,
  args: z.output<typeof findArgs>,
  kind: 'any' | 'element' | 'route' | 'config' | 'selector' | 'nav',
  limit: number,
  workspaceRoot: string,
): Promise<string> {
  const lines: string[] = [`query: "${args.query}"`];

  // 1. The live page, if one is already open. Finding an element costs one
  //    in-page call and no clicks.
  const session = await existingSession(ctx, args);
  if (session && kind !== 'route' && kind !== 'config' && kind !== 'nav') {
    const currentTab = session.lastSnapshot()?.tabPath;
    const within = args.within ? { within: args.within } : {};
    const lookup = async (query: { name?: string; text?: string }): Promise<FindCandidate[]> =>
      session.find({ ...query, ...within, limit }).catch((e: unknown) => {
        logger.debug(`in-page find failed: ${toFbaError(e).message}`);
        return [];
      });

    // The in-page matcher ANDs its criteria, so `{name, text}` in one call would
    // require both to match. Ask by accessible name first — that is what an
    // agent almost always means — and only fall back to body text.
    let candidates = await lookup({ name: args.query });
    if (candidates.length === 0) candidates = await lookup({ text: args.query });
    if (candidates.length > 0) {
      lines.push(`page (${candidates.length}):`);
      for (const c of candidates) {
        // "How to reach it" is the point of this tool, so it has to be the
        // candidate's own tab path — not the page's current one. A control
        // sitting in an unopened panel needs a selectTab first, and saying
        // otherwise buys a failed click and a recovery round trip.
        const where = !c.tabPath || c.tabPath.length === 0
          ? 'reachable now, not inside a tab panel'
          : sameTabPath(c.tabPath, currentTab)
            ? `reachable now, tab ${c.tabPath.join(' > ')}`
            : `needs selectTab ${JSON.stringify(c.tabPath)}`;
        lines.push(`  ${c.ref} ${c.role} "${truncate(normalizeText(c.name), 60)}" (${c.score.toFixed(2)}) — ${where}`);
      }
    } else {
      lines.push('page: no match in the current view');
    }
  }

  // 2. The code index. Works with no browser at all and is the only source that
  //    can produce a deep link.
  if (kind !== 'element') {
    const index = await ctx.indexer.get(workspaceRoot);
    const wanted = kind === 'any' ? undefined : kind;
    const matches = ctx.indexer
      .search(index, args.query, limit * 2)
      .filter((m) => (wanted ? m.kind === wanted : true))
      .slice(0, limit);
    if (matches.length > 0) {
      lines.push(`code (${matches.length}):`);
      for (const match of matches) lines.push(`  ${codeMatchLine(match, index, ctx.config)}`);
    } else {
      lines.push('code: no match in the index');
    }
  }

  if (!session) lines.push('(no page open — code index only; call browser_open to search the live page too)');
  const line = pageLine(session);
  if (line) lines.push(line);
  return join(lines);
}

function codeMatchLine(match: CodeMatch, index: CodeIndex, config: FbaConfig): string {
  const parts = [`${match.kind} "${truncate(match.label, 60)}"`, `(${match.score.toFixed(2)})`];
  if (match.url) {
    parts.push(`-> ${match.url}`);
    // The reach instruction is the point of this tool: a deep link means the
    // element is one navigation away, not a menu walk away.
    parts.push(`— browser_open{route:"${routeArgFor(match, index, config)}"}`);
  } else if (match.target) {
    parts.push(`— target ${compactJson(match.target, 120)}`);
  }
  parts.push(`@${match.source}`);
  return parts.join(' ');
}

/** The string to hand back to `browser_open` so the caller can reuse the hit. */
function routeArgFor(match: CodeMatch, index: CodeIndex, config: FbaConfig): string {
  const base = baseUrlOf(config, index);
  if (!match.url) return match.label;
  if (base && match.url.startsWith(base)) return match.url.slice(base.length) || '/';
  return match.url;
}

// ---------------------------------------------------------------------------
// browser_map
// ---------------------------------------------------------------------------

const MAX_MAPPED_ROUTES = 60;

function mapLines(ctx: ToolContext, index: CodeIndex, query?: string): string[] {
  const lines: string[] = [];
  const base = baseUrlOf(ctx.config, index);
  lines.push(
    `workspace: ${index.workspaceRoot}` +
      `  |  frameworks: ${index.frameworks.join(', ') || 'unknown'}` +
      (base ? `  |  base: ${base}` : ''),
  );
  lines.push(
    `index: ${index.routes.length} routes, ${index.navGroups.length} nav groups, ` +
      `${index.configFields.length} config fields, ${index.stats.filesScanned} files (${index.stats.buildMs}ms)`,
  );

  if (index.routes.length === 0 && index.navGroups.length === 0) {
    lines.push('(no routes found — this workspace may not be a UI project, or FBA_CODE_INDEX is off)');
    return lines;
  }

  const q = normalizeText(query).toLowerCase();
  const keep = (text: string): boolean => !q || text.toLowerCase().includes(q);

  const routes = index.routes.filter((r) => keep(`${r.pattern} ${r.label ?? ''}`));
  if (routes.length > 0) {
    lines.push('', `routes (${routes.length}):`);
    for (const route of routes.slice(0, MAX_MAPPED_ROUTES)) {
      const label = route.label ? ` "${truncate(route.label, 40)}"` : '';
      const params = route.params.length > 0 ? ` params:${route.params.join(',')}` : '';
      lines.push(`  ${route.pattern}${label}${params}  @${route.source}`);
    }
    if (routes.length > MAX_MAPPED_ROUTES) {
      lines.push(`  … +${routes.length - MAX_MAPPED_ROUTES} more (pass query to filter)`);
    }
  }

  const groups = index.navGroups.filter(
    (g) => keep(g.label ?? '') || g.items.some((item) => keep(item.label)),
  );
  if (groups.length > 0) {
    lines.push('', `nav (${groups.length}):`);
    for (const group of groups.slice(0, 20)) {
      const items = group.items
        .slice(0, 12)
        .map((item) => (item.href ? `${item.label} -> ${item.href}` : item.label))
        .join(' | ');
      lines.push(`  ${group.label ?? '(unnamed)'}: ${truncate(items, 300)}  @${group.source}`);
    }
  }

  if (q) {
    const fields = index.configFields.filter((f) => keep(`${f.path} ${f.label ?? ''}`)).slice(0, 20);
    if (fields.length > 0) {
      lines.push('', `config fields (${fields.length}):`);
      for (const field of fields) {
        const type = field.type ? `: ${field.type}` : '';
        const values = field.enumValues && field.enumValues.length > 0 ? ` (${field.enumValues.slice(0, 6).join('|')})` : '';
        lines.push(`  ${field.path}${type}${values}  @${field.source}`);
      }
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// browser_extract
// ---------------------------------------------------------------------------

const MAX_EXTRACT_ROWS = 50;
const MAX_PAYLOAD_CHARS = 6000;

async function extractText(ctx: ToolContext, args: z.output<typeof extractArgs>): Promise<string> {
  const wantsPage = args.endpoint !== undefined || (args.schema && Object.keys(args.schema).length > 0);
  // Listing what has been observed must not launch a browser: with no page
  // open the answer is "nothing yet", and it costs nothing to say so.
  const session = wantsPage ? await sessionFor(ctx, args) : await existingSession(ctx, args);
  if (!session) {
    return 'no page open — call browser_open first; endpoints are observed while the app runs';
  }
  const endpoints = session.endpoints();

  if (args.endpoint !== undefined) {
    const endpoint = pickEndpoint(endpoints, args.endpoint);
    const started = Date.now();
    const result = await replayEndpoint(session.page, endpoint);
    const payload =
      result.json !== undefined ? compactJson(result.json, MAX_PAYLOAD_CHARS) : truncate(result.text ?? '', MAX_PAYLOAD_CHARS);
    // No snapshot, no serializer: a replayed endpoint never rendered anything,
    // and appending a page tree here would undo the entire saving.
    return join([
      `${endpoint.method} ${endpoint.url} -> ${result.status}${result.contentType ? ` ${result.contentType}` : ''} [${Date.now() - started}ms]`,
      payload,
    ]);
  }

  if (!args.schema || Object.keys(args.schema).length === 0) {
    const lines = [`observed endpoints (${endpoints.length}):`];
    for (const endpoint of endpoints) lines.push(`  ${endpointLine(endpoint)}`);
    if (endpoints.length === 0) {
      lines.push('  (none yet — navigate or interact first, then call again)');
    } else {
      lines.push('pass endpoint:"<method> <pattern>" to replay one, or schema:{field:"selector|label"} to read the DOM');
    }
    const line = pageLine(session);
    if (line) lines.push(line);
    return join(lines);
  }

  const fields = Object.entries(args.schema).map(([key, spec]) => ({ key, spec: String(spec) }));
  const rows = await extractFromDom(session, fields, args.selector);
  const lines: string[] = [];
  if (rows.length === 0) {
    lines.push(args.selector ? `no elements matched selector ${args.selector}` : 'no values extracted');
  } else if (rows.length === 1 && !args.selector) {
    const row = rows[0] ?? {};
    for (const field of fields) lines.push(`${field.key}: ${renderCell(row[field.key])}`);
  } else {
    lines.push(`rows: ${rows.length}`);
    rows.forEach((row, i) => {
      lines.push(`${i + 1}. ${fields.map((f) => `${f.key}=${renderCell(row[f.key])}`).join('  ')}`);
    });
  }
  const line = pageLine(session);
  if (line) lines.push(line);
  return join(lines);
}

function renderCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return '(not found)';
  return value === '' ? '(empty)' : truncate(value, 200);
}

function endpointLine(endpoint: ObservedEndpoint): string {
  const parts = [`${endpoint.method} ${endpoint.pattern}`, `x${endpoint.hits}`];
  if (endpoint.status !== undefined) parts.push(String(endpoint.status));
  if (endpoint.responseShape) parts.push(truncate(endpoint.responseShape, 120));
  return parts.join('  ');
}

/** Match an endpoint the way a caller would name it: method+pattern, or any substring. */
function pickEndpoint(endpoints: readonly ObservedEndpoint[], wanted: string): ObservedEndpoint {
  const needle = wanted.trim().toLowerCase();
  const scored = endpoints
    .map((endpoint) => {
      const method = endpoint.method.toLowerCase();
      const label = `${method} ${endpoint.pattern}`.toLowerCase();
      const url = endpoint.url.toLowerCase();
      let score = 0;
      if (label === needle || url === needle || endpoint.pattern.toLowerCase() === needle) score = 3;
      else if (label.includes(needle) || url.includes(needle)) score = 2;
      else if (needle.includes(endpoint.pattern.toLowerCase())) score = 1;
      return { endpoint, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.endpoint.hits - a.endpoint.hits);

  const best = scored[0]?.endpoint;
  if (best) return best;
  throw new FbaError('INVALID_ARGUMENT', `no observed endpoint matches "${wanted}"`, {
    hint:
      endpoints.length > 0
        ? `known: ${endpoints.slice(0, 6).map((e) => `${e.method} ${e.pattern}`).join(', ')}`
        : 'no endpoints observed yet — navigate or interact with the app first',
    details: { candidates: endpoints.slice(0, 6).map((e) => `${e.method} ${e.pattern}`) },
  });
}

interface ExtractField {
  key: string;
  spec: string;
}

type ExtractedRow = Record<string, string | null>;

/**
 * Read fields out of the DOM in ONE page evaluation.
 *
 * Each spec is tried as a CSS selector first and as a visible label second, so
 * a caller can mix `{"total": ".cart-total", "Status": "Status"}` without
 * knowing which is which. When `selector` is given every matching element
 * becomes a row, which is how lists and tables come back as records.
 */
async function extractFromDom(
  session: Session,
  fields: ExtractField[],
  selector: string | undefined,
): Promise<ExtractedRow[]> {
  const request = { fields, selector: selector ?? null, maxRows: MAX_EXTRACT_ROWS };
  try {
    return await session.page.evaluate(
      (req: { fields: ExtractField[]; selector: string | null; maxRows: number }): ExtractedRow[] => {
        const norm = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();

        const readValue = (element: Element | null): string | null => {
          if (!element) return null;
          const tag = element.tagName.toLowerCase();
          if (tag === 'input') {
            const input = element as HTMLInputElement;
            const type = (input.type || 'text').toLowerCase();
            if (type === 'checkbox' || type === 'radio') return input.checked ? 'true' : 'false';
            return input.value;
          }
          if (tag === 'textarea') return (element as HTMLTextAreaElement).value;
          if (tag === 'select') {
            const select = element as HTMLSelectElement;
            const chosen = Array.from(select.selectedOptions).map((o) => o.label || o.value);
            return chosen.join(', ');
          }
          const valueNow = element.getAttribute('aria-valuenow');
          if (valueNow !== null) return valueNow;
          return norm(element.textContent);
        };

        const query = (root: ParentNode, spec: string): Element | null => {
          try {
            return root.querySelector(spec);
          } catch {
            // Not a selector at all (e.g. "SMTP Port") — the label pass handles it.
            return null;
          }
        };

        const controlFor = (label: HTMLLabelElement): Element | null => {
          if (label.control) return label.control;
          const id = label.htmlFor;
          if (id) {
            const byId = label.ownerDocument.getElementById(id);
            if (byId) return byId;
          }
          return label.querySelector('input, select, textarea, [contenteditable="true"]');
        };

        /** Text after removing the label itself — "Status: Active" -> "Active". */
        const trailing = (container: Element, labelText: string): string | null => {
          const whole = norm(container.textContent);
          const index = whole.toLowerCase().indexOf(labelText.toLowerCase());
          if (index < 0) return null;
          const rest = whole.slice(index + labelText.length).replace(/^[\s:\-–—]+/, '');
          return rest ? rest : null;
        };

        const byLabel = (root: ParentNode, spec: string): string | null => {
          const want = norm(spec).toLowerCase();
          if (!want) return null;

          for (const label of Array.from(root.querySelectorAll('label'))) {
            const text = norm(label.textContent).toLowerCase().replace(/[:*]\s*$/, '');
            if (text !== want && !text.includes(want)) continue;
            const control = controlFor(label as HTMLLabelElement);
            if (control) return readValue(control);
          }

          for (const el of Array.from(root.querySelectorAll('[aria-label], [placeholder], [name], [data-testid], [data-test]'))) {
            const keys = [
              el.getAttribute('aria-label'),
              el.getAttribute('placeholder'),
              el.getAttribute('name'),
              el.getAttribute('data-testid'),
              el.getAttribute('data-test'),
            ];
            if (!keys.some((k) => k !== null && norm(k).toLowerCase() === want)) continue;
            return readValue(el);
          }

          // Read-only presentations: dt/dd, th/td, "Label: value" siblings.
          const scanned = Array.from(root.querySelectorAll('dt, th, td, span, div, p, li, strong, b, label'));
          for (const el of scanned.slice(0, 4000)) {
            const text = norm(el.textContent).toLowerCase().replace(/[:*]\s*$/, '');
            if (text !== want) continue;
            const tag = el.tagName.toLowerCase();
            const next = el.nextElementSibling;
            if (tag === 'dt' && next && next.tagName.toLowerCase() === 'dd') return readValue(next);
            if ((tag === 'th' || tag === 'td') && next) return readValue(next);
            if (next) {
              const value = readValue(next);
              if (value) return value;
            }
            const parent = el.parentElement;
            if (parent) {
              const rest = trailing(parent, norm(el.textContent));
              if (rest) return rest;
            }
          }
          return null;
        };

        const extractRow = (root: ParentNode): ExtractedRow => {
          const row: ExtractedRow = {};
          for (const field of req.fields) {
            const direct = query(root, field.spec);
            row[field.key] = direct ? readValue(direct) : byLabel(root, field.spec);
          }
          return row;
        };

        if (req.selector === null) return [extractRow(document)];
        let roots: Element[] = [];
        try {
          roots = Array.from(document.querySelectorAll(req.selector)).slice(0, req.maxRows);
        } catch {
          return [];
        }
        return roots.map((root) => extractRow(root));
      },
      request,
    );
  } catch (e) {
    throw toFbaError(e, 'INTERNAL');
  }
}

// ---------------------------------------------------------------------------
// browser_skill
// ---------------------------------------------------------------------------

async function skillText(ctx: ToolContext, args: z.output<typeof skillArgs>): Promise<string | { text: string; isError?: boolean }> {
  switch (args.action) {
    case 'list': {
      const session = await existingSession(ctx, args);
      const origin = session ? safeOrigin(session) : undefined;
      const records = await ctx.skills.list(origin);
      const lines = [`skills (${records.length})${origin ? ` for ${origin}` : ''}:`];
      for (const record of records) lines.push(`  ${skillLine(record)}`);
      if (records.length === 0) {
        lines.push('  (none — run browser_act with record:"name" to compile one)');
      }
      const line = pageLine(session);
      if (line) lines.push(line);
      return join(lines);
    }

    case 'show': {
      const record = await requireSkill(ctx, args.name);
      return join([
        skillLine(record),
        record.description ? `description: ${record.description}` : undefined,
        `steps (${record.steps.length}):`,
        ...record.steps.map((step, i) => `  ${i + 1}. ${compactJson(step, 300)}`),
      ]);
    }

    case 'save': {
      const name = requireName(args.name);
      if (!args.steps || args.steps.length === 0) {
        throw new FbaError('INVALID_ARGUMENT', 'save needs steps', { hint: 'pass the action program to store' });
      }
      const session = await existingSession(ctx, args);
      const origin = session ? safeOrigin(session) : ctx.config.baseUrl;
      if (!origin) {
        throw new FbaError('INVALID_ARGUMENT', 'cannot save a skill without an origin', {
          hint: 'open the app first (browser_open), or set baseUrl so the skill can be keyed',
        });
      }
      const record = compileFromSteps(name, origin, args.steps as unknown as ActionStep[], {
        ...(args.description ? { description: args.description } : {}),
        addAssertions: true,
      });
      await ctx.skills.save(record);
      return join([`saved ${skillLine(record)}`, `replay with browser_skill{action:"replay",name:"${record.name}"}`]);
    }

    case 'replay': {
      const name = requireName(args.name);
      const session = await sessionFor(ctx, args);
      const result = await ctx.runner.replay(session, name, args.params ?? {});
      const lines = [`session: ${session.id}`, `replay ${result.name}: ${result.ok ? 'ok' : 'FAILED'} [${result.ms}ms]`];
      lines.push(...stepLines(result.steps));
      if (result.fallbackReason) {
        lines.unshift(
          new FbaError('SKILL_REPLAY_FAILED', result.fallbackReason, {
            hint: 'drive the flow with browser_act, then re-record it with record:"<name>"',
          }).toLine(),
        );
      }
      lines.push(observationText(result.observation));
      return { text: join(lines), ...(result.ok ? {} : { isError: true }) };
    }

    case 'delete': {
      const name = requireName(args.name);
      const removed = await ctx.skills.delete(name);
      if (!removed) throw new FbaError('SKILL_NOT_FOUND', `no skill named "${name}"`, { hint: 'list skills first' });
      return `deleted skill ${name}`;
    }

    default:
      throw new FbaError('INVALID_ARGUMENT', `unknown skill action`);
  }
}

function skillLine(record: SkillRecord): string {
  const parts = [`${record.name} @ ${record.origin}`, `${record.steps.length} steps`];
  if (record.params.length > 0) parts.push(`params: ${record.params.join(',')}`);
  parts.push(`${record.runs} runs${record.failures > 0 ? `, ${record.failures} failed` : ''}`);
  if (record.lastMs !== undefined) parts.push(`${record.lastMs}ms`);
  if (record.description) parts.push(`— ${truncate(record.description, 80)}`);
  return parts.join('  ');
}

function requireName(name: string | undefined): string {
  const value = normalizeText(name);
  if (!value) throw new FbaError('INVALID_ARGUMENT', 'name is required for this action');
  return value;
}

async function requireSkill(ctx: ToolContext, name: string | undefined): Promise<SkillRecord> {
  const wanted = requireName(name);
  const record = await ctx.skills.get(wanted);
  if (record) return record;
  const known = (await ctx.skills.list()).slice(0, 8).map((r) => r.name);
  throw new FbaError('SKILL_NOT_FOUND', `no skill named "${wanted}"`, {
    hint: known.length > 0 ? `known skills: ${known.join(', ')}` : 'record one with browser_act{record:"name"}',
    details: { candidates: known },
  });
}

function safeOrigin(session: Session): string | undefined {
  const url = session.info().url;
  if (!url || url === 'about:blank') return undefined;
  try {
    return normalizeOrigin(url);
  } catch {
    return undefined;
  }
}

/**
 * Compile a just-succeeded program into the skill cache.
 *
 * Recording lives here rather than in the executor because only this layer
 * knows the origin and owns the store — and because a failed program must
 * never be cached: replaying a broken trajectory is worse than having none.
 */
async function recordSkill(
  ctx: ToolContext,
  session: Session,
  name: string,
  steps: ActionStep[],
  ok: boolean,
): Promise<string> {
  if (!ok) return `not recorded as "${name}": the program did not succeed`;
  if (!ctx.config.skills) return `not recorded as "${name}": the skill cache is disabled`;
  const origin = safeOrigin(session);
  if (!origin) return `not recorded as "${name}": no page origin to key the skill by`;
  try {
    const record = compileFromSteps(name, origin, steps, { addAssertions: true });
    await ctx.skills.save(record);
    return `recorded skill "${record.name}" (${record.steps.length} steps${record.params.length ? `, params ${record.params.join(',')}` : ''})`;
  } catch (e) {
    // The actions themselves succeeded; failing the whole call over a caching
    // problem would throw away work the agent already paid for.
    return `not recorded as "${name}": ${toFbaError(e).message}`;
  }
}

// ---------------------------------------------------------------------------
// browser_session
// ---------------------------------------------------------------------------

async function sessionText(
  ctx: ToolContext,
  profiles: ProfileManager,
  args: z.output<typeof sessionArgs>,
): Promise<string> {
  const workspace = await workspaceFor(ctx, args.workspace);

  switch (args.action) {
    case 'list': {
      const sessions = ctx.pool.list();
      const lines = [`sessions (${sessions.length}):`];
      for (const info of sessions) {
        lines.push(
          `  ${info.id}  ws:${info.workspaceId}  v${info.version}  ${info.url}` +
            `  idle ${Math.round((Date.now() - info.lastUsedAt) / 1000)}s`,
        );
      }
      if (sessions.length === 0) lines.push('  (none open)');
      return join(lines);
    }

    case 'new': {
      // `sessionId` is deliberately dropped: the pool returns an existing
      // session whenever it is given a live id, which would silently turn
      // "give me a new tab" into "give me the tab I already had".
      const session = await sessionFor(ctx, {
        ...(args.workspace ? { workspace: args.workspace } : {}),
        fresh: true,
      });
      const observation = await session.observe({ summaryPrefix: 'new session' });
      return join([`session: ${session.id} (workspace ${session.workspaceId})`, observationText(observation)]);
    }

    case 'close': {
      if (args.sessionId) {
        await ctx.pool.closeSession(args.sessionId);
        return `closed session ${args.sessionId}`;
      }
      await ctx.pool.closeWorkspace(workspace.id);
      return `closed every session for workspace ${workspace.id}`;
    }

    case 'warm': {
      const started = Date.now();
      await ctx.pool.warm(workspace.root);
      return `browser warm for ${workspace.root} [${Date.now() - started}ms]`;
    }

    case 'reset': {
      // The browser holds the profile lock; it has to go first or `reset` would
      // refuse (correctly) to delete a directory in use.
      await ctx.pool.closeWorkspace(workspace.id);
      await profiles.reset(workspace.id);
      return `reset profile ${workspace.id} (${workspace.root}) — the next call starts logged out`;
    }

    case 'seed': {
      const from = await profileIdFor(profiles, args.from, 'from');
      const to = await profileIdFor(profiles, args.to, 'to');
      await profiles.seed(from, to);
      return `seeded ${to} from ${from} — the target workspace now shares its cookies and local storage`;
    }

    case 'profiles': {
      const list = await profiles.list();
      const lines = [`profiles (${list.length}):`];
      for (const profile of list) {
        const size = profile.sizeBytes !== undefined ? `${Math.round(profile.sizeBytes / 1024 / 1024)}MB` : '?';
        lines.push(
          `  ${profile.id}  ${size}${profile.lockedBy !== undefined ? `  locked by pid ${profile.lockedBy}` : ''}` +
            `${profile.root ? `  ${profile.root}` : ''}`,
        );
      }
      if (list.length === 0) lines.push('  (none yet)');
      return join(lines);
    }

    default:
      throw new FbaError('INVALID_ARGUMENT', 'unknown session action');
  }
}

/**
 * Accept either a workspace path or a profile id.
 *
 * A path is what an agent naturally has ("the main checkout is at ~/app"); the
 * id is what `profiles` prints. Anything containing a separator is treated as a
 * path so that ids — which are always `<slug>-<hash8>` — stay unambiguous.
 */
async function profileIdFor(profiles: ProfileManager, value: string | undefined, which: string): Promise<string> {
  const raw = normalizeText(value);
  if (!raw) {
    throw new FbaError('INVALID_ARGUMENT', `seed needs a "${which}" workspace path or profile id`, {
      hint: 'call browser_session{action:"profiles"} to list ids',
    });
  }
  if (raw.includes('/') || raw.includes('\\') || raw === '.' || raw.startsWith('~')) {
    const workspace = await profiles.describe(resolvePath(raw.startsWith('~') ? raw.replace('~', process.env['HOME'] ?? '~') : raw));
    return workspace.id;
  }
  return raw;
}
