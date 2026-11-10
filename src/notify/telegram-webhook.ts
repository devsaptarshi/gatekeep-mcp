import { Hono } from "hono";
import { appendEvent } from "../audit/log.js";
import type { GatekeepDb } from "../db/client.js";
import { approve, deny } from "../db/repositories/approvals.js";
import { timingSafeEqual } from "../shared/timing-safe-equal.js";
import { parseCallbackData, TelegramClient } from "./telegram.js";
import type { SentMessageStore } from "./sent-message-store.js";

export interface TelegramWebhookDeps {
  db: GatekeepDb;
  client: TelegramClient;
  messages: SentMessageStore;
  webhookSecret: string;
}

interface TelegramUpdate {
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number; username?: string };
  };
}

/**
 * Receives Telegram's webhook POSTs. Telegram signs nothing cryptographically
 * for webhooks — the documented control is the `X-Telegram-Bot-Api-Secret-
 * Token` header, set when the webhook is registered via setWebhook's
 * `secret_token` and echoed on every delivery; we reject anything that
 * doesn't carry the exact value we configured.
 */
export function buildTelegramWebhook(deps: TelegramWebhookDeps): Hono {
  const app = new Hono();

  app.post("/webhook", async (c) => {
    const provided = c.req.header("X-Telegram-Bot-Api-Secret-Token");
    if (!provided || !timingSafeEqual(provided, deps.webhookSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const update = await c.req.json<TelegramUpdate>().catch(() => ({}) as TelegramUpdate);
    const cq = update.callback_query;
    if (!cq) {
      return c.json({ ok: true }); // not a button press — nothing to do, still 200 so Telegram doesn't retry
    }

    const parsed = parseCallbackData(cq.data);
    if (!parsed) {
      await deps.client.answerCallbackQuery(cq.id, "Could not understand this button.");
      return c.json({ ok: true });
    }

    const decidedBy = cq.from?.username ? `telegram:@${cq.from.username}` : `telegram:${cq.from?.id ?? "unknown"}`;
    const result = parsed.action === "approve" ? approve(deps.db, parsed.approvalId, decidedBy) : deny(deps.db, parsed.approvalId, decidedBy);

    if (!result) {
      await deps.client.answerCallbackQuery(cq.id, "Already decided, expired, or not found.");
      return c.json({ ok: true });
    }

    appendEvent(deps.db, {
      runId: "telegram",
      event: parsed.action === "approve" ? "approval_approved_by_human" : "approval_denied_by_human",
      callHash: result.callHash,
      decision: parsed.action,
      payload: { approval_id: parsed.approvalId, decided_by: decidedBy, server_id: result.serverId, tool_name: result.toolName },
    });

    await deps.client.answerCallbackQuery(cq.id, parsed.action === "approve" ? "Approved." : "Denied.");

    const sent = deps.messages.get(parsed.approvalId);
    if (sent) {
      await deps.client.editMessageAfterDecision(sent, parsed.action === "approve" ? "approved" : "denied", decidedBy);
      deps.messages.delete(parsed.approvalId);
    }

    return c.json({ ok: true });
  });

  return app;
}
