import { and, eq } from "drizzle-orm";
import type { GatekeepDb } from "../client.js";
import { toolPins } from "../schema.js";

export type PinCheckResult =
  | { kind: "new" }
  | { kind: "match" }
  | { kind: "changed"; previousHash: string };

/**
 * Called once per tool on every gateway startup (after fetching tools/list
 * from each upstream). First sight pins the definition. A later sight with
 * a different hash is a rug pull: it is reported, never silently accepted
 * or auto-repinned — a human has to look and re-pin deliberately.
 */
export function checkAndRecordPin(db: GatekeepDb, serverId: string, toolName: string, definitionHash: string): PinCheckResult {
  const existing = db
    .select()
    .from(toolPins)
    .where(and(eq(toolPins.serverId, serverId), eq(toolPins.toolName, toolName)))
    .get();

  if (!existing) {
    db.insert(toolPins).values({ serverId, toolName, definitionHash, status: "pinned" }).run();
    return { kind: "new" };
  }

  if (existing.definitionHash === definitionHash) {
    if (existing.status === "changed") {
      // Same definition as last time we saw it, but it had previously been
      // flagged changed and not yet re-pinned — still surface it.
      return { kind: "changed", previousHash: existing.definitionHash };
    }
    return { kind: "match" };
  }

  db.update(toolPins).set({ status: "changed" }).where(eq(toolPins.id, existing.id)).run();
  return { kind: "changed", previousHash: existing.definitionHash };
}

/** Explicit human action: accept the new definition as the pinned one. */
export function repin(db: GatekeepDb, serverId: string, toolName: string, definitionHash: string): void {
  db.update(toolPins)
    .set({ definitionHash, status: "pinned" })
    .where(and(eq(toolPins.serverId, serverId), eq(toolPins.toolName, toolName)))
    .run();
}
