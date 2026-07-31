/**
 * Chromium discovery and launch (L0).
 *
 * Two jobs live here:
 *   1. finding a usable Chromium binary without ever hard-failing on a
 *      playwright revision mismatch, and
 *   2. launching a persistent context tuned for *agents* rather than humans —
 *      no animations, no background throttling, no first-run noise.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, type BrowserContext } from 'playwright-core';

import type { FbaConfig } from '../types.js';
import { FbaError, errorMessage } from '../util/errors.js';
import { createLogger } from '../util/logger.js';

const logger = createLogger('launcher');

/**
 * Why we resolve the executable ourselves instead of just calling
 * `chromium.launch()` and letting playwright-core do it:
 *
 * playwright-core pins one browser *revision* per npm version. If the machine
 * has browsers from a different playwright version installed (extremely common
 * — CI images, `npx playwright install` run at a different time, a shared
 * `PLAYWRIGHT_BROWSERS_PATH`, a distro Chromium), playwright throws
 * "Executable doesn't exist at ..." and refuses to start even though a perfectly
 * good Chromium sits right next to the one it wanted. For a tool whose entire
 * pitch is "fast", failing the very first call over an off-by-one revision is
 * the worst possible first-run experience. So: try playwright's own answer
 * first, then look around, then fall back to whatever the system has.
 */
export function resolveExecutablePath(config: FbaConfig): string | undefined {
  const explicit = config.executablePath ?? process.env.FBA_CHROMIUM_PATH ?? process.env.FBA_EXECUTABLE_PATH;
  if (explicit) {
    const p = resolve(explicit);
    if (isExecutableFile(p)) return p;
    // An explicit path that does not exist is a configuration bug, not a reason
    // to silently run some other browser — but we still continue so that
    // checkBrowser() can report the whole picture instead of throwing here.
    logger.warn(`configured executablePath does not exist: ${p}`);
  }

  const fromPlaywright = playwrightExecutablePath();
  if (fromPlaywright && isExecutableFile(fromPlaywright)) return fromPlaywright;

  const scanned = scanBrowsersRoot(browsersRoot());
  if (scanned) return scanned;

  for (const candidate of systemChromePaths()) {
    if (isExecutableFile(candidate)) return candidate;
  }

  return undefined;
}

/** playwright-core's own guess; throws when its pinned revision is absent. */
function playwrightExecutablePath(): string | undefined {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
}

function browsersRoot(): string {
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  // "0" is playwright's opt-out sentinel meaning "next to the package"; there is
  // nothing useful to scan in that case.
  if (env && env !== '0') return resolve(env);
  if (platform() === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) return join(local, 'ms-playwright');
  }
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  return join(homedir(), '.cache', 'ms-playwright');
}

/** Layouts playwright has used for the chromium bundle across versions. */
const BUNDLE_RELATIVE_PATHS = [
  join('chrome-linux', 'chrome'),
  join('chrome-linux64', 'chrome'),
  join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  join('chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  join('chrome-win', 'chrome.exe'),
];

/**
 * Find the newest `chromium*-<revision>` bundle under a playwright browsers
 * root. Highest revision wins; a full `chromium-*` build beats a
 * `chromium_headless_shell-*` of the same revision because the headless shell
 * cannot run headed and lacks a few surfaces (extensions, some devtools
 * domains) that we may want later.
 */
function scanBrowsersRoot(root: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }

  interface Candidate {
    path: string;
    revision: number;
    full: boolean;
  }
  const better = (a: Candidate, b: Candidate): boolean =>
    a.full !== b.full ? a.full : a.revision > b.revision;

  let best: Candidate | undefined;
  for (const entry of entries) {
    if (!entry.startsWith('chromium')) continue;
    const match = /-(\d+)$/.exec(entry);
    const revision = match?.[1] ? Number.parseInt(match[1], 10) : 0;
    const candidate: Candidate = {
      path: '',
      revision,
      full: !entry.includes('headless_shell'),
    };
    for (const rel of BUNDLE_RELATIVE_PATHS) {
      const path = join(root, entry, rel);
      if (!isExecutableFile(path)) continue;
      candidate.path = path;
      break;
    }
    if (!candidate.path) continue;
    if (!best || better(candidate, best)) best = candidate;
  }
  return best?.path;
}

