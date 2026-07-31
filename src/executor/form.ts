/**
 * L2 — bulk form filling.
 *
 * The highest-leverage tool in the whole server. A twelve-field configuration
 * page costs a naive agent something like 25 model round trips (snapshot,
 * decide, click, type, re-snapshot, ...). Here it costs one: the caller sends
 * `{ host: 'smtp.example.com', port: 587, tls: true, ... }`, this file takes a
 * *single* snapshot, matches every key against the controls it found, compiles
 * one action program, and runs it in one deterministic pass.
 *
 * Two design rules carry most of the value:
 *
 *  - The action is chosen from the CONTROL's role, never from the value's type.
 *    `{ notifications: 'off' }` on a switch must uncheck it, not type "off"
 *    into it; `{ port: 587 }` on a textbox must type "587". Guessing from the
 *    value is how bulk fillers corrupt forms.
 *  - Fields that already hold the requested value are skipped. On config pages
 *    most fields are already correct, and every skipped field is an actionability
 *    wait, a re-render and a change event that never happen — this is routinely
 *    the difference between a 400ms fill and a 4s one.
 */

import type { Executor, Session, TargetResolver } from '../contracts.js';
import { CONTAINER_ROLES, INTERACTIVE_ROLES } from '../types.js';
import type {
  ActionStep,
  FieldFillResult,
  FormFillRequest,
  FormFillResult,
  Observation,
  Ref,
  SnapNode,
  SnapRole,
  StepResult,
  Target,
} from '../types.js';
import { FbaError, errorMessage } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { matchKey, normalizeText, rankMatches, truncate } from '../util/text.js';

const logger = createLogger('executor:form');

/** Below this a "match" is really a guess, and a wrong field is worse than none. */
const MIN_FIELD_SCORE = 0.55;

/** Snapshot cap for the matching pool. It never reaches the model, so it can be generous. */
const POOL_MAX_NODES = 1_500;

export type FieldValue = string | number | boolean | string[];

/** What we do to a control, derived from its role. */
export type FieldAction = 'check' | 'select' | 'type' | 'radio' | 'upload' | 'click';

/** One interactive control lifted out of the snapshot. */
export interface FieldCandidate {
  ref: Ref;
  role: SnapRole;
  name?: string;
  value?: string;
  testId?: string;
  placeholder?: string;
  options?: string[];
  /** Nearest named ancestor container — disambiguates repeated field names. */
  group?: string;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  readonly?: boolean;
}

// ---------------------------------------------------------------------------
// pure helpers (unit-tested without a browser)
// ---------------------------------------------------------------------------

const TRUTHY = new Set(['true', 'yes', 'on', '1', 'checked', 'enabled', 'y']);
const FALSY = new Set(['false', 'no', 'off', '0', 'unchecked', 'disabled', 'n']);

/**
 * Coerce a JSON-ish value into a checkbox state.
 *
 * Callers write config the way their config files look — `"true"`, `"on"`,
 * `1`, `yes` — and all of those mean the same thing to a checkbox. Returns
 * undefined when the value carries no boolean meaning, so the caller can
 * report a real error instead of silently unchecking something.
 */
export function coerceBoolean(value: FieldValue): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : undefined;
  if (Array.isArray(value)) return undefined;
  const key = matchKey(value);
  if (TRUTHY.has(key)) return true;
  if (FALSY.has(key)) return false;
  return undefined;
}

/**
 * Map a control's role onto the action that fills it.
 *
 * The value's type is consulted only for roles that carry no interaction
 * semantics at all (`generic`, custom widgets), where there is nothing better
 * to go on.
 */
export function actionForRole(role: SnapRole, value: FieldValue): FieldAction {
  switch (role) {
    case 'checkbox':
    case 'switch':
      return 'check';
    case 'combobox':
    case 'listbox':
      return 'select';
    case 'radio':
      return 'radio';
    case 'file':
      return 'upload';
    case 'textbox':
    case 'searchbox':
    case 'slider':
    case 'spinbutton':
    case 'colorpicker':
    case 'datepicker':
      return 'type';
    case 'button':
    case 'link':
    case 'menuitem':
    case 'tab':
    case 'option':
    case 'treeitem':
      return 'click';
    default:
      return Array.isArray(value) ? 'select' : 'type';
  }
}

