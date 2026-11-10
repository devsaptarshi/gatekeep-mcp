#!/usr/bin/env node
// One-time setup: registers the gateway's /telegram/webhook URL with
// Telegram via setWebhook. Run manually after deploying the gateway
// somewhere Telegram's servers can reach (a public HTTPS URL — Telegram
// does not accept http:// or a bare IP for webhooks).
//
// Usage: GATEKEEP_PUBLIC_URL=https://your-host tsx scripts/telegram-set-webhook.ts
import { loadConfig } from "../src/config.js";

async function main() {
  const config = loadConfig(process.env.GATEKEEP_CONFIG_PATH ?? "./gatekeep.config.yaml");
  if (!config.telegram) {
    console.error("TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, and TELEGRAM_WEBHOOK_SECRET must all be set.");
    process.exit(1);
  }
  const publicUrl = process.env.GATEKEEP_PUBLIC_URL;
  if (!publicUrl || !publicUrl.startsWith("https://")) {
    console.error("Set GATEKEEP_PUBLIC_URL to a public https:// URL for this gateway (Telegram requires HTTPS).");
    process.exit(1);
  }

  const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: `${publicUrl.replace(/\/$/, "")}/telegram/webhook`,
      secret_token: config.telegram.webhookSecret,
      allowed_updates: ["callback_query"],
    }),
  });
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
  if (!(body as { ok?: boolean }).ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
