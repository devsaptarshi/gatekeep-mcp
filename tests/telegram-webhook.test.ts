import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type GatekeepDb } from "../src/db/client.js";
import { createPending, findById } from "../src/db/repositories/approvals.js";
import { buildTelegramWebhook } from "../src/notify/telegram-webhook.js";
import { SentMessageStore } from "../src/notify/sent-message-store.js";
import { TelegramClient } from "../src/notify/telegram.js";

const SECRET = "test-webhook-secret";
let db: GatekeepDb;
let app: ReturnType<typeof buildTelegramWebhook>;
let messages: SentMessageStore;
let client: TelegramClient;
let apiCalls: string[];

beforeEach(() => {
  db = openDb(":memory:");
  messages = new SentMessageStore();
  apiCalls = [];
  const fakeFetch = vi.fn(async (url: string) => {
    apiCalls.push(url.split("/").pop()!);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
  client = new TelegramClient({ botToken: "T", chatId: "1" }, fakeFetch);
  app = buildTelegramWebhook({ db, client, messages, webhookSecret: SECRET });
});

function createCall() {
  return createPending(db, {
    callHash: "h1",
    serverId: "erp",
    toolName: "create_payment",
    principal: "alice",
    canonicalArgs: { amountInr: 490000 },
    reason: "test",
    ttlSeconds: 600,
  });
}

// `secret: null` means "send no secret header at all" — distinct from
// omitting the argument (which uses the correct SECRET). Using `undefined`
// as the sentinel instead would be silently swallowed by a default
// parameter, since JS treats an explicit `undefined` argument the same as
// omitting it.
async function post(body: unknown, secret: string | null = SECRET) {
  return app.request("/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("Telegram webhook", () => {
  it("rejects a request with no secret header", async () => {
    const res = await post({ callback_query: { id: "cbq", data: "approve:x" } }, null);
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong secret", async () => {
    const res = await post({ callback_query: { id: "cbq", data: "approve:x" } }, "wrong-secret");
    expect(res.status).toBe(401);
  });

  it("an update with no callback_query is accepted and ignored (not a button press)", async () => {
    const res = await post({});
    expect(res.status).toBe(200);
  });

  it("approving via the Approve button actually approves the call", async () => {
    const row = createCall();
    const res = await post({
      callback_query: { id: "cbq-1", data: `approve:${row.id}`, from: { id: 999, username: "bob" } },
    });
    expect(res.status).toBe(200);
    expect(findById(db, row.id)?.status).toBe("approved");
    expect(findById(db, row.id)?.decidedBy).toBe("telegram:@bob");
  });

  it("denying via the Deny button actually denies the call", async () => {
    const row = createCall();
    await post({ callback_query: { id: "cbq-2", data: `deny:${row.id}`, from: { id: 999, username: "bob" } } });
    expect(findById(db, row.id)?.status).toBe("denied");
  });

  it("falls back to the numeric Telegram id when the user has no username", async () => {
    const row = createCall();
    await post({ callback_query: { id: "cbq-3", data: `approve:${row.id}`, from: { id: 999 } } });
    expect(findById(db, row.id)?.decidedBy).toBe("telegram:999");
  });

  it("edits the tracked message after a decision when one was stored", async () => {
    const row = createCall();
    messages.set(row.id, { chatId: "1", messageId: 42 });
    await post({ callback_query: { id: "cbq-4", data: `approve:${row.id}`, from: { id: 1, username: "bob" } } });
    expect(apiCalls).toContain("editMessageReplyMarkup");
    expect(messages.get(row.id)).toBeUndefined(); // cleaned up after use
  });

  it("an unknown or already-decided approval id answers the callback query gracefully, not a 500", async () => {
    const res = await post({ callback_query: { id: "cbq-5", data: "approve:does-not-exist", from: { id: 1 } } });
    expect(res.status).toBe(200);
    expect(apiCalls).toContain("answerCallbackQuery");
  });

  it("garbage callback_data is handled without crashing", async () => {
    const res = await post({ callback_query: { id: "cbq-6", data: "not-a-real-action", from: { id: 1 } } });
    expect(res.status).toBe(200);
  });
});
