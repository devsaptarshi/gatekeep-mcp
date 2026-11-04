import { beforeEach, describe, expect, it } from "vitest";
import { appendEvent, GENESIS_HASH, listEvents, verifyChain } from "../src/audit/log.js";
import { openDb, type GatekeepDb } from "../src/db/client.js";

let db: GatekeepDb;

beforeEach(() => {
  db = openDb(":memory:");
});

describe("audit log hash chain", () => {
  it("the first row chains from the genesis hash", () => {
    const row = appendEvent(db, { runId: "run-1", event: "policy_decision", decision: "allow", payload: { tool: "x" } });
    expect(row.prevHash).toBe(GENESIS_HASH);
  });

  it("each row's prev_hash equals the previous row's event_hash", () => {
    const a = appendEvent(db, { runId: "run-1", event: "a", payload: {} });
    const b = appendEvent(db, { runId: "run-1", event: "b", payload: {} });
    expect(b.prevHash).toBe(a.eventHash);
  });

  it("verifyChain passes on an untouched log", () => {
    for (let i = 0; i < 10; i++) appendEvent(db, { runId: "run-1", event: `event-${i}`, payload: { i } });
    const result = verifyChain(db);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(10);
  });

  it("verifyChain passes on an empty log", () => {
    expect(verifyChain(db).ok).toBe(true);
  });

  it("[mutation check] editing a middle row's payload breaks verification from that point on", () => {
    for (let i = 0; i < 5; i++) appendEvent(db, { runId: "run-1", event: `event-${i}`, payload: { i } });
    const rows = listEvents(db);
    const target = rows[2]!;

    // Simulate tampering: directly rewrite a row's content without
    // recomputing the hash chain, exactly what an attacker editing the
    // SQLite file would do.
    db.run(`UPDATE audit_events SET redacted_payload = '{"i":"tampered"}' WHERE seq = ${target.seq}`);

    const result = verifyChain(db);
    expect(result.ok).toBe(false);
    expect(result.brokenAtSeq).toBe(target.seq);
  });

  it("[mutation check] deleting a row breaks the chain at the next surviving row", () => {
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(appendEvent(db, { runId: "run-1", event: `event-${i}`, payload: { i } }));
    db.run(`DELETE FROM audit_events WHERE seq = ${rows[2]!.seq}`);

    const result = verifyChain(db);
    expect(result.ok).toBe(false);
    expect(result.brokenAtSeq).toBe(rows[3]!.seq);
  });

  it("redacts secret-shaped values before they are ever written to disk", () => {
    const row = appendEvent(db, {
      runId: "run-1",
      event: "tool_call",
      payload: { note: "Bearer abcdef123456.secrettoken", apiKey: "sk_live_abcdefghijklmno1234567890" },
    });
    expect(row.redactedPayload).not.toContain("secrettoken");
    expect(row.redactedPayload).not.toContain("sk_live_abcdefghijklmno1234567890");
    expect(row.redactedPayload).toContain("REDACTED");
  });

  it("concurrent appends never fork the chain (sequential transactions still link correctly)", () => {
    const results = Array.from({ length: 20 }, (_, i) => appendEvent(db, { runId: "run-1", event: `e${i}`, payload: { i } }));
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.prevHash).toBe(results[i - 1]!.eventHash);
    }
    expect(verifyChain(db).ok).toBe(true);
  });
});
