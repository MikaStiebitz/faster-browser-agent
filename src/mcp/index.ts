/**
 * L4 — the MCP surface.
 *
 * `createTools` is the whole tool contract and is usable without a transport;
 * `createServer` / `startStdioServer` bolt it onto MCP stdio.
 */

export {
  TOOL_NAMES,
  createTools,
  resolveNavigation,
  type NavigationSpec,
  type ResolvedNavigation,
  type ToolContext,
  type ToolDefinition,
} from './tools.js';

export { createServer, startStdioServer, type ServerHandle } from './server.js';
