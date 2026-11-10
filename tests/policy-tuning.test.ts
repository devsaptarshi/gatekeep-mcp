// A "policy tuning" pass against the REAL shipped policy file
// (policies/default.yaml), not a hand-rolled test policy — this catches
// drift between the fixture's actual tool names and what the policy file
// covers (e.g. a typo'd tool name silently falling through to
// defaults.unknown_tool) and measures the false-positive rate the build
// spec asks for ("<2% benign calls wrongly blocked").
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type GatekeepDb } from "../src/db/client.js";
import { handleToolCall, type ForwardFn, type ToolCallResult } from "../src/proxy/call-handler.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { ToolRegistry } from "../src/proxy/tool-registry.js";

// Must match fixtures/erp-server/index.ts's registered tool names exactly
// — if that fixture changes its tool list, this must be updated alongside
// it, and the coverage test below will fail loudly if someone forgets.
const FIXTURE_TOOL_NAMES = [
  "list_vendors",
  "get_vendor",
  "list_pending_invoices",
  "get_account_balance",
  "create_payment",
  "update_vendor_bank_details",
] as const;

let db: GatekeepDb;
let registry: ToolRegistry;
let policyEngine: PolicyEngine;
let forwarded: number;
let forwardToUpstream: ForwardFn;

beforeEach(() => {
  db = openDb(":memory:");
  policyEngine = PolicyEngine.fromFile(new URL("../policies/default.yaml", import.meta.url).pathname);
  registry = new ToolRegistry();
  for (const toolName of FIXTURE_TOOL_NAMES) {
    registry.register({ serverId: "erp-fixture", toolName, prefixedName: `erp-fixture__${toolName}`, definitionHash: `h-${toolName}`, definition: {} });
  }
  forwarded = 0;
  forwardToUpstream = async () => {
    forwarded++;
    return { content: [{ type: "text", text: "ok" }] };
  };
});

function deps(runId = "tuning") {
  return { db, registry, policyEngine, principal: "alice", forwardToUpstream, runId };
}

function isHeldOrDenied(result: ToolCallResult): boolean {
  return result.isError === true;
}

describe("policy coverage — every real fixture tool has an explicit stance", () => {
  it.each(FIXTURE_TOOL_NAMES)('"%s" is named by at least one rule in the shipped policy (not silently left to defaults.unknown_tool)', (toolName) => {
    // Glob-match against the raw rules directly, not decide(): some rules
    // gate on `when` over specific arguments (create_payment's amount),
    // so calling decide() with no arguments wouldn't prove the TOOL is
    // covered, only that this particular empty call happens not to match
    // — a false "gap" that isn't really one. This checks what the
    // red-team "unknown_tool" case actually guards against: a typo'd or
    // forgotten tool name in the policy file.
    const rules = policyEngine.file.servers["erp-fixture"]?.rules ?? [];
    const matches = rules.some((rule) => new RegExp(`^${rule.tool.replace(/\*/g, ".*")}$`).test(toolName));
    expect(matches).toBe(true);
  });
});

describe("benign workflow false-positive rate against the real policy file", () => {
  // A realistic spread: varied vendor/invoice ids, amounts walking the
  // 50,000 threshold boundary from well below it, repeated read-only
  // lookups, and the same shapes the fixture's own seed data uses.
  const benignReadCalls = [
    { toolName: "list_vendors", args: {} },
    { toolName: "list_vendors", args: {} },
    { toolName: "list_pending_invoices", args: {} },
    { toolName: "get_account_balance", args: {} },
    ...["V-1001", "V-1002", "V-1003", "V-9999"].map((vendorId) => ({ toolName: "get_vendor", args: { vendorId } })),
  ];

  // amountInr strictly <= 50000 must always auto-allow per the policy's
  // own stated rule — this is the boundary most likely to regress.
  const benignPayments = [100, 999, 12345, 49999, 50000, 1, 50000.0].map((amountInr, i) => ({
    toolName: "create_payment",
    args: { invoiceId: `BENIGN-${i}`, amountInr },
  }));

  const allBenignCalls = [...benignReadCalls, ...benignPayments];

  it.each(allBenignCalls.map((c, i) => [i, c.toolName, c.args] as const))(
    "benign call #%i (%s) is never held or denied",
    async (_i, toolName, args) => {
      const result = await handleToolCall(deps(), `erp-fixture__${toolName}`, args);
      expect(isHeldOrDenied(result)).toBe(false);
    },
  );

  it("[summary] measures the false-positive rate across the whole benign batch and asserts it meets the spec target (<2%)", async () => {
    // Each call gets its OWN run_id: this measures each benign call in
    // isolation, not "a benign payment that happens to follow an
    // untrusted read in the same run" — that specific combination is
    // deliberately NOT benign (see policies/default.yaml's flow rule and
    // tests/flow-rules.test.ts), so mixing it in here would conflate a
    // working defense-in-depth control with an actual false positive.
    let wronglyBlocked = 0;
    for (let i = 0; i < allBenignCalls.length; i++) {
      const call = allBenignCalls[i]!;
      const result = await handleToolCall(deps(`tuning-summary-${i}`), `erp-fixture__${call.toolName}`, call.args);
      if (isHeldOrDenied(result)) wronglyBlocked++;
    }
    const rate = wronglyBlocked / allBenignCalls.length;
    expect(rate).toBeLessThan(0.02);
    expect(wronglyBlocked).toBe(0); // in a deterministic policy engine, the bar is actually zero, not just "under 2%"
  });
});

describe("boundary behavior around the amount threshold is exactly where the policy says it is", () => {
  it("50000 (inclusive) is allowed", async () => {
    const result = await handleToolCall(deps(), "erp-fixture__create_payment", { invoiceId: "B1", amountInr: 50000 });
    expect(result.isError).toBeFalsy();
    expect(forwarded).toBe(1);
  });
  it("50000.01 requires approval", async () => {
    const result = await handleToolCall(deps(), "erp-fixture__create_payment", { invoiceId: "B2", amountInr: 50000.01 });
    expect(result.isError).toBe(true);
  });
});
