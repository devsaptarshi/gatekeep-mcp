import type { SentMessage } from "./telegram.js";

/**
 * Maps a pending approval id to the Telegram message that notified about
 * it, so a decision made via the inline buttons can edit that same
 * message. In-memory and per-process: a decision made through the CLI or
 * web inbox instead of Telegram simply leaves the Telegram message
 * un-edited (see KNOWN_LIMITS.md) — the approval itself is still correctly
 * decided either way, this only affects what the Telegram message shows.
 */
export class SentMessageStore {
  private byApprovalId = new Map<string, SentMessage>();

  set(approvalId: string, message: SentMessage): void {
    this.byApprovalId.set(approvalId, message);
  }

  get(approvalId: string): SentMessage | undefined {
    return this.byApprovalId.get(approvalId);
  }

  delete(approvalId: string): void {
    this.byApprovalId.delete(approvalId);
  }
}
