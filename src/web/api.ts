import { Hono } from "hono";
import { appendEvent } from "../audit/log.js";
import type { GatekeepDb } from "../db/client.js";
import { approve, deny, findById } from "../db/repositories/approvals.js";
import { approvals } from "../db/schema.js";
import { revealDeep } from "./reveal.js";
import {
  extractSessionCookie,
  SESSION_COOKIE_NAME,
  SessionStore,
  validateApproverToken,
  validateCsrf,
  type Session,
} from "./session.js";

type Env = { Variables: { session: Session } };

export interface WebApiDeps {
  db: GatekeepDb;
  approverToken: string;
  sessions: SessionStore;
}

function sessionCookieHeader(sessionId: string | null): string {
  if (sessionId === null) {
    // Clears the cookie (used on logout).
    return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  }
  return `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * The approval inbox's own API, separate from /mcp. Anti-clickjacking
 * headers (frame-ancestors 'none') and the session/CSRF checks below are
 * what make this safe to expose to a browser at all — /mcp is machine-to-
 * machine and doesn't need any of this.
 */
export function buildWebApi(deps: WebApiDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
    c.header("X-Content-Type-Options", "nosniff");
  });

  app.post("/login", async (c) => {
    const body = await c.req.json<{ approverToken?: string }>().catch(() => ({ approverToken: undefined }));
    if (!validateApproverToken(body.approverToken, deps.approverToken)) {
      return c.json({ error: "invalid_approver_token" }, 401);
    }
    const session = deps.sessions.create("web-approver");
    c.header("Set-Cookie", sessionCookieHeader(session.id));
    return c.json({ csrfToken: session.csrfToken });
  });

  app.post("/logout", (c) => {
    const sessionId = extractSessionCookie(c.req.header("Cookie"));
    if (sessionId) deps.sessions.destroy(sessionId);
    c.header("Set-Cookie", sessionCookieHeader(null));
    return c.json({ ok: true });
  });

  // Everything below requires a valid session.
  app.use("*", async (c, next) => {
    const sessionId = extractSessionCookie(c.req.header("Cookie"));
    const session = deps.sessions.get(sessionId);
    if (!session) {
      return c.json({ error: "unauthorized", reason: "no valid session — log in first" }, 401);
    }
    c.set("session", session);
    await next();
  });

  // Everything below also requires CSRF for state-changing methods. GET
  // is exempt (CSRF only matters for requests that change state).
  app.use("*", async (c, next) => {
    if (c.req.method === "GET") return next();
    const session = c.get("session");
    if (!validateCsrf(c.req.header("X-CSRF-Token"), session)) {
      return c.json({ error: "csrf_check_failed" }, 403);
    }
    return next();
  });

  app.get("/approvals", (c) => {
    const rows = deps.db
      .select({
        id: approvals.id,
        serverId: approvals.serverId,
        toolName: approvals.toolName,
        principal: approvals.principal,
        reason: approvals.reason,
        status: approvals.status,
        createdAt: approvals.createdAt,
        expiresAt: approvals.expiresAt,
      })
      .from(approvals)
      .all()
      .filter((r) => r.status === "pending");
    return c.json({ approvals: rows });
  });

  app.get("/approvals/:id", (c) => {
    const row = findById(deps.db, c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    const parsedArgs = JSON.parse(row.canonicalArgs) as unknown;
    return c.json({
      approval: row,
      // Both representations are sent so the UI's reveal-mode toggle is
      // instant and never re-fetches — and so an approver comparing them
      // side by side can see exactly what reveal mode changed.
      argumentsRaw: parsedArgs,
      argumentsRevealed: revealDeep(parsedArgs),
    });
  });

  app.post("/approvals/:id/approve", (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    const result = approve(deps.db, id, session.decidedByLabel);
    if (!result) {
      return c.json({ error: "cannot_approve", reason: "not pending, already decided, or expired" }, 409);
    }
    appendEvent(deps.db, {
      runId: "web",
      event: "approval_approved_by_human",
      callHash: result.callHash,
      decision: "approve",
      payload: { approval_id: id, decided_by: session.decidedByLabel, server_id: result.serverId, tool_name: result.toolName },
    });
    return c.json({ approval: result });
  });

  app.post("/approvals/:id/deny", (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    const result = deny(deps.db, id, session.decidedByLabel);
    if (!result) {
      return c.json({ error: "cannot_deny", reason: "not pending or already decided" }, 409);
    }
    appendEvent(deps.db, {
      runId: "web",
      event: "approval_denied_by_human",
      callHash: result.callHash,
      decision: "deny",
      payload: { approval_id: id, decided_by: session.decidedByLabel, server_id: result.serverId, tool_name: result.toolName },
    });
    return c.json({ approval: result });
  });

  return app;
}
