/**
 * L2 — target resolution.
 *
 * A `Target` is deliberately over-specified: callers pass whatever they happen
 * to know (a ref from the last snapshot, a testId they read out of the source,
 * an accessible name the user said out loud) and this resolver walks a fallback
 * chain until something addresses exactly one element.
 *
 * The chain is the *self-healing* property of the whole system. Refs are minted
 * per snapshot generation and die on navigation or on a re-render that replaces
 * the node; a naive executor would fail the step and burn a full model round
 * trip re-discovering an element that never actually moved. Here a dead ref
 * simply falls through to the next strategy, the step still runs, and the
 * `healed` flag tells the caller its cached ref is stale so it can refresh
 * cheaply instead of re-planning.
 *
 * The other half of the design is *not* guessing: when several elements tie for
 * best match we refuse to pick one and raise `TARGET_AMBIGUOUS` carrying the top
 * candidates. One extra round trip in which the model says "the second one" is
 * far cheaper than clicking the wrong Delete button.
 */

import type { Locator } from 'playwright-core';

import type { ResolvedTarget, Session, TargetResolver } from '../contracts.js';
import type { Ref, ResolutionInfo, SnapNode, Target } from '../types.js';
import { FbaError } from '../util/errors.js';
import { cssEscapeValue, truncate } from '../util/text.js';

/** What the in-page runtime returns from `find()`. */
interface FindCandidate {
  ref: Ref;
  role: string;
  name: string;
  score: number;
}

/**
 * Two candidates whose scores differ by less than this are considered tied.
 * The in-page matcher is coarse-grained on purpose, so anything closer than a
 * few hundredths carries no real signal about which element was meant.
 */
const TIE_EPSILON = 0.05;

/** How many candidates we ask the runtime for; enough to detect ties and report. */
const CANDIDATE_LIMIT = 8;

/** Short bound for the incidental attribute reads this file performs. */
const ATTR_TIMEOUT_MS = 2_000;

export interface TargetResolverOptions {
  /**
   * Fuzzy candidates below this score are treated as "not found" rather than
   * clicked. Raising it makes the resolver stricter (more `TARGET_NOT_FOUND`,
   * fewer wrong clicks).
   */
  minConfidence?: number;
}

/** Render a target the way a human would say it, for logs and error messages. */
export function describeTarget(target: Target): string {
  const parts: string[] = [];
  if (target.role) parts.push(target.role);
  if (target.name) parts.push(`"${truncate(target.name, 60)}"`);
  if (target.label) parts.push(`label "${truncate(target.label, 60)}"`);
  if (target.text) parts.push(`text "${truncate(target.text, 60)}"`);
  if (target.placeholder) parts.push(`placeholder "${truncate(target.placeholder, 60)}"`);
  if (target.testId) parts.push(`testId=${target.testId}`);
  if (target.css) parts.push(`css=${truncate(target.css, 60)}`);
  if (target.ref) parts.push(`ref=${target.ref}`);
  if (target.nth !== undefined) parts.push(`#${target.nth}`);
  if (target.within) parts.push(`within ${target.within}`);
  return parts.length > 0 ? parts.join(' ') : '<empty target>';
}

/** True when the target carries at least one addressable field. */
export function hasSelector(target: Target): boolean {
  return Boolean(
    target.ref ??
      target.testId ??
      target.css ??
      target.role ??
      target.name ??
      target.label ??
      target.text ??
      target.placeholder,
  );
}

/** CSS that addresses a ref stamped by the page runtime. */
export function selectorForRef(ref: Ref): string {
  return `[data-fba="${cssEscapeValue(ref)}"]`;
}

function testIdSelector(value: string): string {
  const v = cssEscapeValue(value);
  // Cover the four conventions we see in the wild in one selector so that a
  // testId lifted from source works regardless of the project's flavour.
  return `[data-testid="${v}"], [data-test="${v}"], [data-cy="${v}"], [data-qa="${v}"]`;
}

/** Prefix each comma-separated clause of `selector` with `scope`. */
function scopeSelector(selector: string, within: Ref | undefined): string {
  if (!within) return selector;
  const prefix = `${selectorForRef(within)} `;
  return selector
    .split(',')
    .map((part) => `${prefix}${part.trim()}`)
    .join(', ');
}

function findNodeByRef(node: SnapNode | undefined, ref: Ref): SnapNode | undefined {
  if (!node) return undefined;
  if (node.ref === ref) return node;
  for (const child of node.children ?? []) {
    const hit = findNodeByRef(child, ref);
    if (hit) return hit;
  }
  return undefined;
}

function nodeSummary(node: SnapNode): string {
  return node.name ? `${node.role} "${truncate(node.name, 60)}"` : node.role;
}

