export interface ApprovalSummary {
  id: string;
  serverId: string;
  toolName: string;
  principal: string;
  reason: string;
  status: string;
  createdAt: string;
  expiresAt: string;
}

export interface ApprovalDetail {
  approval: ApprovalSummary & { canonicalArgs: string; decidedBy: string | null };
  argumentsRaw: unknown;
  argumentsRevealed: unknown;
}
