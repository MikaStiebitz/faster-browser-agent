/**
 * The MCP server (L4).
 *
 * Wiring only: it assembles the six collaborators a `ToolContext` needs,
 * registers the tools from `createTools`, and speaks stdio.
 *
 * The one rule that is not negotiable here: **nothing may write to stdout**.
 * stdout is the JSON-RPC channel; a stray `console.log` anywhere in the process
 * corrupts the protocol frame and the client drops the connection. All
 * diagnostics go to stderr through the logger.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { getSharedPool, shutdownSharedPool } from '../browser/pool.js';
import { detectWorkspace } from '../browser/profile.js';
import { FsCodeIndexer } from '../code/indexer.js';
import { loadConfig } from '../config.js';
import type { Session } from '../contracts.js';
import { DefaultExecutor } from '../executor/act.js';
import { DefaultSkillRunner } from '../skills/runner.js';
import { FsSkillStore } from '../skills/store.js';
import type { FbaConfig } from '../types.js';
import { errorMessage } from '../util/errors.js';
import { createLogger, setLogLevel } from '../util/logger.js';
import { FsSiteMemoryStore } from '../site/memory.js';
import { createTools, resolveNavigation, type ToolContext } from './tools.js';

const logger = createLogger('mcp:server');

const SERVER_NAME = 'faster-browser-agent';
const SERVER_VERSION = '0.1.0';

export interface ServerHandle {
  server: McpServer;
  /** The wired collaborators, exposed for embedding and for tests. */
  context: ToolContext;
  /** Close the transport and every browser this server owns. */
  close(): Promise<void>;
}

/**
 * Build a fully wired MCP server.
 *
 * Every collaborator can be overridden, which is what makes the whole surface
 * testable without a browser: pass a fake pool and the tools run against it.
 * Anything not passed is constructed here — and only what this process
 * constructed is torn down by `close()`, so an injected pool owned by a test
 * (or by an embedding application) is never closed behind its owner's back.
 */
export function createServer(ctx: Partial<ToolContext> = {}): ServerHandle {
  const config = ctx.config ?? loadConfig();
  setLogLevel(config.logLevel);

  const indexer = ctx.indexer ?? new FsCodeIndexer(config);
  const skills = ctx.skills ?? new FsSkillStore(config);

  // The shared pool, not a private one: the profile lock is per *process*, so a
  // second pool in this process would fight the first over the same user-data
  // dirs and the loser would silently get cookie-less ephemeral clones.
  // A pool we created is ours to close; an injected one belongs to its owner.
  const ownsPool = ctx.pool === undefined;
  // Site memory must be created before the pool: the pool hands it to every
  // session it opens, and a pool created without it would never learn.
  const memory = ctx.memory ?? (config.siteMemory ? new FsSiteMemoryStore(config) : undefined);
  const pool = ctx.pool ?? getSharedPool(config, memory);

  /**
   * Route resolution for `{ do: 'goto', route }` steps.
   *
   * The executor deliberately knows nothing about the code index, so this is
   * the seam where L2 gets its deep links: the same resolution `browser_open`
   * uses, injected as a callback.
   */
  const onNavigate = async (session: Session, spec: { url?: string; route?: string }): Promise<void> => {
    // Same workspace resolution the tools use, so a `goto route` step inside a
    // program resolves against exactly the index `browser_open` would consult.
    const workspace = await detectWorkspace(config.workspace ?? process.cwd());
    const resolved = await resolveNavigation({ config, indexer }, workspace.root, spec);
    await session.goto(resolved.url);
  };

  const executor = ctx.executor ?? new DefaultExecutor({ onNavigate, ...(memory ? { memory } : {}) });
  const runner = ctx.runner ?? new DefaultSkillRunner(skills, executor);
  const context: ToolContext = { config, pool, indexer, skills, runner, executor, ...(memory ? { memory } : {}) };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Code-aware browser automation. Prefer browser_open{route} over clicking through menus, ' +
        'browser_act with many steps over one call per click, and browser_form over per-field typing. ' +
        'sessionId is optional everywhere — omit it unless driving several tabs at once.',
    },
  );

  for (const tool of createTools(context)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
        // Nothing here is safe to retry blindly except reading; the honest
        // annotation lets a client decide whether to auto-approve.
        annotations: { readOnlyHint: READ_ONLY_TOOLS.has(tool.name) },
      },
      async (args: unknown) => {
        const result = await tool.handler(args);
        return {
          content: [
            { type: 'text' as const, text: result.text },
            // Screenshots ride along as proper MCP image blocks, so the model
            // sees pixels, not a base64 wall of text.
            ...(result.images ?? []).map((img) => ({
              type: 'image' as const,
              data: img.data,
              mimeType: img.mimeType,
            })),
          ],
          ...(result.isError ? { isError: true } : {}),
        };
      },
    );
  }

  return {
    server,
    context,
    async close(): Promise<void> {
      await server.close().catch((e: unknown) => logger.debug(`server close: ${errorMessage(e)}`));
      if (ownsPool) await shutdownSharedPool().catch((e: unknown) => logger.warn(`pool shutdown: ${errorMessage(e)}`));
    },
  };
}

/** Tools that never mutate page state — everything else can navigate or click. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['browser_snapshot', 'browser_find', 'browser_map', 'browser_screenshot']);

/**
 * Run the server over stdio until the client disconnects.
 *
 * The browser is warmed in the background: cold start is 0.3-8s and paying it
 * while the model is still reading the tool list is free, whereas paying it
 * inside the first `browser_open` is the most visible latency in the system.
 */
export async function startStdioServer(overrides?: Partial<FbaConfig>): Promise<void> {
  const config = loadConfig(overrides ? { overrides } : {});
  const handle = createServer({ config });

  const transport = new StdioServerTransport();
  await handle.server.connect(transport);
  logger.info(`faster-browser-agent ${SERVER_VERSION} ready on stdio (workspace ${config.workspace ?? process.cwd()})`);

  // Fire-and-forget: a failed warm is not a reason to refuse to serve, and the
  // first real call will surface the same failure with a better message.
  void handle.context.pool.warm().catch((e: unknown) => logger.debug(`warm failed: ${errorMessage(e)}`));

  await new Promise<void>((resolveDone) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      void handle.close().finally(() => resolveDone());
    };
    transport.onclose = finish;
    // stdin closing is the canonical "the client went away" signal for stdio
    // servers; without it a disconnected server would keep a browser alive.
    process.stdin.once('end', finish);
    process.stdin.once('close', finish);
  });
}
