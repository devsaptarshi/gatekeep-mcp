import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type GatekeepDb } from "../src/db/client.js";
import { handleToolCall, type ForwardFn, type ToolCallResult } from "../src/proxy/call-handler.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { PolicyFileSchema } from "../src/policy/types.js";
import { ToolRegistry } from "../src/proxy/tool-registry.js";

// The build spec's own example: a flow named "untrusted-to-external" that
// requires approval for an "external_send"-tagged tool IF this run already
// saw an "untrusted_read"-tagged tool. Individually, reading invoices is
// fine, and a small payment is fine — but reading untrusted content and
// THEN sending money in the same run is the pattern that matters, even
// though no single call looks risky on its own.
function policyWithFlow() {
  return new PolicyEngine(
    PolicyFileSchema.parse({
      version: "flow-test",
      defaults: { unknown_tool: "approve", on_gateway_error: "deny", approval_ttl_seconds: 600 },
      servers: {
        erp: {
          rules: [
            { tool: "list_pending_invoices", action: "allow" },
            { tool: "create_payment", action: "allow", when: "arguments.amountInr <= 50000" },
            { tool: "create_payment", action: "approve", when: "arguments.amountInr > 50000" },
          ],
          tags: {
            list_pending_invoices: ["untrusted_read"],
            create_payment: ["external_send"],
          },
        },
      },
      flows: [
        {
          name: "untrusted-to-external",
          if_seen: ["untrusted_read"],
          then_tag: "external_send",
          action: "approve",
          reason: "this run read untrusted content earlier and is now trying to send money",
        },
      ],
    }),
  );
}

let db: GatekeepDb;
let registry: ToolRegistry;
let forwarded: Array<{ toolName: string; args: Record<string, unknown> }>;
let forwardToUpstream: ForwardFn;

beforeEach(() => {
  db = openDb(":memory:");
  registry = new ToolRegistry();
  registry.register({ serverId: "erp", toolName: "list_pending_invoices", prefixedName: "erp__list_pending_invoices", definitionHash: "h1", definition: {} });
  registry.register({ serverId: "erp", toolName: "create_payment", prefixedName: "erp__create_payment", definitionHash: "h2", definition: {} });
  forwarded = [];
  forwardToUpstream = async (_serverId, toolName, args) => {
    forwarded.push({ toolName, args });
    return { content: [{ type: "text", text: "ok" }] };
  };
});

function deps(policyEngine: PolicyEngine, runId = "run-a") {
  return { db, registry, policyEngine, principal: "alice", forwardToUpstream, runId };
}

function isHeld(result: ToolCallResult): boolean {
  return result.isError === true && /approval (required|pending)/i.test(result.content[0]?.text ?? "");
}

describe("flow rules (run_tags-based escalation)", () => {
  it("a small payment with NO prior untrusted read in this run is auto-allowed", async () => {
    const policyEngine = policyWithFlow();
    const result = await handleToolCall(deps(policyEngine), "erp__create_payment", { invoiceId: "X", amountInr: 1000 });
    expect(result.isError).toBeFalsy();
    expect(forwarded).toHaveLength(1);
  });

  it("the SAME small payment, in a run that already read untrusted content, is escalated to approval", async () => {
    const policyEngine = policyWithFlow();
    const d = deps(policyEngine, "run-b");
    const readResult = await handleToolCall(d, "erp__list_pending_invoices", {});
    expect(readResult.isError).toBeFalsy();

    const paymentResult = await handleToolCall(d, "erp__create_payment", { invoiceId: "X", amountInr: 1000 });
    expect(isHeld(paymentResult)).toBe(true); // escalated, even though 1000 <= 50000 would normally auto-allow
    expect(forwarded).toHaveLength(1); // only the read went through; the payment is held
  });

  it("the untrusted read in a DIFFERENT run does not escalate this run's payment — tags are per-run", async () => {
    const policyEngine = policyWithFlow();
    await handleToolCall(deps(policyEngine, "run-x"), "erp__list_pending_invoices", {});
    const paymentResult = await handleToolCall(deps(policyEngine, "run-y"), "erp__create_payment", { invoiceId: "X", amountInr: 1000 });
    expect(paymentResult.isError).toBeFalsy(); // run-y never read anything untrusted
  });

  it("a flow can only tighten, never loosen: a normally-denied call stays denied even without any matching flow", async () => {
    const policyEngine = new PolicyEngine(
      PolicyFileSchema.parse({
        version: "flow-test-2",
        defaults: { unknown_tool: "approve", on_gateway_error: "deny", approval_ttl_seconds: 600 },
        servers: {
          erp: {
            rules: [{ tool: "create_payment", action: "deny" }],
            tags: { create_payment: ["external_send"] },
          },
        },
        flows: [{ name: "noop-flow", if_seen: ["untrusted_read"], then_tag: "external_send", action: "allow" }],
      }),
    );
    // Even if the flow's action were "allow", a flow can never loosen a
    // base "deny" — strictest() always wins deny over allow.
    const result = await handleToolCall(deps(policyEngine), "erp__create_payment", { amountInr: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/denied/i);
  });

  it("a tool with no tags is never affected by any flow", async () => {
    const policyEngine = policyWithFlow();
    registry.register({ serverId: "erp", toolName: "get_account_balance", prefixedName: "erp__get_account_balance", definitionHash: "h3", definition: {} });
    const d = deps(policyEngine, "run-c");
    await handleToolCall(d, "erp__list_pending_invoices", {}); // records untrusted_read
    const result = await handleToolCall(d, "erp__get_account_balance", {}); // untagged, no rule either -> defaults.unknown_tool
    // get_account_balance has no policy rule and no tags, so it falls to
    // defaults.unknown_tool ("approve") regardless of any flow — flows
    // only ever apply to tools that carry a matching then_tag.
    expect(isHeld(result)).toBe(true);
    expect(result.content[0]?.text).not.toMatch(/flow/i);
  });
});
