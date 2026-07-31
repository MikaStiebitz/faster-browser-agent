import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FsProfileManager, detectWorkspace, workspaceIdFor } from '../src/browser/profile.js';
import { defaultConfig } from '../src/config.js';
import type { FbaConfig, ProfileHandle, WorkspaceInfo } from '../src/types.js';
import { isFbaError } from '../src/util/errors.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const fixtures: string[] = [];
const handles: ProfileHandle[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  fixtures.push(dir);
  // Resolve symlinks up front: on macOS `/tmp` is a symlink to `/private/tmp`,
  // and detectWorkspace reports real paths.
  return realpath(dir);
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.release().catch(() => undefined);
  for (const dir of fixtures.splice(0)) await rm(dir, { recursive: true, force: true });
});

function manager(home: string, workspace?: string): FsProfileManager {
  const config: FbaConfig = { ...defaultConfig(), home, ...(workspace ? { workspace } : {}) };
  return new FsProfileManager(config);
}

function workspace(root: string, id = 'demo-abcd1234'): WorkspaceInfo {
  return { root, id, isWorktree: false, gitRoot: root, branch: 'main' };
}

function profilesDir(home: string): string {
  return join(home, 'profiles');
}

function lockPath(home: string, id: string): string {
  return join(profilesDir(home), id, '.fba-lock');
}

async function writeLock(home: string, id: string, pid: number): Promise<void> {
  const dir = join(profilesDir(home), id);
  await mkdir(dir, { recursive: true });
  await writeFile(lockPath(home, id), JSON.stringify({ pid, startedAt: Date.now(), host: hostname() }), 'utf8');
}

/** A pid that is provably not running, so we can exercise lock stealing. */
function deadPid(): number {
  for (let pid = 65_000; pid > 30_000; pid--) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('could not find an unused pid on this machine');
}

async function readLockPid(home: string, id: string): Promise<number> {
  const parsed: unknown = JSON.parse(await readFile(lockPath(home, id), 'utf8'));
  return (parsed as { pid: number }).pid;
}

// ---------------------------------------------------------------------------
// workspaceIdFor
// ---------------------------------------------------------------------------

describe('workspaceIdFor', () => {
  it('is stable for the same path', async () => {
    const dir = await tempDir('fba-id-');
    expect(workspaceIdFor(dir)).toBe(workspaceIdFor(dir));
    expect(workspaceIdFor(`${dir}/`)).toBe(workspaceIdFor(dir));
    expect(workspaceIdFor(join(dir, 'sub', '..'))).toBe(workspaceIdFor(dir));
  });

  it('separates same-named directories under different parents', async () => {
    const base = await tempDir('fba-id-');
    const a = join(base, 'one', 'api');
    const b = join(base, 'two', 'api');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    expect(workspaceIdFor(a)).not.toBe(workspaceIdFor(b));
    expect(workspaceIdFor(a).startsWith('api-')).toBe(true);
    expect(workspaceIdFor(b).startsWith('api-')).toBe(true);
  });

  it('sanitises the basename into a filesystem-safe slug', async () => {
    const base = await tempDir('fba-id-');
    const messy = join(base, 'My App (v2)! ');
    await mkdir(messy, { recursive: true });
    const id = workspaceIdFor(messy);
    expect(id).toMatch(/^[a-z0-9._-]+$/);
    expect(id.startsWith('my-app-v2-')).toBe(true);
  });

  it('still produces an id for a path that does not exist', () => {
    const id = workspaceIdFor(join(tmpdir(), 'fba-does-not-exist-xyz'));
    expect(id).toMatch(/^fba-does-not-exist-xyz-[a-z0-9]+$/);
  });
});

// ---------------------------------------------------------------------------
// detectWorkspace
// ---------------------------------------------------------------------------

