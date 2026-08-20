/**
 * Shared contracts for faster-browser-agent.
 *
 * Everything in this file is a pure type / interface declaration plus a few
 * small constant tables. It is imported by every layer (L0 pool .. L4 MCP), so
 * it must stay free of runtime dependencies.
 *
 * Layering:
 *   L0 browser pool      -> BrowserPool, ProfileHandle
 *   L1 page runtime      -> PageSnapshot, SnapNode, SettleResult
 *   L2 executor          -> ActionStep, StepResult, ActResult
 *   L3 skill cache       -> SkillRecord
 *   L4 MCP tool surface  -> Observation
 */

// ---------------------------------------------------------------------------
// L1 — perception
// ---------------------------------------------------------------------------

/**
 * A stable handle to a DOM element within one page session.
 *
 * Refs are minted by the injected page runtime and written onto the element as
 * a `data-fba` attribute, which means they survive re-snapshots, React
 * re-renders that keep the node, and scrolling. They do NOT survive a full
 * navigation — every navigation starts a fresh ref generation.
 *
 * Format: `e<n>` (e.g. `e42`).
 */
export type Ref = string;

/**
 * Normalised element roles. We deliberately use a small, closed vocabulary
 * rather than the full ARIA set: fewer distinct tokens means a smaller, more
 * predictable surface for the model, and the mapping from ARIA/implicit roles
 * onto this set is done once inside the page runtime.
 */
export type SnapRole =
  // interactive controls
  | 'button'
  | 'link'
  | 'textbox'
  | 'searchbox'
  | 'combobox'
  | 'listbox'
  | 'option'
  | 'checkbox'
  | 'radio'
  | 'switch'
  | 'slider'
  | 'spinbutton'
  | 'file'
  | 'colorpicker'
  | 'datepicker'
  | 'menuitem'
  | 'treeitem'
  // structure the agent must understand to navigate config UIs
  | 'tablist'
  | 'tab'
  | 'tabpanel'
  | 'dialog'
  | 'menu'
  | 'nav'
  | 'form'
  | 'section'
  | 'fieldset'
  | 'table'
  | 'row'
  | 'cell'
  | 'list'
  | 'listitem'
  | 'main'
  | 'banner'
  | 'contentinfo'
  | 'region'
  | 'group'
  | 'heading'
  | 'alert'
  | 'status'
  | 'text'
  | 'image'
  | 'iframe'
  | 'generic';

/** Roles that represent something the agent can directly act on. */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set<SnapRole>([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'file',
  'colorpicker',
  'datepicker',
  'menuitem',
  'treeitem',
  'tab',
]);

/** Roles that group other nodes and give the page its navigable structure. */
export const CONTAINER_ROLES: ReadonlySet<string> = new Set<SnapRole>([
  'tablist',
  'tabpanel',
  'dialog',
  'menu',
  'nav',
  'form',
  'section',
  'fieldset',
  'table',
  'row',
  'list',
  'main',
  'banner',
  'contentinfo',
  'region',
  'group',
]);

/**
 * Per-node state. Absent fields mean "not applicable" — the serializer only
 * prints what is present, which is a large part of why snapshots stay small.
 */
export interface SnapState {
  disabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  invalid?: boolean;
  checked?: boolean | 'mixed';
  selected?: boolean;
  /** aria-expanded. `false` on a container means its contents are collapsed. */
  expanded?: boolean;
  focused?: boolean;
  /** Element is in the layout but scrolled out of the viewport. */
  offscreen?: boolean;
  /** Element is inside a container that is currently hidden/inactive. */
  hidden?: boolean;
}

/** Extra facts that are cheap to collect and often decisive for navigation. */
export interface SnapMeta {
  /** `data-testid` / `data-test` / `data-cy`, whichever is present. */
  testId?: string;
  /** Resolved href for links, useful for deep-linking instead of clicking. */
  href?: string;
  placeholder?: string;
  /** For select-like controls: the choosable options (capped). */
  options?: string[];
  /** Number of children elided by repeat-pattern compression. */
  repeated?: number;
  /** Number of children elided because of a size cap. */
  truncated?: number;
  /** Container is collapsed; its children were not expanded into the tree. */
  collapsed?: boolean;
  /**
   * Source location from the code index (`src/Settings.tsx:42`), attached by
   * the code-aware layer when a confident match exists.
   */
  src?: string;
  /** Short description for images/icons where the name is not enough. */
  desc?: string;
}

