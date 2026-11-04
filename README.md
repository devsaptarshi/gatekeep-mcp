# gatekeep-mcp

A transparent [MCP](https://modelcontextprotocol.io) gateway: it looks like a
normal MCP server to the client and a normal MCP client to each upstream
server. Every tool call is classified by a policy. Low-risk calls pass.
Risky calls wait for a human to approve the **exact** call — not just the
tool name, but a hash of the tool, its arguments, the tool's own definition,
and the policy version that decided it needed approval. An approval only
ever authorizes that one exact call, once.

## Why not just "ask the human"?

Most MCP approval flows approve the *tool*, not the *call*. An agent that
reads untrusted content (a poisoned invoice, a scraped web page) can be
tricked into generating a tool call with different arguments than what a
human thinks they're approving — or can retry with changed arguments after
approval. gatekeep closes that gap:

- `call_hash = SHA-256(canonical_json({server_id, tool_name, arguments, tool_definition_hash, principal, policy_version}))`,
  canonicalized per [RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785).
- Including `tool_definition_hash` invalidates an approval if the tool's
  definition changed since review (catches "rug pulls").
- Including `policy_version` invalidates approvals if the policy tightened.
- After approval, the gateway forwards its own **stored** `canonical_args`
  to the upstream — never whatever the agent sends on retry.
- Approvals are single-use, consumed with one atomic
  `UPDATE ... WHERE status='approved' AND consumed_at IS NULL RETURNING id`.

See [SECURITY.md](./SECURITY.md) for the full threat model, and
[KNOWN_LIMITS.md](./KNOWN_LIMITS.md) for what this does *not* protect against.

## Prior art — and what's different here

- **[hoop.dev](https://github.com/hoophq/hoop)** — an open-source Layer 7
  gateway between MCP clients and services, routing high-risk methods (e.g.
  production table mutations) to human approval, with session logging.
  gatekeep's approvals go further: they bind the approval to a hash of the
  *exact arguments*, the *tool's definition*, and the *policy version* at
  decision time, not just the method name — so a changed argument, a
  silently-updated tool definition, or a loosened policy all invalidate a
  pending or already-granted approval instead of silently passing through.
- **TrueFoundry's gateway approvals** — scope grants to requester/server/tool
  and support time-limited approvals, a similar model to the above. Same
  gap: approving a tool/method, not a specific call.

Neither (as far as the evaluation in this repo found) does hash-chained,
tamper-evident audit logging or tool-definition pinning to detect rug-pulls,
both of which are core to gatekeep's design.

## Status

Week 1 in progress — see [the build spec] for the three-week plan. Not
ready for anything beyond local development and the fixtures in this repo.

## Quickstart (dev)

```bash
npm install
cp .env.example .env
npm run dev:erp-fixture   # terminal 1: fake upstream ERP MCP server
npm run dev:gateway       # terminal 2: gateway, proxies to the fixture
```
