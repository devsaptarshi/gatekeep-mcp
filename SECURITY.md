# Security model

## Boundary

The security boundary is deterministic: a policy engine evaluates every
tool call against a YAML policy (allow / approve / deny, precedence
deny > approve > allow), and risky calls cannot reach an upstream server
until a human approves the exact call (see README for the hashing scheme).
This boundary holds even if the model generating tool calls is fully
compromised by prompt injection — nothing here depends on the model
behaving well.

## MCP 2026-07-28 spec implications

- Streamable HTTP is stateless under SEP-2567 (no session IDs, no stream
  resumability) — the gateway tracks its own `run_id` server-side;
  approvals never depend on a transport-level session.
- `Mcp-Method` / `Mcp-Name` headers are log-only; the JSON-RPC body is the
  source of truth. A header/body mismatch is rejected with HTTP 400.
- Tool annotations (e.g. `readOnlyHint`) are untrusted input from the
  upstream server and may only ever tighten policy, never loosen it.
- Token passthrough (forwarding a client's credential to an upstream) is
  forbidden — client and upstream credentials are always separate
  ("confused deputy problem").

## Local-gateway hardening

- Binds to `127.0.0.1` by default.
- Validates the `Origin` header and requires a local token on HTTP mode
  (anti DNS-rebinding).
- Spawns upstream stdio processes only from local config at startup, never
  from an API call at runtime.

Full 14-row threat table lives in the build spec; it will be ported into
this file as each control ships (tracked per-week in the task list).