/**
 * One node of a page snapshot.
 *
 * The snapshot is a *tree* rather than a flat list because the tree is what
 * lets the serializer express "this field lives under Settings > Advanced >
 * Networking" in a couple of tokens instead of repeating the breadcrumb on
 * every line.
 */
export interface SnapNode {
  /** Present only for nodes the agent can address (interactive or notable). */
  ref?: Ref;
  role: SnapRole;
  /** Accessible name, trimmed and length-capped by the runtime. */
  name?: string;
  /** Current value for inputs / selects. */
  value?: string;
  state?: SnapState;
  meta?: SnapMeta;
  children?: SnapNode[];
}

/** A modal-ish overlay that currently owns the user's attention. */
export interface OverlayInfo {
  kind: 'dialog' | 'alertdialog' | 'popover' | 'menu' | 'drawer';
  ref?: Ref;
  name?: string;
}

/** Native `alert()` / `confirm()` / `prompt()` awaiting a decision. */
export interface NativeDialogInfo {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultValue?: string;
}

/**
 * A full page snapshot as produced by a single in-page evaluation.
 *
 * Producing this in one round trip (rather than one CDP call per query) is the
 * single biggest browser-side latency win — see docs/ARCHITECTURE.md.
 */
export interface PageSnapshot {
  url: string;
  title: string;
  /** Monotonic per-session counter; the diff engine compares consecutive ids. */
  version: number;
  tree: SnapNode;
  /**
   * When an overlay is open the tree is scoped to it and this records what was
   * scoped away, so the agent knows the rest of the page still exists.
   */
  overlay?: OverlayInfo;
  /** Currently selected tab path, e.g. `['Settings', 'Advanced']`. */
  tabPath?: string[];
  /** Non-fatal observations worth one line each ("3 validation errors"). */
  notes?: string[];
  /** Counters used for budgeting and for the `stats` line in observations. */
  stats: SnapshotStats;
}

export interface SnapshotStats {
  /** Interactive elements found before any capping. */
  interactive: number;
  /** Nodes actually emitted into the tree. */
  emitted: number;
  /** Nodes dropped by caps / compression. */
  elided: number;
  /** Wall-clock milliseconds spent inside the page evaluation. */
  captureMs: number;
}

/** Options controlling how much of the page a snapshot covers. */
export interface SnapshotOptions {
  /**
   * `viewport` — only what is currently visible (default; cheapest).
   * `page`     — the whole document.
   * `region`   — subtree rooted at `root`.
   */
  scope?: 'viewport' | 'page' | 'region';
  /** Ref of the subtree root when `scope: 'region'`. */
  root?: Ref;
  /** Hard cap on emitted nodes. Excess is compressed then truncated. */
  maxNodes?: number;
  /** Include non-interactive text nodes that carry meaning. */
  includeText?: boolean;
  /** Expand collapsed containers instead of summarising them. */
  expandCollapsed?: boolean;
  /** Case-insensitive substring filter on names/values. */
  filter?: string;
  /** Max characters retained per accessible name. */
  nameCap?: number;
}

export const DEFAULT_SNAPSHOT_OPTIONS: Required<
  Pick<SnapshotOptions, 'scope' | 'maxNodes' | 'includeText' | 'expandCollapsed' | 'nameCap'>
> = {
  scope: 'viewport',
  maxNodes: 300,
  includeText: true,
  expandCollapsed: false,
  nameCap: 80,
};

// ---------------------------------------------------------------------------
// L1 — settle detection
// ---------------------------------------------------------------------------

export interface SettleOptions {
  /** Required quiet period with no network activity. */
  networkQuietMs?: number;
  /** Required quiet period with no DOM mutations. */
  domQuietMs?: number;
  /** Absolute upper bound; we return `timeout` rather than throwing. */
  timeoutMs?: number;
}

export const DEFAULT_SETTLE_OPTIONS: Required<SettleOptions> = {
  networkQuietMs: 300,
  domQuietMs: 200,
  timeoutMs: 5_000,
};

