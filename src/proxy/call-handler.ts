import { appendEvent } from "../audit/log.js";
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
import { strictest, type PolicyEngine } from "../policy/engine.js";
import { hasSeenAnyTag, recordTags } from "../db/repositories/run-tags.js";
import type { ApprovalRow } from "../db/repositories/approvals.js";
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
  /** Groups this handler's audit events with the gateway process (or test run) that made the call. */
  runId: string;
  /** Fired once a call starts (or restarts, after expiry) waiting on a human — e.g. to send a Telegram notice. Never awaited into the response path: a notification failure must not block the gateway's own answer. */
  onApprovalPending?: (approval: ApprovalRow) => void;
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
    appendEvent(deps.db, {
      runId: deps.runId,
      event: "unknown_tool_call",
      payload: { prefixedName, arguments: args as JsonValue, principal: deps.principal },
    });
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

  const auditPayload: JsonValue = {
    server_id: tool.serverId,
    tool_name: tool.toolName,
    arguments: args as JsonValue,
    principal: deps.principal,
  };

  const consumed = consumeApproved(deps.db, callHash);
  if (consumed) {
    const forwardArgs = JSON.parse(consumed.canonicalArgs) as Record<string, unknown>;
    appendEvent(deps.db, { runId: deps.runId, event: "approval_consumed_and_executed", callHash, decision: "approve", payload: auditPayload });
    recordTags(deps.db, deps.runId, tool.toolName, deps.policyEngine.tagsFor(tool.serverId, tool.toolName));
    return deps.forwardToUpstream(tool.serverId, tool.toolName, forwardArgs);
  }

  const existing = findByCallHash(deps.db, callHash);
  if (existing) {
    if (existing.status === "approved" && existing.consumedAt) {
      appendEvent(deps.db, { runId: deps.runId, event: "replay_blocked_already_consumed", callHash, payload: auditPayload });
      return errorResult(
        "This exact call was already approved and executed once. Approvals are single-use — " +
          "an identical repeat needs fresh policy review, which this gateway doesn't support for " +
          "byte-identical calls yet. If this is a legitimate repeat action, vary the request or ask an operator.",
      );
    }
    if (existing.status === "denied") {
      appendEvent(deps.db, { runId: deps.runId, event: "call_denied_cached", callHash, decision: "deny", payload: auditPayload });
      return errorResult(`Denied by an approver: ${existing.reason}`);
    }
    if (existing.status === "pending") {
      const afterExpiryCheck = expireIfPastDue(deps.db, existing.id) ?? existing;
      if (afterExpiryCheck.status === "pending") {
        appendEvent(deps.db, { runId: deps.runId, event: "approval_still_pending", callHash, payload: auditPayload });
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
        appendEvent(deps.db, { runId: deps.runId, event: "approval_renewed_after_expiry", callHash, payload: auditPayload });
        deps.onApprovalPending?.(renewed);
        return errorResult(
          `Approval pending (id=${renewed.id}). Ask an approver to run: gatekeep approve ${renewed.id}`,
        );
      }
    }
  }

  let decision = deps.policyEngine.decide({
    serverId: tool.serverId,
    toolName: tool.toolName,
    arguments: args,
    principal: deps.principal,
  });

  // Flow rules can only TIGHTEN the base decision, never loosen it — same
  // principle as untrusted tool annotations (SECURITY.md). A flow fires
  // when this tool carries a tag a flow is watching for (`then_tag`) AND
  // this run already recorded one of that flow's `if_seen` tags earlier.
  for (const flow of deps.policyEngine.flowsFor(tool.serverId, tool.toolName)) {
    if (hasSeenAnyTag(deps.db, deps.runId, flow.if_seen)) {
      const flowAction = strictest(decision.action, flow.action);
      if (flowAction !== decision.action) {
        appendEvent(deps.db, {
          runId: deps.runId,
          event: "flow_rule_escalated",
          callHash,
          decision: flowAction,
          payload: { ...auditPayload, flow: flow.name, if_seen: flow.if_seen, base_action: decision.action },
        });
      }
      decision = {
        action: flowAction,
        reason: flowAction === decision.action ? decision.reason : `flow "${flow.name}": ${flow.reason ?? `saw ${flow.if_seen.join("/")} earlier this run`}`,
        matchedRule: decision.matchedRule,
      };
    }
  }

  if (decision.action === "deny") {
    appendEvent(deps.db, { runId: deps.runId, event: "policy_denied", callHash, decision: "deny", payload: auditPayload });
    return errorResult(`Denied by policy: ${decision.reason}`);
  }

  if (decision.action === "allow") {
    appendEvent(deps.db, { runId: deps.runId, event: "policy_allowed_and_executed", callHash, decision: "allow", payload: auditPayload });
    recordTags(deps.db, deps.runId, tool.toolName, deps.policyEngine.tagsFor(tool.serverId, tool.toolName));
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
  appendEvent(deps.db, { runId: deps.runId, event: "approval_created", callHash, decision: "approve", payload: auditPayload });
  deps.onApprovalPending?.(created);
  return errorResult(
    `Approval required (id=${created.id}): ${decision.reason}. ` +
      `Ask an approver to run: gatekeep approve ${created.id}, then retry this exact call.`,
  );
}
