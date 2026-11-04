import { createHash } from "node:crypto";
import { desc } from "drizzle-orm";
import { canonicalize, type JsonValue } from "../hash/canonical-json.js";
import type { GatekeepDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { redact } from "./redact.js";

/** The fixed prev_hash for the very first row in the chain. */
export const GENESIS_HASH = "0".repeat(64);

export interface AppendEventInput {
  runId: string;
  event: string;
  callHash?: string;
  decision?: string;
  payload: JsonValue;
}

export type AuditEventRow = typeof auditEvents.$inferSelect;

function computeEventHash(row: {
  runId: string;
  event: string;
  callHash: string | null;
  decision: string | null;
  prevHash: string;
  redactedPayload: string;
}): string {
  const canonical = canonicalize({
    run_id: row.runId,
    event: row.event,
    call_hash: row.callHash,
    decision: row.decision,
    prev_hash: row.prevHash,
    redacted_payload: row.redactedPayload,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Appends one row to the hash chain. Wrapped in a transaction because
 * "read the current tip, then insert the next link" is a read-modify-write
 * — without a transaction, two processes writing audit events at the same
 * time (e.g. the gateway and a concurrent `gatekeep approve`) could both
 * read the same tip and silently fork the chain.
 */
export function appendEvent(db: GatekeepDb, input: AppendEventInput): AuditEventRow {
  return db.transaction((tx) => {
    const tip = tx.select().from(auditEvents).orderBy(desc(auditEvents.seq)).limit(1).get();
    const prevHash = tip?.eventHash ?? GENESIS_HASH;
    const redactedPayload = JSON.stringify(redact(input.payload));
    const callHash = input.callHash ?? null;
    const decision = input.decision ?? null;
    const eventHash = computeEventHash({ runId: input.runId, event: input.event, callHash, decision, prevHash, redactedPayload });

    const inserted = tx
      .insert(auditEvents)
      .values({
        runId: input.runId,
        event: input.event,
        callHash,
        decision,
        prevHash,
        eventHash,
        redactedPayload,
      })
      .returning()
      .get();
    return inserted;
  });
}

export function listEvents(db: GatekeepDb): AuditEventRow[] {
  return db.select().from(auditEvents).orderBy(auditEvents.seq).all();
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  brokenAtSeq?: number;
  reason?: string;
}

/**
 * Walks the whole chain from the genesis and recomputes every link.
 * Catches: an edited field in any row (its own event_hash no longer
 * matches), a deleted row (the next row's prev_hash no longer matches
 * anything), and a reordered row (same — the prev_hash linkage breaks).
 */
export function verifyChain(db: GatekeepDb): VerifyResult {
  const rows = listEvents(db);
  let expectedPrevHash = GENESIS_HASH;

  for (const row of rows) {
    if (row.prevHash !== expectedPrevHash) {
      return { ok: false, checked: rows.length, brokenAtSeq: row.seq, reason: `prev_hash mismatch at seq=${row.seq}: expected ${expectedPrevHash.slice(0, 12)}…, found ${row.prevHash.slice(0, 12)}…` };
    }
    const recomputed = computeEventHash({
      runId: row.runId,
      event: row.event,
      callHash: row.callHash,
      decision: row.decision,
      prevHash: row.prevHash,
      redactedPayload: row.redactedPayload,
    });
    if (recomputed !== row.eventHash) {
      return { ok: false, checked: rows.length, brokenAtSeq: row.seq, reason: `event_hash mismatch at seq=${row.seq} — this row's stored fields were edited after the fact` };
    }
    expectedPrevHash = row.eventHash;
  }

  return { ok: true, checked: rows.length };
}
