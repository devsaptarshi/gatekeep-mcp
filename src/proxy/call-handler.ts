import { computeCallHash } from "../hash/call-hash.js";
import type { JsonValue } from "../hash/canonical-json.js";
import type { GatekeepDb } from "../db/client.js";
import {
  consumeApproved,
  createPending,
  expireIfPastDue,
  findByCallHash,
  renewExpiredToPending,
} from "../db/repositories/approvals.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { ToolRegistry } from "./tool-registry.js";

export interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}

export type ForwardFn = (
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<ToolCallResult>;

export interface CallHandlerDeps {
  db: GatekeepDb;
  registry: ToolRegistry;
  policyEngine: PolicyEngine;
  principal: string;
  forwardToUpstream: ForwardFn;
}

function errorResult(text: string): ToolCallResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * The gateway's whole decision tree for one tools/call, decoupled from any
 * MCP transport so it can be driven by tests with a fake `forwardToUpstream`.
 *
 * Order matters and is deliberate:
 *   1. An approved-and-unconsumed row for this EXACT call hash is consumed
 *      once and forwarded using the gateway's OWN stored arguments — never
 *      whatever arguments this call just arrived with. This is what closes
 *      the TOCTOU gap: even if the agent's retry carries different
 *      arguments than what was approved, those different arguments hash
 *      differently and never match the approved row.
 *   2. Any other existing row for this call hash (denied / already-
 *      consumed / still-pending / expired) is handled without re-running
 *      policy — a decision, once made, isn't reconsidered by a retry.
 *   3. Only a call with no row at all gets a fresh policy decision.
 */
export async function handleToolCall(
  deps: CallHandlerDeps,
  prefixedName: string,
  rawArgs: Record<string, unknown> | undefined,
): Promise<ToolCallResult> {
  const args = rawArgs ?? {};
  const tool = deps.registry.get(prefixedName);
  if (!tool) {
    return errorResult(
      `Unknown tool "${prefixedName}". Expected the form "<server>__<tool>" for a tool this gateway has registered.`,
    );
  }

  const callHash = computeCallHash({
    serverId: tool.serverId,
    toolName: tool.toolName,
    arguments: args as JsonValue,
    toolDefinitionHash: tool.definitionHash,
    principal: deps.principal,
    policyVersion: deps.policyEngine.policyVersion,
  });

  const consumed = consumeApproved(deps.db, callHash);
  if (consumed) {
    const forwardArgs = JSON.parse(consumed.canonicalArgs) as Record<string, unknown>;
    return deps.forwardToUpstream(tool.serverId, tool.toolName, forwardArgs);
  }

  const existing = findByCallHash(deps.db, callHash);
  if (existing) {
    if (existing.status === "approved" && existing.consumedAt) {
      return errorResult(
        "This exact call was already approved and executed once. Approvals are single-use — " +
          "an identical repeat needs fresh policy review, which this gateway doesn't support for " +
          "byte-identical calls yet. If this is a legitimate repeat action, vary the request or ask an operator.",
      );
    }
    if (existing.status === "denied") {
      return errorResult(`Denied by an approver: ${existing.reason}`);
    }
    if (existing.status === "pending") {
      const afterExpiryCheck = expireIfPastDue(deps.db, existing.id) ?? existing;
      if (afterExpiryCheck.status === "pending") {
        return errorResult(
          `Approval pending (id=${afterExpiryCheck.id}). Ask an approver to run: gatekeep approve ${afterExpiryCheck.id}`,
        );
      }
      // fell through to expired — renew below
    }
    const fresh = findByCallHash(deps.db, callHash);
    if (fresh?.status === "expired") {
      const renewed = renewExpiredToPending(deps.db, fresh.id, deps.policyEngine.file.defaults.approval_ttl_seconds);
      if (renewed) {
        return errorResult(
          `Approval pending (id=${renewed.id}). Ask an approver to run: gatekeep approve ${renewed.id}`,
        );
      }
    }
  }

  const decision = deps.policyEngine.decide({
    serverId: tool.serverId,
    toolName: tool.toolName,
    arguments: args,
    principal: deps.principal,
  });

  if (decision.action === "deny") {
    return errorResult(`Denied by policy: ${decision.reason}`);
  }

  if (decision.action === "allow") {
    return deps.forwardToUpstream(tool.serverId, tool.toolName, args);
  }

  const created = createPending(deps.db, {
    callHash,
    serverId: tool.serverId,
    toolName: tool.toolName,
    principal: deps.principal,
    canonicalArgs: args,
    reason: decision.reason,
    ttlSeconds: deps.policyEngine.file.defaults.approval_ttl_seconds,
  });
  return errorResult(
    `Approval required (id=${created.id}): ${decision.reason}. ` +
      `Ask an approver to run: gatekeep approve ${created.id}, then retry this exact call.`,
  );
}