describe('detectWorkspace', () => {
  it('finds the repo root by walking up to a .git directory', async () => {
    const repo = await tempDir('fba-repo-');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const deep = join(repo, 'packages', 'web', 'src');
    await mkdir(deep, { recursive: true });

    const info = await detectWorkspace(deep);
    expect(info.root).toBe(repo);
    expect(info.gitRoot).toBe(repo);
    expect(info.branch).toBe('main');
    expect(info.isWorktree).toBe(false);
    expect(info.id).toBe(workspaceIdFor(repo));
  });

  it('reports no branch for a detached HEAD', async () => {
    const repo = await tempDir('fba-repo-');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, '.git', 'HEAD'), '9f1c0d0a5b3e2f7c8d9e0a1b2c3d4e5f60718293\n', 'utf8');

    const info = await detectWorkspace(repo);
    expect(info.branch).toBeUndefined();
    expect(info.gitRoot).toBe(repo);
  });

  it('resolves a linked worktree through its .git file and commondir', async () => {
    const main = await tempDir('fba-main-');
    const gitDir = join(main, '.git', 'worktrees', 'feature');
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/feature/login\n', 'utf8');
    await writeFile(join(gitDir, 'commondir'), '../..\n', 'utf8');

    const wt = await tempDir('fba-wt-');
    await writeFile(join(wt, '.git'), `gitdir: ${gitDir}\n`, 'utf8');

    const info = await detectWorkspace(wt);
    expect(info.isWorktree).toBe(true);
    expect(info.root).toBe(wt);
    expect(info.gitRoot).toBe(main);
    expect(info.branch).toBe('feature/login');
    // The whole point: a worktree gets a different profile from its main repo.
    expect(info.id).not.toBe(workspaceIdFor(main));
  });

  it('accepts a relative gitdir pointer', async () => {
    const base = await tempDir('fba-rel-');
    const main = join(base, 'main');
    const gitDir = join(main, '.git', 'worktrees', 'wt');
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/topic\n', 'utf8');
    await writeFile(join(gitDir, 'commondir'), '../..\n', 'utf8');

    const wt = join(base, 'wt');
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, '.git'), 'gitdir: ../main/.git/worktrees/wt\n', 'utf8');

    const info = await detectWorkspace(wt);
    expect(info.isWorktree).toBe(true);
    expect(info.gitRoot).toBe(main);
    expect(info.branch).toBe('topic');
  });

  it('treats a submodule (.git file without commondir) as its own workspace', async () => {
    const base = await tempDir('fba-sub-');
    const gitDir = join(base, 'super', '.git', 'modules', 'lib');
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    const sub = join(base, 'super', 'lib');
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, '.git'), `gitdir: ${gitDir}\n`, 'utf8');

    const info = await detectWorkspace(sub);
    expect(info.isWorktree).toBe(false);
    expect(info.root).toBe(sub);
    expect(info.gitRoot).toBe(sub);
  });

  it('falls back to the plain directory when there is no git at all', async () => {
    const dir = await tempDir('fba-plain-');
    const info = await detectWorkspace(dir);
    expect(info.root).toBe(dir);
    expect(info.gitRoot).toBeUndefined();
    expect(info.branch).toBeUndefined();
    expect(info.isWorktree).toBe(false);
    expect(info.id).toBe(workspaceIdFor(dir));
  });

  it('never throws on an unreadable or missing directory', async () => {
    const info = await detectWorkspace(join(tmpdir(), 'fba-missing-dir-xyz', 'nested'));
    expect(info.isWorktree).toBe(false);
    expect(info.id.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// FsProfileManager — locking
// ---------------------------------------------------------------------------

describe('FsProfileManager.acquire', () => {
  it('creates the profile directory and takes the lock', async () => {
    const home = await tempDir('fba-home-');
    const root = await tempDir('fba-ws-');
    const handle = await manager(home).acquire(workspace(root));
    handles.push(handle);

    expect(handle.ephemeral).toBe(false);
    expect(handle.dir).toBe(join(profilesDir(home), 'demo-abcd1234'));
    expect(await readLockPid(home, 'demo-abcd1234')).toBe(process.pid);

    await handle.release();
    expect(existsSync(lockPath(home, 'demo-abcd1234'))).toBe(false);
    // A released non-ephemeral profile keeps its state.
    expect(existsSync(handle.dir)).toBe(true);
  });

  it('is idempotent on release', async () => {
    const home = await tempDir('fba-home-');
    const root = await tempDir('fba-ws-');
    const handle = await manager(home).acquire(workspace(root));
    await handle.release();
    await expect(handle.release()).resolves.toBeUndefined();
  });

  it('steals a lock whose owning pid is gone', async () => {
    const home = await tempDir('fba-home-');
    const root = await tempDir('fba-ws-');
    await writeLock(home, 'demo-abcd1234', deadPid());

    const handle = await manager(home).acquire(workspace(root));
    handles.push(handle);

    expect(handle.ephemeral).toBe(false);
    expect(handle.dir).toBe(join(profilesDir(home), 'demo-abcd1234'));
    expect(await readLockPid(home, 'demo-abcd1234')).toBe(process.pid);
  });

  it('falls back to a seeded ephemeral clone when the lock owner is alive', async () => {
    const home = await tempDir('fba-home-');
    const root = await tempDir('fba-ws-');
    const primary = join(profilesDir(home), 'demo-abcd1234');
    await writeLock(home, 'demo-abcd1234', process.pid);
    await mkdir(join(primary, 'Default', 'Local Storage'), { recursive: true });
    await writeFile(join(primary, 'Default', 'Cookies'), 'session=abc', 'utf8');
    await writeFile(join(primary, 'Default', 'Local Storage', 'leveldb.log'), 'token', 'utf8');

    const handle = await manager(home).acquire(workspace(root));
    handles.push(handle);

    expect(handle.ephemeral).toBe(true);
    expect(handle.dir).not.toBe(primary);
    expect(handle.dir.startsWith(`${primary}-`)).toBe(true);
    // The clone starts logged in — that is the point of seeding it.
    expect(await readFile(join(handle.dir, 'Default', 'Cookies'), 'utf8')).toBe('session=abc');
    expect(await readFile(join(handle.dir, 'Default', 'Local Storage', 'leveldb.log'), 'utf8')).toBe('token');
    // The live holder's lock is untouched.
    expect(await readLockPid(home, 'demo-abcd1234')).toBe(process.pid);

    const cloneDir = handle.dir;
    await handle.release();
    expect(existsSync(cloneDir)).toBe(false);
    expect(existsSync(primary)).toBe(true);
  });

  it('gives two concurrent acquisitions of one workspace distinct directories', async () => {
    const home = await tempDir('fba-home-');
    const root = await tempDir('fba-ws-');
    const mgr = manager(home);
    const first = await mgr.acquire(workspace(root));
    const second = await mgr.acquire(workspace(root));
    handles.push(first, second);

    expect(first.ephemeral).toBe(false);
    expect(second.ephemeral).toBe(true);
    expect(second.dir).not.toBe(first.dir);
  });
});

// ---------------------------------------------------------------------------
// FsProfileManager — list / reset / seed
// ---------------------------------------------------------------------------

describe('FsProfileManager.list', () => {
  it('reports id, dir, workspace root, holder pid and size', async () => {
    const home = await tempDir('fba-home-');
    const root = await tempDir('fba-ws-');
    const mgr = manager(home);
    const handle = await mgr.acquire(workspace(root));
    handles.push(handle);
    await writeFile(join(handle.dir, 'History'), 'x'.repeat(512), 'utf8');

    const listed = await mgr.list();
    const entry = listed.find((p) => p.id === 'demo-abcd1234');
    expect(entry).toBeDefined();
    expect(entry?.dir).toBe(handle.dir);
    expect(entry?.root).toBe(root);
    expect(entry?.lockedBy).toBe(process.pid);
    expect(entry?.sizeBytes ?? 0).toBeGreaterThanOrEqual(512);

    await handle.release();
    const after = await mgr.list();
    expect(after.find((p) => p.id === 'demo-abcd1234')?.lockedBy).toBeUndefined();
  });

  it('returns an empty list when nothing has been created yet', async () => {
    const home = await tempDir('fba-home-');
    await expect(manager(home).list()).resolves.toEqual([]);
  });
});

describe('FsProfileManager.reset', () => {
  it('refuses while a live process holds the lock', async () => {
    const home = await tempDir('fba-home-');
    await writeLock(home, 'demo-abcd1234', process.pid);

    const error = await manager(home)
      .reset('demo-abcd1234')
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(isFbaError(error)).toBe(true);
    expect(isFbaError(error) ? error.code : '').toBe('PROFILE_LOCKED');
    expect(existsSync(join(profilesDir(home), 'demo-abcd1234'))).toBe(true);
  });

  it('deletes the profile when the lock is stale', async () => {
    const home = await tempDir('fba-home-');
    await writeLock(home, 'demo-abcd1234', deadPid());
    await manager(home).reset('demo-abcd1234');
    expect(existsSync(join(profilesDir(home), 'demo-abcd1234'))).toBe(false);
  });

  it('rejects ids that would escape the profiles directory', async () => {
    const home = await tempDir('fba-home-');
    const error = await manager(home)
      .reset('../../etc')
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(isFbaError(error) ? error.code : '').toBe('INVALID_ARGUMENT');
  });
});

describe('FsProfileManager.seed', () => {
  it('copies cookies and web storage into a fresh profile', async () => {
    const home = await tempDir('fba-home-');
    const from = join(profilesDir(home), 'main-11111111');
    await mkdir(join(from, 'Default', 'Network'), { recursive: true });
    await writeFile(join(from, 'Default', 'Network', 'Cookies'), 'sid=logged-in', 'utf8');
    await mkdir(join(from, 'Default', 'IndexedDB', 'http_localhost_3000.indexeddb.leveldb'), { recursive: true });
    await writeFile(
      join(from, 'Default', 'IndexedDB', 'http_localhost_3000.indexeddb.leveldb', 'CURRENT'),
      'MANIFEST-000001',
      'utf8',
    );

    const mgr = manager(home);
    await mgr.seed('main-11111111', 'wt-22222222');

    const to = join(profilesDir(home), 'wt-22222222');
    expect(await readFile(join(to, 'Default', 'Network', 'Cookies'), 'utf8')).toBe('sid=logged-in');
    expect(
      await readFile(join(to, 'Default', 'IndexedDB', 'http_localhost_3000.indexeddb.leveldb', 'CURRENT'), 'utf8'),
    ).toBe('MANIFEST-000001');
  });

  it('refuses when either side is locked by a live process', async () => {
    const home = await tempDir('fba-home-');
    const from = join(profilesDir(home), 'main-11111111');
    await mkdir(join(from, 'Default'), { recursive: true });
    await writeFile(join(from, 'Default', 'Cookies'), 'sid=1', 'utf8');
    await writeLock(home, 'wt-22222222', process.pid);

    const error = await manager(home)
      .seed('main-11111111', 'wt-22222222')
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(isFbaError(error) ? error.code : '').toBe('PROFILE_LOCKED');
  });

  it('reports a useful error when the source has no state', async () => {
    const home = await tempDir('fba-home-');
    await mkdir(join(profilesDir(home), 'main-11111111'), { recursive: true });
    const error = await manager(home)
      .seed('main-11111111', 'wt-22222222')
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(isFbaError(error) ? error.code : '').toBe('INVALID_ARGUMENT');
  });

  it('rejects a missing source profile', async () => {
    const home = await tempDir('fba-home-');
    const error = await manager(home)
      .seed('nope-00000000', 'wt-22222222')
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(isFbaError(error) ? error.code : '').toBe('INVALID_ARGUMENT');
  });
});

describe('FsProfileManager.describe', () => {
  it('describes the configured workspace by default', async () => {
    const home = await tempDir('fba-home-');
    const repo = await tempDir('fba-repo-');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/dev\n', 'utf8');

    const info = await manager(home, repo).describe();
    expect(info.root).toBe(repo);
    expect(info.branch).toBe('dev');
  });
});