export interface SettleResult {
  settled: boolean;
  /**
   * `quiet`      — DOM and network both went still. The clean case.
   * `dom-stable` — the DOM stopped changing while background traffic continued.
   *                Apps that poll (React Query refetch intervals, session
   *                heartbeats, SSE) never reach network quiet, so treating it
   *                as necessary means burning the entire timeout on every
   *                single action. See `settleVerdict` in the page runtime.
   * `timeout`    — neither condition held within the budget.
   * `navigated`  — the document changed under us mid-wait.
   * `detached`   — the page went away.
   */
  reason: 'quiet' | 'dom-stable' | 'timeout' | 'navigated' | 'detached';
  waitedMs: number;
  /** Requests still in flight when we gave up, for diagnostics. */
  pendingRequests?: number;
}

// ---------------------------------------------------------------------------
// L1 — diffing
// ---------------------------------------------------------------------------

export type DiffChangeKind = 'added' | 'removed' | 'value' | 'name' | 'state';

export interface DiffEntry {
  kind: DiffChangeKind;
  ref?: Ref;
  role: SnapRole;
  name?: string;
  /** For `value`/`name`/`state` changes. */
  from?: string;
  to?: string;
}

/**
 * The result of comparing two consecutive snapshots.
 *
 * Returning a diff instead of a fresh full tree after every action is what
 * keeps multi-step flows cheap: a click that toggles one checkbox costs a
 * couple of tokens to report, not a full page re-serialisation.
 */
export interface SnapshotDiff {
  fromVersion: number;
  toVersion: number;
  urlChanged?: { from: string; to: string };
  titleChanged?: { from: string; to: string };
  overlayOpened?: OverlayInfo;
  overlayClosed?: OverlayInfo;
  tabChanged?: { from?: string[]; to?: string[] };
  entries: DiffEntry[];
  /** True when the page changed so much that a full snapshot is cheaper. */
  tooLarge?: boolean;
}

// ---------------------------------------------------------------------------
// L2 — element targeting
// ---------------------------------------------------------------------------

/**
 * How to find an element.
 *
 * A target is deliberately over-specified: callers pass whatever they know and
 * the resolver walks a fallback chain (ref -> testId -> role+name -> label ->
 * text -> css). This is the self-healing property — a stale ref does not fail
 * the step if the same element is still findable by name.
 */
export interface Target {
  ref?: Ref;
  testId?: string;
  role?: SnapRole;
  /** Accessible name; matched case-insensitively, exact-then-substring. */
  name?: string;
  /** Associated form label. */
  label?: string;
  /** Visible text content. */
  text?: string;
  placeholder?: string;
  css?: string;
  /** Disambiguator when several elements match. */
  nth?: number;
  /** Restrict the search to the subtree of this ref (e.g. a dialog). */
  within?: Ref;
}

/** How a target was ultimately resolved — reported back for transparency. */
export interface ResolutionInfo {
  strategy: 'ref' | 'testId' | 'role+name' | 'label' | 'text' | 'placeholder' | 'css' | 'code-index';
  /** 0..1; low confidence resolutions are surfaced as notes. */
  confidence: number;
  /** True when the primary strategy failed and a fallback was used. */
  healed: boolean;
  ref: Ref;
  description: string;
}

// ---------------------------------------------------------------------------
// L2 — action programs
// ---------------------------------------------------------------------------

/**
 * A single step of an action program.
 *
 * Action *programs* rather than single actions are the core of the round-trip
 * reduction: the model emits a guarded sequence, the executor runs it
 * deterministically, and control returns to the model only on divergence.
 */
