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
  /**
   * Deliberately a SEPARATE secret from `localToken`. `localToken` is the
   * agent-facing credential for /mcp; this is the human-facing credential
   * for the approval inbox. If they were the same value, an agent holding
   * its own gateway token could log into the inbox and approve its own
   * pending calls — exactly the self-approval gap exact-call hashing is
   * supposed to prevent one layer up.
   */
  approverToken: string;
  /** v1: a single fixed principal. Multi-user/RBAC is explicitly out of scope — see README. */
  principal: string;
  /** Optional: all three must be set to enable Telegram notifications + the inline approve/deny buttons. */
  telegram?: { botToken: string; chatId: string; webhookSecret: string };
}

export function loadConfig(configPath = "./gatekeep.config.yaml"): GatewayConfig {
  const raw = parseYaml(readFileSync(configPath, "utf8"));
  const parsed = GatewayConfigFileSchema.parse(raw);
  return {
    upstreams: parsed.upstreams,
    dbPath: process.env.GATEKEEP_DB_PATH ?? "./data/gatekeep.sqlite",
    policyPath: process.env.GATEKEEP_POLICY_PATH ?? "./policies/default.yaml",
    localToken: process.env.GATEKEEP_LOCAL_TOKEN ?? "dev-only-insecure-token",
    approverToken: process.env.GATEKEEP_APPROVER_TOKEN ?? "dev-only-insecure-approver-token",
    principal: process.env.GATEKEEP_PRINCIPAL ?? "local-user",
    telegram:
      process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_WEBHOOK_SECRET
        ? {
            botToken: process.env.TELEGRAM_BOT_TOKEN,
            chatId: process.env.TELEGRAM_CHAT_ID,
            webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
          }
        : undefined,
  };
}