/** Words that name a "commit this form" control, most decisive first. */
const SUBMIT_WORDS = [
  'save',
  'save changes',
  'submit',
  'apply',
  'update',
  'confirm',
  'create',
  'done',
  'continue',
  // "OK" is last of the English words: it is also the label of every
  // acknowledgement dialog, so it should only win when nothing better exists.
  'ok',
  // Same buttons in the languages we can recognise without a dependency.
  'speichern',
  'ubernehmen',
  'enregistrer',
  'valider',
  'guardar',
  'salvar',
  'salva',
  'opslaan',
  'gemma',
  'zapisz',
  'sacuvaj',
  'kaydet',
  'сохранить',
  'применить',
  '保存',
  '確定',
  '적용',
  '저장',
];

export interface SubmitCandidate {
  ref?: Ref;
  role: SnapRole;
  name?: string;
  testId?: string;
}

/**
 * Pick the control that commits the form.
 *
 * Exact label matches beat containing ones, and earlier words in SUBMIT_WORDS
 * beat later ones, so "Save" wins over "Save as draft" which wins over "OK".
 */
export function pickSubmitTarget<T extends SubmitCandidate>(candidates: readonly T[]): T | undefined {
  let best: T | undefined;
  let bestScore = 0;

  for (const candidate of candidates) {
    if (candidate.role !== 'button') continue;
    const name = matchKey(candidate.name ?? '');
    const testId = matchKey(candidate.testId ?? '').replace(/[\s-]+/g, '');
    let score = 0;

    for (let i = 0; i < SUBMIT_WORDS.length; i++) {
      const word = SUBMIT_WORDS[i];
      if (!word) continue;
      const rank = i * 0.001;
      if (name === word) score = Math.max(score, 1 - rank);
      else if (name.startsWith(`${word} `) || name.endsWith(` ${word}`) || name.includes(` ${word} `)) {
        score = Math.max(score, 0.8 - rank);
      }
    }
    if (/submit|save|apply/.test(testId)) score = Math.max(score, 0.9);

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Flatten a snapshot tree into the interactive controls we can fill. */
export function collectCandidates(tree: SnapNode | undefined): FieldCandidate[] {
  const out: FieldCandidate[] = [];

  const walk = (node: SnapNode, group: string | undefined): void => {
    if (node.ref && INTERACTIVE_ROLES.has(node.role)) {
      out.push({
        ref: node.ref,
        role: node.role,
        ...(node.name ? { name: node.name } : {}),
        ...(node.value !== undefined ? { value: node.value } : {}),
        ...(node.meta?.testId ? { testId: node.meta.testId } : {}),
        ...(node.meta?.placeholder ? { placeholder: node.meta.placeholder } : {}),
        ...(node.meta?.options ? { options: node.meta.options } : {}),
        ...(group ? { group } : {}),
        ...(node.state?.checked !== undefined ? { checked: node.state.checked } : {}),
        ...(node.state?.disabled ? { disabled: true } : {}),
        ...(node.state?.readonly ? { readonly: true } : {}),
      });
    }
    // Containers name the section a field lives in ("SMTP", "Advanced"), which
    // is what lets `smtp.port` beat a bare `port` elsewhere on the page.
    const nextGroup = CONTAINER_ROLES.has(node.role) && node.name ? node.name : group;
    for (const child of node.children ?? []) walk(child, nextGroup);
  };

  if (tree) walk(tree, undefined);
  return out;
}

/** Keys a requested field name is matched against, best signal first. */
function candidateKeys(candidate: FieldCandidate): Array<string | undefined> {
  return [
    candidate.name,
    candidate.testId,
    candidate.placeholder,
    candidate.group ? `${candidate.group} ${candidate.name ?? ''}`.trim() : undefined,
  ];
}

function valueToString(value: FieldValue): string {
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function sameText(a: string | undefined, b: string): boolean {
  return normalizeText(a ?? '') === normalizeText(b);
}

// ---------------------------------------------------------------------------
// the fill
// ---------------------------------------------------------------------------

interface PlannedField {
  key: string;
  candidate: FieldCandidate;
  score: number;
  step: ActionStep;
}

export async function fillForm(
  session: Session,
  request: FormFillRequest,
  resolver: TargetResolver,
  run: Executor['run'],
): Promise<FormFillResult> {
  const keys = Object.keys(request.fields);

  // 1. Tabs first — the controls simply do not exist in the DOM until the right
  //    panel is mounted, so this has to happen before the snapshot.
  if (request.tabPath && request.tabPath.length > 0) {
    const tabResult = await run(session, [{ do: 'selectTab', path: request.tabPath }], {
      onFailure: 'stop',
      settle: false,
    });
    if (!tabResult.ok) {
      return {
        fields: keys.map((key) => ({ key, status: 'unmatched' as const })),
        submitted: false,
        ok: false,
        observation: tabResult.observation,
      };
    }
  }

  // 2. ONE snapshot builds the whole candidate pool.
  const snapshot = await takeSnapshot(session, request.within);
  const pool = collectCandidates(snapshot.tree);

  // 3. Match every requested key against that pool.
  const results: FieldFillResult[] = [];
  const planned: PlannedField[] = [];
  const used = new Set<Ref>();

  for (const key of keys) {
    const value = request.fields[key];
    if (value === undefined) continue;

    // Text matching against the snapshot first (free), then one round trip to
    // the in-page matcher for the keys it could not place — see rescueMatch.
    const match = matchField(key, pool, used) ?? (await rescueMatch(session, resolver, key, pool, used));
    if (!match) {
      results.push({ key, status: 'unmatched' });
      continue;
    }

    const { candidate, score } = match;
    used.add(candidate.ref);

    if (candidate.disabled || candidate.readonly) {
      results.push({
        key,
        status: 'failed',
        ref: candidate.ref,
        ...(candidate.name ? { matchedName: candidate.name } : {}),
        confidence: score,
        error: `matched ${candidate.role} "${candidate.name ?? candidate.ref}" but it is ${candidate.disabled ? 'disabled' : 'read-only'}`,
      });
      continue;
    }

    let plan: { step: ActionStep; unchanged: boolean } | { error: string };
    try {
      plan = planField(candidate, value, pool);
    } catch (e) {
      plan = { error: errorMessage(e) };
    }

    if ('error' in plan) {
      results.push({
        key,
        status: 'failed',
        ref: candidate.ref,
        ...(candidate.name ? { matchedName: candidate.name } : {}),
        confidence: score,
        error: plan.error,
      });
      continue;
    }

    if (plan.unchanged) {
      results.push({
        key,
        status: 'unchanged',
        ref: candidate.ref,
        ...(candidate.name ? { matchedName: candidate.name } : {}),
        confidence: score,
      });
      continue;
    }

    planned.push({ key, candidate, score, step: plan.step });
  }

  const unmatched = results.filter((r) => r.status === 'unmatched');

  // Strict mode fails BEFORE touching the page: a half-filled form the caller
  // believes is complete is the worst possible outcome.
  if (request.strict && unmatched.length > 0) {
    const observation = await observeSafely(
      session,
      `form fill aborted — ${unmatched.length} unmatched field(s) in strict mode`,
    );
    observation.notes = [
      ...(observation.notes ?? []),
      `unmatched: ${unmatched.map((u) => u.key).join(', ')}`,
      `available controls: ${describePool(pool)}`,
    ];
    return { fields: orderResults(keys, results), submitted: false, ok: false, observation };
  }

  // 4. Compile ONE program: every field, then the submit click.
  const steps: ActionStep[] = planned.map((p) => p.step);
  const submitStep = request.submit ? buildSubmitStep(request.submit, pool) : undefined;
  if (submitStep) steps.push(submitStep);

  if (steps.length === 0) {
    const observation = await observeSafely(session, summarize(results, false));
    return { fields: orderResults(keys, results), submitted: false, ok: isOk(results, request.strict), observation };
  }

  const actResult = await run(session, steps, {
    // One bad field must not silently swallow the remaining eleven; the caller
    // gets a per-field report and decides what to do.
    onFailure: 'continue',
    // A wide form legitimately needs more than a single-action budget.
    timeoutMs: Math.max(session.config.timeoutMs, steps.length * 2_000),
  });

  for (let i = 0; i < planned.length; i++) {
    const plan = planned[i];
    const stepResult = actResult.steps[i];
    if (!plan) continue;
    results.push(fieldResultFrom(plan, stepResult));
  }

  const submitted = submitStep
    ? actResult.steps[planned.length]?.status === 'ok' || actResult.steps[planned.length]?.status === 'healed'
    : false;

  let observation = actResult.observation;

  if (submitStep) {
    // A submit is a semantic boundary, and the default settle windows are tuned
    // for intermediate steps. Apps very commonly paint an optimistic "Saving…"
    // and only write the real outcome after a network hop or a short timer, so
    // the generic 200ms DOM-quiet window reports the optimistic state. Handing
    // that back costs the agent a whole extra round trip to learn whether the
    // save actually succeeded — far more expensive than waiting a few hundred
    // more milliseconds here.
    try {
      await session.settle({ networkQuietMs: 400, domQuietMs: 600, timeoutMs: 4_000 });
      observation = await session.observe({ noSettle: true });
    } catch (e) {
      logger.debug(`post-submit settle failed: ${errorMessage(e)}`);
    }
  }

  observation.summary = `${summarize(results, submitted)} — ${observation.summary}`;

  if (submitStep) {
    // The agent must learn immediately that a save was rejected; discovering it
    // two steps later costs a whole recovery loop.
    const problems = await scanValidationErrors(session);
    if (problems.length > 0) {
      observation.notes = [
        ...(observation.notes ?? []),
        `validation errors after submit: ${problems.map((p) => truncate(p, 120)).join(' | ')}`,
      ];
    }
  }
  if (unmatched.length > 0) {
    observation.notes = [
      ...(observation.notes ?? []),
      `unmatched fields: ${unmatched.map((u) => u.key).join(', ')}`,
    ];
  }

  const ordered = orderResults(keys, results);
  return {
    fields: ordered,
    submitted: Boolean(submitted),
    ok: isOk(ordered, request.strict) && (!submitStep || Boolean(submitted)),
    observation,
  };
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

function matchField(
  key: string,
  pool: readonly FieldCandidate[],
  used: ReadonlySet<Ref>,
): { candidate: FieldCandidate; score: number } | undefined {
  const available = pool.filter((c) => !used.has(c.ref));
  const ranked = rankMatches(key, available, candidateKeys, { minScore: MIN_FIELD_SCORE, limit: 1 });
  const top = ranked[0];
  return top ? { candidate: top.item, score: top.score } : undefined;
}

/**
 * Second chance for a key the snapshot text could not place.
 *
 * The in-page matcher resolves associations the snapshot's accessible name does
 * not carry — `<label for>` pointing at a control whose own name came from a
 * placeholder, `aria-labelledby` chains, wrapper labels. It costs one round trip
 * per otherwise-unmatched key, which is a good trade against reporting a field
 * the page really does have as missing. The ref it returns is looked back up in
 * the pool so the action is still chosen from the control's real role.
 */
async function rescueMatch(
  session: Session,
  resolver: TargetResolver,
  key: string,
  pool: readonly FieldCandidate[],
  used: ReadonlySet<Ref>,
): Promise<{ candidate: FieldCandidate; score: number } | undefined> {
  for (const target of [{ label: key }, { name: key }] satisfies Target[]) {
    const resolved = await resolver.tryResolve(session, target);
    const ref = resolved?.resolution.ref;
    if (!ref || used.has(ref)) continue;
    const candidate = pool.find((c) => c.ref === ref);
    if (candidate) return { candidate, score: resolved?.resolution.confidence ?? MIN_FIELD_SCORE };
  }
  return undefined;
}

/** Build the step for one matched control, or report it as already correct. */
function planField(
  candidate: FieldCandidate,
  value: FieldValue,
  pool: readonly FieldCandidate[],
): { step: ActionStep; unchanged: boolean } {
  const target: Target = { ref: candidate.ref };
  const action = actionForRole(candidate.role, value);

  switch (action) {
    case 'check': {
      const wanted = coerceBoolean(value);
      if (wanted === undefined) {
        throw new FbaError(
          'INVALID_ARGUMENT',
          `${candidate.role} "${candidate.name ?? candidate.ref}" needs a boolean, got ${JSON.stringify(value)}`,
        );
      }
      if (candidate.checked === wanted) return { step: { do: 'check', target, checked: wanted }, unchanged: true };
      return { step: { do: 'check', target, checked: wanted }, unchanged: false };
    }

    case 'select': {
      const option = Array.isArray(value) ? value.map(String) : String(value);
      const unchanged = !Array.isArray(option) && sameText(candidate.value, option);
      return { step: { do: 'select', target, option }, unchanged };
    }

    case 'radio': {
      const wanted = valueToString(value);
      const radio = pickRadio(candidate, wanted, pool);
      if (!radio) {
        throw new FbaError('TARGET_NOT_FOUND', `no radio labelled "${wanted}" in this group`, {
          hint: `options: ${pool
            .filter((c) => c.role === 'radio' && c.group === candidate.group)
            .map((c) => c.name ?? c.ref)
            .join(' | ')}`,
        });
      }
      if (radio.checked === true) return { step: { do: 'click', target: { ref: radio.ref } }, unchanged: true };
      return { step: { do: 'click', target: { ref: radio.ref } }, unchanged: false };
    }

    case 'upload': {
      const files = Array.isArray(value) ? value : [String(value)];
      return { step: { do: 'upload', target, files }, unchanged: false };
    }

    case 'click':
      return { step: { do: 'click', target }, unchanged: false };

    case 'type':
    default: {
      const text = valueToString(value);
      if (sameText(candidate.value, text)) return { step: { do: 'type', target, text, clear: true }, unchanged: true };
      return { step: { do: 'type', target, text, clear: true }, unchanged: false };
    }
  }
}

/**
 * A radio's accessible name is its own label ("Monthly"), not the group's, so
 * the requested VALUE is what identifies the radio to click.
 */
function pickRadio(
  matched: FieldCandidate,
  value: string,
  pool: readonly FieldCandidate[],
): FieldCandidate | undefined {
  const siblings = pool.filter((c) => c.role === 'radio' && c.group === matched.group);
  const scope = siblings.length > 0 ? siblings : pool.filter((c) => c.role === 'radio');
  const ranked = rankMatches(value, scope, (c) => [c.name, c.value, c.testId], { minScore: MIN_FIELD_SCORE, limit: 1 });
  return ranked[0]?.item ?? (matchKey(matched.name ?? '') === matchKey(value) ? matched : undefined);
}

function buildSubmitStep(submit: true | Target | boolean, pool: readonly FieldCandidate[]): ActionStep | undefined {
  if (submit === false) return undefined;
  if (submit !== true) return { do: 'click', target: submit };

  const picked = pickSubmitTarget(pool);
  if (picked?.ref) return { do: 'click', target: { ref: picked.ref } };
  // Nothing recognisable by name — fall back to the form's own submit control,
  // which the accessibility tree does not distinguish from any other button.
  return { do: 'click', target: { css: 'button[type="submit"], input[type="submit"]' } };
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function fieldResultFrom(plan: PlannedField, stepResult: StepResult | undefined): FieldFillResult {
  const base = {
    key: plan.key,
    ref: plan.candidate.ref,
    ...(plan.candidate.name ? { matchedName: plan.candidate.name } : {}),
    confidence: plan.score,
  };
  if (!stepResult) return { ...base, status: 'failed', error: 'step did not run' };
  if (stepResult.status === 'ok' || stepResult.status === 'healed') return { ...base, status: 'ok' };
  return {
    ...base,
    status: 'failed',
    error: stepResult.error ?? stepResult.detail ?? `step ${stepResult.status}`,
  };
}

/** Preserve the caller's field order so the report reads like the request. */
function orderResults(keys: readonly string[], results: readonly FieldFillResult[]): FieldFillResult[] {
  const byKey = new Map<string, FieldFillResult>();
  for (const result of results) if (!byKey.has(result.key)) byKey.set(result.key, result);
  const ordered: FieldFillResult[] = [];
  for (const key of keys) {
    const hit = byKey.get(key);
    if (hit) ordered.push(hit);
  }
  return ordered;
}

function isOk(results: readonly FieldFillResult[], strict: boolean | undefined): boolean {
  return results.every((r) => r.status === 'ok' || r.status === 'unchanged' || (!strict && r.status === 'unmatched'));
}

function summarize(results: readonly FieldFillResult[], submitted: boolean): string {
  const count = (status: FieldFillResult['status']): number => results.filter((r) => r.status === status).length;
  const parts = [`${count('ok')} filled`];
  if (count('unchanged') > 0) parts.push(`${count('unchanged')} unchanged`);
  if (count('failed') > 0) parts.push(`${count('failed')} failed`);
  if (count('unmatched') > 0) parts.push(`${count('unmatched')} unmatched`);
  if (submitted) parts.push('submitted');
  return parts.join(', ');
}

function describePool(pool: readonly FieldCandidate[]): string {
  return (
    pool
      .slice(0, 20)
      .map((c) => `${c.role} "${truncate(c.name ?? c.placeholder ?? c.testId ?? c.ref, 40)}"`)
      .join(' | ') || 'none'
  );
}

// ---------------------------------------------------------------------------
// page access
// ---------------------------------------------------------------------------

async function takeSnapshot(session: Session, within: Ref | undefined): Promise<{ tree?: SnapNode }> {
  const options = within
    ? ({ scope: 'region', root: within, maxNodes: POOL_MAX_NODES, includeText: false, expandCollapsed: true } as const)
    : ({ scope: 'page', maxNodes: POOL_MAX_NODES, includeText: false, expandCollapsed: true } as const);
  try {
    return await session.snapshot(options);
  } catch (e) {
    if (!within) throw e;
    // The scoping ref died (a re-render between snapshot and fill). Fall back to
    // the whole page rather than failing the call outright.
    logger.debug(`region snapshot for ${within} failed, falling back to page scope: ${errorMessage(e)}`);
    return session.snapshot({ scope: 'page', maxNodes: POOL_MAX_NODES, includeText: false, expandCollapsed: true });
  }
}

async function observeSafely(session: Session, summaryPrefix: string): Promise<Observation> {
  try {
    return await session.observe({ noSettle: true, summaryPrefix });
  } catch (e) {
    return {
      url: session.page.url(),
      title: '',
      summary: `${summaryPrefix} — observation failed: ${errorMessage(e)}`,
    };
  }
}

/**
 * Collect visible validation messages after a submit.
 *
 * Done with one page evaluation rather than a snapshot because the signals we
 * need (class names, `aria-invalid`, `aria-errormessage`) are DOM-level details
 * the snapshot deliberately drops.
 */
async function scanValidationErrors(session: Session): Promise<string[]> {
  try {
    const found: unknown = await session.page.evaluate(() => {
      const out: string[] = [];
      const seen = new Set<string>();
      const push = (raw: string | null | undefined): void => {
        const text = (raw ?? '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 300 || seen.has(text)) return;
        seen.add(text);
        out.push(text);
      };
      const selector =
        '[role="alert"], [aria-invalid="true"], [data-error], [class*="error" i], [class*="invalid" i]';
      const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 60);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.getClientRects().length === 0) continue; // not rendered
        if (node.getAttribute('aria-invalid') === 'true') {
          const id = node.getAttribute('aria-errormessage') ?? node.getAttribute('aria-describedby');
          const described = id ? document.getElementById(id) : null;
          const label = node.getAttribute('name') ?? (node.id || 'field');
          push(described?.textContent ?? node.getAttribute('title') ?? `${label}: invalid`);
          continue;
        }
        push(node.innerText || node.textContent);
      }
      return out.slice(0, 8);
    });
    return Array.isArray(found) ? found.filter((v): v is string => typeof v === 'string') : [];
  } catch (e) {
    logger.debug(`validation scan failed: ${errorMessage(e)}`);
    return [];
  }
}