export type ActionStep =
  | { do: 'click'; target: Target; button?: 'left' | 'right' | 'middle'; clickCount?: number; modifiers?: Modifier[] }
  | { do: 'dblclick'; target: Target }
  | { do: 'hover'; target: Target }
  | { do: 'focus'; target: Target }
  | { do: 'blur'; target?: Target }
  | { do: 'type'; target: Target; text: string; /** Replace existing value. */ clear?: boolean; pressEnter?: boolean }
  | { do: 'setValue'; target: Target; value: string }
  | { do: 'select'; target: Target; /** Option label or value; array for multi-selects. */ option: string | string[] }
  | { do: 'check'; target: Target; checked?: boolean }
  | { do: 'upload'; target: Target; files: string[] }
  | { do: 'press'; keys: string; target?: Target }
  | { do: 'scroll'; target?: Target; to?: 'top' | 'bottom'; by?: number }
  | { do: 'goto'; url?: string; route?: string }
  | { do: 'back' }
  | { do: 'forward' }
  | { do: 'reload' }
  | { do: 'waitFor'; target?: Target; state?: 'visible' | 'hidden' | 'enabled'; text?: string; urlContains?: string; timeoutMs?: number }
  | { do: 'settle'; options?: SettleOptions }
  | { do: 'assert'; target?: Target; exists?: boolean; text?: string; value?: string; urlContains?: string }
  | { do: 'dialog'; accept: boolean; promptText?: string }
  | { do: 'selectTab'; path: string[] }
  | { do: 'expand'; target: Target }
  | { do: 'eval'; fn: string; args?: unknown[] }
  /**
   * Coordinate click — the escape hatch for canvas/WebGL surfaces where no DOM
   * target exists. Coordinates are CSS pixels relative to the viewport, i.e.
   * exactly the coordinate space of a `browser_screenshot` image.
   */
  | { do: 'clickAt'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { do: 'drag'; target: Target; to: Target }
  | { do: 'resize'; width: number; height: number }
  /**
   * Click something that triggers a file download and wait for the file.
   * The step's detail reports the saved path.
   */
  | { do: 'download'; target: Target; timeoutMs?: number };

export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

export type StepStatus = 'ok' | 'failed' | 'skipped' | 'healed';

export interface StepResult {
  index: number;
  step: ActionStep['do'];
  status: StepStatus;
  /** One-line human/model readable outcome. */
  detail?: string;
  resolution?: ResolutionInfo;
  error?: string;
  ms: number;
}

/**
 * Control-flow policy when a step fails.
 * `stop`     — abort the remaining steps (default; safest).
 * `continue` — record the failure and keep going.
 * `retry`    — re-resolve and retry the step, then fall back to `stop`.
 */
export type OnFailure = 'stop' | 'continue' | 'retry';

export interface ActOptions {
  onFailure?: OnFailure;
  /** Return a full snapshot instead of a diff. */
  full?: boolean;
  /** Settle policy applied after the last step. */
  settle?: SettleOptions | false;
  /** Overall budget for the whole program. */
  timeoutMs?: number;
  /** Record this program into the skill cache under this name. */
  record?: string;
  /**
   * Called after each step, before the next one starts.
   *
   * `act` deliberately batches many steps into one call so the model does not
   * pay a round trip per click — which also means the call resolves atomically
   * and a host watching from outside cannot tell step 2 of 5 from a hang.
   * Steps that leave no page-level trace (`scroll`, a failed `waitFor`) are
   * invisible without this.
   *
   * Throwing from the callback is contained: a broken observer must not fail
   * the program it is watching.
   */
  onStep?: (result: StepResult, index: number, total: number) => void;
}

export interface ActResult {
  steps: StepResult[];
  ok: boolean;
  /** Index of the first failing step, if any. */
  failedAt?: number;
  observation: Observation;
}

// ---------------------------------------------------------------------------
// L2 — bulk form filling
// ---------------------------------------------------------------------------

/**
 * Fill many fields in one round trip.
 *
 * Field keys are matched fuzzily against labels, accessible names, testIds and
 * — when available — the code index, so callers can use the human wording they
 * already have without first snapshotting to discover refs.
 */
export interface FormFillRequest {
  fields: Record<string, string | number | boolean | string[]>;
  /** Restrict matching to a subtree (a dialog, a tab panel, a fieldset). */
  within?: Ref;
  /** Click the submit control when done. */
  submit?: boolean | Target;
  /** Fail the whole call if any field cannot be matched. */
  strict?: boolean;
  /** Switch to this tab path before filling. */
  tabPath?: string[];
}

export interface FieldFillResult {
  key: string;
  status: 'ok' | 'unmatched' | 'failed' | 'unchanged';
  ref?: Ref;
  matchedName?: string;
  confidence?: number;
  error?: string;
}

export interface FormFillResult {
  fields: FieldFillResult[];
  submitted: boolean;
  ok: boolean;
  observation: Observation;
}

// ---------------------------------------------------------------------------
// L4 — what tools return
// ---------------------------------------------------------------------------

/**
 * The uniform return shape of every navigation/action tool.
 *
 * Tools return *either* a diff or a tree, never both, and always a short
 * `summary` line. Keeping tool results structured and minimal is as important
 * for latency as anything happening in the browser.
 */
export interface Observation {
  url: string;
  title: string;
  /** One-line status, e.g. "navigated to /settings — 12 controls, form detected". */
  summary: string;
  /** Present when this observation is incremental. */
  diff?: SnapshotDiff;
  /** Present on the first observation or when a diff would be larger. */
  tree?: SnapNode;
  overlay?: OverlayInfo;
  nativeDialog?: NativeDialogInfo;
  tabPath?: string[];
  notes?: string[];
  stats?: SnapshotStats;
  /** Console errors / failed requests since the previous observation. */
  problems?: string[];
}

// ---------------------------------------------------------------------------
// L0 — workspaces, profiles, sessions
// ---------------------------------------------------------------------------

/**
 * An isolated browser identity bound to a code workspace.
 *
 * Parallel agents working in different git worktrees each get their own
 * profile directory, so cookies, localStorage, service workers and logins never
 * bleed across agents — while still allowing an explicit `seed` to copy a
 * logged-in state into a fresh worktree.
 */
export interface WorkspaceInfo {
  /** Absolute, symlink-resolved workspace root. */
  root: string;
  /** Stable id derived from the root path: `<basename>-<hash8>`. */
  id: string;
  /** Git repository root (the common dir when this is a worktree). */
  gitRoot?: string;
  /** Current branch, when resolvable. */
  branch?: string;
  /** True when `root` is a linked worktree rather than the main checkout. */
  isWorktree: boolean;
}

export interface ProfileHandle {
  workspace: WorkspaceInfo;
  /** Chromium user-data-dir for this workspace. */
  dir: string;
  /** True when this profile was cloned because the primary was locked. */
  ephemeral: boolean;
  /** Release the lock and (for ephemeral profiles) delete the directory. */
  release(): Promise<void>;
}

export interface SessionInfo {
  id: string;
  workspaceId: string;
  url: string;
  title: string;
  createdAt: number;
  lastUsedAt: number;
  /** Snapshot version at last observation. */
  version: number;
  /** Caller-supplied name, for hosts that show several sessions at once. */
  label?: string;
  /**
   * True while the session is being driven.
   *
   * `lastUsedAt` cannot answer this: it is stamped when work *starts*, so a
   * session sitting in a four-second settle looks identical to an idle one —
   * which is exactly when a host's activity indicator matters most.
   */
  busy: boolean;
}

// ---------------------------------------------------------------------------
// L0 — request blocking
// ---------------------------------------------------------------------------

export type ResourceCategory =
  | 'image'
  | 'media'
  | 'font'
  | 'stylesheet'
  | 'script'
  | 'xhr'
  | 'document'
  | 'other';

export interface BlockingPolicy {
  /** Resource categories to abort outright. */
  categories: ResourceCategory[];
  /** Additional host/url substring or regex patterns to abort. */
  patterns: string[];
  /** Never block these, even if a rule above matches. */
  allow: string[];
  enabled: boolean;
}

/**
 * Default policy: kill the bytes that never influence an agent's decision.
 * Scripts and stylesheets are deliberately NOT blocked — modern apps do not
 * render without them.
 */
export const DEFAULT_BLOCKING: BlockingPolicy = {
  enabled: true,
  categories: ['image', 'media', 'font'],
  patterns: [
    'google-analytics.com',
    'googletagmanager.com',
    'doubleclick.net',
    'facebook.net',
    'connect.facebook.com',
    'hotjar.com',
    'segment.io',
    'segment.com/analytics.js',
    'mixpanel.com',
    'amplitude.com',
    'fullstory.com',
    'intercom.io',
    'sentry.io/api',
    'datadoghq.com',
    'newrelic.com',
    'clarity.ms',
    'optimizely.com',
    'adservice.google',
    'adsystem.com',
    'criteo.com',
    'taboola.com',
    'outbrain.com',
  ],
  allow: [],
};

// ---------------------------------------------------------------------------
// L3 — code index
// ---------------------------------------------------------------------------

export type UiFramework =
  | 'next-app'
  | 'next-pages'
  | 'react-router'
  | 'vue-router'
  | 'nuxt'
  | 'sveltekit'
  | 'angular'
  | 'remix'
  | 'astro'
  | 'solid-start'
  | 'django'
  | 'rails'
  | 'flask'
  | 'fastapi'
  | 'express'
  | 'unknown';

/**
 * A route discovered by reading the application's source code.
 *
 * This is the feature that makes the agent fast on deep config UIs: instead of
 * clicking through `Settings -> Advanced -> Networking` (3 round trips, 3
 * snapshots), it deep-links straight to `/settings/advanced/networking`.
 */
/**
 * Teach the indexer about a hand-rolled route registry.
 *
 * The built-in extractors know twelve JS frameworks, which is worth nothing to
 * a legacy monolith whose entire navigation lives in one array in one file.
 * Those registries are structurally trivial — a list of records — so pointing
 * at the file and describing how a record becomes a URL unlocks the whole
 * application without the indexer learning a new framework.
 *
 * Example, for a PHP app routing through `index.php?page=…&sub=…`:
 * ```json
 * {
 *   "routeRegistry": {
 *     "file": "framework/tb/html/mainmenu.php",
 *     "url": "index.php?page={page}&sub={sub}",
 *     "label": "{title}",
 *     "aclField": "aclKey"
 *   }
 * }
 * ```
 */
export interface RouteRegistryConfig {
  /** Workspace-relative path or glob. */
  file: string | string[];
  /** URL template; `{field}` placeholders come from the record. */
  url: string;
  /** Label template; falls back to a title-cased path segment. */
  label?: string;
  /** Record field holding an access-control key, surfaced on the route. */
  aclField?: string;
  /** Additional record fields to carry into `RouteEntry.meta`. */
  meta?: string[];
  /** Only accept records carrying all of these fields. */
  require?: string[];
}

export interface RouteEntry {
  /** Route pattern as written in source, e.g. `/settings/[section]`. */
  pattern: string;
  /** Dynamic segment names in order. */
  params: string[];
  framework: UiFramework;
  /** `src/app/settings/[section]/page.tsx:1` */
  source: string;
  /** Human label inferred from the file/component/nav definition. */
  label?: string;
  /**
   * Permission required to reach the route, when the registry declares one.
   *
   * Surfaced so a blank page can be attributed to "the injected session lacks
   * this permission" instead of the agent re-deriving that the route is wrong.
   */
  acl?: string;
  /** Extra registry fields the adapter was asked to carry through. */
  meta?: Record<string, string>;
}

/**
 * A UI string and every place it is referenced.
 *
 * The return path from screen to source: an agent sees "Print delivery note",
 * the catalogue maps it to `view.print_delivery_note`, and `callSites` says
 * which template actually renders it. Without that last hop the translation
 * hit is a dead end the caller has to grep out by hand.
 */
export interface TranslationEntry {
  key: string;
  value: string;
  locale?: string;
  /** Catalogue location, `translations/order.en.json:12`. */
  source: string;
  /** `modul/order/index.php:348` — where the key is used. */
  callSites: string[];
}

/** A selector literal found in source, with where it came from. */
export interface SelectorEntry {
  kind: 'testid' | 'id' | 'aria-label' | 'name' | 'placeholder' | 'text';
  value: string;
  source: string;
  /** Nearby component name, used to group selectors by screen. */
  component?: string;
}

/** A configuration field discovered from a schema (zod/yup/JSON Schema/i18n). */
export interface ConfigFieldEntry {
  /** Dotted path, e.g. `smtp.port`. */
  path: string;
  type?: string;
  label?: string;
  enumValues?: string[];
  required?: boolean;
  source: string;
}

/** A navigation/tab group defined declaratively in source. */
export interface NavGroupEntry {
  label?: string;
  items: Array<{ label: string; href?: string; id?: string }>;
  source: string;
}

export interface CodeIndex {
  workspaceRoot: string;
  /** Unix ms when the index was built. */
  builtAt: number;
  /** Index schema version, for cache invalidation across upgrades. */
  schema: number;
  frameworks: UiFramework[];
  /** Best guess at the dev server origin, e.g. `http://localhost:3000`. */
  baseUrl?: string;
  routes: RouteEntry[];
  translations: TranslationEntry[];
  selectors: SelectorEntry[];
  configFields: ConfigFieldEntry[];
  navGroups: NavGroupEntry[];
  /** Files scanned and their mtimes, for incremental rebuilds. */
  files: Record<string, number>;
  stats: {
    filesScanned: number;
    buildMs: number;
  };
}

export const CODE_INDEX_SCHEMA = 2;

/** A ranked answer to "where is the thing called X?". */
export interface CodeMatch {
  /** What kind of artifact matched. */
  kind: 'route' | 'selector' | 'config' | 'nav' | 'translation';
  label: string;
  /** Deep link when the match implies a URL. */
  url?: string;
  /** Selector to hand to the executor when the match implies an element. */
  target?: Target;
  source: string;
  score: number;
  /** Permission the route requires, when the registry declared one. */
  acl?: string;
  /** For translation matches: where the key is actually used in code. */
  callSites?: string[];
}

// ---------------------------------------------------------------------------
// L3 — skill cache (compiled trajectories)
// ---------------------------------------------------------------------------

/**
 * A previously successful action program, replayable without any model calls.
 *
 * The cache is keyed by (origin, name). On replay every `assert` step doubles
 * as a verifier: if the page has changed shape, replay fails fast and the
 * caller falls back to model-driven navigation, then re-records.
 */
export interface SkillRecord {
  name: string;
  /** Origin the skill was recorded against, e.g. `http://localhost:3000`. */
  origin: string;
  description?: string;
  /** Named inputs referenced in steps as `{{param}}`. */
  params: string[];
  steps: ActionStep[];
  createdAt: number;
  updatedAt: number;
  runs: number;
  failures: number;
  /** Last known-good duration, used to flag regressions. */
  lastMs?: number;
  /** Workspace the skill was recorded in; skills are shared across workspaces. */
  recordedIn?: string;
}

export interface SkillReplayResult {
  name: string;
  ok: boolean;
  steps: StepResult[];
  ms: number;
  /** Set when replay failed and the caller should fall back to the model. */
  fallbackReason?: string;
  observation: Observation;
}

// ---------------------------------------------------------------------------
// Network observation (API shortcutting)
// ---------------------------------------------------------------------------

/**
 * A JSON-ish endpoint the page itself called.
 *
 * For extraction tasks, replaying one of these directly is orders of magnitude
 * faster than driving the UI — no render, no snapshot, no clicks.
 */
export interface ObservedEndpoint {
  method: string;
  url: string;
  /** URL with numeric/uuid path segments replaced by `:id`, for grouping. */
  pattern: string;
  status?: number;
  contentType?: string;
  /** Count of times observed in this session. */
  hits: number;
  /** Truncated shape description of the JSON response. */
  responseShape?: string;
  requestBodyShape?: string;
  lastSeenAt: number;
  /**
   * What a replay of this call actually needs — the shape fields above are
   * type sketches, not values, so a request promoted from them is a stub.
   *
   * Only populated when `FbaConfig.captureRequests` is on, because these
   * routinely carry an `Authorization` header or a session cookie. Sensitive
   * header names are redacted to `<redacted>` even then; see `REDACTED_HEADERS`
   * in `net/observer.ts`.
   */
  requestHeaders?: Array<[string, string]>;
  requestBody?: { text: string; truncated: boolean };
  requestContentType?: string;
}

/**
 * One entry of the recent-request ring buffer.
 *
 * Distinct from `ObservedEndpoint`: endpoints are the aggregated, deduplicated
 * table used for API shortcutting, while this is the raw last-N log an agent
 * asks for when debugging ("what did the page actually fetch just now?").
 */
export interface RecentRequest {
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  /** Set when the request failed at the network level. */
  failure?: string;
  ms?: number;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Site memory — what the agent learns by browsing
// ---------------------------------------------------------------------------

/**
 * The code index only helps for applications whose source is in the workspace.
 * For every other site the agent would start from zero on every visit, which is
 * exactly the blindness that makes generic drivers slow.
 *
 * Site memory closes that gap: it is built as a *side effect* of ordinary
 * observation — no extra calls, no extra navigations — and turns the second
 * visit to any site into a lookup instead of an exploration.
 */
export interface PageMemory {
  /** URL path with volatile segments generalised, e.g. `/users/:id`. */
  pattern: string;
  title?: string;
  /** Tab paths seen on this page, outermost first. */
  tabs: string[][];
  /** Interactive elements counted on the last visit. */
  controlCount: number;
  visits: number;
  lastSeenAt: number;
}

/**
 * A control seen somewhere on the site, with the information needed to get
 * back to it: which page, and which tab path within that page.
 */
export interface ControlMemory {
  name: string;
  role: SnapRole;
  /** Page pattern the control was seen on. */
  page: string;
  /** Tab path within that page; absent means no tab switch needed. */
  tabPath?: string[];
  testId?: string;
  /** Times observed — a proxy for how reliably it is there. */
  seen: number;
  lastSeenAt: number;
}

/** A learned navigation edge: activating `via` on `from` led to `to`. */
export interface TransitionMemory {
  from: string;
  via: string;
  to: string;
  count: number;
  lastSeenAt: number;
}

/** One observed settle distribution. */
export interface TimingSample {
  samples: number;
  /** Median settle time in ms. */
  p50: number;
  /** 90th percentile settle time in ms. */
  p90: number;
}

/**
 * What kind of settle a sample describes.
 *
 * Kept apart because a page load and a tab click are not the same event: mixing
 * them produces one median that is too loose for interactions and too tight for
 * navigations, which is worse than the generic default it replaces.
 */
export type SettleKind = 'navigation' | 'interaction';

/** Observed settle durations, used to adapt the wait budget per origin. */
export interface TimingMemory extends TimingSample {
  navigation?: TimingSample;
  interaction?: TimingSample;
}

export interface SiteMemory {
  origin: string;
  schema: number;
  firstSeenAt: number;
  lastSeenAt: number;
  visits: number;
  pages: PageMemory[];
  controls: ControlMemory[];
  transitions: TransitionMemory[];
  endpoints: ObservedEndpoint[];
  timing: TimingMemory;
}

export const SITE_MEMORY_SCHEMA = 1;

/** Caps that keep a memory file small enough to load and merge cheaply. */
export const SITE_MEMORY_LIMITS = {
  pages: 200,
  controls: 800,
  transitions: 300,
  endpoints: 80,
  /** Settle samples retained for the percentile estimate. */
  timingSamples: 50,
} as const;

/** A ranked answer from site memory to "where is X on this site?". */
export interface SiteMatch {
  name: string;
  role: SnapRole;
  page: string;
  tabPath?: string[];
  testId?: string;
  /** Absolute URL when the origin and page pattern have no unresolved params. */
  url?: string;
  score: number;
  seen: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * What the network observer is allowed to keep, as configuration.
 *
 * The observer has always taken these; only `captureRequests` was reachable
 * from `FbaConfig`, so an embedder who wanted a bigger endpoint table or no
 * response-body reads at all had to construct their own `NetworkObserver` and
 * bypass the session that owns it.
 */
export interface NetworkObservationOptions {
  /** Rows kept in the endpoint table. Observer default 60. */
  maxEndpoints?: number;
  /** Read response bodies to compute shapes. Observer default true. */
  captureBodies?: boolean;
  /** Responses larger than this are never read. Observer default 256KB. */
  maxBodyBytes?: number;
  /** Request bodies longer than this are truncated. Observer default 32KB. */
  maxRequestBodyBytes?: number;
}

export interface FbaConfig {
  /** Root for all persistent state. Default `~/.faster-browser-agent`. */
  home: string;
  /** Workspace root; defaults to git toplevel of cwd. */
  workspace?: string;
  headless: boolean;
  /** Chromium executable override. */
  executablePath?: string;
  /** Extra Chromium args. */
  browserArgs: string[];
  blocking: BlockingPolicy;
  snapshot: SnapshotOptions;
  settle: SettleOptions;
  /** Default navigation/action timeout. */
  timeoutMs: number;
  /** Idle time after which a pooled browser is closed. */
  idleTimeoutMs: number;
  /** Max concurrently open browser contexts. */
  maxContexts: number;
  viewport: { width: number; height: number };
  userAgent?: string;
  locale?: string;
  timezone?: string;
  /** Enable the code index. */
  codeIndex: boolean;
  /** Hand-rolled route registries to parse in addition to the built-ins. */
  routeRegistry?: RouteRegistryConfig | RouteRegistryConfig[];
  /** Enable the skill cache. */
  skills: boolean;
  /**
   * Enable site memory — what the agent learns about a site by browsing it.
   * Unlike the code index this works for sites whose source you do not have.
   */
  siteMemory: boolean;
  /** Enable network endpoint observation. */
  networkObserver: boolean;
  /**
   * Sizing knobs for that observation.
   *
   * Every field is optional and unset means "the observer's own default", so
   * this adds a seam without adding a second place where the defaults live.
   */
  network: NetworkObservationOptions;
  /**
   * Capture request headers and bodies onto `ObservedEndpoint`, so an observed
   * call can be promoted into a replayable request.
   *
   * Off by default: this is the difference between recording that a call
   * happened and recording the credential it carried. Sensitive headers are
   * redacted even when it is on, but a caller should have to ask.
   */
  captureRequests: boolean;
  /** Dev server base URL override. */
  baseUrl?: string;
  logLevel: LogLevel;
}

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
