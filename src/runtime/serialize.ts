/**
 * Snapshot / diff serialisation (L1).
 *
 * Everything an agent ever sees about a page passes through this file, so the
 * primary design goal is characters-per-fact and the secondary one is
 * readability. Two consequences drive the whole format:
 *
 *  - It is indented plain text, not JSON. JSON spends roughly a third of its
 *    bytes on braces, quotes and repeated key names; an indented line-per-node
 *    form spends none of them and tokenises about as well.
 *  - Nothing is printed that can be inferred from absence. No `= ` means the
 *    value is empty, no flag group means default state, no ref means the node
 *    is not addressable. Defaults are free; only deviations cost.
 *
 * The rendering is display-only — it is never parsed back — but names and
 * values keep full fidelity (escaped rather than mangled) because agents copy
 * them straight into a `Target`.
 */

import { INTERACTIVE_ROLES } from '../types.js';
import type {
  DiffEntry,
  Observation,
  OverlayInfo,
  PageSnapshot,
  SnapNode,
  SnapRole,
  SnapshotDiff,
  SnapshotStats,
} from '../types.js';
import { normalizeText, plural, truncate } from '../util/text.js';

export interface SerializeOptions {
  /** Hard character budget for the whole rendering. Default 12000. */
  maxChars?: number;
  /** Print `e12` handles. Default true. */
  showRefs?: boolean;
  /** Per-depth indentation. Default two spaces. */
  indent?: string;
  /** Shorten roles (`button` -> `btn`). Default true. */
  roleAliases?: boolean;
}

const DEFAULT_MAX_CHARS = 12_000;
const NAME_CAP = 100;
const VALUE_CAP = 60;
const HREF_CAP = 60;
const OPTION_CAP = 24;
const MAX_OPTIONS = 6;
/**
 * Reserved for the "… N lines omitted" notice. The notice length depends on a
 * count we only know after dropping, so we reserve a fixed slab up front rather
 * than iterating to a fixed point.
 */
const OMIT_NOTICE_RESERVE = 64;

/**
 * Short role names. `textbox` -> `text` collides with the `text` role, which is
 * acceptable: a textbox always carries a ref and a text node never does, so the
 * two are trivially distinguishable on the line itself.
 */
const ROLE_ALIASES: Readonly<Partial<Record<SnapRole, string>>> = {
  button: 'btn',
  textbox: 'text',
  searchbox: 'search',
  checkbox: 'check',
  combobox: 'select',
  spinbutton: 'num',
  listitem: 'li',
  heading: 'h',
  tabpanel: 'panel',
  generic: 'div',
};

interface ResolvedOptions {
  maxChars: number;
  showRefs: boolean;
  indent: string;
  roleAliases: boolean;
  /**
   * Page origin used to shorten absolute hrefs to paths. Internal: the public
   * entry points derive it from the snapshot/observation they were handed.
   */
  origin?: string;
}

function resolve(options: SerializeOptions | undefined, origin: string | undefined): ResolvedOptions {
  return {
    maxChars: options?.maxChars ?? DEFAULT_MAX_CHARS,
    showRefs: options?.showRefs !== false,
    indent: options?.indent ?? '  ',
    roleAliases: options?.roleAliases !== false,
    origin,
  };
}

// ---------------------------------------------------------------------------
// Line model
// ---------------------------------------------------------------------------

/**
 * Drop tiers used by the `maxChars` budget. Lower goes first.
 * Offscreen nodes are worthless to an agent that cannot see them, plain text is
 * usually decoration, and deep anonymous containers carry structure the tree
 * indentation already implies.
 */
const P_OFFSCREEN = 0;
const P_TEXT = 1;
const P_GENERIC = 2;
const P_KEEP = 3;

interface RenderLine {
  text: string;
  depth: number;
  /** Index of the parent line, or -1. Used to re-indent around dropped lines. */
  parent: number;
  priority: number;
}

function nodePriority(node: SnapNode, depth: number): number {
  if (node.state?.offscreen) return P_OFFSCREEN;
  if (!node.ref && (node.role === 'text' || node.role === 'image')) return P_TEXT;
  if (!node.ref && (node.role === 'generic' || node.role === 'group') && depth >= 3) return P_GENERIC;
  return P_KEEP;
}

/**
 * A container with no identity of its own costs a line and teaches nothing —
 * its children are hoisted to the parent's depth instead. The page runtime
 * already prunes most of these; this is the belt-and-braces pass.
 */