function systemChromePaths(): string[] {
  switch (platform()) {
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      ];
    case 'win32': {
      const roots = [
        process.env['PROGRAMFILES'],
        process.env['PROGRAMFILES(X86)'],
        process.env['LOCALAPPDATA'],
      ].filter((v): v is string => Boolean(v));
      return roots.flatMap((r) => [
        join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(r, 'Chromium', 'Application', 'chrome.exe'),
        join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]);
    }
    default:
      return [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/local/bin/chromium',
        '/snap/bin/chromium',
        '/opt/google/chrome/chrome',
      ];
  }
}

function isExecutableFile(path: string): boolean {
  try {
    // statSync (not lstatSync) so that the common `.../chromium -> .../chrome`
    // symlink layout resolves instead of being rejected.
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when we are almost certainly inside a container without user namespaces. */
function needsNoSandbox(): boolean {
  if (process.env.FBA_NO_SANDBOX) return true;
  // Chromium's setuid/namespace sandbox cannot initialise as uid 0 in most
  // container runtimes, and the failure mode is a cryptic immediate crash.
  // We do NOT pass --no-sandbox unconditionally: on a normal developer machine
  // the sandbox is a real security boundary between arbitrary web content and
  // the user's files, and agents browse untrusted pages.
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * Performance-first Chromium flags. Every group here buys either latency or
 * determinism; nothing is cosmetic.
 */
export function browserLaunchArgs(config: FbaConfig): string[] {
  const args = [
    // Headless/background tabs get their timers throttled and their renderers
    // deprioritised, which makes an "idle" page take seconds to settle.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // Chromium starts dropping IPCs when a renderer is chatty; our snapshot
    // evaluation is exactly that kind of burst.
    '--disable-ipc-flooding-protection',

    // Feature killswitches:
    //  Translate/OptimizationHints  — network calls and UI we never want
    //  BackForwardCache             — makes back/forward skip our re-injection
    //  AcceptCHFrame                — extra handshake round trip
    //  MediaRouter                  — background mDNS discovery
    //  site-per-process             — one renderer process per site is a lot of
    //                                 memory and slows cross-frame evaluation
    '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints,site-per-process',

    // Never block on a modal the agent cannot see.
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',

    // First-run / profile chrome that costs startup time and network calls.
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',

    // Keychain/keyring access blocks on a desktop prompt in headless
    // environments. `basic`/mock keychain use a fixed key, which additionally
    // makes cookie databases portable between profile dirs — that is what
    // makes ProfileManager.seed() actually carry a login across workspaces.
    '--password-store=basic',
    '--use-mock-keychain',

    '--metrics-recording-only',
    '--mute-audio',

    // /dev/shm is tiny in most containers; without this Chromium tabs crash
    // with an out-of-memory that looks like a bug in us.
    '--disable-dev-shm-usage',

    // Background network chatter we never benefit from.
    '--disable-client-side-phishing-detection',
    '--disable-component-update',
    '--disable-domain-reliability',
  ];

  if (needsNoSandbox()) args.push('--no-sandbox', '--disable-setuid-sandbox');

  // User args go last so that a later `--disable-features=...` (or anything
  // else) wins over ours — this is the documented escape hatch.
  args.push(...config.browserArgs);
  return args;
}

/**
 * Context-level options shared by the pool and by diagnostics.
 *
 * Returned untyped-ish (`Record<string, unknown>`) on purpose: it is spread
 * into both `launchPersistentContext` and `browser.newContext`, whose option
 * types overlap but are not identical across playwright versions.
 */
export function contextOptions(config: FbaConfig): Record<string, unknown> {
  return {
    viewport: { width: config.viewport.width, height: config.viewport.height },
    // A fixed device scale factor keeps screenshots and element geometry
    // reproducible regardless of the host display.
    deviceScaleFactor: 1,
    locale: config.locale ?? 'en-US',
    timezoneId: config.timezone ?? 'UTC',
    ...(config.userAgent ? { userAgent: config.userAgent } : {}),
    // We do NOT relax TLS: an agent silently trusting a bad certificate on a
    // staging host is a security footgun, and dev servers are plain http.
    ignoreHTTPSErrors: false,
    // Many dev apps are PWAs; killing their service worker changes the app's
    // behaviour rather than just its speed.
    serviceWorkers: 'allow',
    bypassCSP: false,
    // `reduce` is a real latency win, not an accessibility nicety: CSS
    // transitions and enter/exit animations are the single most common reason a
    // freshly opened dialog is not yet stable, and they add 150-400ms of
    // pointless waiting to every settle.
    reducedMotion: 'reduce',
    // Leave forced-colors at the platform default: forcing it changes computed
    // styles and can flip elements' visibility heuristics.
    forcedColors: 'none',
    colorScheme: 'light',
  };
}

/**
 * Launch a persistent (profile-backed) Chromium context.
 *
 * Persistent rather than `browser.newContext()` because the whole point of the
 * per-workspace profile is that cookies, localStorage and service worker caches
 * survive between agent runs.
 */
export async function launchPersistentContext(profileDir: string, config: FbaConfig): Promise<BrowserContext> {
  const executablePath = resolveExecutablePath(config);
  const args = browserLaunchArgs(config);

  try {
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: config.headless,
      ...(executablePath ? { executablePath } : {}),
      args,
      ...contextOptions(config),
      // Chromium can take a while to come up on a cold page cache; the launch
      // budget is deliberately larger than the per-action timeout.
      timeout: Math.max(config.timeoutMs, 30_000),
    });

    // One place to set the default so every page created later inherits it.
    context.setDefaultTimeout(config.timeoutMs);
    context.setDefaultNavigationTimeout(config.timeoutMs);
    return context;
  } catch (e) {
    throw new FbaError('BROWSER_LAUNCH_FAILED', `could not launch Chromium: ${errorMessage(e)}`, {
      hint: launchHint(executablePath),
      details: { profileDir, executablePath: executablePath ?? null, headless: config.headless },
      cause: e,
    });
  }
}

function launchHint(executablePath: string | undefined): string {
  if (!executablePath) {
    return (
      'no Chromium was found. Install one with `npx playwright install chromium`, ' +
      'or point fba at an existing binary via FBA_CHROMIUM_PATH=/path/to/chrome ' +
      '(or PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers if browsers are installed there)'
    );
  }
  return (
    `found Chromium at ${executablePath} but it failed to start. ` +
    'In a container, set FBA_NO_SANDBOX=1; if it exits immediately, missing shared libraries ' +
    'are the usual cause — `npx playwright install-deps chromium` installs them'
  );
}

/**
 * Diagnostic used by the CLI `doctor` command and by the MCP server on startup.
 *
 * It actually launches the browser rather than just stat-ing the binary: the
 * interesting failures (missing libnss3, no /dev/shm, sandbox refusal) only
 * show up at launch time, and a "doctor" that reports OK and then breaks is
 * worse than none.
 */
export async function checkBrowser(
  config: FbaConfig,
): Promise<{ ok: boolean; executablePath?: string; version?: string; error?: string }> {
  const executablePath = resolveExecutablePath(config);
  if (!executablePath) {
    return {
      ok: false,
      error:
        'no Chromium executable found. Looked at: config.executablePath, $FBA_CHROMIUM_PATH, ' +
        `$FBA_EXECUTABLE_PATH, playwright's bundled revision, ${browsersRoot()} and the usual system ` +
        'locations. Fix with one of: `npx playwright install chromium`, ' +
        '`export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` (if browsers are already installed there), ' +
        'or `export FBA_CHROMIUM_PATH=/usr/bin/google-chrome`.',
    };
  }

  try {
    const browser = await chromium.launch({
      headless: true,
      executablePath,
      args: browserLaunchArgs(config),
      timeout: Math.max(config.timeoutMs, 30_000),
    });
    const version = browser.version();
    await browser.close();
    return { ok: true, executablePath, version };
  } catch (e) {
    // Fall back to `--version` so we can still tell the user *which* build is
    // broken; that string is often the fastest route to the real problem.
    const version = await probeVersion(executablePath);
    return {
      ok: false,
      executablePath,
      ...(version ? { version } : {}),
      error: `${errorMessage(e)} — ${launchHint(executablePath)}`,
    };
  }
}

function probeVersion(executablePath: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    execFile(executablePath, ['--version'], { timeout: 5_000 }, (err, stdout) => {
      if (err) {
        resolvePromise(undefined);
        return;
      }
      const line = stdout.trim().split('\n')[0];
      resolvePromise(line ? line.trim() : undefined);
    });
  });
}

/** Exported for diagnostics: where we looked for playwright-managed browsers. */
export function browserSearchPaths(): { browsersRoot: string; system: string[]; exists: boolean } {
  const root = browsersRoot();
  return { browsersRoot: root, system: systemChromePaths(), exists: existsSync(root) };
}
