import { describe, expect, it } from "vitest";
import { checkHeaderBodyConsistency, checkLocalToken, checkOrigin } from "../src/proxy/http-security.js";

describe("checkOrigin (anti DNS-rebinding)", () => {
  const allowed = ["http://127.0.0.1:3100", "http://localhost:3100"];

  it("allows requests with no Origin header (non-browser clients)", () => {
    expect(checkOrigin(undefined, allowed).ok).toBe(true);
    expect(checkOrigin(null, allowed).ok).toBe(true);
    expect(checkOrigin("", allowed).ok).toBe(true);
  });

  it("allows an Origin on the allowlist", () => {
    expect(checkOrigin("http://127.0.0.1:3100", allowed).ok).toBe(true);
  });

  it("rejects an Origin not on the allowlist — the DNS-rebinding case", () => {
    const result = checkOrigin("http://attacker.example", allowed);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not in the allowed list/);
  });

  it("rejects a localhost-looking but differently-ported Origin", () => {
    expect(checkOrigin("http://127.0.0.1:9999", allowed).ok).toBe(false);
  });
});

describe("checkLocalToken", () => {
  const token = "super-secret-local-token-value";

  it("accepts the correct Bearer token", () => {
    expect(checkLocalToken(`Bearer ${token}`, token).ok).toBe(true);
  });

  it("rejects a missing Authorization header", () => {
    expect(checkLocalToken(undefined, token).ok).toBe(false);
    expect(checkLocalToken(null, token).ok).toBe(false);
  });

  it("rejects a malformed Authorization header", () => {
    expect(checkLocalToken(token, token).ok).toBe(false); // missing "Bearer " prefix
    expect(checkLocalToken(`Basic ${token}`, token).ok).toBe(false);
  });

  it("rejects a wrong token, including one that's a prefix/suffix of the right one", () => {
    expect(checkLocalToken(`Bearer ${token}x`, token).ok).toBe(false);
    expect(checkLocalToken(`Bearer ${token.slice(0, -1)}`, token).ok).toBe(false);
    expect(checkLocalToken(`Bearer wrong-token`, token).ok).toBe(false);
  });
});

describe("checkHeaderBodyConsistency", () => {
  it("passes when headers and body agree", () => {
    const result = checkHeaderBodyConsistency({
      mcpMethodHeader: "tools/call",
      mcpNameHeader: "erp__create_payment",
      bodyMethod: "tools/call",
      bodyToolName: "erp__create_payment",
    });
    expect(result.ok).toBe(true);
  });

  it("passes when headers are absent entirely (not every client sends them)", () => {
    const result = checkHeaderBodyConsistency({
      mcpMethodHeader: undefined,
      mcpNameHeader: undefined,
      bodyMethod: "tools/call",
      bodyToolName: "erp__create_payment",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a method header that disagrees with the body", () => {
    const result = checkHeaderBodyConsistency({
      mcpMethodHeader: "tools/list",
      mcpNameHeader: undefined,
      bodyMethod: "tools/call",
      bodyToolName: "erp__create_payment",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not match body method/);
  });

  it("rejects a name header that disagrees with the body's tool name — the smuggling case", () => {
    // A client claiming (via header, for logging/routing) that it's
    // calling a benign tool while the body actually calls a risky one.
    const result = checkHeaderBodyConsistency({
      mcpMethodHeader: "tools/call",
      mcpNameHeader: "erp__get_account_balance",
      bodyMethod: "tools/call",
      bodyToolName: "erp__create_payment",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not match body params.name/);
  });
});
