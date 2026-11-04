import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type GatekeepDb } from "../src/db/client.js";
import { approve, consumeApproved, createPending, deny, findByCallHash } from "../src/db/repositories/approvals.js";
import { checkAndRecordPin } from "../src/db/repositories/tool-pins.js";

let db: GatekeepDb;

beforeEach(() => {
  db = openDb(":memory:");
});

describe("approvals repository", () => {
  it("creates a pending approval and finds it by call_hash", () => {
    const row = createPending(db, {
      callHash: "hash-1",
      serverId: "erp",
      toolName: "create_payment",
      principal: "alice",
      canonicalArgs: { amountInr: 490000 },
      reason: "test",
      ttlSeconds: 600,
    });
    expect(row.status).toBe("pending");
    expect(findByCallHash(db, "hash-1")?.id).toBe(row.id);
  });

  it("approve() then consumeApproved() returns the row exactly once", () => {
    const row = createPending(db, {
      callHash: "hash-2",
      serverId: "erp",
      toolName: "create_payment",
      principal: "alice",
      canonicalArgs: { amountInr: 1 },
      reason: "test",
      ttlSeconds: 600,
    });
    const approved = approve(db, row.id, "approver-bob");
    expect(approved?.status).toBe("approved");
    expect(approved?.decidedBy).toBe("approver-bob");

    const consumedOnce = consumeApproved(db, "hash-2");
    expect(consumedOnce?.consumedAt).toBeTruthy();

    // single-use: a second consume attempt must find nothing
    const consumedTwice = consumeApproved(db, "hash-2");
    expect(consumedTwice).toBeNull();
  });

  it("consumeApproved() returns null for a merely-pending (not yet approved) call", () => {
    createPending(db, {
      callHash: "hash-3",
      serverId: "erp",
      toolName: "create_payment",
      principal: "alice",
      canonicalArgs: {},
      reason: "test",
      ttlSeconds: 600,
    });
    expect(consumeApproved(db, "hash-3")).toBeNull();
  });

  it("deny() marks denied and blocks a later approve()", () => {
    const row = createPending(db, {
      callHash: "hash-4",
      serverId: "erp",
      toolName: "create_payment",
      principal: "alice",
      canonicalArgs: {},
      reason: "test",
      ttlSeconds: 600,
    });
    const denied = deny(db, row.id, "approver-bob");
    expect(denied?.status).toBe("denied");
    // already decided — approve() must not flip a denied row to approved
    expect(approve(db, row.id, "approver-bob")).toBeNull();
  });

  it("approve() expires a row past its TTL instead of approving it", () => {
    const row = createPending(db, {
      callHash: "hash-5",
      serverId: "erp",
      toolName: "create_payment",
      principal: "alice",
      canonicalArgs: {},
      reason: "test",
      ttlSeconds: -1, // already expired
    });
    expect(approve(db, row.id, "approver-bob")).toBeNull();
    expect(findByCallHash(db, "hash-5")?.status).toBe("expired");
  });

  it("[concurrency] only one of two racing consumeApproved() calls wins", () => {
    const row = createPending(db, {
      callHash: "hash-6",
      serverId: "erp",
      toolName: "create_payment",
      principal: "alice",
      canonicalArgs: {},
      reason: "test",
      ttlSeconds: 600,
    });
    approve(db, row.id, "approver-bob");
    const results = [consumeApproved(db, "hash-6"), consumeApproved(db, "hash-6"), consumeApproved(db, "hash-6")];
    const wins = results.filter((r) => r !== null);
    expect(wins.length).toBe(1);
  });
});

describe("tool_pins repository", () => {
  it("pins a tool on first sight", () => {
    const result = checkAndRecordPin(db, "erp", "create_payment", "hash-a");
    expect(result.kind).toBe("new");
  });

  it("reports a match when the definition hash is unchanged", () => {
    checkAndRecordPin(db, "erp", "create_payment", "hash-a");
    const result = checkAndRecordPin(db, "erp", "create_payment", "hash-a");
    expect(result.kind).toBe("match");
  });

  it("detects a rug pull: same tool, changed definition hash", () => {
    checkAndRecordPin(db, "erp", "create_payment", "hash-a");
    const result = checkAndRecordPin(db, "erp", "create_payment", "hash-b");
    expect(result.kind).toBe("changed");
    if (result.kind === "changed") expect(result.previousHash).toBe("hash-a");
  });

  it("keeps reporting changed on every subsequent sight until explicitly re-pinned", () => {
    checkAndRecordPin(db, "erp", "create_payment", "hash-a");
    checkAndRecordPin(db, "erp", "create_payment", "hash-b");
    const result = checkAndRecordPin(db, "erp", "create_payment", "hash-b");
    expect(result.kind).toBe("changed");
  });
});
