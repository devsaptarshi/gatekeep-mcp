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
- **Approval-inbox sessions are in-memory and single-process.** A gateway
  restart logs every approver out; there's no shared session store for
  running more than one gateway process. Fine for local/single-host use,
  not for a horizontally-scaled deployment.
- **The inbox's CSRF token lives only in the browser tab's memory**, never
  localStorage — a reload loses it (log in again). Deliberate: anywhere
  more durable is more exposed to XSS reading it. See `web/src/api.ts`.
- **`__Host-` session cookies require a secure context.** They work over
  plain `http://127.0.0.1` / `http://localhost` because browsers treat the
  loopback address as "potentially trustworthy," but the inbox has not
  been tested behind a real TLS-terminating proxy yet — do that before
  exposing it beyond localhost.
- **Telegram integration is untested against a live bot.** No bot token
  was available while building it. `src/notify/telegram.ts` and
  `src/notify/telegram-webhook.ts` are unit-tested against a mocked
  `fetch` and a real Hono app (`tests/telegram.test.ts`,
  `tests/telegram-webhook.test.ts`), which verifies the request/response
  shapes match Telegram's documented Bot API — but that's not the same as
  confirming it against the real service. Before relying on it: run
  `npm run telegram:set-webhook` against a real bot and manually verify a
  notification arrives and both buttons work.
- **A decision made via the CLI or web inbox doesn't update the Telegram
  message.** The approval itself is correctly decided either way (single
  source of truth: the `approvals` table) — only the Telegram message's
  buttons/text can go stale if the decision came from elsewhere. Tracked
  by an in-memory, single-process map (`SentMessageStore`), which also
  means a gateway restart loses the mapping for any still-pending
  approval's Telegram message.
- **The reveal-mode table in `src/web/reveal.ts` / `web/src/reveal.ts` is a
  denylist of known tricks**, not an exhaustive Unicode confusables
  defense. It catches the specific categories in the build spec's red-team
  corpus (zero-width, RTL/LTR overrides, NBSP) but not, for example,
  homoglyph substitution (the hash still binds the exact bytes either way —
  see the Unicode red-team tests — this only affects what a human *sees*).
