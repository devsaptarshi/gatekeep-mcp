import { z } from "zod";

export const PolicyActionSchema = z.enum(["allow", "approve", "deny"]);
export type PolicyAction = z.infer<typeof PolicyActionSchema>;

const RuleSchema = z.object({
  tool: z.string(), // glob matched against the bare (unprefixed) tool name
  action: PolicyActionSchema,
  when: z.string().optional(), // CEL expression; absent = always matches
  reason: z.string().optional(),
});
export type PolicyRule = z.infer<typeof RuleSchema>;

const FlowRuleSchema = z.object({
  name: z.string(),
  // The flow fires when at least one of these tags was recorded earlier
  // in THIS run (see run_tags) — e.g. "this run already read untrusted
  // content" — and the tool being called now carries `then_tag`.
  if_seen: z.array(z.string()).min(1),
  then_tag: z.string(),
  action: PolicyActionSchema,
  reason: z.string().optional(),
});
export type FlowRule = z.infer<typeof FlowRuleSchema>;

export const PolicyFileSchema = z.object({
  version: z.string(),
  defaults: z.object({
    unknown_tool: PolicyActionSchema.default("approve"),
    on_gateway_error: PolicyActionSchema.default("deny"),
    approval_ttl_seconds: z.number().int().positive().default(600),
  }),
  servers: z
    .record(
      z.string(),
      z.object({
        rules: z.array(RuleSchema).default([]),
        // Tags are assigned by the operator writing this policy file, NOT
        // taken from the upstream tool's own definition/annotations —
        // those are untrusted input from the server being proxied (see
        // SECURITY.md: tool annotations may only ever tighten a rule,
        // never loosen one, and here they aren't consulted at all).
        tags: z.record(z.string(), z.array(z.string())).default({}),
      }),
    )
    .default({}),
  flows: z.array(FlowRuleSchema).default([]),
});
export type PolicyFile = z.infer<typeof PolicyFileSchema>;

export interface PolicyDecision {
  action: PolicyAction;
  reason: string;
  matchedRule: PolicyRule | null;
}

export interface PolicyEvalContext {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  principal: string;
}
