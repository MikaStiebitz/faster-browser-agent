/**
 * L4 tool-surface tests.
 *
 * Everything here runs without a browser: the point of `createTools(ctx)` taking
 * a plain context is that the whole MCP surface is testable with fakes, and that
 * the tools which claim not to need a browser provably do not touch one.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { workspaceIdFor } from '../src/browser/profile.js';
import { FsCodeIndexer } from '../src/code/indexer.js';
import { defaultConfig } from '../src/config.js';
import type {
  AcquireOptions,
  BrowserPool,
  Executor,
  Session,
  SkillRunner,
  SkillStore,
} from '../src/contracts.js';
import { createServer } from '../src/mcp/server.js';
import { TOOL_NAMES, createTools, type ToolContext, type ToolDefinition } from '../src/mcp/tools.js';
import { FsSkillStore } from '../src/skills/store.js';
import type {
  ActOptions,
  ActResult,
  ActionStep,
  FbaConfig,
  FormFillRequest,
  FormFillResult,
  Observation,
  PageSnapshot,
  SessionInfo,
  SkillReplayResult,
} from '../src/types.js';
import { FbaError } from '../src/util/errors.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAGE_URL = 'http://localhost:3000/settings';

function observation(summary = 'settings — 3 controls'): Observation {
  return {
    url: PAGE_URL,
    title: 'Settings',
    summary,
    tree: {
      role: 'main',
      children: [
        { ref: 'e1', role: 'textbox', name: 'SMTP Host', value: 'smtp.example.com' },
        { ref: 'e2', role: 'button', name: 'Save' },
      ],
    },
    stats: { interactive: 2, emitted: 3, elided: 0, captureMs: 4 },
  };
}

function snapshot(): PageSnapshot {
  return {
    url: PAGE_URL,
    title: 'Settings',
    version: 1,
    tree: { role: 'main', children: [] },
    tabPath: ['Settings', 'Advanced'],
    stats: { interactive: 2, emitted: 3, elided: 0, captureMs: 4 },
  };
}

/** Just enough Session for the tools; the browser half is never reached. */
function fakeSession(config: FbaConfig, id = 's1'): Session {
  // The real workspace id, so `existingSession()` — which resolves a session
  // from the workspace rather than from an explicit id — finds this one.
  const workspaceId = workspaceIdFor(config.workspace ?? process.cwd());
  const info: SessionInfo = {
    id,
    workspaceId,
    url: PAGE_URL,
    title: 'Settings',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    version: 1,
    busy: false,
  };
  return {
    id,
    workspaceId,
    config,
    page: {} as Session['page'],
    info: () => info,
    goto: async () => undefined,
    snapshot: async () => snapshot(),
    lastSnapshot: () => snapshot(),
    settle: async () => ({ settled: true, reason: 'quiet' as const, waitedMs: 1 }),
    // Mirrors PageSession: the caller's prefix leads the summary line.
    observe: async (options) => {
      const result = observation();
      if (options?.summaryPrefix) result.summary = `${options.summaryPrefix} — ${result.summary}`;
      return result;
    },
    find: async () => [{ ref: 'e1', role: 'textbox', name: 'SMTP Host', score: 0.91 }],
    structure: async () => ({
      tabs: [{ ref: 't1', label: 'Advanced', selected: true, group: 'Settings' }],
      sections: [],
    }),
    pendingDialog: () => undefined,
    answerDialog: async () => undefined,
    recentRequests: () => [],
    endpoints: () => [
      {
        method: 'GET',
        url: `${PAGE_URL}/api/users?page=2`,
        pattern: '/api/users',
        status: 200,
        contentType: 'application/json',
        hits: 3,
        responseShape: '{id,name}[]',
        lastSeenAt: Date.now(),
      },
    ],
    drainProblems: async () => [],
    ensureRuntime: async () => undefined,
    close: async () => undefined,
  } satisfies Session;
}

class FakePool implements BrowserPool {
  acquireCalls = 0;
  sessions: Session[] = [];

  constructor(private readonly config: FbaConfig) {}

