// Manual end-to-end smoke test, run once by hand (not part of the vitest
// suite — it spawns real child processes end-to-end: gateway -> fixture).
// Usage: npm run smoke
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT_DIR = fileURLToPath(new URL("..", import.meta.url));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function main() {
  const transport = new StdioClientTransport({
    // Direct binary, not `npx` — see gatekeep.config.yaml's comment on why.
    command: `${PROJECT_DIR}/node_modules/.bin/tsx`,
    args: ["src/proxy/stdio-gateway.ts"],
    cwd: PROJECT_DIR,
  });
  const client = new Client({ name: "smoke-test-client", version: "0.0.1" });
  await client.connect(transport);
  console.log("[smoke] connected to gateway");

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  console.log("[smoke] tools:", names);
  assert(names.length === 6, `expected 6 tools, got ${names.length}`);
  assert(names.includes("erp-fixture__create_payment"), "missing create_payment");
  assert(names.includes("erp-fixture__get_account_balance"), "missing get_account_balance");

  // 1. Read-only call: should pass straight through.
  const balance = await client.callTool({ name: "erp-fixture__get_account_balance", arguments: {} });
  console.log("[smoke] balance call isError:", balance.isError);
  assert(!balance.isError, "read-only balance call should not error");

  // 2. Risky payment: should be held for approval.
  const riskyArgs = { invoiceId: "INV-2026-0093", amountInr: 490000 };
  const held = await client.callTool({ name: "erp-fixture__create_payment", arguments: riskyArgs });
  console.log("[smoke] held result:", JSON.stringify(held));
  assert(held.isError === true, "risky payment should be held (isError=true)");
  const text = (held.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  const match = text.match(/id=([0-9a-f-]+)/i);
  assert(match, `expected an approval id in: ${text}`);
  const approvalId = match![1]!;
  console.log("[smoke] approval id:", approvalId);

  // 3. A DIFFERENT amount must NOT ride that same pending/approved slot.
  const swapped = await client.callTool({
    name: "erp-fixture__create_payment",
    arguments: { invoiceId: "INV-2026-0093", amountInr: 999999999 },
  });
  assert(swapped.isError === true, "swapped-argument call must also be held, separately");
  const swappedText = (swapped.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  assert(!swappedText.includes(approvalId), "swapped call must NOT reuse the original approval id");
  console.log("[smoke] swapped-argument call correctly got its own separate hold");

  // 4. Approve the ORIGINAL call via the CLI (separate process, same DB).
  const approveOutput = execFileSync(`${PROJECT_DIR}/node_modules/.bin/tsx`, ["src/cli/index.ts", "approve", approvalId], {
    cwd: PROJECT_DIR,
    encoding: "utf8",
  });
  console.log("[smoke] CLI approve output:", approveOutput.trim());
  assert(approveOutput.includes("Approved"), "CLI approve should report success");

  // 5. Retry the ORIGINAL exact call: should now go through, exactly once.
  const executed = await client.callTool({ name: "erp-fixture__create_payment", arguments: riskyArgs });
  console.log("[smoke] executed result:", JSON.stringify(executed));
  assert(!executed.isError, "approved call should now execute");

  // 6. A second identical retry must be refused (single-use).
  const replay = await client.callTool({ name: "erp-fixture__create_payment", arguments: riskyArgs });
  console.log("[smoke] replay result:", JSON.stringify(replay));
  assert(replay.isError === true, "replaying an already-consumed approval must fail");

  // 7. update_vendor_bank_details is policy-denied outright, no approval offered.
  const denied = await client.callTool({
    name: "erp-fixture__update_vendor_bank_details",
    arguments: { vendorId: "V-1003", bankAccount: "999", ifsc: "FAKE0001" },
  });
  console.log("[smoke] denied result:", JSON.stringify(denied));
  assert(denied.isError === true, "bank-detail change should be denied by policy");
  const deniedText = (denied.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  assert(deniedText.toLowerCase().includes("denied"), "denial message should say denied");

  await client.close();

  // 8. The audit log should verify clean after everything above...
  const verifyOk = execFileSync(`${PROJECT_DIR}/node_modules/.bin/tsx`, ["src/cli/index.ts", "verify"], { cwd: PROJECT_DIR, encoding: "utf8" });
  console.log("[smoke] verify (before tamper):", verifyOk.trim());
  assert(verifyOk.includes("OK"), "audit chain should verify clean before tampering");

  // ...and must FAIL once a row is edited directly in the SQLite file,
  // proving the suite can actually catch something (not vacuously green).
  const Database = (await import("better-sqlite3")).default;
  const raw = new Database(`${PROJECT_DIR}/data/gatekeep.sqlite`);
  raw.exec(`UPDATE audit_events SET redacted_payload = '{"tampered":true}' WHERE seq = (SELECT MIN(seq) FROM audit_events)`);
  raw.close();

  let verifyFailed = false;
  try {
    execFileSync(`${PROJECT_DIR}/node_modules/.bin/tsx`, ["src/cli/index.ts", "verify"], { cwd: PROJECT_DIR, encoding: "utf8" });
  } catch (err) {
    verifyFailed = true;
    const output = (err as { stdout?: Buffer; stderr?: Buffer }).stderr?.toString() ?? "";
    console.log("[smoke] verify (after tamper):", output.trim());
    assert(output.includes("FAILED"), "verify should report FAILED after tampering");
  }
  assert(verifyFailed, "gatekeep verify must exit non-zero after the audit log is tampered with");

  console.log("\n[smoke] ALL CHECKS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
