/**
 * Per-git-workspace browser profiles (L0).
 *
 * The headline property: two agents working in two git worktrees of the same
 * repo get two completely separate browser identities — separate cookies,
 * localStorage, IndexedDB and logins — while two agents that happen to share a
 * worktree still both work, because the second one transparently gets an
 * ephemeral clone instead of corrupting the first one's user-data-dir.
 *
 * Chromium is extremely unforgiving here: two processes pointed at the same
 * user-data-dir do not "share" it, they race on LevelDB/SQLite files and the
 * second one either refuses to start or silently trashes the profile. So the
 * directory is treated as a mutually exclusive resource, guarded by a real
 * lock file.
 */

import { constants as fsConstants, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { paths } from '../config.js';
import type { ProfileManager } from '../contracts.js';
import type { FbaConfig, ProfileHandle, WorkspaceInfo } from '../types.js';
import { FbaError, errorMessage } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { shortHash } from '../util/text.js';

const logger = createLogger('profile');

const LOCK_FILE = '.fba-lock';
const META_FILE = 'fba-meta.json';

// ---------------------------------------------------------------------------
// Workspace identity
// ---------------------------------------------------------------------------

/**
 * Stable, filesystem-safe id for a workspace root: `<basename>-<hash8>`.
 *
 * The basename is there purely so humans can recognise the directory in
 * `~/.faster-browser-agent/profiles`; the hash is what actually guarantees
 * uniqueness, because `~/work/api` and `~/oss/api` must not collide.
 */
export function workspaceIdFor(root: string): string {
  const real = realpathSyncSafe(resolve(root));
  const slug =
    basename(real)
      .toLowerCase()
      // Anything outside this set is a portability hazard across macOS/Windows.
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 32) || 'workspace';
  return `${slug}-${shortHash(real)}`;
}

