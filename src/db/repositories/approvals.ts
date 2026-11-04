import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { GatekeepDb } from "../client.js";
import { approvals } from "../schema.js";

export type ApprovalRow = typeof approvals.$inferSelect;

export function findByCallHash(db: GatekeepDb, callHash: string): ApprovalRow | undefined {
  return db.select().from(approvals).where(eq(approvals.callHash, callHash)).get();
}

export function findById(db: GatekeepDb, id: string): ApprovalRow | undefined {
  return db.select().from(approvals).where(eq(approvals.id, id)).get();
}

export interface CreatePendingInput {
  callHash: string;
  serverId: string;
  toolName: string;
  principal: string;
  canonicalArgs: unknown;
  reason: string;
  ttlSeconds: number;
}

export function createPending(db: GatekeepDb, input: CreatePendingInput): ApprovalRow {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
  db.insert(approvals)
    .values({
      id,
      callHash: input.callHash,
      serverId: input.serverId,
      toolName: input.toolName,
      principal: input.principal,
      canonicalArgs: JSON.stringify(input.canonicalArgs),
      reason: input.reason,
      status: "pending",
      expiresAt,
    })
    .run();
  const row = findById(db, id);
  if (!row) throw new Error("failed to read back just-inserted approval row");
  return row;
}

/** Marks a pending, non-expired approval as approved. Returns null if it wasn't pending. */
export function approve(db: GatekeepDb, id: string, decidedBy: string): ApprovalRow | null {
  const now = new Date();
  const existing = findById(db, id);
  if (!existing) return null;
  if (existing.status !== "pending") return null;
  if (new Date(existing.expiresAt) <= now) {
    db.update(approvals).set({ status: "expired" }).where(eq(approvals.id, id)).run();
    return null;
  }
  db.update(approvals)
    .set({ status: "approved", decidedBy })
    .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
    .run();
  return findById(db, id) ?? null;
}

export function deny(db: GatekeepDb, id: string, decidedBy: string): ApprovalRow | null {
  const updated = db
    .update(approvals)
    .set({ status: "denied", decidedBy })
    .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
    .returning()
    .get();
  return updated ?? null;
}

/** Lazily transitions a pending row whose TTL has passed into "expired". No-op otherwise. */
export function expireIfPastDue(db: GatekeepDb, id: string): ApprovalRow | null {
  const row = findById(db, id);
  if (!row) return null;
  if (row.status === "pending" && new Date(row.expiresAt) <= new Date()) {
    db.update(approvals)
      .set({ status: "expired" })
      .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
      .run();
    return findById(db, id) ?? null;
  }
  return row;
}

/**
 * An expired approval is a timeout, not a decision — unlike a denial, it's
 * safe to let an identical retry start a fresh pending approval. Since
 * call_hash is the primary key and a genuine retry hashes identically, we
 * renew the existing row in place rather than trying (and failing) to
 * insert a duplicate.
 */
export function renewExpiredToPending(db: GatekeepDb, id: string, ttlSeconds: number): ApprovalRow | null {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const updated = db
    .update(approvals)
    .set({ status: "pending", decidedBy: null, consumedAt: null, expiresAt })
    .where(and(eq(approvals.id, id), eq(approvals.status, "expired")))
    .returning()
    .get();
  return updated ?? null;
}

/**
 * The single-use consume. One atomic UPDATE, guarded on both `status =
 * 'approved'` and `consumed_at IS NULL` in the WHERE clause, so two
 * concurrent retries of the same call can race this and only one will ever
 * get a row back — the MCP spec's requirement that one-time state be
 * server-enforced, not trusted to the client.
 */
export function consumeApproved(db: GatekeepDb, callHash: string): ApprovalRow | null {
  const now = new Date();
  const row = findByCallHash(db, callHash);
  if (!row) return null;
  if (row.status === "approved" && new Date(row.expiresAt) <= now) {
    db.update(approvals).set({ status: "expired" }).where(eq(approvals.id, row.id)).run();
    return null;
  }
  const consumedAt = now.toISOString();
  const updated = db
    .update(approvals)
    .set({ consumedAt })
    .where(and(eq(approvals.callHash, callHash), eq(approvals.status, "approved"), isNull(approvals.consumedAt)))
    .returning()
    .get();
  return updated ?? null;
}
