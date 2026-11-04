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

export const PolicyFileSchema = z.object({
  version: z.string(),
  defaults: z.object({
    unknown_tool: PolicyActionSchema.default("approve"),
    on_gateway_error: PolicyActionSchema.default("deny"),
    approval_ttl_seconds: z.number().int().positive().default(600),
  }),
  servers: z.record(z.string(), z.object({ rules: z.array(RuleSchema).default([]) })).default({}),
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