function realpathSyncSafe(path: string): string {
  try {
    // Resolving symlinks matters: `/tmp` is a symlink on macOS, and a worktree
    // reached through a symlinked parent must map to the same profile as that
    // worktree reached directly. Falls back to the literal path for directories
    // that do not exist yet, so the id stays computable either way.
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * Discover the workspace (git root, branch, worktree-ness) for a directory.
 *
 * Deliberately implemented by reading `.git` directly rather than shelling out
 * to `git rev-parse`: a process spawn costs 20-60ms *per call* on a warm
 * machine and considerably more on Windows, this runs on every session
 * acquisition, and git is not guaranteed to exist in the minimal containers
 * agents often run in. Reading three small files is microseconds and works
 * without git installed at all.
 *
 * Never throws: an unreadable or missing `.git` simply means "plain directory".
 */
export async function detectWorkspace(cwd?: string): Promise<WorkspaceInfo> {
  const start = resolve(cwd ?? process.cwd());
  let real = start;
  try {
    real = await realpath(start);
  } catch {
    // Directory may not exist yet; the id stays stable either way.
  }

  try {
    const found = await findGitEntry(real);
    if (!found) return plainWorkspace(real);

    if (found.kind === 'dir') {
      const root = found.dir;
      const branch = await readBranch(join(found.entry, 'HEAD'));
      return {
        root,
        id: workspaceIdFor(root),
        gitRoot: root,
        isWorktree: false,
        ...(branch ? { branch } : {}),
      };
    }

    // `.git` is a FILE: either a linked worktree or a submodule.
    const gitDir = await readGitdirPointer(found.entry, found.dir);
    if (!gitDir) return plainWorkspace(real);

    const branch = await readBranch(join(gitDir, 'HEAD'));
    const commonDir = await readCommonDir(gitDir);
    if (commonDir) {
      // Linked worktree: `commondir` points at the main repository's .git.
      const gitRoot = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
      return {
        root: found.dir,
        id: workspaceIdFor(found.dir),
        gitRoot,
        isWorktree: true,
        ...(branch ? { branch } : {}),
      };
    }

    // No commondir — a submodule. It is its own workspace, not a worktree.
    return {
      root: found.dir,
      id: workspaceIdFor(found.dir),
      gitRoot: found.dir,
      isWorktree: false,
      ...(branch ? { branch } : {}),
    };
  } catch (e) {
    logger.debug(`workspace detection fell back to plain directory: ${errorMessage(e)}`);
    return plainWorkspace(real);
  }
}

function plainWorkspace(root: string): WorkspaceInfo {
  return { root, id: workspaceIdFor(root), isWorktree: false };
}

interface GitEntry {
  /** Directory that contains the `.git` entry — i.e. the workspace root. */
  dir: string;
  /** Absolute path of the `.git` entry itself. */
  entry: string;
  kind: 'dir' | 'file';
}

async function findGitEntry(from: string): Promise<GitEntry | undefined> {
  let dir = from;
  // Bounded so a pathological symlink loop cannot spin forever.
  for (let depth = 0; depth < 64; depth++) {
    const entry = join(dir, '.git');
    try {
      const st = await stat(entry);
      return { dir, entry, kind: st.isDirectory() ? 'dir' : 'file' };
    } catch {
      // not here; keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** `.git` file contents look like `gitdir: /abs/path/.git/worktrees/name`. */
async function readGitdirPointer(entryPath: string, containingDir: string): Promise<string | undefined> {
  const text = await readFile(entryPath, 'utf8').catch(() => '');
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  const target = match?.[1];
  if (!target) return undefined;
  // git may write it relative to the worktree directory.
  return isAbsolute(target) ? resolve(target) : resolve(containingDir, target);
}

/** `commondir` sits next to the worktree gitdir and is usually `../..`. */
async function readCommonDir(gitDir: string): Promise<string | undefined> {
  const text = await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => '');
  const value = text.trim();
  if (!value) return undefined;
  const abs = isAbsolute(value) ? resolve(value) : resolve(gitDir, value);
  return realpath(abs).catch(() => abs);
}

/** `ref: refs/heads/main` -> `main`; a bare sha means detached HEAD. */
async function readBranch(headPath: string): Promise<string | undefined> {
  const text = await readFile(headPath, 'utf8').catch(() => '');
  const match = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(text);
  return match?.[1];
}

// ---------------------------------------------------------------------------
// Lock bookkeeping
// ---------------------------------------------------------------------------

interface LockPayload {
  pid: number;
  startedAt: number;
  host: string;
}

interface LockRecord {
  lockPath: string;
  dir: string;
  /** Exact bytes we wrote, so release() can prove we still own the lock. */
  payload: string;
  ephemeral: boolean;
}

/**
 * Locks held by *this* process. Module-level rather than per-manager because
 * the exit handler has to be able to clean up everything, and there may be more
 * than one manager instance in a process (tests, embedded use).
 */
const heldLocks = new Map<string, LockRecord>();

let exitHandlersInstalled = false;
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function installExitHandlers(): void {
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;

  // 'exit' handlers must be fully synchronous — no promises will ever settle.
  process.on('exit', releaseAllSync);

  for (const signal of SIGNALS) {
    process.on(signal, () => {
      releaseAllSync();
      // Registering a signal listener suppresses Node's default terminate
      // behaviour. If we are the only listener then nobody else is managing
      // shutdown, and staying alive would make Ctrl-C look broken — so restore
      // the default disposition and re-raise. We never call process.exit()
      // ourselves: that would cut short another layer's graceful shutdown.
      if (process.listenerCount(signal) === 1) {
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      }
    });
  }
}

function releaseAllSync(): void {
  for (const record of [...heldLocks.values()]) {
    heldLocks.delete(record.lockPath);
    try {
      if (readFileSync(record.lockPath, 'utf8') === record.payload) unlinkSync(record.lockPath);
    } catch {
      // Already gone, or stolen by someone who judged us dead. Either way there
      // is nothing useful to do while the process is dying.
    }
    if (record.ephemeral) {
      try {
        rmSync(record.dir, { recursive: true, force: true });
      } catch {
        // Best effort; a leftover ephemeral dir is reclaimed by the next sweep.
      }
    }
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to another user.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isHolderAlive(holder: LockPayload): boolean {
  // A lock written on a different machine (shared/NFS home directory) cannot be
  // checked with process.kill, and guessing "dead" would corrupt that machine's
  // profile. Treat it as alive — the caller falls back to an ephemeral clone,
  // which is always safe.
  if (holder.host && holder.host !== hostname()) return true;
  return isPidAlive(holder.pid);
}

async function readLock(lockPath: string): Promise<LockPayload | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Partial<LockPayload>;
      if (typeof p.pid === 'number') {
        return { pid: p.pid, startedAt: typeof p.startedAt === 'number' ? p.startedAt : 0, host: String(p.host ?? '') };
      }
    }
  } catch {
    // Missing or malformed. Malformed is treated as stale on purpose: a
    // half-written lock is the signature of a process that died mid-write.
  }
  return undefined;
}

/** Take the lock, stealing it when the recorded pid is provably gone. */
async function tryLock(dir: string, ephemeral: boolean): Promise<LockRecord | undefined> {
  const lockPath = join(dir, LOCK_FILE);
  const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now(), host: hostname() });

  // Two passes at most: create, and if that collides with a dead holder, unlink
  // and create again. A third collision means a live race, which is exactly the
  // case the ephemeral fallback exists for.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath, payload, { flag: 'wx' });
      const record: LockRecord = { lockPath, dir, payload, ephemeral };
      heldLocks.set(lockPath, record);
      installExitHandlers();
      return record;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new FbaError('PROFILE_LOCKED', `cannot write profile lock at ${lockPath}: ${errorMessage(e)}`, {
          hint: 'check filesystem permissions on the fba home directory',
          cause: e,
        });
      }
      const holder = await readLock(lockPath);
      if (holder && isHolderAlive(holder)) return undefined;
      logger.debug(`stealing stale profile lock ${lockPath} (pid ${holder?.pid ?? 'unknown'} is gone)`);
      await rm(lockPath, { force: true });
    }
  }
  return undefined;
}

