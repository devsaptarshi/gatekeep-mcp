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
- **Spawn upstreams by binary path, not through a shell wrapper.** Config
  (`gatekeep.config.yaml`) and anything else that spawns a gateway or
  upstream process must give `command` the real binary
  (`./node_modules/.bin/tsx`, not `npx tsx` or anything invoking a shell).
  An intermediate `npx`/`npm exec`/`sh -c` layer doesn't reliably forward
  `SIGTERM` down to the actual node process, which left orphaned upstream
  processes behind on every shutdown until this was fixed — confirmed with
  `ps` before and after. Not a correctness issue (DB state, and therefore
  every security property, was unaffected) but worth getting right before
  anyone runs this unattended.
- **Untested against MCP clients predating the 2026-07-28 spec revision** —
  see SECURITY.md for what changed and what's untested.
