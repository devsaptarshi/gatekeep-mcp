import { randomBytes } from "node:crypto";
import { timingSafeEqual } from "../shared/timing-safe-equal.js";

export const SESSION_COOKIE_NAME = "__Host-gatekeep-session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

export interface Session {
  id: string;
  csrfToken: string;
  decidedByLabel: string; // what shows up as approvals.decided_by / audit "decided_by"
  createdAt: number;
  expiresAt: number;
}

/**
 * In-memory session store — fine for a single-process v1 inbox. Sessions
 * don't survive a gateway restart, which is the right failure mode for a
 * local approval tool: restart it, log in again, nothing silently stays
 * authorized.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();

  create(decidedByLabel: string): Session {
    const now = Date.now();
    const session: Session = {
      id: randomBytes(32).toString("hex"),
      csrfToken: randomBytes(32).toString("hex"),
      decidedByLabel,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(sessionId: string | undefined | null): Session | undefined {
    if (!sessionId) return undefined;
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  destroy(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/** Parses the session id out of a raw `Cookie` header, without a cookie-parsing dependency. */
export function extractSessionCookie(cookieHeader: string | undefined | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawRest] = part.trim().split("=");
    if (rawName === SESSION_COOKIE_NAME) {
      return rawRest.join("=");
    }
  }
  return undefined;
}

export function validateApproverToken(provided: string | undefined | null, expected: string): boolean {
  if (!provided) return false;
  return timingSafeEqual(provided, expected);
}

/** Double-submit style CSRF check: the header must match the session's own token. */
export function validateCsrf(headerToken: string | undefined | null, session: Session): boolean {
  if (!headerToken) return false;
  return timingSafeEqual(headerToken, session.csrfToken);
}