async function releaseLock(record: LockRecord): Promise<void> {
  heldLocks.delete(record.lockPath);
  try {
    // Only delete a lock that is still ours — if a peer decided we were dead
    // and stole it, deleting would unlock a directory someone else is using.
    if ((await readFile(record.lockPath, 'utf8')) === record.payload) {
      await rm(record.lockPath, { force: true });
    }
  } catch {
    // Already removed.
  }
}

// ---------------------------------------------------------------------------
// State copying (the "inherit my login" feature)
// ---------------------------------------------------------------------------

/**
 * The Chromium files that actually carry a logged-in session.
 *
 * Cookies live in `Default/Network/Cookies` on modern Chromium and in
 * `Default/Cookies` on older builds, so both are copied. Everything else here
 * is web storage. Deliberately NOT copied:
 *   `Local State`  — global browser state (profile list, window metrics)
 *   `Preferences`  — per-profile UI/window state that confuses a fresh dir
 *   `Login Data`   — saved passwords; copying secrets around is not our call
 *
 * This works across profile directories only because we launch with
 * `--password-store=basic` / `--use-mock-keychain` (see launcher.ts), which
 * makes Chromium encrypt cookies with a fixed key rather than an OS keyring
 * entry bound to one profile.
 */
const LOGIN_STATE_PATHS = [
  join('Default', 'Cookies'),
  join('Default', 'Cookies-journal'),
  join('Default', 'Network'),
  join('Default', 'Local Storage'),
  join('Default', 'Session Storage'),
  join('Default', 'IndexedDB'),
];

async function copyLoginState(fromDir: string, toDir: string): Promise<number> {
  let copied = 0;
  for (const rel of LOGIN_STATE_PATHS) {
    const src = join(fromDir, rel);
    try {
      await access(src, fsConstants.R_OK);
    } catch {
      continue;
    }
    const dest = join(toDir, rel);
    try {
      await mkdir(dirname(dest), { recursive: true });
      await cp(src, dest, { recursive: true, force: true });
      copied += 1;
    } catch (e) {
      // A live Chromium may hold a write lock or be mid-checkpoint on these
      // SQLite/LevelDB files. Partial seeding degrades to "log in again", which
      // is far better than failing the whole acquisition.
      logger.debug(`could not copy ${rel}: ${errorMessage(e)}`);
    }
  }
  return copied;
}

// ---------------------------------------------------------------------------
// ProfileManager
// ---------------------------------------------------------------------------

interface ProfileMeta {
  id: string;
  root: string;
  gitRoot?: string;
  branch?: string;
  isWorktree: boolean;
  ephemeral?: boolean;
  updatedAt: number;
}

export class FsProfileManager implements ProfileManager {
  private readonly config: FbaConfig;

  constructor(config: FbaConfig) {
    this.config = config;
  }

