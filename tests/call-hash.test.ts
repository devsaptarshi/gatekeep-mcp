import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeCallHash, type CallIdentity } from "../src/hash/call-hash.js";

const baseIdentity: CallIdentity = {
  serverId: "erp-fixture",
  toolName: "create_payment",
  arguments: { invoiceId: "INV-2026-0093", amountInr: 490000 },
  toolDefinitionHash: "def-hash-abc",
  principal: "user:alice",
  policyVersion: "v3",
};

const identityArb: fc.Arbitrary<CallIdentity> = fc.record({
  serverId: fc.string({ minLength: 1, maxLength: 20 }),
  toolName: fc.string({ minLength: 1, maxLength: 20 }),
  arguments: fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
  )),
  toolDefinitionHash: fc.hexaString({ minLength: 8, maxLength: 64 }),
  principal: fc.string({ minLength: 1, maxLength: 20 }),
  policyVersion: fc.string({ minLength: 1, maxLength: 10 }),
});

describe("computeCallHash", () => {
  it("is a 64-char lowercase hex SHA-256 digest", () => {
    const hash = computeCallHash(baseIdentity);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is invariant to argument key reordering (via canonicalization)", () => {
    const reordered: CallIdentity = {
      ...baseIdentity,
      arguments: { amountInr: 490000, invoiceId: "INV-2026-0093" },
    };
    expect(computeCallHash(reordered)).toBe(computeCallHash(baseIdentity));
  });

  it("changes when the amount argument changes", () => {
    const tampered: CallIdentity = {
      ...baseIdentity,
      arguments: { invoiceId: "INV-2026-0093", amountInr: 4900000 },
    };
    expect(computeCallHash(tampered)).not.toBe(computeCallHash(baseIdentity));
  });

  it("changes when tool_definition_hash changes (rug-pull detection)", () => {
    const changed: CallIdentity = { ...baseIdentity, toolDefinitionHash: "def-hash-xyz" };
    expect(computeCallHash(changed)).not.toBe(computeCallHash(baseIdentity));
  });

  it("changes when policy_version changes (policy-tightening invalidation)", () => {
    const changed: CallIdentity = { ...baseIdentity, policyVersion: "v4" };
    expect(computeCallHash(changed)).not.toBe(computeCallHash(baseIdentity));
  });

  it("changes when the principal changes", () => {
    const changed: CallIdentity = { ...baseIdentity, principal: "user:mallory" };
    expect(computeCallHash(changed)).not.toBe(computeCallHash(baseIdentity));
  });

  it("changes when the tool name changes, even with identical arguments", () => {
    const changed: CallIdentity = { ...baseIdentity, toolName: "create_refund" };
    expect(computeCallHash(changed)).not.toBe(computeCallHash(baseIdentity));
  });

  it("[property] mutating exactly one scalar field changes the hash", () => {
    fc.assert(
      fc.property(
        identityArb,
        fc.constantFrom<keyof CallIdentity>(
          "serverId",
          "toolName",
          "toolDefinitionHash",
          "principal",
          "policyVersion",
        ),
        fc.string({ minLength: 1, maxLength: 20 }),
        (identity, field, replacement) => {
          fc.pre(identity[field] !== replacement);
          const mutated: CallIdentity = { ...identity, [field]: replacement };
          expect(computeCallHash(mutated)).not.toBe(computeCallHash(identity));
        },
      ),
    );
  });

  it("[property] identical identities always hash identically", () => {
    fc.assert(
      fc.property(identityArb, (identity) => {
        expect(computeCallHash(identity)).toBe(computeCallHash(structuredClone(identity)));
      }),
    );
  });
});