function isNoise(node: SnapNode): boolean {
  return (
    node.role === 'generic' &&
    !node.ref &&
    !node.name &&
    !node.value &&
    !node.meta?.testId &&
    !node.meta?.href &&
    !node.meta?.repeated &&
    !node.meta?.truncated
  );
}

function collectLines(
  node: SnapNode,
  depth: number,
  parent: number,
  out: RenderLine[],
  opts: ResolvedOptions,
): void {
  if (isNoise(node) && node.children && node.children.length > 0) {
    for (const child of node.children) collectLines(child, depth, parent, out, opts);
    return;
  }
  const index = out.length;
  out.push({ text: formatNode(node, opts), depth, parent, priority: nodePriority(node, depth) });
  if (!node.children) return;
  for (const child of node.children) collectLines(child, depth + 1, index, out, opts);
}

// ---------------------------------------------------------------------------
// Node formatting
// ---------------------------------------------------------------------------

function formatNode(node: SnapNode, opts: ResolvedOptions): string {
  const parts: string[] = [];
  if (opts.showRefs && node.ref) parts.push(node.ref);
  parts.push(formatRole(node.role, opts));

  const label = displayName(node);
  if (label) parts.push(`"${escapeQuotes(label)}"`);

  const value = formatValue(node.value);
  if (value !== undefined) parts.push('=', value);

  const flags = formatFlags(node);
  if (flags) parts.push(flags);

  const meta = formatMeta(node, opts, label !== '');
  if (meta) parts.push(meta);

  const markers = formatMarkers(node);
  if (markers) parts.push(markers);

  return parts.join(' ');
}

function formatRole(role: SnapRole, opts: ResolvedOptions): string {
  if (!opts.roleAliases) return role;
  return ROLE_ALIASES[role] ?? role;
}

/**
 * `desc` stands in when there is no accessible name (icon buttons, images).
 * `placeholder` deliberately does not: the accname algorithm already folds it
 * into the name, so printing it again would double the cost for no information.
 */
function displayName(node: SnapNode): string {
  const name = normalizeText(node.name) || normalizeText(node.meta?.desc);
  return name ? truncate(name, NAME_CAP) : '';
}

