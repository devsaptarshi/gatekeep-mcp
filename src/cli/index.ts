#!/usr/bin/env node
// Temporary CLI approver for Week 1. A proper web approval inbox (React +
// Vite, with a "reveal mode" for hidden whitespace/Unicode tricks) is a
// Week 2 item per the build spec — this exists so the end-to-end flow is
// testable before that UI exists.
import { appendEvent, verifyChain } from "../audit/log.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { approve, deny, findById } from "../db/repositories/approvals.js";
import { approvals } from "../db/schema.js";
import { revealDeep } from "../web/reveal.js";

const APPROVER_PRINCIPAL = process.env.GATEKEEP_APPROVER ?? "cli-approver";

function usage(): never {
  console.error(
    [
      "Usage:",
      "  gatekeep list                 List pending approvals",
      "  gatekeep show <id> [--reveal] Show one approval's full (raw, unsummarized) arguments",
      "                                 --reveal surfaces zero-width/RTL-override/NBSP tricks",
      "  gatekeep approve <id>         Approve a pending approval",
      "  gatekeep deny <id>            Deny a pending approval",
      "  gatekeep verify                Verify the audit log's hash chain end to end",
    ].join("\n"),
  );
  process.exit(1);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const revealFlagIndex = rawArgs.indexOf("--reveal");
  const revealRequested = revealFlagIndex !== -1;
  if (revealRequested) rawArgs.splice(revealFlagIndex, 1);
  const [cmd, arg] = rawArgs;
  const config = loadConfig(process.env.GATEKEEP_CONFIG_PATH ?? "./gatekeep.config.yaml");
  const db = openDb(config.dbPath);

  switch (cmd) {
    case "list": {
      const rows = db.select().from(approvals).all().filter((r) => r.status === "pending");
      if (rows.length === 0) {
        console.log("No pending approvals.");
        return;
      }
      for (const row of rows) {
        console.log(`${row.id}  ${row.serverId}/${row.toolName}  principal=${row.principal}  expires=${row.expiresAt}`);
        console.log(`  reason: ${row.reason}`);
      }
      return;
    }
    case "show": {
      if (!arg) usage();
      const row = findById(db, arg);
      if (!row) {
        console.error(`No approval with id ${arg}`);
        process.exit(1);
      }
      // Raw, unsummarized — the whole point of exact-call approval is that
      // the approver sees the literal arguments, not a model's gloss on them.
      const display = revealRequested
        ? { ...row, canonicalArgs: JSON.stringify(revealDeep(JSON.parse(row.canonicalArgs))) }
        : row;
      console.log(JSON.stringify(display, null, 2));
      if (!revealRequested) {
        console.log("\n(pass --reveal to surface zero-width/RTL-override/NBSP tricks hidden in the arguments above)");
      }
      return;
    }
    case "approve": {
      if (!arg) usage();
      const result = approve(db, arg, APPROVER_PRINCIPAL);
      if (!result) {
        console.error(`Could not approve ${arg} — it may not exist, may already be decided, or may have expired.`);
        process.exit(1);
      }
      appendEvent(db, {
        runId: "cli",
        event: "approval_approved_by_human",
        callHash: result.callHash,
        decision: "approve",
        payload: { approval_id: arg, decided_by: APPROVER_PRINCIPAL, server_id: result.serverId, tool_name: result.toolName },
      });
      console.log(`Approved ${arg}. The agent can now retry the exact same call.`);
      return;
    }
    case "deny": {
      if (!arg) usage();
      const result = deny(db, arg, APPROVER_PRINCIPAL);
      if (!result) {
        console.error(`Could not deny ${arg} — it may not exist or may already be decided.`);
        process.exit(1);
      }
      appendEvent(db, {
        runId: "cli",
        event: "approval_denied_by_human",
        callHash: result.callHash,
        decision: "deny",
        payload: { approval_id: arg, decided_by: APPROVER_PRINCIPAL, server_id: result.serverId, tool_name: result.toolName },
      });
      console.log(`Denied ${arg}.`);
      return;
    }
    case "verify": {
      const result = verifyChain(db);
      if (result.ok) {
        console.log(`OK — ${result.checked} audit event(s) verified, chain intact from genesis.`);
        return;
      }
      console.error(`FAILED at seq=${result.brokenAtSeq}: ${result.reason}`);
      console.error(`(${result.checked} event(s) checked before the break was found)`);
      process.exit(1);
      return;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error("[gatekeep] fatal:", err);
  process.exit(1);
});
