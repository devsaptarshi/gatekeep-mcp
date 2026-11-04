# Known limits

This does not stop harmful actions inside the `allow` tier, and it cannot
make a person read carefully before clicking approve. It reduces blast
radius. It does not make agents safe.

- **Caching (future risk).** If a query/result cache is ever added in front
  of policy decisions or approvals, the cache key must include the full
  `call_hash` (which already includes `principal`), never just `tool_name`
  or `server_id`. A cache keyed too loosely can serve one principal's
  decision to another — the same class of bug that leaks tenant data in
  multi-tenant text-to-SQL systems when a cached SQL template doesn't carry
  its security scope. No cache exists yet in this codebase; this is a
  constraint on anyone adding one later.
- **Prompt-injection detection is a bonus, not a boundary.** The security
  guarantee comes from deterministic policy + exact-call hashing, which
  holds even if the underlying model is fully compromised. Nothing here
  tries to detect injected instructions in tool results.
- **No multi-tenant / RBAC model in v1.** Single "allowed approver" concept.
  No SSO, no roles.
- **No OAuth proxying.** One credential per upstream via env var.
- **Process teardown is best-effort, not instant.** On shutdown the gateway
  closes its upstream connections before exiting (`SIGTERM`/`SIGINT`
  handlers in `src/proxy/stdio-gateway.ts`), but each layer's own
  SIGTERM→2s-wait→SIGKILL sequence in the MCP SDK's `StdioClientTransport`
  can stack (client→gateway→upstream), so a hard-killed client can
  occasionally outrace a clean cascade and leave an upstream fixture
  process orphaned. Not a correctness issue — the DB state (and therefore
  every security property) is unaffected — just a process-hygiene gap
  worth fixing before this runs unattended for long periods.
- **Untested against MCP clients predating the 2026-07-28 spec revision** —
  see SECURITY.md for what changed and what's untested.
