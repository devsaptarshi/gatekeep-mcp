import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type GatekeepDb } from "../src/db/client.js";
import { createPending } from "../src/db/repositories/approvals.js";
import { buildWebApi } from "../src/web/api.js";
import { SessionStore } from "../src/web/session.js";

const APPROVER_TOKEN = "correct-approver-token";
let db: GatekeepDb;
let app: ReturnType<typeof buildWebApi>;

beforeEach(() => {
  db = openDb(":memory:");
  app = buildWebApi({ db, approverToken: APPROVER_TOKEN, sessions: new SessionStore() });
});

function cookieFrom(res: Response): string {
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  return setCookie.split(";")[0] ?? "";
}

async function login(): Promise<{ cookie: string; csrfToken: string }> {
  const res = await app.request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approverToken: APPROVER_TOKEN }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { csrfToken: string };
  return { cookie: cookieFrom(res), csrfToken: body.csrfToken };
}

describe("web approval inbox API", () => {
  it("rejects login with the wrong approver token", async () => {
    const res = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approverToken: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts login with the correct token and sets a Secure, HttpOnly, SameSite=Lax session cookie", async () => {
    const res = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approverToken: APPROVER_TOKEN }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("__Host-gatekeep-session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("rejects /approvals with no session at all", async () => {
    const res = await app.request("/approvals");
    expect(res.status).toBe(401);
  });

  it("every response carries anti-clickjacking headers, authenticated or not", async () => {
    const res = await app.request("/approvals");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("lists pending approvals once logged in", async () => {
    createPending(db, { callHash: "h1", serverId: "erp", toolName: "create_payment", principal: "alice", canonicalArgs: { amountInr: 490000 }, reason: "test", ttlSeconds: 600 });
    const { cookie } = await login();
    const res = await app.request("/approvals", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approvals: Array<{ id: string }> };
    expect(body.approvals).toHaveLength(1);
  });

  it("rejects approve/deny without a CSRF token, even with a valid session", async () => {
    const row = createPending(db, { callHash: "h2", serverId: "erp", toolName: "create_payment", principal: "alice", canonicalArgs: {}, reason: "test", ttlSeconds: 600 });
    const { cookie } = await login();
    const res = await app.request(`/approvals/${row.id}/approve`, { method: "POST", headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
  });

  it("rejects approve/deny with a wrong CSRF token", async () => {
    const row = createPending(db, { callHash: "h3", serverId: "erp", toolName: "create_payment", principal: "alice", canonicalArgs: {}, reason: "test", ttlSeconds: 600 });
    const { cookie } = await login();
    const res = await app.request(`/approvals/${row.id}/approve`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": "wrong-token" },
    });
    expect(res.status).toBe(403);
  });

  it("approves a pending call with a valid session + CSRF token, end to end", async () => {
    const row = createPending(db, { callHash: "h4", serverId: "erp", toolName: "create_payment", principal: "alice", canonicalArgs: { amountInr: 490000 }, reason: "test", ttlSeconds: 600 });
    const { cookie, csrfToken } = await login();
    const res = await app.request(`/approvals/${row.id}/approve`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": csrfToken },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approval: { status: string; decidedBy: string } };
    expect(body.approval.status).toBe("approved");
    expect(body.approval.decidedBy).toBe("web-approver");
  });

  it("denies a pending call with a valid session + CSRF token", async () => {
    const row = createPending(db, { callHash: "h5", serverId: "erp", toolName: "update_vendor_bank_details", principal: "alice", canonicalArgs: {}, reason: "test", ttlSeconds: 600 });
    const { cookie, csrfToken } = await login();
    const res = await app.request(`/approvals/${row.id}/deny`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSRF-Token": csrfToken },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approval: { status: string } };
    expect(body.approval.status).toBe("denied");
  });

  it("the detail endpoint returns both the raw and reveal-mode arguments — the raw bytes are never lost", async () => {
    const tricky = "Acme​ Co";
    const row = createPending(db, { callHash: "h6", serverId: "erp", toolName: "create_payment", principal: "alice", canonicalArgs: { vendor: tricky }, reason: "test", ttlSeconds: 600 });
    const { cookie } = await login();
    const res = await app.request(`/approvals/${row.id}`, { headers: { Cookie: cookie } });
    const body = (await res.json()) as { argumentsRaw: { vendor: string }; argumentsRevealed: { vendor: string } };
    expect(body.argumentsRaw.vendor).toBe(tricky); // exact bytes preserved
    expect(body.argumentsRevealed.vendor).toBe("Acme[ZWSP][NBSP]Co"); // but surfaced for display
  });

  it("logging out invalidates the session immediately", async () => {
    const { cookie } = await login();
    const logoutRes = await app.request("/logout", { method: "POST", headers: { Cookie: cookie } });
    expect(logoutRes.status).toBe(200);
    const after = await app.request("/approvals", { headers: { Cookie: cookie } });
    expect(after.status).toBe(401);
  });

  it("approving an already-decided approval returns a conflict, not a silent success", async () => {
    const row = createPending(db, { callHash: "h7", serverId: "erp", toolName: "create_payment", principal: "alice", canonicalArgs: {}, reason: "test", ttlSeconds: 600 });
    const { cookie, csrfToken } = await login();
    await app.request(`/approvals/${row.id}/approve`, { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrfToken } });
    const again = await app.request(`/approvals/${row.id}/approve`, { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrfToken } });
    expect(again.status).toBe(409);
  });
});
