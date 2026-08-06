/**
 * Cross-layer interfaces.
 *
 * Kept separate from `types.ts` because these reference Playwright types
 * (type-only) and describe *behaviour* rather than data. Implementations live
 * in `browser/`, `executor/`, `code/` and `skills/`; every consumer programs
 * against the interfaces here.
 */

import type { Locator, Page } from 'playwright-core';

import type {
  ActOptions,
  ActResult,
  ActionStep,
  CodeIndex,
  CodeMatch,
  FbaConfig,
  FormFillRequest,
  FormFillResult,
  NativeDialogInfo,
  Observation,
  ObservedEndpoint,
  RecentRequest,
  PageSnapshot,
  ProfileHandle,
  Ref,
  ResolutionInfo,
  SessionInfo,
  SettleOptions,
  SettleResult,
  SkillRecord,
  SkillReplayResult,
  SnapshotOptions,
  Target,
  WorkspaceInfo,
} from './types.js';

// ---------------------------------------------------------------------------
// In-page runtime (L1)
// ---------------------------------------------------------------------------

/** What the injected runtime returns; the session adds the version counter. */
export type RuntimeSnapshot = Omit<PageSnapshot, 'version'>;

export interface FindQuery {
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  within?: Ref;
  limit?: number;
}

/** One ranked candidate from an in-page search. */
export interface FindCandidate {
  ref: Ref;
  role: string;
  name: string;
  score: number;
  /**
   * Tab path the candidate actually lives under, outermost first.
   *
   * This is per-candidate rather than per-page on purpose: a search regularly
   * surfaces controls sitting in tab panels that are not the open one, and
   * telling the caller they are reachable "here" would be a lie that costs a
   * failed click plus a recovery round trip. Absent means "not inside any tab
   * panel", i.e. reachable without switching tabs.
   */
  tabPath?: string[];
}

/**
 * The API the injected runtime exposes as `window.__fba`.
 *
 * Everything here executes inside the page in a single evaluation, which is
 * the whole point: one CDP round trip per observation instead of one per
 * query.
 */
export interface PageRuntimeApi {
  readonly version: string;
  /** Build a snapshot of the current DOM. Synchronous and fast (<20ms typical). */
  snapshot(options?: SnapshotOptions): RuntimeSnapshot;
  /**
   * Resolve in-page once the DOM and network have been quiet for the
   * configured windows. Resolves rather than rejects on timeout.
   */
  waitSettled(options?: SettleOptions): Promise<SettleResult>;
  /** Non-blocking settle check. */
  isSettled(options?: SettleOptions): boolean;
  /** CSS selector that addresses a ref, or null if the node is gone. */
  selectorForRef(ref: Ref): string | null;
  /** Whether a ref still points at a connected element. */
  hasRef(ref: Ref): boolean;
  /** Rich description of one element, used for diagnostics and healing. */
  describe(ref: Ref): { role: string; name: string; value?: string; visible: boolean; path: string } | null;
  /** Ranked candidate refs for a fuzzy name, used by the resolver's fallbacks. */
  find(query: FindQuery): FindCandidate[];
  /** Tab/section structure of the page, independent of a full snapshot. */
  structure(): { tabs: Array<{ ref: Ref; label: string; selected: boolean; group?: string }>; sections: Array<{ ref: Ref; label: string; collapsed: boolean }> };
  /** Scroll a ref into view; returns false when the ref is gone. */
  scrollIntoView(ref: Ref): boolean;
  /** Console errors and failed requests captured since the last drain. */
  drainProblems(): string[];
  /** Reset ref generation and caches (called after navigation). */
  reset(): void;
}

declare global {
  interface Window {
    __fba?: PageRuntimeApi;
  }
}

// ---------------------------------------------------------------------------
// Session (L1/L2 bridge)
// ---------------------------------------------------------------------------

export interface ObserveOptions extends SnapshotOptions {
  /** Force a full tree even when a diff is available. */
  full?: boolean;
  /** Skip settling before observing. */
  noSettle?: boolean;
  settle?: SettleOptions;
  /** One-line summary prefix supplied by the caller, e.g. "clicked Save". */
  summaryPrefix?: string;
}

export interface GotoOptions {
  /** `commit` is the fastest; we settle separately with our own heuristic. */
  waitUntil?: 'commit' | 'domcontentloaded' | 'load';
  timeoutMs?: number;
  /** Skip the settle step after navigation. */
  noSettle?: boolean;
}

/**
 * A live page under agent control.
 *
 * One session == one tab. Sessions belong to a workspace-scoped browser
 * context, so two agents in two git worktrees never share cookies or storage.
 */
export interface Session {
  readonly id: string;
  readonly workspaceId: string;
  readonly page: Page;
  readonly config: FbaConfig;

  info(): SessionInfo;

  /** Navigate, re-inject the runtime and reset ref generation. */
  goto(url: string, options?: GotoOptions): Promise<void>;

  /** One-round-trip snapshot. */
  snapshot(options?: SnapshotOptions): Promise<PageSnapshot>;

  /** The most recent snapshot, if one has been taken. */
  lastSnapshot(): PageSnapshot | undefined;