  describe(workspaceRoot?: string): Promise<WorkspaceInfo> {
    return detectWorkspace(workspaceRoot ?? this.config.workspace);
  }

  /**
   * Get an exclusive profile directory for a workspace.
   *
   * When the primary directory is already locked by a *live* process we do not
   * fail and we do not share: we hand back an ephemeral clone seeded with the
   * primary's cookies and web storage. That is what lets several agents run in
   * one worktree at once — they all start logged in, they cannot corrupt each
   * other's user-data-dir, and the clones evaporate on release.
   */
  async acquire(workspace: WorkspaceInfo): Promise<ProfileHandle> {
    const profilesRoot = paths(this.config).profiles;
    const primaryDir = join(profilesRoot, workspace.id);
    await mkdir(primaryDir, { recursive: true });
    await this.writeMeta(primaryDir, workspace, false);

    const primary = await tryLock(primaryDir, false);
    if (primary) {
      logger.debug(`profile ${workspace.id} acquired at ${primaryDir}`);
      return this.makeHandle(workspace, primaryDir, primary, false);
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const suffix = shortHash(`${process.pid}:${Date.now()}:${attempt}:${Math.random()}`, 6);
      const cloneDir = join(profilesRoot, `${workspace.id}-${suffix}`);
      try {
        await mkdir(cloneDir, { recursive: false });
      } catch {
        continue; // Suffix collision; try another.
      }
      const clone = await tryLock(cloneDir, true);
      if (!clone) continue;

      await this.writeMeta(cloneDir, workspace, true);
      const copied = await copyLoginState(primaryDir, cloneDir);
      logger.info(
        `profile ${workspace.id} is in use by another process — using ephemeral clone ${basename(cloneDir)} ` +
          `(seeded ${copied} state ${copied === 1 ? 'entry' : 'entries'})`,
      );
      return this.makeHandle(workspace, cloneDir, clone, true);
    }

    throw new FbaError('PROFILE_LOCKED', `could not create an ephemeral profile for workspace ${workspace.id}`, {
      hint: 'the profiles directory may be full or read-only; check ' + profilesRoot,
      details: { workspaceId: workspace.id, primaryDir },
    });
  }

  async list(): Promise<Array<{ id: string; dir: string; root?: string; lockedBy?: number; sizeBytes?: number }>> {
    const root = paths(this.config).profiles;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const out: Array<{ id: string; dir: string; root?: string; lockedBy?: number; sizeBytes?: number }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const meta = await this.readMeta(dir);
      const holder = await readLock(join(dir, LOCK_FILE));
      const lockedBy = holder && isHolderAlive(holder) ? holder.pid : undefined;
      out.push({
        id: entry.name,
        dir,
        ...(meta?.root ? { root: meta.root } : {}),
        ...(lockedBy !== undefined ? { lockedBy } : {}),
        sizeBytes: await directorySize(dir),
      });
    }

    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  async reset(workspaceId: string): Promise<void> {
    const dir = this.profileDirFor(workspaceId);
    const holder = await readLock(join(dir, LOCK_FILE));
    if (holder && isHolderAlive(holder)) {
      throw new FbaError('PROFILE_LOCKED', `profile ${workspaceId} is in use by pid ${holder.pid}`, {
        hint: "close that agent's browser first, or reset a different workspace",
        details: { workspaceId, pid: holder.pid },
      });
    }
    await rm(dir, { recursive: true, force: true });
    logger.info(`reset profile ${workspaceId}`);
  }

