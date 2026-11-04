import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const UpstreamSchema = z.object({
  id: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

const GatewayConfigFileSchema = z.object({
  upstreams: z.array(UpstreamSchema).min(1),
});
export type UpstreamConfig = z.infer<typeof UpstreamSchema>;

export interface GatewayConfig {
  upstreams: UpstreamConfig[];
  dbPath: string;
  policyPath: string;
  localToken: string;
  /** v1: a single fixed principal. Multi-user/RBAC is explicitly out of scope — see README. */
  principal: string;
}

export function loadConfig(configPath = "./gatekeep.config.yaml"): GatewayConfig {
  const raw = parseYaml(readFileSync(configPath, "utf8"));
  const parsed = GatewayConfigFileSchema.parse(raw);
  return {
    upstreams: parsed.upstreams,
    dbPath: process.env.GATEKEEP_DB_PATH ?? "./data/gatekeep.sqlite",
    policyPath: process.env.GATEKEEP_POLICY_PATH ?? "./policies/default.yaml",
    localToken: process.env.GATEKEEP_LOCAL_TOKEN ?? "dev-only-insecure-token",
    principal: process.env.GATEKEEP_PRINCIPAL ?? "local-user",
  };
}
