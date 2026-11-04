// Local-gateway HTTP hardening, factored out from the transport wiring so
// it's unit-testable without a running server. Three independent checks,
// each matching a specific threat from SECURITY.md:
//
//   1. Origin validation — anti DNS-rebinding. A browser page on an
//      attacker's domain can't make a cross-origin request carry our local
//      token (browsers don't let JS set arbitrary Origin), but DNS
//      rebinding tricks the BROWSER itself into believing our localhost
//      server is same-origin with the attacker's page. Checking Origin
//      against an explicit allowlist (not just "is it localhost") closes
//      that gap: a request from an unexpected Origin is rejected even if
//      it reaches 127.0.0.1.
//   2. Local token — a bearer token only this machine's processes know,
//      required on every request.
//   3. Mcp-Method/Mcp-Name header vs. JSON-RPC body consistency — the
//      2026-07-28 MCP spec makes these headers log/routing hints only; the
//      body is the source of truth, and a mismatch must be rejected rather
//      than silently preferring one over the other.

export interface OriginCheckResult {
  ok: boolean;
  reason?: string;
}

export function checkOrigin(originHeader: string | undefined | null, allowedOrigins: string[]): OriginCheckResult {
  // No Origin header at all: not a browser request (browsers always send
  // Origin on fetch/XHR to another origin, and same-origin navigation
  // requests are irrelevant here since nothing serves a page from this
  // gateway). Non-browser MCP clients (the CLI, Claude Code, curl) don't
  // send one either, and are exactly gatekeep's intended audience.
  if (originHeader === undefined || originHeader === null || originHeader === "") {
    return { ok: true };
  }
  if (!allowedOrigins.includes(originHeader)) {
    return { ok: false, reason: `Origin "${originHeader}" is not in the allowed list` };
  }
  return { ok: true };
}

export function checkLocalToken(authorizationHeader: string | undefined | null, expectedToken: string): OriginCheckResult {
  if (!authorizationHeader) {
    return { ok: false, reason: "missing Authorization header" };
  }
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/);
  if (!match) {
    return { ok: false, reason: "Authorization header must be 'Bearer <token>'" };
  }
  if (!timingSafeEqual(match[1]!, expectedToken)) {
    return { ok: false, reason: "token does not match" };
  }
  return { ok: true };
}

function timingSafeEqual(a: string, b: string): boolean {
  // Lengths almost never match for a wrong guess anyway, but avoid the
  // obvious early-exit-on-length shortcut some naive comparisons use.
  const maxLen = Math.max(a.length, b.length, 32);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

export interface HeaderBodyCheckInput {
  mcpMethodHeader: string | undefined | null;
  mcpNameHeader: string | undefined | null;
  bodyMethod: string | undefined;
  bodyToolName: string | undefined; // body.params?.name, only meaningful for tools/call
}

/**
 * Per the 2026-07-28 spec, `Mcp-Method`/`Mcp-Name` are routing/log hints —
 * the JSON-RPC body is authoritative. A gateway that silently trusted
 * whichever one it read first would let a client lie to downstream
 * logging/routing while the body does something else. Reject instead.
 */
export function checkHeaderBodyConsistency(input: HeaderBodyCheckInput): OriginCheckResult {
  if (input.mcpMethodHeader && input.bodyMethod && input.mcpMethodHeader !== input.bodyMethod) {
    return { ok: false, reason: `Mcp-Method header "${input.mcpMethodHeader}" does not match body method "${input.bodyMethod}"` };
  }
  if (input.mcpNameHeader && input.bodyToolName && input.mcpNameHeader !== input.bodyToolName) {
    return { ok: false, reason: `Mcp-Name header "${input.mcpNameHeader}" does not match body params.name "${input.bodyToolName}"` };
  }
  return { ok: true };
}
