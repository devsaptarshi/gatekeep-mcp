# Lessons

Things that actually went wrong while building this, and what caught them.
Written for the README's sake and for the next project in this series —
not a victory lap.

## Real bugs real tests actually caught

**A stateless HTTP transport instance is single-use per request.** The MCP
SDK's `WebStandardStreamableHTTPServerTransport`, built once at startup and
reused across requests (the obvious way to wire it up, and how the stdio
transport works), threw "Stateless transport cannot be reused across
requests" on the second real request. Nothing in the unit tests caught
this — they drive `handleToolCall` directly, never a real transport. Only
hitting the live server with `curl` surfaced it. Fixed by building a fresh
`Server` + transport pair per request over the same shared, expensive
state (db, registry, policy engine, upstreams); that's cheap, the
transport object is not. Lesson: for anything wrapping a third-party
transport/protocol layer, at least one test has to go through the real
transport, not just the business logic behind it.

**Spawning upstreams via `npx tsx ...` orphaned processes on shutdown.**
The gateway's SIGTERM handler closed its upstream connections correctly,
but `ps` after a "clean" shutdown kept showing the fixture process alive.
The intermediate `npm exec` → `sh -c` → `tsx` process chain doesn't
reliably forward `SIGTERM` down to the actual Node process. Fixed by
spawning the `tsx` binary directly (`./node_modules/.bin/tsx`, no shell in
between) in both `gatekeep.config.yaml` and anywhere else that spawns a
gateway or upstream. Found this only by actually checking `ps` after the
"ALL CHECKS PASSED" smoke-test line — a passing script is not the same as
a clean process tree.

**My own test helper's default parameter swallowed an explicit
`undefined`.** `async function post(body, secret = SECRET)` — calling
`post(body, undefined)` to mean "send no secret header" silently fell
back to the default `SECRET`, because JS treats an explicit `undefined`
argument the same as omitting it. The test (`rejects a request with no
secret header`) passed for the wrong reason until a second look at the
failure showed 200 instead of 401. Fixed by using `null` as the
"send nothing" sentinel, reserving the default only for an omitted
argument. Lesson: a default parameter and "the caller explicitly asked
for the empty/absent case" are not the same thing, and a passing test
suite doesn't prove this was handled right — only a *failing* one, read
carefully, does.

**A dependency version pinned from earlier research was already stale.**
`@marcbachmann/cel-js` was pinned to `^0.5.0` based on a web search done
before implementation started; by install time the real latest was
`8.0.0` and `0.5.0` didn't exist on the registry at all. `npm install`
failed immediately and loudly — the cheap kind of wrong. The more
expensive kind came from `npm audit`: several transitive dependencies
(`drizzle-orm`, `zod`, `minimatch`, `vitest`) needed real version bumps
(including major versions) to clear actual CVEs, not just version-pin
hygiene. Lesson: treat a web-researched version number as a starting
guess, not a fact, and run `npm audit` before calling a dependency set
"done" — building a security tool with known-vulnerable dependencies in
it would have been a bad look even if none of them were exploitable here.

## A measurement that looked wrong until it wasn't

Measuring the benign-call false-positive rate against the real policy
file, the aggregate run showed ~47% of benign calls "wrongly blocked" —
alarming, until closer inspection showed the *individual* per-case tests
all passed. The difference: the aggregate loop ran every benign call
through the *same* `run_id`, so once one call read invoice text
(tagged `untrusted_read`), the flow rule correctly escalated every
*subsequent* payment in that run — including the small, normally
auto-allowed ones. That's the intended defense-in-depth behavior (see
`policies/default.yaml`'s `untrusted-to-external` flow), not a bug. The
fix wasn't to the gateway; it was to the measurement — give each benign
call in the aggregate its own isolated `run_id`, matching what "a benign
call in isolation" actually means. Lesson: when an aggregate metric
disagrees sharply with the per-case results that make it up, suspect the
aggregate's test setup before suspecting the code it's measuring — and
write down why, because the same confusion will happen to the next person
reading the number without the context.

## What held up without surprises

The cryptographic core (canonical JSON + `call_hash`, RFC 8785-ish) and
the single-use atomic approval consume passed their property-based and
concurrency tests on the first run and never needed a fix afterward —
unlike almost everything that touched a transport, a process boundary, or
a test's own setup. The pattern across this whole build: pure,
deterministic logic with no I/O was reliably right the first time;
everything that crossed a process/network/shell boundary needed a real
end-to-end check (a live `curl`, a real spawned process, a real browser
via Playwright) to catch what unit tests structurally couldn't see.
