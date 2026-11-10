import { and, eq, inArray } from "drizzle-orm";
import type { GatekeepDb } from "../client.js";
import { runTags } from "../schema.js";

export function recordTags(db: GatekeepDb, runId: string, sourceTool: string, tags: string[]): void {
  if (tags.length === 0) return;
  db.insert(runTags)
    .values(tags.map((tag) => ({ runId, tag, sourceTool })))
    .run();
}

/** Has this run already recorded any of these tags? */
export function hasSeenAnyTag(db: GatekeepDb, runId: string, tags: string[]): boolean {
  if (tags.length === 0) return false;
  const row = db
    .select({ id: runTags.id })
    .from(runTags)
    .where(and(eq(runTags.runId, runId), inArray(runTags.tag, tags)))
    .limit(1)
    .get();
  return row !== undefined;
}
