import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalize, type JsonValue } from "../src/hash/canonical-json.js";

// A JSON value arbitrary restricted to what gatekeep actually hashes:
// no NaN/Infinity, no -0 surprises beyond what we explicitly normalize,
// finite depth so the recursive serializer terminates in reasonable time.
const jsonValue: fc.Arbitrary<JsonValue> = fc.letrec<{ value: JsonValue }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e9, max: 1e9 }),
    fc.string(),
    fc.array(tie("value") as fc.Arbitrary<JsonValue>, { maxLength: 5 }),
    fc.dictionary(fc.string(), tie("value") as fc.Arbitrary<JsonValue>, { maxKeys: 5 }),
  ),
})).value;

describe("canonicalize", () => {
  it("is invariant to object key order", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ minLength: 1 }), jsonValue, { maxKeys: 8 }), (obj) => {
        const shuffled = Object.fromEntries(
          [...Object.entries(obj)].sort(() => Math.random() - 0.5),
        );
        expect(canonicalize(shuffled)).toBe(canonicalize(obj));
      }),
    );
  });

  it("produces valid, re-parseable JSON", () => {
    fc.assert(
      fc.property(jsonValue, (v) => {
        expect(() => JSON.parse(canonicalize(v))).not.toThrow();
      }),
    );
  });

  it("is deterministic for the same logical value", () => {
    fc.assert(
      fc.property(jsonValue, (v) => {
        expect(canonicalize(v)).toBe(canonicalize(structuredClone(v)));
      }),
    );
  });

  it("nested key order does not matter either", () => {
    const a = { outer: { b: 1, a: 2 }, z: [1, 2, { y: 1, x: 2 }] };
    const b = { z: [1, 2, { x: 2, y: 1 }], outer: { a: 2, b: 1 } };
    expect(canonicalize(a as JsonValue)).toBe(canonicalize(b as JsonValue));
  });

  it("sorts keys by UTF-16 code unit, not locale order", () => {
    // "B" (0x42) sorts before "a" (0x61) in code-unit order, unlike most
    // locale collations, which would put "a" first.
    expect(canonicalize({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
  });

  it("distinguishes values that differ only in type", () => {
    expect(canonicalize("1")).not.toBe(canonicalize(1 as unknown as JsonValue));
    expect(canonicalize("true")).not.toBe(canonicalize(true));
    expect(canonicalize(null)).not.toBe(canonicalize("null"));
  });

  it("normalizes negative zero to 0", () => {
    expect(canonicalize(-0)).toBe("0");
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize(Number.NaN as unknown as JsonValue)).toThrow();
    expect(() => canonicalize(Number.POSITIVE_INFINITY as unknown as JsonValue)).toThrow();
  });
});
