#!/usr/bin/env node
// Temporary CLI approver for Week 1. A proper web approval inbox (React +
// Vite, with a "reveal mode" for hidden whitespace/Unicode tricks) is a
// Week 2 item per the build spec — this exists so the end-to-end flow is
// testable before that UI exists.
import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import { approve, deny, findById } from "../db/repositories/approvals.js";
import { approvals } from "../db/schema.js";

const APPROVER_PRINCIPAL = process.env.GATEKEEP_APPROVER ?? "cli-approver";

function usage(): never {
  console.error(
    [
      "Usage:",
      "  gatekeep list                 List pending approvals",
      "  gatekeep show <id>            Show one approval's full (raw, unsummarized) arguments",
      "  gatekeep approve <id>         Approve a pending approval",
      "  gatekeep deny <id>            Deny a pending approval",
    ].join("\n"),
  );
  process.exit(1);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
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
      console.log(JSON.stringify(row, null, 2));
      return;
    }
    case "approve": {
      if (!arg) usage();
      const result = approve(db, arg, APPROVER_PRINCIPAL);
      if (!result) {
        console.error(`Could not approve ${arg} — it may not exist, may already be decided, or may have expired.`);
        process.exit(1);
      }
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
      console.log(`Denied ${arg}.`);
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
