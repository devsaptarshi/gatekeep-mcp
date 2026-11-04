import { createHash } from "node:crypto";
import { canonicalize, type JsonValue } from "./canonical-json.js";

export interface CallIdentity {
  serverId: string;
  toolName: string;
  arguments: JsonValue;
  toolDefinitionHash: string;
  principal: string;
  policyVersion: string;
}

/**
 * call_hash = SHA-256(canonical_json({server_id, tool_name, arguments,
 * tool_definition_hash, principal, policy_version})).
 *
 * Including tool_definition_hash invalidates an approval if the tool's
 * definition changed since review (rug-pull detection). Including
 * policy_version invalidates approvals if the policy tightened. Both are
 * deliberately part of the hash, not separate checks, so there is exactly
 * one place that decides whether a stored approval still matches reality.
 */
export function computeCallHash(identity: CallIdentity): string {
  const canonical = canonicalize({
    server_id: identity.serverId,
    tool_name: identity.toolName,
    arguments: identity.arguments,
    tool_definition_hash: identity.toolDefinitionHash,
    principal: identity.principal,
    policy_version: identity.policyVersion,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Hash of a tool's own definition, used for tool-pinning / rug-pull detection. */
export function computeToolDefinitionHash(definition: JsonValue): string {
  return createHash("sha256").update(canonicalize(definition), "utf8").digest("hex");
}