  /**
   * Copy a logged-in session from one workspace profile into another.
   *
   * This is what makes a brand-new git worktree usable immediately: the agent
   * inherits the cookies it already earned in the main checkout instead of
   * re-running an OAuth dance (which typically needs a human, and is the single
   * most expensive thing that can happen in an automated run).
   */
  async seed(fromWorkspaceId: string, toWorkspaceId: string): Promise<void> {
    if (fromWorkspaceId === toWorkspaceId) {
      throw new FbaError('INVALID_ARGUMENT', 'source and target profile are the same');
    }
    const fromDir = this.profileDirFor(fromWorkspaceId);
    const toDir = this.profileDirFor(toWorkspaceId);

    try {
      await access(fromDir, fsConstants.R_OK);
    } catch {
      throw new FbaError('INVALID_ARGUMENT', `no profile named ${fromWorkspaceId}`, {
        hint: 'run the profile list tool to see known profile ids',
      });
    }

    for (const [id, dir] of [
      [fromWorkspaceId, fromDir],
      [toWorkspaceId, toDir],
    ] as const) {
      const holder = await readLock(join(dir, LOCK_FILE));
      if (holder && isHolderAlive(holder)) {
        throw new FbaError('PROFILE_LOCKED', `profile ${id} is in use by pid ${holder.pid}`, {
          // Copying under a running Chromium yields a torn SQLite file, which
          // looks like "randomly logged out" later — refuse instead.
          hint: 'close the browser using that profile and retry',
          details: { workspaceId: id, pid: holder.pid },
        });
      }
    }

    await mkdir(toDir, { recursive: true });
    const copied = await copyLoginState(fromDir, toDir);
    if (copied === 0) {
      throw new FbaError('INVALID_ARGUMENT', `profile ${fromWorkspaceId} has no saved browser state to copy`, {
        hint: 'log in once in that workspace, close the browser, then seed again',
      });
    }
    logger.info(`seeded ${copied} state entries from ${fromWorkspaceId} into ${toWorkspaceId}`);
  }

  // -- internals ------------------------------------------------------------

  /**
   * Reject ids that could escape the profiles directory. `reset` and `seed` are
   * reachable from MCP tool arguments, so this is untrusted input and a positive
   * allow-list is the only defensible check.
   */
  private profileDirFor(workspaceId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(workspaceId) || workspaceId.includes('..')) {
      throw new FbaError('INVALID_ARGUMENT', `invalid profile id ${JSON.stringify(workspaceId)}`, {
        hint: 'profile ids look like `myapp-a1b2c3d4`; list profiles to see the real ones',
      });
    }
    return join(paths(this.config).profiles, workspaceId);
  }

  private makeHandle(
    workspace: WorkspaceInfo,
    dir: string,
    record: LockRecord,
    ephemeral: boolean,
  ): ProfileHandle {
    let released = false;
    return {
      workspace,
      dir,
      ephemeral,
      async release(): Promise<void> {
        if (released) return;
        released = true;
        await releaseLock(record);
        if (ephemeral) {
          await rm(dir, { recursive: true, force: true }).catch((e: unknown) => {
            logger.warn(`could not remove ephemeral profile ${dir}: ${errorMessage(e)}`);
          });
        }
      },
    };
  }

  /** `list()` has no other way to show which repo a hashed id belongs to. */
  private async writeMeta(dir: string, workspace: WorkspaceInfo, ephemeral: boolean): Promise<void> {
    const meta: ProfileMeta = {
      id: workspace.id,
      root: workspace.root,
      isWorktree: workspace.isWorktree,
      updatedAt: Date.now(),
      ...(workspace.gitRoot ? { gitRoot: workspace.gitRoot } : {}),
      ...(workspace.branch ? { branch: workspace.branch } : {}),
      ...(ephemeral ? { ephemeral: true } : {}),
    };
    await writeFile(join(dir, META_FILE), JSON.stringify(meta, null, 2), 'utf8').catch((e: unknown) => {
      logger.debug(`could not write profile meta: ${errorMessage(e)}`);
    });
  }

  private async readMeta(dir: string): Promise<ProfileMeta | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, META_FILE), 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed as ProfileMeta;
    } catch {
      // Pre-existing or hand-made directory; nothing to report.
    }
    return undefined;
  }
}

/**
 * Approximate directory size.
 *
 * Capped on purpose: a warm Chromium profile can hold tens of thousands of
 * cache files, and `profile list` is a diagnostic — an exact byte count is not
 * worth a multi-second stat storm. Symlinks are not followed (Chromium's
 * `SingletonLock` is a dangling symlink by design).
 */
async function directorySize(dir: string, nodeCap = 4_000): Promise<number> {
  let total = 0;
  let visited = 0;
  const stack: string[] = [dir];

  while (stack.length > 0 && visited < nodeCap) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited >= nodeCap) break;
      visited += 1;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile()) {
        try {
          total += (await stat(path)).size;
        } catch {
          // Chromium deletes cache files while we walk; ignore.
        }
      }
    }
  }
  return total;
}
