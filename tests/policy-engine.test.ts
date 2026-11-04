import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../src/policy/engine.js";
import { PolicyFileSchema } from "../src/policy/types.js";

function engineFrom(servers: Record<string, { rules: Array<Record<string, unknown>> }>) {
  const parsed = PolicyFileSchema.parse({
    version: "test",
    defaults: { unknown_tool: "approve", on_gateway_error: "deny", approval_ttl_seconds: 600 },
    servers,
  });
  return new PolicyEngine(parsed);
}

describe("PolicyEngine.decide", () => {
  it("falls back to defaults.unknown_tool when no rule matches", () => {
    const engine = engineFrom({ erp: { rules: [] } });
    const decision = engine.decide({ serverId: "erp", toolName: "mystery_tool", arguments: {}, principal: "alice" });
    expect(decision.action).toBe("approve");
    expect(decision.matchedRule).toBeNull();
  });

  it("matches a plain glob rule with no `when`", () => {
    const engine = engineFrom({ erp: { rules: [{ tool: "list_*", action: "allow" }] } });
    const decision = engine.decide({ serverId: "erp", toolName: "list_vendors", arguments: {}, principal: "alice" });
    expect(decision.action).toBe("allow");
  });

  it("evaluates a CEL `when` expression against arguments", () => {
    const engine = engineFrom({
      erp: {
        rules: [
          { tool: "create_payment", action: "approve", when: "arguments.amountInr > 50000" },
          { tool: "create_payment", action: "allow", when: "arguments.amountInr <= 50000" },
        ],
      },
    });
    const big = engine.decide({ serverId: "erp", toolName: "create_payment", arguments: { amountInr: 490000 }, principal: "a" });
    expect(big.action).toBe("approve");
    const small = engine.decide({ serverId: "erp", toolName: "create_payment", arguments: { amountInr: 1000 }, principal: "a" });
    expect(small.action).toBe("allow");
  });

  it("deny beats approve beats allow when multiple rules match the same call", () => {
    const engine = engineFrom({
      erp: {
        rules: [
          { tool: "risky", action: "allow" },
          { tool: "risky", action: "deny" },
          { tool: "risky", action: "approve" },
        ],
      },
    });
    const decision = engine.decide({ serverId: "erp", toolName: "risky", arguments: {}, principal: "a" });
    expect(decision.action).toBe("deny");
  });

  it("fails closed (on_gateway_error) when a `when` expression is invalid", () => {
    const engine = engineFrom({ erp: { rules: [{ tool: "bad", action: "allow", when: "this is not valid cel ((" }] } });
    const decision = engine.decide({ serverId: "erp", toolName: "bad", arguments: {}, principal: "a" });
    expect(decision.action).toBe("deny");
  });

  it("tool glob matching is scoped per server — no cross-server leakage", () => {
    const engine = engineFrom({
      erp: { rules: [{ tool: "create_payment", action: "allow" }] },
      other: { rules: [] },
    });
    const decision = engine.decide({ serverId: "other", toolName: "create_payment", arguments: {}, principal: "a" });
    expect(decision.action).toBe("approve"); // falls to defaults.unknown_tool, not erp's allow rule
  });

  it("policyVersion changes when the policy file content changes", () => {
    const a = engineFrom({ erp: { rules: [{ tool: "x", action: "allow" }] } });
    const b = engineFrom({ erp: { rules: [{ tool: "x", action: "deny" }] } });
    expect(a.policyVersion).not.toBe(b.policyVersion);
  });

  it("policyVersion is stable for identical policy content", () => {
    const a = engineFrom({ erp: { rules: [{ tool: "x", action: "allow" }] } });
    const b = engineFrom({ erp: { rules: [{ tool: "x", action: "allow" }] } });
    expect(a.policyVersion).toBe(b.policyVersion);
  });

  it("loads the shipped default.yaml and matches the fixture's risky tool", () => {
    const engine = PolicyEngine.fromFile(new URL("../policies/default.yaml", import.meta.url).pathname);
    const decision = engine.decide({
      serverId: "erp-fixture",
      toolName: "create_payment",
      arguments: { invoiceId: "INV-2026-0093", amountInr: 490000 },
      principal: "alice",
    });
    expect(decision.action).toBe("approve");

    const deny = engine.decide({
      serverId: "erp-fixture",
      toolName: "update_vendor_bank_details",
      arguments: { vendorId: "V-1003", bankAccount: "x", ifsc: "y" },
      principal: "alice",
    });
    expect(deny.action).toBe("deny");
  });
});
