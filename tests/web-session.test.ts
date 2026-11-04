import { describe, expect, it } from "vitest";
import { extractSessionCookie, SessionStore, validateApproverToken, validateCsrf, SESSION_COOKIE_NAME } from "../src/web/session.js";

describe("extractSessionCookie", () => {
  it("extracts the session cookie from a Cookie header with several cookies", () => {
    const header = `foo=bar; ${SESSION_COOKIE_NAME}=abc123; baz=qux`;
    expect(extractSessionCookie(header)).toBe("abc123");
  });
  it("returns undefined when the cookie is absent", () => {
    expect(extractSessionCookie("foo=bar")).toBeUndefined();
    expect(extractSessionCookie(undefined)).toBeUndefined();
    expect(extractSessionCookie(null)).toBeUndefined();
  });
});

describe("validateApproverToken", () => {
  it("accepts the correct token and rejects everything else", () => {
    expect(validateApproverToken("correct", "correct")).toBe(true);
    expect(validateApproverToken("wrong", "correct")).toBe(false);
    expect(validateApproverToken(undefined, "correct")).toBe(false);
    expect(validateApproverToken(null, "correct")).toBe(false);
  });
});

describe("SessionStore", () => {
  it("creates a session that can be fetched back by id", () => {
    const store = new SessionStore();
    const session = store.create("web-approver");
    expect(store.get(session.id)?.id).toBe(session.id);
  });

  it("each session gets a distinct id and csrf token", () => {
    const store = new SessionStore();
    const a = store.create("web-approver");
    const b = store.create("web-approver");
    expect(a.id).not.toBe(b.id);
    expect(a.csrfToken).not.toBe(b.csrfToken);
  });

  it("returns undefined for an unknown session id", () => {
    const store = new SessionStore();
    expect(store.get("does-not-exist")).toBeUndefined();
    expect(store.get(undefined)).toBeUndefined();
  });

  it("destroy() invalidates a session immediately", () => {
    const store = new SessionStore();
    const session = store.create("web-approver");
    store.destroy(session.id);
    expect(store.get(session.id)).toBeUndefined();
  });

  it("a session past its expiry is treated as gone", () => {
    const store = new SessionStore();
    const session = store.create("web-approver");
    session.expiresAt = Date.now() - 1000; // simulate time passing
    expect(store.get(session.id)).toBeUndefined();
  });
});

describe("validateCsrf", () => {
  it("accepts the session's own csrf token and rejects any other value", () => {
    const store = new SessionStore();
    const session = store.create("web-approver");
    expect(validateCsrf(session.csrfToken, session)).toBe(true);
    expect(validateCsrf("wrong-token", session)).toBe(false);
    expect(validateCsrf(undefined, session)).toBe(false);
  });

  it("one session's csrf token does not validate against another session", () => {
    const store = new SessionStore();
    const a = store.create("web-approver");
    const b = store.create("web-approver");
    expect(validateCsrf(a.csrfToken, b)).toBe(false);
  });
});