  async acquire(_options: AcquireOptions = {}): Promise<Session> {
    this.acquireCalls += 1;
    const session = this.sessions[0] ?? fakeSession(this.config);
    if (this.sessions.length === 0) this.sessions.push(session);
    return session;
  }
  get(sessionId: string): Session | undefined {
    return this.sessions.find((s) => s.id === sessionId);
  }
  list(): SessionInfo[] {
    return this.sessions.map((s) => s.info());
  }
  async closeSession(): Promise<void> {}
  async closeWorkspace(): Promise<void> {}
  async warm(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

class FakeExecutor implements Executor {
  lastSteps: ActionStep[] = [];
  error: Error | undefined;
  ok = true;

  async run(_session: Session, steps: ActionStep[], _options?: ActOptions): Promise<ActResult> {
    if (this.error) throw this.error;
    this.lastSteps = steps;
    return {
      ok: this.ok,
      steps: steps.map((step, index) => ({
        index,
        step: step.do,
        status: this.ok ? ('ok' as const) : ('failed' as const),
        ...(this.ok ? {} : { error: 'element not visible' }),
        ms: 3,
      })),
      ...(this.ok ? {} : { failedAt: 0 }),
      observation: observation(),
    };
  }

  async fillForm(_session: Session, request: FormFillRequest): Promise<FormFillResult> {
    return {
      ok: true,
      submitted: request.submit === true,
      fields: Object.keys(request.fields).map((key) => ({ key, status: 'ok' as const, ref: 'e1', matchedName: key })),
      observation: observation(),
    };
  }
}

class FakeRunner implements SkillRunner {
  async replay(_session: Session, name: string): Promise<SkillReplayResult> {
    return { name, ok: true, steps: [], ms: 12, observation: observation() };
  }
}

let home: string;
let workspace: string;
let config: FbaConfig;
let pool: FakePool;
let executor: FakeExecutor;
let skills: SkillStore;
let ctx: ToolContext;
let tools: Map<string, ToolDefinition>;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'fba-mcp-'));
  home = join(root, 'home');
  workspace = join(root, 'app');

  // A minimal next-app workspace so the code index has real routes to answer
  // browser_map and browser_find from.
  await mkdir(join(workspace, 'src/app/settings/advanced'), { recursive: true });
  await writeFile(
    join(workspace, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: { next: '15.0.0' } }),
  );
  await writeFile(join(workspace, 'src/app/settings/page.tsx'), 'export default function Settings() { return null }\n');
  await writeFile(
    join(workspace, 'src/app/settings/advanced/page.tsx'),
    'export default function Advanced() { return null }\n',
  );

  config = {
    ...defaultConfig(),
    home,
    workspace,
    baseUrl: 'http://localhost:3000',
    logLevel: 'silent',
  };

  pool = new FakePool(config);
  executor = new FakeExecutor();
  skills = new FsSkillStore(config);
  ctx = {
    config,
    pool,
    indexer: new FsCodeIndexer(config),
    skills,
    runner: new FakeRunner(),
    executor,
  };
  tools = new Map(createTools(ctx).map((tool) => [tool.name, tool]));
});

afterAll(async () => {
  await rm(join(home, '..'), { recursive: true, force: true });
});

function tool(name: string): ToolDefinition {
  const found = tools.get(name);
  if (!found) throw new Error(`tool ${name} is not registered`);
  return found;
}

// ---------------------------------------------------------------------------

describe('tool surface', () => {
  it('registers exactly the eleven expected tools', () => {
    expect([...tools.keys()]).toEqual([...TOOL_NAMES]);
  });

  it('keeps descriptions short — they are resident context on every call', () => {
    for (const definition of tools.values()) {
      expect(definition.description.length, definition.name).toBeLessThanOrEqual(200);
      expect(definition.description.length, definition.name).toBeGreaterThan(20);
    }
  });
});