function candidateSummary(candidate: FindCandidate): string {
  return candidate.name ? `${candidate.role} "${truncate(candidate.name, 60)}"` : candidate.role;
}

export class DefaultTargetResolver implements TargetResolver {
  private readonly minConfidence: number;

  constructor(options: TargetResolverOptions = {}) {
    this.minConfidence = options.minConfidence ?? 0.5;
  }

  async resolve(session: Session, target: Target): Promise<ResolvedTarget> {
    if (!hasSelector(target)) {
      throw new FbaError('INVALID_ARGUMENT', 'target has no selector fields', {
        hint: 'provide at least one of ref, testId, css, role, name, label, text or placeholder',
      });
    }

    // `healed` flips the first time a strategy the caller explicitly asked for
    // comes up empty. Everything after that point is a repair, and the caller
    // needs to know so it can refresh its cached refs.
    const state = { healed: false, nearMisses: [] as FindCandidate[] };

    // 1. ref — cheapest and exact, but the most perishable.
    if (target.ref) {
      const hit = await this.byCss(session, selectorForRef(target.ref), target, 'ref', 1, state.healed);
      if (hit) return hit;
      // A stale ref must NOT fail the step: the element is usually still there
      // under the same name, it just got a new generation id after a re-render
      // or navigation. Fall through and let the semantic strategies find it.
      state.healed = true;
    }

    // 2. testId — stable across redesigns, the best thing a codebase can offer.
    if (target.testId) {
      const hit = await this.byCss(
        session,
        scopeSelector(testIdSelector(target.testId), target.within),
        target,
        'testId',
        0.95,
        state.healed,
      );
      if (hit) return hit;
      state.healed = true;
    }

    // 3. css — exactly what the caller asked for, no interpretation.
    if (target.css) {
      const hit = await this.byCss(
        session,
        scopeSelector(target.css, target.within),
        target,
        'css',
        0.9,
        state.healed,
      );
      if (hit) return hit;
      state.healed = true;
    }

    // 4. role + name — the semantic identity of a control, and the strategy
    //    that survives virtually every refactor.
    if (target.role ?? target.name) {
      const hit = await this.byQuery(
        session,
        { role: target.role, name: target.name },
        target,
        'role+name',
        state,
      );
      if (hit) return hit;
      state.healed = true;
    }

    if (target.label) {
      const hit = await this.byQuery(session, { label: target.label }, target, 'label', state);
      if (hit) return hit;
      state.healed = true;
    }

    if (target.placeholder) {
      const hit = await this.byQuery(
        session,
        { placeholder: target.placeholder },
        target,
        'placeholder',
        state,
      );
      if (hit) return hit;
      state.healed = true;
    }

    if (target.text) {
      const hit = await this.byQuery(session, { text: target.text }, target, 'text', state);
      if (hit) return hit;
      state.healed = true;
    }

    // 8. name alone — drop the role constraint. Roles are frequently wrong
    //    (a "button" that is really a link, a "combobox" that is a listbox),
    //    so this is the last repair before giving up.
    if (target.name && target.role) {
      const hit = await this.byQuery(session, { name: target.name }, target, 'role+name', state);
      if (hit) return hit;
      state.healed = true;
    }

    throw await this.notFound(session, target, state.nearMisses);
  }

