import type { ApprovalDetail, ApprovalSummary } from "./types";

// The CSRF token lives only in memory (a module-level variable), never in
// localStorage/sessionStorage: it's returned once at login and needed only
// for the lifetime of this tab. A page reload loses it and the session
// cookie along with any in-flight state — the user just logs in again.
// That's a deliberate, acceptable limit for a "temporary" Week 2 inbox
// (see KNOWN_LIMITS.md); a persisted session would need a different,
// more careful design (e.g. a short-lived token refreshed from the
// server, never written to storage an XSS could read).
let csrfToken: string | null = null;

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export async function login(approverToken: string): Promise<void> {
  const body = await request<{ csrfToken: string }>("/login", {
    method: "POST",
    body: JSON.stringify({ approverToken }),
  });
  csrfToken = body.csrfToken;
}

export async function logout(): Promise<void> {
  try {
    await request("/logout", { method: "POST" });
  } finally {
    csrfToken = null;
  }
}

export function listApprovals(): Promise<{ approvals: ApprovalSummary[] }> {
  return request("/approvals");
}

export function getApproval(id: string): Promise<ApprovalDetail> {
  return request(`/approvals/${encodeURIComponent(id)}`);
}

export function approveCall(id: string): Promise<{ approval: ApprovalSummary }> {
  return request(`/approvals/${encodeURIComponent(id)}/approve`, { method: "POST" });
}

export function denyCall(id: string): Promise<{ approval: ApprovalSummary }> {
  return request(`/approvals/${encodeURIComponent(id)}/deny`, { method: "POST" });
}
