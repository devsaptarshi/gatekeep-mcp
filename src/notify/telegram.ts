// A thin, directly-testable client for the Telegram Bot API — no SDK
// dependency, just fetch, with `fetchImpl` injectable so tests never make
// a real network call. Untested against a live bot (no bot token was
// available while building this) — see KNOWN_LIMITS.md. The message
// shapes below follow Telegram's documented Bot API (sendMessage,
// editMessageText, answerCallbackQuery, inline keyboards).

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface ApprovalNotice {
  id: string;
  serverId: string;
  toolName: string;
  principal: string;
  reason: string;
  expiresAt: string;
  canonicalArgs: string; // JSON string, shown raw — same principle as the web inbox: exact bytes, not a summary
}

export type FetchLike = typeof fetch;

function escapeMarkdownV2(s: string): string {
  // Telegram's MarkdownV2 requires escaping these characters anywhere
  // they appear outside of explicit formatting entities.
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (ch) => `\\${ch}`);
}

export function formatApprovalMessage(a: ApprovalNotice): string {
  const lines = [
    `*Approval required*`,
    `${escapeMarkdownV2(a.serverId)} / ${escapeMarkdownV2(a.toolName)}`,
    escapeMarkdownV2(a.reason),
    "",
    "```",
    a.canonicalArgs,
    "```",
    `principal: ${escapeMarkdownV2(a.principal)}`,
    `expires: ${escapeMarkdownV2(a.expiresAt)}`,
  ];
  return lines.join("\n");
}

export interface SentMessage {
  chatId: string;
  messageId: number;
}

export class TelegramClient {
  constructor(
    private config: TelegramConfig,
    private fetchImpl: FetchLike = fetch,
  ) {}

  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.config.botToken}/${method}`;
  }

  async sendApprovalNotice(approval: ApprovalNotice): Promise<SentMessage> {
    const res = await this.fetchImpl(this.apiUrl("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.config.chatId,
        text: formatApprovalMessage(approval),
        parse_mode: "MarkdownV2",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `approve:${approval.id}` },
              { text: "❌ Deny", callback_data: `deny:${approval.id}` },
            ],
          ],
        },
      }),
    });
    const body = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
    if (!body.ok || !body.result) {
      throw new Error(`Telegram sendMessage failed: ${body.description ?? res.status}`);
    }
    return { chatId: this.config.chatId, messageId: body.result.message_id };
  }

  async editMessageAfterDecision(sent: SentMessage, decision: "approved" | "denied", decidedBy: string): Promise<void> {
    const suffix = decision === "approved" ? `✅ Approved by ${decidedBy}` : `❌ Denied by ${decidedBy}`;
    await this.fetchImpl(this.apiUrl("editMessageReplyMarkup"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: sent.chatId, message_id: sent.messageId, reply_markup: { inline_keyboard: [] } }),
    });
    await this.fetchImpl(this.apiUrl("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: sent.chatId, text: escapeMarkdownV2(suffix), parse_mode: "MarkdownV2", reply_to_message_id: sent.messageId }),
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    await this.fetchImpl(this.apiUrl("answerCallbackQuery"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  }
}

/** Parses a Telegram callback_data value of the form "approve:<id>" / "deny:<id>". */
export function parseCallbackData(data: string | undefined): { action: "approve" | "deny"; approvalId: string } | null {
  if (!data) return null;
  const match = data.match(/^(approve|deny):(.+)$/);
  if (!match) return null;
  return { action: match[1] as "approve" | "deny", approvalId: match[2]! };
}