  async tryResolve(session: Session, target: Target): Promise<ResolvedTarget | undefined> {
    try {
      return await this.resolve(session, target);
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // strategies
  // -------------------------------------------------------------------------

  private async byCss(
    session: Session,
    selector: string,
    target: Target,
    strategy: ResolutionInfo['strategy'],
    baseConfidence: number,
    healed: boolean,
  ): Promise<ResolvedTarget | undefined> {
    let locator: Locator;
    try {
      locator = session.page.locator(selector);
    } catch {
      // Malformed CSS from the caller — treat as "no match" so the chain heals.
      return undefined;
    }

    let count: number;
    try {
      count = await locator.count();
    } catch {
      return undefined;
    }
    if (count === 0) return undefined;

    const index = target.nth ?? 0;
    if (index >= count) return undefined;
    const picked = locator.nth(index);

    // Multiple CSS matches are not treated as ambiguous: unlike fuzzy name
    // matches we have no candidate descriptions to offer the model, and
    // "first match wins" is the universal convention for a selector. We do
    // lower the confidence and say so, so a surprised caller can see why.
    const extra = target.nth === undefined && count > 1;
    const confidence = extra ? Math.max(0, baseConfidence - 0.1) : baseConfidence;

    const ref =
      strategy === 'ref' && target.ref
        ? target.ref
        : ((await this.readRef(picked)) ?? '');

    const known = ref ? findNodeByRef(session.lastSnapshot()?.tree, ref) : undefined;
    const base = known ? nodeSummary(known) : describeTarget(target);
    const description = extra
      ? `${base} (${count} matches for ${strategy}, using #${index})`
      : `${base} via ${strategy}`;

    return { locator: picked, resolution: { strategy, confidence, healed, ref, description } };
  }

  private async byQuery(
    session: Session,
    query: { role?: string; name?: string; text?: string; label?: string; placeholder?: string },
    target: Target,
    strategy: ResolutionInfo['strategy'],
    state: { healed: boolean; nearMisses: FindCandidate[] },
  ): Promise<ResolvedTarget | undefined> {
    let candidates: FindCandidate[];
    try {
      candidates = await session.find({
        ...query,
        ...(target.within ? { within: target.within } : {}),
        limit: CANDIDATE_LIMIT,
      });
    } catch {
      // The runtime may be missing right after a navigation; the caller's
      // retry path re-injects it. Treat as "no match" here.
      return undefined;
    }
    if (candidates.length === 0) return undefined;

    const ranked = [...candidates].sort((a, b) => b.score - a.score);

    if (target.nth !== undefined) {
      const picked = ranked[target.nth];
      if (!picked) return undefined;
      return this.fromCandidate(session, picked, strategy, state.healed);
    }

    const top = ranked[0];
    if (!top) return undefined;
    if (top.score < this.minConfidence) {
      state.nearMisses.push(...ranked.slice(0, 3));
      return undefined;
    }

    const tied = ranked.filter((c) => top.score - c.score < TIE_EPSILON);
    if (tied.length > 1) {
      throw new FbaError(
        'TARGET_AMBIGUOUS',
        `${tied.length} elements match ${describeTarget(target)}`,
        {
          hint: 'add nth, a role, a testId or within to disambiguate — the candidates are listed in details',
          details: {
            target: describeTarget(target),
            strategy,
            candidates: tied.slice(0, 3).map((c, i) => ({
              nth: i,
              ref: c.ref,
              role: c.role,
              name: truncate(c.name, 80),
              score: Number(c.score.toFixed(3)),
            })),
          },
        },
      );
    }

    return this.fromCandidate(session, top, strategy, state.healed);
  }

  private fromCandidate(
    session: Session,
    candidate: FindCandidate,
    strategy: ResolutionInfo['strategy'],
    healed: boolean,
  ): ResolvedTarget {
    // The ref came straight out of the live DOM, so it addresses the element
    // globally — no need to re-apply `within` scoping here.
    const locator = session.page.locator(selectorForRef(candidate.ref)).first();
    return {
      locator,
      resolution: {
        strategy,
        confidence: Math.max(0, Math.min(1, candidate.score)),
        healed,
        ref: candidate.ref,
        description: `${candidateSummary(candidate)} via ${strategy}`,
      },
    };
  }

  private async readRef(locator: Locator): Promise<string | undefined> {
    // One extra attribute read buys the caller a usable ref for every
    // strategy, which is what makes `within` chaining and diffing work after a
    // CSS/testId resolution.
    try {
      return (await locator.getAttribute('data-fba', { timeout: ATTR_TIMEOUT_MS })) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async notFound(
    session: Session,
    target: Target,
    nearMisses: FindCandidate[],
  ): Promise<FbaError> {
    const closest = nearMisses.length > 0 ? nearMisses : await this.probe(session, target);
    const listed = closest
      .slice(0, 3)
      .map((c) => `${candidateSummary(c)} (${c.score.toFixed(2)}, ref ${c.ref})`)
      .join(', ');

    return new FbaError('TARGET_NOT_FOUND', `no element matches ${describeTarget(target)}`, {
      hint: listed
        ? `closest candidates: ${listed} — retry with one of those refs, or add nth/within`
        : 'nothing on the page matched — snapshot first, and check the right tab or dialog is open',
      details: {
        target: describeTarget(target),
        ...(closest.length > 0
          ? {
              candidates: closest.slice(0, 3).map((c) => ({
                ref: c.ref,
                role: c.role,
                name: truncate(c.name, 80),
                score: Number(c.score.toFixed(3)),
              })),
            }
          : {}),
      },
    });
  }

  /** Last-ditch broad search purely to make the error message actionable. */
  private async probe(session: Session, target: Target): Promise<FindCandidate[]> {
    const needle = target.name ?? target.label ?? target.text ?? target.placeholder ?? target.testId;
    if (!needle) return [];
    try {
      return await session.find({
        name: needle,
        ...(target.within ? { within: target.within } : {}),
        limit: 3,
      });
    } catch {
      return [];
    }
  }
}

/** Shared default instance; stateless, so a singleton is safe. */
export const targetResolver: TargetResolver = new DefaultTargetResolver();
