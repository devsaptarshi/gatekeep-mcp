import { describe, expect, it, vi } from "vitest";
import { formatApprovalMessage, parseCallbackData, TelegramClient, type ApprovalNotice } from "../src/notify/telegram.js";

const notice: ApprovalNotice = {
  id: "abc-123",
  serverId: "erp",
  toolName: "create_payment",
  principal: "alice",
  reason: "payment above INR 50,000 requires approval",
  expiresAt: "2026-11-10T12:00:00.000Z",
  canonicalArgs: '{"invoiceId":"INV-1","amountInr":490000}',
};

describe("formatApprovalMessage", () => {
  it("includes the tool, reason, raw arguments, and expiry", () => {
    const text = formatApprovalMessage(notice);
    expect(text).toContain("create\\_payment"); // underscore is escaped per MarkdownV2
    expect(text).toContain("490000"); // inside a ``` code block, never escaped
    expect(text).toContain("alice");
  });

  it("escapes MarkdownV2 special characters so the message isn't rejected or mis-rendered", () => {
    const text = formatApprovalMessage({ ...notice, reason: "payment > 50,000 (urgent!)" });
    // MarkdownV2 requires backslash-escaping these outside formatting entities.
    expect(text).toContain("\\>");
    expect(text).toContain("\\(");
    expect(text).toContain("\\!");
  });
});

describe("parseCallbackData", () => {
  it("parses an approve action", () => {
    expect(parseCallbackData("approve:abc-123")).toEqual({ action: "approve", approvalId: "abc-123" });
  });
  it("parses a deny action", () => {
    expect(parseCallbackData("deny:abc-123")).toEqual({ action: "deny", approvalId: "abc-123" });
  });
  it("returns null for garbage input", () => {
    expect(parseCallbackData("not-a-valid-action")).toBeNull();
    expect(parseCallbackData(undefined)).toBeNull();
    expect(parseCallbackData("")).toBeNull();
  });
});

describe("TelegramClient", () => {
  it("sendApprovalNotice posts to the Bot API with an inline approve/deny keyboard", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(init!.body as string) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new TelegramClient({ botToken: "TEST_TOKEN", chatId: "12345" }, fakeFetch);
    const sent = await client.sendApprovalNotice(notice);

    expect(sent).toEqual({ chatId: "12345", messageId: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("bot TEST_TOKEN".replace(" ", ""));
    expect(calls[0]!.url).toContain("sendMessage");
    const body = calls[0]!.body as { chat_id: string; reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } };
    expect(body.chat_id).toBe("12345");
    const buttons = body.reply_markup.inline_keyboard[0]!;
    expect(buttons.map((b) => b.callback_data)).toEqual(["approve:abc-123", "deny:abc-123"]);
  });

  it("throws a clear error when the Bot API reports failure", async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 })) as unknown as typeof fetch;
    const client = new TelegramClient({ botToken: "TEST_TOKEN", chatId: "bad-chat" }, fakeFetch);
    await expect(client.sendApprovalNotice(notice)).rejects.toThrow(/chat not found/);
  });

  it("editMessageAfterDecision removes the keyboard and posts a follow-up", async () => {
    const calls: string[] = [];
    const fakeFetch = vi.fn(async (url: string) => {
      calls.push(url.split("/").pop()!);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new TelegramClient({ botToken: "T", chatId: "1" }, fakeFetch);
    await client.editMessageAfterDecision({ chatId: "1", messageId: 42 }, "approved", "bob");
    expect(calls).toContain("editMessageReplyMarkup");
    expect(calls).toContain("sendMessage");
  });

  it("answerCallbackQuery posts the acknowledgement", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(init!.body as string) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new TelegramClient({ botToken: "T", chatId: "1" }, fakeFetch);
    await client.answerCallbackQuery("cbq-1", "Approved.");
    expect(calls[0]!.url).toContain("answerCallbackQuery");
    expect((calls[0]!.body as { callback_query_id: string }).callback_query_id).toBe("cbq-1");
  });
});