function escapeQuotes(input: string): string {
  return input.replace(/["\\]/g, '\\$&');
}

/** Empty values render as nothing at all — absence of `=` means "empty". */
function formatValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = normalizeText(raw);
  if (!value) return undefined;
  const short = truncate(value, VALUE_CAP);
  return needsQuotes(short) ? `"${escapeQuotes(short)}"` : short;
}

function needsQuotes(value: string): boolean {
  return /[\s"[\]()]/.test(value);
}

function formatFlags(node: SnapNode): string {
  const s = node.state;
  const flags: string[] = [];
  if (s) {
    if (s.disabled) flags.push('disabled');
    if (s.required) flags.push('required');
    if (s.invalid) flags.push('invalid');
    if (s.checked === true) flags.push('checked');
    else if (s.checked === false) flags.push('unchecked');
    else if (s.checked === 'mixed') flags.push('mixed');
    if (s.selected) flags.push('selected');
  }
  if (isCollapsed(node)) flags.push('collapsed');
  if (s) {
    if (s.readonly) flags.push('readonly');
    if (s.focused) flags.push('focused');
    if (s.offscreen) flags.push('offscreen');
    if (s.hidden) flags.push('hidden');
  }
  return flags.length > 0 ? `[${flags.join(' ')}]` : '';
}

function isCollapsed(node: SnapNode): boolean {
  return node.meta?.collapsed === true || node.state?.expanded === false;
}

function formatMeta(node: SnapNode, opts: ResolvedOptions, hasName: boolean): string {
  const m = node.meta;
  if (!m) return '';
  const out: string[] = [];
  // A testId is a fallback identity, not extra colour: skip it when the node
  // already prints a name.
  if (!hasName && m.testId) out.push(`#${m.testId}`);
  if (m.href) out.push(`-> ${formatHref(m.href, opts.origin)}`);
  if (m.options && m.options.length > 0) out.push(formatOptions(m.options));
  if (m.src) out.push(`@${m.src}`);
  return out.join(' ');
}

function formatOptions(options: readonly string[]): string {
  const shown = options.slice(0, MAX_OPTIONS).map((o) => truncate(normalizeText(o), OPTION_CAP));
  const rest = options.length > MAX_OPTIONS ? '|…' : '';
  return `(${shown.join('|')}${rest})`;
}

function formatMarkers(node: SnapNode): string {
  const m = node.meta;
  if (!m) return '';
  const out: string[] = [];
  if (m.repeated && m.repeated > 0) out.push(`… +${m.repeated} similar`);
  if (m.truncated && m.truncated > 0) {
    out.push(isCollapsed(node) ? `(${m.truncated} hidden)` : `… +${m.truncated} more`);
  }
  return out.join(' ');
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function originOf(raw: string): string | undefined {
  const url = parseUrl(raw);
  // `origin` is the string "null" for non-hierarchical schemes (data:, about:).
  if (!url || url.origin === 'null') return undefined;
  return url.origin;
}

function pathOf(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}` || '/';
}

/**
 * Absolute URLs collapse to a path when they share the reference origin. The
 * structured `Observation.url` always carries the absolute form, so the text
 * rendering never needs to repeat the host.
 */
function formatUrl(raw: string, origin: string | undefined): string {
  const url = parseUrl(raw);
  if (!url) return raw;
  if (origin !== undefined && url.origin === origin) return pathOf(url);
  if (origin === undefined) return pathOf(url);
  return raw;
}

function formatHref(href: string, origin: string | undefined): string {
  const url = parseUrl(href);
  if (!url) return truncate(href, HREF_CAP); // already relative
  if (origin !== undefined && url.origin === origin) return truncate(pathOf(url), HREF_CAP);
  return truncate(href, HREF_CAP);
}

// ---------------------------------------------------------------------------
// Budgeted rendering
// ---------------------------------------------------------------------------

/**
 * Join fixed header/footer lines around a droppable body, respecting
 * `maxChars`. Lines are dropped whole — never truncated mid-line — cheapest
 * tier first, deepest first within a tier.
 *
 * The estimate is conservative: dropping a parent also de-indents its
 * survivors, so the emitted string is never longer than what we budgeted for
 * (it can be slightly shorter). When the header and footer alone blow the
 * budget the output still contains them; a rendering that omits its own url
 * line would be worse than a slightly oversized one.
 */
function renderBudgeted(
  prefix: readonly string[],
  body: readonly RenderLine[],
  suffix: readonly string[],
  opts: ResolvedOptions,
): string {
  const indentLen = opts.indent.length;
  const costs = body.map((l) => l.depth * indentLen + l.text.length + 1);

  let total = 0;
  for (const line of prefix) total += line.length + 1;
  for (const line of suffix) total += line.length + 1;
  for (const cost of costs) total += cost;

  const dropped = new Set<number>();
  if (total > opts.maxChars && body.length > 0) {
    const budget = opts.maxChars - OMIT_NOTICE_RESERVE;
    const order = body.map((_, i) => i).sort((a, b) => {
      const la = body[a];
      const lb = body[b];
      if (!la || !lb) return 0;
      if (la.priority !== lb.priority) return la.priority - lb.priority;
      if (la.depth !== lb.depth) return lb.depth - la.depth;
      return b - a;
    });
    for (const index of order) {
      if (total <= budget) break;
      dropped.add(index);
      total -= costs[index] ?? 0;
    }
  }

  const out: string[] = [...prefix];
  const displayDepth: number[] = new Array<number>(body.length).fill(0);
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    if (!line) continue;
    // Re-parent onto the nearest surviving ancestor so indentation stays a
    // faithful containment ladder even after lines are dropped.
    let p = line.parent;
    while (p >= 0 && dropped.has(p)) {
      const parentLine = body[p];
      if (!parentLine) break;
      p = parentLine.parent;
    }
    const depth = p >= 0 ? (displayDepth[p] ?? 0) + 1 : 0;
    displayDepth[i] = depth;
    if (dropped.has(i)) continue;
    out.push(opts.indent.repeat(depth) + line.text);
  }

  if (dropped.size > 0) {
    out.push(`… ${plural(dropped.size, 'line')} omitted (raise maxChars or narrow scope)`);
  }
  out.push(...suffix);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Public: trees and snapshots
// ---------------------------------------------------------------------------

export function serializeTree(node: SnapNode, options?: SerializeOptions): string {
  const opts = resolve(options, undefined);
  const body: RenderLine[] = [];
  collectLines(node, 0, -1, body, opts);
  return renderBudgeted([], body, [], opts);
}

export function serializeSnapshot(snapshot: PageSnapshot, options?: SerializeOptions): string {
  const opts = resolve(options, originOf(snapshot.url));
  const prefix = headerLines(snapshot.url, snapshot.title, opts, {
    tabPath: snapshot.tabPath,
    overlay: snapshot.overlay,
    notes: snapshot.notes,
  });
  const body: RenderLine[] = [];
  collectLines(snapshot.tree, 0, -1, body, opts);
  return renderBudgeted(prefix, body, [statsLine(snapshot.stats)], opts);
}

interface HeaderExtras {
  tabPath?: string[];
  overlay?: OverlayInfo;
  notes?: string[];
  problems?: string[];
  nativeDialog?: { type: string; message: string; defaultValue?: string };
}

function headerLines(
  url: string,
  title: string,
  opts: ResolvedOptions,
  extras: HeaderExtras,
): string[] {
  const lines: string[] = [];
  const cleanTitle = normalizeText(title);
  const head = `url: ${formatUrl(url, opts.origin)}`;
  lines.push(cleanTitle ? `${head}  |  title: ${truncate(cleanTitle, 80)}` : head);
  if (extras.tabPath && extras.tabPath.length > 0) lines.push(`tab: ${extras.tabPath.join(' > ')}`);
  if (extras.overlay) lines.push(`overlay: ${describeOverlay(extras.overlay)}`);
  if (extras.nativeDialog) {
    const d = extras.nativeDialog;
    const dflt = d.defaultValue ? ` (default "${escapeQuotes(d.defaultValue)}")` : '';
    lines.push(`! native ${d.type}: "${escapeQuotes(normalizeText(d.message))}"${dflt}`);
  }
  for (const note of extras.notes ?? []) {
    const text = normalizeText(note);
    if (text) lines.push(`! ${text}`);
  }
  // Two bangs: problems come from the console/network, not from the page's own
  // UI, and conflating them with notes hides real breakage.
  for (const problem of extras.problems ?? []) {
    const text = normalizeText(problem);
    if (text) lines.push(`!! ${text}`);
  }
  return lines;
}

function describeOverlay(overlay: OverlayInfo): string {
  const name = normalizeText(overlay.name);
  const ref = overlay.ref ? `${overlay.ref} ` : '';
  return name ? `${ref}${overlay.kind} "${escapeQuotes(truncate(name, NAME_CAP))}"` : `${ref}${overlay.kind}`;
}

function statsLine(stats: SnapshotStats): string {
  return `[${stats.interactive} interactive, ${stats.emitted} shown, ${stats.elided} elided, ${stats.captureMs}ms]`;
}

// ---------------------------------------------------------------------------
// Public: diffs
// ---------------------------------------------------------------------------

export function serializeDiff(diff: SnapshotDiff, options?: SerializeOptions): string {
  const origin = diff.urlChanged ? originOf(diff.urlChanged.from) : undefined;
  const opts = resolve(options, origin);
  const body = diffLines(diff, opts);
  if (body.length === 0) return '(no changes)';
  return renderBudgeted([], body, [], opts);
}

/**
 * Structural facts (`@`) lead: a navigation or a newly opened dialog reframes
 * every element line under it, so an agent reading top-down should learn it
 * first.
 */
function diffLines(diff: SnapshotDiff, opts: ResolvedOptions): RenderLine[] {
  const lines: RenderLine[] = [];
  const push = (text: string, priority: number): void => {
    lines.push({ text, depth: 0, parent: -1, priority });
  };

  if (diff.urlChanged) {
    push(
      `@ url ${formatUrl(diff.urlChanged.from, opts.origin)} -> ${formatUrl(diff.urlChanged.to, opts.origin)}`,
      P_KEEP,
    );
  }
  if (diff.titleChanged) {
    push(`@ title ${normalizeText(diff.titleChanged.from)} -> ${normalizeText(diff.titleChanged.to)}`, P_KEEP);
  }
  if (diff.tabChanged) {
    const from = diff.tabChanged.from?.join(' > ') ?? '(none)';
    const to = diff.tabChanged.to?.join(' > ') ?? '(none)';
    push(`@ tab ${from} -> ${to}`, P_KEEP);
  }
  if (diff.overlayOpened) push(`@ ${overlayEvent(diff.overlayOpened, 'opened')}`, P_KEEP);
  if (diff.overlayClosed) push(`@ ${overlayEvent(diff.overlayClosed, 'closed')}`, P_KEEP);

  for (const entry of diff.entries) push(formatDiffEntry(entry, opts), P_GENERIC);

  if (diff.tooLarge) {
    push(
      `! diff truncated at ${plural(diff.entries.length, 'change')} — request a full snapshot`,
      P_KEEP,
    );
  }
  return lines;
}

function overlayEvent(overlay: OverlayInfo, event: 'opened' | 'closed'): string {
  const name = normalizeText(overlay.name);
  const suffix = name ? ` "${escapeQuotes(truncate(name, NAME_CAP))}"` : '';
  return `${overlay.kind} ${event}${suffix}`;
}

function formatDiffEntry(entry: DiffEntry, opts: ResolvedOptions): string {
  const parts: string[] = [];
  parts.push(entry.kind === 'added' ? '+' : entry.kind === 'removed' ? '-' : '~');
  if (opts.showRefs && entry.ref) parts.push(entry.ref);
  parts.push(formatRole(entry.role, opts));

  const name = normalizeText(entry.name);
  const from = entry.from ?? '';
  const to = entry.to ?? '';

  switch (entry.kind) {
    case 'added': {
      if (name) parts.push(`"${escapeQuotes(truncate(name, NAME_CAP))}"`);
      const value = formatValue(entry.to);
      if (value !== undefined) parts.push('=', value);
      break;
    }
    case 'removed': {
      if (name) parts.push(`"${escapeQuotes(truncate(name, NAME_CAP))}"`);
      break;
    }
    case 'name': {
      // The name itself is what changed, so it replaces the name slot.
      parts.push(`"${escapeQuotes(truncate(from, NAME_CAP))}" -> "${escapeQuotes(truncate(to, NAME_CAP))}"`);
      break;
    }
    case 'value': {
      if (name) parts.push(`"${escapeQuotes(truncate(name, NAME_CAP))}"`);
      parts.push(`${valueToken(from)} -> ${valueToken(to)}`);
      break;
    }
    case 'state': {
      if (name) parts.push(`"${escapeQuotes(truncate(name, NAME_CAP))}"`);
      parts.push(`[${from} -> ${to}]`);
      break;
    }
  }
  return parts.join(' ');
}

function valueToken(raw: string): string {
  const value = formatValue(raw);
  return value ?? '""';
}

// ---------------------------------------------------------------------------
// Public: one-line summary
// ---------------------------------------------------------------------------

/**
 * The single line that lands in `Observation.summary`. It answers "where am I
 * and what can I do here?" and nothing else — anything an agent would need to
 * act on is in the tree or the diff.
 */
export function summarize(snapshot: PageSnapshot): string {
  let controls = 0;
  let invalid = 0;
  let form: SnapNode | undefined;
  walk(snapshot.tree, (node) => {
    if (INTERACTIVE_ROLES.has(node.role)) controls += 1;
    if (node.state?.invalid) invalid += 1;
    if (!form && node.role === 'form') form = node;
  });

  const parts: string[] = [plural(controls, 'control')];
  if (snapshot.overlay) parts.push(describeOverlay({ ...snapshot.overlay, ref: undefined }));
  if (form) {
    const name = normalizeText(form.name) || normalizeText(form.meta?.testId);
    parts.push(name ? `form "${truncate(name, 40)}"` : 'form');
  }
  if (invalid > 0) parts.push(plural(invalid, 'validation error'));
  if (snapshot.tabPath && snapshot.tabPath.length > 0) parts.push(`tab ${snapshot.tabPath.join(' > ')}`);

  return `${summaryLocation(snapshot.url)} — ${parts.join(', ')}`;
}

function summaryLocation(raw: string): string {
  const url = parseUrl(raw);
  if (!url) return raw;
  const path = pathOf(url);
  // Leading slash is noise in a one-liner; the root path keeps it so the line
  // never starts with an em dash.
  return path === '/' ? '/' : path.replace(/^\//, '');
}

function walk(node: SnapNode, visit: (node: SnapNode) => void): void {
  visit(node);
  if (!node.children) return;
  for (const child of node.children) walk(child, visit);
}

// ---------------------------------------------------------------------------
// Public: observations
// ---------------------------------------------------------------------------

/**
 * Render a whole `Observation`. The `summary` field is intentionally not
 * repeated here: the tool result carries it as structured data and duplicating
 * it would cost tokens for a fact the caller already has.
 */
export function serializeObservation(observation: Observation, options?: SerializeOptions): string {
  const opts = resolve(options, originOf(observation.url));
  const prefix = headerLines(observation.url, observation.title, opts, {
    tabPath: observation.tabPath,
    overlay: observation.overlay,
    notes: observation.notes,
    problems: observation.problems,
    nativeDialog: observation.nativeDialog,
  });

  let body: RenderLine[];
  if (observation.diff) {
    body = diffLines(observation.diff, opts);
    if (body.length === 0) body = [{ text: '(no changes)', depth: 0, parent: -1, priority: P_KEEP }];
  } else if (observation.tree) {
    body = [];
    collectLines(observation.tree, 0, -1, body, opts);
  } else {
    body = [];
  }

  const suffix = observation.stats ? [statsLine(observation.stats)] : [];
  return renderBudgeted(prefix, body, suffix, opts);
}
