import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type GatekeepDb } from "../src/db/client.js";
import { hasSeenAnyTag, recordTags } from "../src/db/repositories/run-tags.js";

let db: GatekeepDb;

beforeEach(() => {
  db = openDb(":memory:");
});

describe("run_tags repository", () => {
  it("hasSeenAnyTag is false before anything is recorded", () => {
    expect(hasSeenAnyTag(db, "run-1", ["untrusted_read"])).toBe(false);
  });

  it("recordTags then hasSeenAnyTag finds it", () => {
    recordTags(db, "run-1", "list_pending_invoices", ["untrusted_read"]);
    expect(hasSeenAnyTag(db, "run-1", ["untrusted_read"])).toBe(true);
  });

  it("recordTags with an empty tag list is a no-op", () => {
    recordTags(db, "run-1", "get_account_balance", []);
    expect(hasSeenAnyTag(db, "run-1", ["untrusted_read"])).toBe(false);
  });

  it("tags are scoped to their own run_id — no bleed across runs", () => {
    recordTags(db, "run-1", "list_pending_invoices", ["untrusted_read"]);
    expect(hasSeenAnyTag(db, "run-2", ["untrusted_read"])).toBe(false);
  });

  it("hasSeenAnyTag matches if ANY of the queried tags was seen", () => {
    recordTags(db, "run-1", "list_pending_invoices", ["untrusted_read"]);
    expect(hasSeenAnyTag(db, "run-1", ["something_else", "untrusted_read"])).toBe(true);
  });

  it("a tool can carry several tags at once", () => {
    recordTags(db, "run-1", "weird_tool", ["untrusted_read", "pii"]);
    expect(hasSeenAnyTag(db, "run-1", ["pii"])).toBe(true);
    expect(hasSeenAnyTag(db, "run-1", ["untrusted_read"])).toBe(true);
  });
});