describe('schemas', () => {
  it('browser_act accepts a representative discriminated-union program', () => {
    const parsed = tool('browser_act').schema.safeParse({
      steps: [
        { do: 'goto', route: '/settings/advanced' },
        { do: 'click', target: { role: 'tab', name: 'Networking' } },
        { do: 'type', target: { ref: 'e12' }, text: 'smtp.example.com', clear: true },
        { do: 'select', target: { label: 'Protocol' }, option: ['tls', 'ssl'] },
        { do: 'check', target: { testId: 'enabled' }, checked: true },
        { do: 'press', keys: 'Enter' },
        { do: 'settle', options: { networkQuietMs: 400 } },
        { do: 'assert', urlContains: '/settings/advanced' },
      ],
      onFailure: 'retry',
      record: 'configure-smtp',
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['unknown step kind', { steps: [{ do: 'frobnicate' }] }],
    ['missing required target', { steps: [{ do: 'click' }] }],
    ['empty target', { steps: [{ do: 'click', target: {} }] }],
    ['wrong payload type', { steps: [{ do: 'type', target: { ref: 'e1' }, text: 42 }] }],
    ['no steps at all', { steps: [] }],
  ])('browser_act rejects %s', async (_label, args) => {
    expect(tool('browser_act').schema.safeParse(args).success).toBe(false);
    const result = await tool('browser_act').handler(args);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^INVALID_ARGUMENT: bad arguments for browser_act/);
  });

  // The check lives in the handler, not in the schema: a `.refine()` would make
  // `openArgs` a ZodEffects, which the MCP SDK cannot convert — see the
  // tools/list assertion in the createServer block below.
  it('browser_open requires exactly one of url/route', async () => {
    expect(tool('browser_open').schema.safeParse({ url: 'http://x/' }).success).toBe(true);
    expect(tool('browser_open').schema.safeParse({ route: '/settings' }).success).toBe(true);

    const neither = await tool('browser_open').handler({});
    expect(neither.isError).toBe(true);
    expect(neither.text).toContain('exactly one of url or route');

    const both = await tool('browser_open').handler({ url: 'http://x/', route: '/settings' });
    expect(both.isError).toBe(true);
    expect(both.text).toContain('exactly one of url or route');
  });

  it('browser_form accepts mixed field value types and rejects objects', () => {
    const schema = tool('browser_form').schema;
    expect(
      schema.safeParse({ fields: { Host: 'smtp.example.com', Port: 587, TLS: true, Tags: ['a', 'b'] }, submit: true })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ fields: { Host: { nested: 1 } } }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('browser_snapshot and browser_session validate their scalars', async () => {
    expect(tool('browser_snapshot').schema.safeParse({ maxNodes: 'lots' }).success).toBe(false);
    expect(tool('browser_snapshot').schema.safeParse({ scope: 'region', root: 'e4' }).success).toBe(true);
    expect(tool('browser_session').schema.safeParse({ action: 'explode' }).success).toBe(false);
    expect(tool('browser_session').schema.safeParse({ action: 'list' }).success).toBe(true);
  });
});

describe('browser_map', () => {
  it('answers from the code index without touching the browser', async () => {
    const before = pool.acquireCalls;
    const result = await tool('browser_map').handler({});
    expect(result.isError).toBeFalsy();
    expect(pool.acquireCalls).toBe(before);
    expect(result.text).toContain('/settings/advanced');
    expect(result.text).toContain('next-app');
    expect(result.text).toContain('routes (');
  });

  it('filters routes by query', async () => {
    const result = await tool('browser_map').handler({ query: 'advanced' });
    expect(result.text).toContain('/settings/advanced');
    expect(result.text).not.toContain('  /settings "');
  });
});

describe('browser_find', () => {
  it('reports code-index deep links and how to reach them', async () => {
    const result = await tool('browser_find').handler({ query: 'advanced' });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('browser_open{route:');
    expect(result.text).toContain('http://localhost:3000/settings/advanced');
  });
});

describe('error handling', () => {
  it('returns executor failures as isError with the FbaError code and candidates', async () => {
    executor.error = new FbaError('TARGET_NOT_FOUND', 'no element matches button "Saev"', {
      hint: 'closest candidates: e2 button "Save"',
      details: { candidates: [{ ref: 'e2', role: 'button', name: 'Save' }] },
    });
    const result = await tool('browser_act').handler({ steps: [{ do: 'click', target: { name: 'Saev' } }] });
    executor.error = undefined;

    expect(result.isError).toBe(true);
    expect(result.text.startsWith('TARGET_NOT_FOUND: ')).toBe(true);
    expect(result.text).toContain('closest candidates');
  });

  it('reports an unresolvable route as ROUTE_NOT_FOUND without opening a browser', async () => {
    const before = pool.acquireCalls;
    const result = await tool('browser_open').handler({ route: '/nope/definitely-not-a-route' });
    expect(result.isError).toBe(true);
    expect(result.text.startsWith('ROUTE_NOT_FOUND: ')).toBe(true);
    expect(pool.acquireCalls).toBe(before);
  });

  it('reports a failing action program as isError but still returns the observation', async () => {
    executor.ok = false;
    const result = await tool('browser_act').handler({ steps: [{ do: 'click', target: { name: 'Save' } }] });
    executor.ok = true;
    expect(result.isError).toBe(true);
    expect(result.text).toContain('STEP_FAILED');
    expect(result.text).toContain('url: /settings');
  });

  it('names a missing skill and lists what does exist', async () => {
    const result = await tool('browser_skill').handler({ action: 'show', name: 'does-not-exist' });
    expect(result.isError).toBe(true);
    expect(result.text.startsWith('SKILL_NOT_FOUND: ')).toBe(true);
  });
});

describe('happy paths', () => {
  it('browser_open deep-links via the code index and ends with an observation', async () => {
    const result = await tool('browser_open').handler({ route: '/settings/advanced' });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('opened route /settings/advanced');
    expect(result.text).toContain('url: /settings');
    expect(result.text).toContain('e2 btn "Save"');
  });

  it('browser_act runs the program and records a replayable skill', async () => {
    const result = await tool('browser_act').handler({
      steps: [{ do: 'click', target: { name: 'Save' } }],
      record: 'save-settings',
    });
    expect(result.isError).toBeFalsy();
    expect(executor.lastSteps).toHaveLength(1);
    expect(result.text).toContain('recorded skill "save-settings"');

    const stored = await skills.get('save-settings');
    expect(stored?.origin).toBe('http://localhost:3000');
    expect(stored?.steps[0]?.do).toBe('click');

    const listed = await tool('browser_skill').handler({ action: 'list' });
    expect(listed.text).toContain('save-settings');
  });

  it('browser_form fills many fields in one call', async () => {
    const result = await tool('browser_form').handler({
      fields: { 'SMTP Host': 'smtp.example.com', 'SMTP Port': 587, TLS: true },
      submit: true,
    });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('SMTP Host: ok');
    expect(result.text).toContain('submitted');
  });

  it('browser_extract lists observed endpoints when called with no schema', async () => {
    const result = await tool('browser_extract').handler({});
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('GET /api/users');
    expect(result.text).toContain('{id,name}[]');
  });

  it('browser_session lists sessions', async () => {
    const result = await tool('browser_session').handler({ action: 'list' });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('sessions (');
  });

  it('browser_snapshot defaults the session id', async () => {
    const result = await tool('browser_snapshot').handler({});
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('session: s1');
  });
});

describe('createServer', () => {
  it('registers every tool over a real MCP transport and answers a call', async () => {
    const handle = createServer({ config, pool });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());

      // The whole tool surface is resident context on every turn; keep an eye
      // on its size the same way we keep an eye on snapshot size. The budget
      // went up by ~800 bytes in 0.5.0 because `browser_open` finally
      // advertises its properties instead of an empty object — that is the
      // schema arriving, not the surface bloating.
      expect(JSON.stringify(listed.tools).length).toBeLessThan(26_000);

      const result = await client.callTool({ name: 'browser_map', arguments: {} });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.type).toBe('text');
      expect(content[0]?.text).toContain('/settings/advanced');
    } finally {
      await client.close();
      await handle.close();
    }
  });
});
