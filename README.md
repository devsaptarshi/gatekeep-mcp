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

All three weeks of the build plan are done. v0.1.0 is tagged for local
use and portfolio review; see [KNOWN_LIMITS.md](./KNOWN_LIMITS.md) before
relying on this beyond that — a few things (the live layer-2 agent eval,
Telegram against a real bot) are built and tested in isolation but not
yet confirmed end-to-end against the real external services they talk to.

Shipped: canonical-hash approval binding; the MCP stdio and Streamable
HTTP proxy; a YAML/CEL policy engine with flow rules (`run_tags`) for
multi-step attacks; a hash-chained tamper-evident audit log
(`gatekeep verify`); secret redaction; local-gateway HTTP hardening
(Origin allowlist, bearer token, header/body consistency); a React
approval inbox with session/CSRF/clickjacking hardening and a Unicode
reveal mode; Telegram notifications with inline approve/deny; a 89-case
layer-1 red-team corpus (deterministic, runs on every PR) plus a
real-API-ready layer-2 harness; and a latency benchmark (p95 0.72ms
gateway overhead, target was <10ms — see
[results/latest.json](./results/latest.json)).

**236/236 tests pass.** See [LESSONS.md](./LESSONS.md) for what actually
went wrong while building this and what caught it — including two real
bugs (a single-use-per-request SDK transport, orphaned processes from
spawning through `npx`) that only a real end-to-end run surfaced, not the
unit tests.

### Proving the test suite can actually fail

A green suite that can't go red proves nothing. As a deliberate check, the
TTL-expiry guard in `approve()` (`src/db/repositories/approvals.ts`) was
removed and the full suite re-run:

```
FAIL  tests/db-approvals.test.ts > approve() expires a row past its TTL instead of approving it
FAIL  tests/redteam/layer1-corpus.test.ts > [redteam] replay and expiry > an expired (never-approved) pending request cannot be smuggled through by waiting
Test Files  2 failed | 6 passed (8)
     Tests  2 failed | 151 passed (153)
```

Two tests failed, from two different files (one unit test, one red-team
case), exactly as expected for that specific control. The guard was then
restored (`git checkout -- src/db/repositories/approvals.ts`) and the
suite returned to 153/153. This is a manual spot-check, not a standing CI
gate yet — automating "intentionally break one control per run and assert
something fails" is tracked for Week 3.

## Quickstart (dev)

```bash
npm install
cp .env.example .env
npm run dev:gateway-http   # terminal 1: gateway over HTTP (spawns the ERP fixture itself)
cd web && npm install && npm run dev   # terminal 2: approval inbox UI, http://localhost:5173
```

Sign in to the inbox with `GATEKEEP_APPROVER_TOKEN` from `.env` (NOT
`GATEKEEP_LOCAL_TOKEN` — see "Two separate tokens" below). Or skip the UI
entirely and use the CLI: `npm run dev:gateway` (stdio) +
`npm run cli -- approve <id>` / `list` / `show <id> [--reveal]` / `verify`.

### Two separate tokens

`GATEKEEP_LOCAL_TOKEN` authenticates agents calling `/mcp`.
`GATEKEEP_APPROVER_TOKEN` authenticates humans logging into the inbox at
`/api`. They're deliberately different secrets: if an agent's own gateway
token also worked as an approver login, it could approve its own pending
calls — exactly the self-approval gap exact-call hashing exists to close
one layer up.

### Other scripts

```bash
npm run smoke              # end-to-end: real gateway + fixture + CLI, including the tamper-detection round trip
npm run bench:latency      # gateway's own added-latency benchmark (p95/p99/max)
npm run eval:layer2        # a real Claude agent vs. the poisoned-invoice scenario (needs ANTHROPIC_API_KEY, costs money — see KNOWN_LIMITS.md)
npm run telegram:set-webhook  # one-time: register the webhook with Telegram (needs a public HTTPS URL)
```

### Build / publish

```bash
npm run build   # tsc -p tsconfig.build.json -> dist/, matching the "bin" path in package.json
npm pack --dry-run   # see exactly what `files` in package.json would publish
```

Not yet pushed to a public repository or published to npm — the
`LICENSE` file's copyright line and `package.json`'s `author`/`repository`
fields are left for whoever does that to fill in.
