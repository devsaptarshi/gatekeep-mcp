import { describe, expect, it } from "vitest";
import { reveal, revealDeep } from "../src/web/reveal.js";

describe("reveal", () => {
  it("leaves ordinary text unchanged", () => {
    expect(reveal("Acme Vendor Co, invoice 123")).toBe("Acme Vendor Co, invoice 123");
  });

  it("surfaces a zero-width space", () => {
    expect(reveal("Acme​Co")).toBe("Acme[ZWSP]Co");
  });

  it("surfaces an RTL override — the filename/display-spoofing trick", () => {
    expect(reveal("invoice‮gnp.exe")).toBe("invoice[RLO]gnp.exe");
  });

  it("distinguishes a non-breaking space from a regular one", () => {
    expect(reveal("Acme Co")).toBe("Acme[NBSP]Co");
    expect(reveal("Acme Co")).toBe("Acme Co");
  });

  it("surfaces a null byte and other control characters", () => {
    expect(reveal("abc\u0000def")).toBe("abc[U+0000]def");
  });

  it("keeps ordinary newlines and tabs readable, not escaped", () => {
    expect(reveal("line1\nline2\ttabbed")).toBe("line1\nline2\ttabbed");
  });

  it("handles multiple tricks in the same string", () => {
    expect(reveal("A​‮B C")).toBe("A[ZWSP][RLO]B[NBSP]C");
  });
});

describe("revealDeep", () => {
  it("applies reveal to every string field in a nested object", () => {
    const input = { invoiceId: "INV​-1", meta: { vendor: "Acme Co" }, amountInr: 490000, tags: ["a‮b"] };
    expect(revealDeep(input)).toEqual({
      invoiceId: "INV[ZWSP]-1",
      meta: { vendor: "Acme[NBSP]Co" },
      amountInr: 490000, // non-strings pass through untouched
      tags: ["a[RLO]b"],
    });
  });
});