  /** Wait for the page to go quiet, using the hybrid in-page + CDP heuristic. */
  settle(options?: SettleOptions): Promise<SettleResult>;

  /**
   * Snapshot and render it as an `Observation` — a diff when a previous
   * snapshot exists and the diff is smaller, a full tree otherwise.
   */
  observe(options?: ObserveOptions): Promise<Observation>;

  /** Ask the in-page runtime for candidate elements. */
  find(query: FindQuery): Promise<FindCandidate[]>;

  /** Tab and section structure without a full snapshot. */
  structure(): Promise<Awaited<ReturnType<PageRuntimeApi['structure']>>>;

  /** Pending native dialog, if the page opened one. */
  pendingDialog(): NativeDialogInfo | undefined;

  /** Answer a pending native dialog. */
  answerDialog(accept: boolean, promptText?: string): Promise<void>;

  /** JSON-ish endpoints the page called during this session. */
  endpoints(): ObservedEndpoint[];

  /** Raw last-N request log, newest first. Empty when observation is off. */
  recentRequests(limit?: number): RecentRequest[];

  /** Console errors / failed requests since the last observation. */
  drainProblems(): Promise<string[]>;

  /** Ensure `window.__fba` exists (re-inject after a same-document swap). */
  ensureRuntime(): Promise<void>;

  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Browser pool (L0)
// ---------------------------------------------------------------------------

export interface AcquireOptions {
  /** Workspace root; defaults to the pool's configured workspace. */
  workspace?: string;
  /** Reuse an existing session with this id when present. */
  sessionId?: string;
  /** Open in a fresh tab even if an idle one exists. */
  fresh?: boolean;
  /**
   * Namespace for the implicit session lookup.
   *
   * Without one, every caller in a workspace shares the most-recently-used tab
   * — correct for a single agent, actively wrong for several workers in one
   * process, which would silently drive each other's page. Give each worker its
   * own key (or set `FBA_SESSION_KEY`) and each gets its own tab in the same
   * browser context, keeping the shared cookie jar and the warm process.
   */
  sessionKey?: string;
}

export interface BrowserPool {
  /** Get (or create) a session for a workspace. */
  acquire(options?: AcquireOptions): Promise<Session>;
  /** Look up an existing session. */
  get(sessionId: string): Session | undefined;
  list(): SessionInfo[];
  /** Close one session; the underlying context stays warm. */
  closeSession(sessionId: string): Promise<void>;
  /** Close everything belonging to a workspace, releasing its profile lock. */
  closeWorkspace(workspaceId: string): Promise<void>;
  /** Pre-launch a browser so the first real call does not pay cold start. */
  warm(workspace?: string): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ProfileManager {
  /** Resolve a workspace root into workspace metadata. */
  describe(workspaceRoot?: string): Promise<WorkspaceInfo>;
  /** Acquire the profile directory for a workspace, taking its lock. */
  acquire(workspace: WorkspaceInfo): Promise<ProfileHandle>;
  /** List known profiles. */
  list(): Promise<Array<{ id: string; dir: string; root?: string; lockedBy?: number; sizeBytes?: number }>>;
  /** Delete a profile's state. */
  reset(workspaceId: string): Promise<void>;
  /** Copy cookies/localStorage from one profile into another. */
  seed(fromWorkspaceId: string, toWorkspaceId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Executor (L2)
// ---------------------------------------------------------------------------

export interface ResolvedTarget {
  locator: Locator;
  resolution: ResolutionInfo;
}

export interface TargetResolver {
  resolve(session: Session, target: Target): Promise<ResolvedTarget>;
  /** Resolve without throwing; returns undefined when nothing matches. */
  tryResolve(session: Session, target: Target): Promise<ResolvedTarget | undefined>;
}

export interface Executor {
  run(session: Session, steps: ActionStep[], options?: ActOptions): Promise<ActResult>;
  fillForm(session: Session, request: FormFillRequest): Promise<FormFillResult>;
}

// ---------------------------------------------------------------------------
// Code index (L3)
// ---------------------------------------------------------------------------

export interface CodeIndexer {
  /** Build or load the index for a workspace. */
  get(workspaceRoot: string, options?: { force?: boolean }): Promise<CodeIndex>;
  /** Rank index entries against a free-text query. */
  search(index: CodeIndex, query: string, limit?: number): CodeMatch[];
  /** Turn a route-ish string into an absolute URL, when resolvable. */
  resolveRoute(index: CodeIndex, route: string, params?: Record<string, string>): string | undefined;
  /** Drop cached indexes. */
  invalidate(workspaceRoot?: string): void;
}

// ---------------------------------------------------------------------------
// Skill cache (L3)
// ---------------------------------------------------------------------------

export interface SkillStore {
  list(origin?: string): Promise<SkillRecord[]>;
  get(name: string, origin?: string): Promise<SkillRecord | undefined>;
  save(record: SkillRecord): Promise<void>;
  delete(name: string, origin?: string): Promise<boolean>;
  /** Record run statistics after a replay. */
  markRun(name: string, origin: string, ok: boolean, ms: number): Promise<void>;
}

export interface SkillRunner {
  replay(
    session: Session,
    name: string,
    params?: Record<string, string>,
    options?: ActOptions,
  ): Promise<SkillReplayResult>;
}
