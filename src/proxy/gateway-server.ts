import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { GatekeepDb } from "../db/client.js";
import type { ApprovalRow } from "../db/repositories/approvals.js";
import type { PolicyEngine } from "../policy/engine.js";
import { handleToolCall, type ToolCallResult } from "./call-handler.js";
import type { ConnectedUpstream } from "./upstream-manager.js";
import type { ToolRegistry } from "./tool-registry.js";

export interface GatewayServerDeps {
  db: GatekeepDb;
  registry: ToolRegistry;
  policyEngine: PolicyEngine;
  principal: string;
  upstreams: ConnectedUpstream[];
  runId: string;
  onApprovalPending?: (approval: ApprovalRow) => void;
}

/**
 * The gateway's own MCP server identity: this is what a client (Claude
 * Code, Cursor, a custom agent) actually connects to. It looks like a
 * normal MCP server — advertising the union of every upstream's tools,
 * `server__tool`-prefixed — and internally proxies every call through
 * `handleToolCall`'s policy/approval decision before ever reaching a real
 * upstream.
 */
export function buildGatewayServer(deps: GatewayServerDeps): Server {
  const upstreamsById = new Map(deps.upstreams.map((u) => [u.id, u]));

  const server = new Server(
    { name: "gatekeep-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: deps.registry.list().map((tool) => ({
      ...tool.definition,
      name: tool.prefixedName,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result: ToolCallResult = await handleToolCall(
      {
        db: deps.db,
        registry: deps.registry,
        policyEngine: deps.policyEngine,
        principal: deps.principal,
        runId: deps.runId,
        onApprovalPending: deps.onApprovalPending,
        forwardToUpstream: async (serverId, toolName, forwardArgs) => {
          const upstream = upstreamsById.get(serverId);
          if (!upstream) {
            return { isError: true, content: [{ type: "text", text: `No connected upstream "${serverId}"` }] };
          }
          const upstreamResult = await upstream.client.callTool({ name: toolName, arguments: forwardArgs });
          return upstreamResult as ToolCallResult;
        },
      },
      name,
      args as Record<string, unknown> | undefined,
    );
    // The SDK's CallToolResult type is a large discriminated union (task
    // support, structured content, etc.) that our minimal ToolCallResult
    // deliberately doesn't model. It's a structural subset of the plain
    // (non-task) branch, which is all the gateway ever returns.
    return result as unknown as Record<string, unknown>;
  });

  return server;
}
