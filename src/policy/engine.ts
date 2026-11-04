import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { evaluate as evaluateCel } from "@marcbachmann/cel-js";
import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";
import { canonicalize } from "../hash/canonical-json.js";
import { PolicyFileSchema, type PolicyDecision, type PolicyEvalContext, type PolicyFile, type PolicyRule } from "./types.js";

const ACTION_RANK: Record<string, number> = { deny: 3, approve: 2, allow: 1 };

export class PolicyEngine {
  readonly file: PolicyFile;
  /**
   * The policy_version baked into call_hash. It is NOT the human-written
   * `version` field in the YAML (which the author may forget to bump) —
   * it's a hash of the fully-parsed, canonicalized policy, so *any* change
   * to the policy — including one the author didn't think to version —
   * invalidates every outstanding approval.
   */
  readonly policyVersion: string;

  constructor(file: PolicyFile) {
    this.file = file;
    this.policyVersion = createHash("sha256")
      .update(canonicalize(file as unknown as Parameters<typeof canonicalize>[0]), "utf8")
      .digest("hex")
      .slice(0, 16);
  }

  static fromFile(path: string): PolicyEngine {
    const raw = parseYaml(readFileSync(path, "utf8"));
    const parsed = PolicyFileSchema.parse(raw);
    return new PolicyEngine(parsed);
  }

  decide(ctx: PolicyEvalContext): PolicyDecision {
    const serverRules = this.file.servers[ctx.serverId]?.rules ?? [];
    const matched: PolicyRule[] = [];

    for (const rule of serverRules) {
      if (!minimatch(ctx.toolName, rule.tool)) continue;
      if (rule.when === undefined) {
        matched.push(rule);
        continue;
      }
      try {
        const result = evaluateCel(rule.when, {
          tool: ctx.toolName,
          server: ctx.serverId,
          principal: ctx.principal,
          arguments: ctx.arguments,
        });
        if (result === true) matched.push(rule);
      } catch (err) {
        // A broken `when` expression is a policy-authoring bug, not a
        // signal to fall open. Treat it as a gateway error.
        return {
          action: this.file.defaults.on_gateway_error,
          reason: `policy rule for tool="${rule.tool}" has an invalid 'when' expression: ${String(err)}`,
          matchedRule: null,
        };
      }
    }

    if (matched.length === 0) {
      return {
        action: this.file.defaults.unknown_tool,
        reason: `no policy rule matched server="${ctx.serverId}" tool="${ctx.toolName}"; applying defaults.unknown_tool`,
        matchedRule: null,
      };
    }

    // deny > approve > allow
    let winner = matched[0]!;
    for (const rule of matched) {
      if (ACTION_RANK[rule.action]! > ACTION_RANK[winner.action]!) winner = rule;
    }
    return {
      action: winner.action,
      reason: winner.reason ?? `matched rule tool="${winner.tool}" action="${winner.action}"`,
      matchedRule: winner,
    };
  }
}
