import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type GatekeepDb } from "../src/db/client.js";
import { approve, deny } from "../src/db/repositories/approvals.js";
import { handleToolCall, type ForwardFn, type ToolCallResult } from "../src/proxy/call-handler.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { PolicyFileSchema } from "../src/policy/types.js";
import { ToolRegistry } from "../src/proxy/tool-registry.js";

let db: GatekeepDb;
let registry: ToolRegistry;
let policyEngine: PolicyEngine;
let forwardToUpstream: ForwardFn;
let forwardCalls: Array<{ serverId: string; toolName: string; args: Record<string, unknown> }>;

const OK: ToolCallResult = { content: [{ type: "text", text: "ok" }] };

function approvalIdFrom(result: ToolCallResult): string {
  const text = result.content[0]?.text ?? "";
  const match = text.match(/id=([0-9a-f-]+)/i);
  if (!match) throw new Error(`no approval id in: ${text}`);
  return match[1]!;
}

beforeEach(async () => {
  db = openDb(":memory:");
  registry = new ToolRegistry();
  registry.register({
    serverId: "erp",
    toolName: "create_payment",
    prefixedName: "erp__create_payment",
    definitionHash: "def-hash-create-payment",
    definition: { name: "create_payment" },
  });

  policyEngine = new PolicyEngine(
    PolicyFileSchema.parse({
      version: "test",
      defaults: { unknown_tool: "approve", on_gateway_error: "deny", approval_ttl_seconds: 600 },
      servers: {
        erp: {
          rules: [
            { tool: "create_payment", action: "approve", when: "arguments.amountInr > 50000" },
            { tool: "create_payment", action: "allow", when: "arguments.amountInr <= 50000" },
          ],
        },
      },
    }),
  );

  forwardCalls = [];
  forwardToUpstream = vi.fn(async (serverId: string, toolName: string, args: Record<string, unknown>) => {
    forwardCalls.push({ serverId, toolName, args });
    return OK;
  });
});

function deps() {
  return { db, registry, policyEngine, principal: "alice", forwardToUpstream };
}

describe("handleToolCall", () => {
  it("rejects an unknown (unregistered) tool without touching policy or DB", async () => {
    const result = await handleToolCall(deps(), "erp__nonexistent_tool", {});
    expect(result.isError).toBe(true);
    expect(forwardCalls).toHaveLength(0);
  });

  it("a risky call with no existing row creates a pending approval and does not forward", async () => {
    const result = await handleToolCall(deps(), "erp__create_payment", { invoiceId: "X", amountInr: 490000 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/approval required/i);
    expect(forwardCalls).toHaveLength(0);
  });

  it("retrying the identical call while still pending reports the same approval id, without creating a duplicate row", async () => {
    const first = await handleToolCall(deps(), "erp__create_payment", { invoiceId: "X", amountInr: 490000 });
    const id1 = approvalIdFrom(first);
    const second = await handleToolCall(deps(), "erp__create_payment", { invoiceId: "X", amountInr: 490000 });
    const id2 = approvalIdFrom(second);
    expect(id2).toBe(id1);
  });

  it("[core security property] approving one exact call does not authorize a retry with different arguments", async () => {
    // 1. Agent requests a risky payment; it waits for approval.
    const original = await handleToolCall(deps(), "erp__create_payment", { invoiceId: "INV-1", amountInr: 490000 });
    const originalId = approvalIdFrom(original);

    // 2. A human approves that exact call.
    const approved = approve(db, originalId, "approver-bob");
    expect(approved?.status).toBe("approved");

    // 3. The agent (or an attacker swapping arguments after approval but
    //    before the retry reaches the upstream) retries with a DIFFERENT
    //    amount. This must NOT ride the existing approval.
    const swapped = await handleToolCall(deps(), "erp__create_payment", { invoiceId: "INV-1", amountInr: 9999999 });
    expect(swapped.isError).toBe(true);
    expect(forwardCalls).toHaveLength(0); // nothing forwarded for the swapped call
    expect(swapped.content[0]?.text).toMatch(/approval required/i); // it needs its OWN fresh approval

    // 4. Retrying with the ORIGINAL, approved arguments succeeds exactly once...
    const retryOriginal = await handleToolCall(deps(), "erp__create_payment", { invoiceId: "INV-1", amountInr: 490000 });
    expect(retryOriginal.isError).toBeFalsy();
    expect(forwardCalls).toHaveLength(1);
    expect(forwardCalls[0]?.args).toEqual({ invoiceId: "INV-1", amountInr: 490000 });

    // 5. ...and a second retry of the original call is blocked — single-use.
    const retryAgain = await handleToolCall(deps(), "erp__create_payment", { invoiceId: "INV-1", amountInr: 490000 });
    expect(retryAgain.isError).toBe(true);
    expect(retryAgain.content[0]?.text).toMatch(/single-use/i);
    expect(forwardCalls).toHaveLength(1); // still just the one successful forward
  });

  it("forwards the gateway's own stored canonical_args, not a fresh copy of the retry's arguments", async () => {
    const args = { invoiceId: "INV-2", amountInr: 490000 };
    const original = await handleToolCall(deps(), "erp__create_payment", args);
    const id = approvalIdFrom(original);
    approve(db, id, "approver-bob");

    // Retry with a structurally-identical but distinct object reference.
    await handleToolCall(deps(), "erp__create_payment", { invoiceId: "INV-2", amountInr: 490000 });
    expect(forwardCalls[0]?.args).toEqual(args);
  });

  it("a denied call stays denied on retry and is never forwarded", async () => {
    const original = await handleToolCall(deps(), "erp__create_payment", { invoiceId: "INV-3", amountInr: 490000 });
    const id = approvalIdFrom(original);
    deny(db, id, "approver-bob");

    const retry = await handleToolCall(deps(), "erp__create_payment", { invoiceId: "INV-3", amountInr: 490000 });
    expect(retry.isError).toBe(true);
    expect(retry.content[0]?.text).toMatch(/denied/i);
    expect(forwardCalls).toHaveLength(0);
  });

  it("a low-risk call matching an allow rule forwards immediately with no approval step", async () => {
    const result = await handleToolCall(deps(), "erp__create_payment", { invoiceId: "INV-4", amountInr: 10 });
    expect(result.isError).toBeFalsy();
    expect(forwardCalls).toHaveLength(1);
  });

  it("denied-by-policy (no matching allow/approve rule under strict deny-by-default server) never forwards", async () => {
    policyEngine = new PolicyEngine(
      PolicyFileSchema.parse({
        version: "test",
        defaults: { unknown_tool: "deny", on_gateway_error: "deny", approval_ttl_seconds: 600 },
        servers: { erp: { rules: [] } },
      }),
    );
    const result = await handleToolCall(deps(), "erp__create_payment", { invoiceId: "INV-5", amountInr: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/denied by policy/i);
    expect(forwardCalls).toHaveLength(0);
  });
});
