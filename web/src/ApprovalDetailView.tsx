import { useEffect, useState } from "react";
import { approveCall, denyCall, getApproval, type ApiError } from "./api";
import type { ApprovalDetail } from "./types";

export function ApprovalDetailView({
  id,
  onDecided,
  onClose,
}: {
  id: string;
  onDecided: () => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [revealMode, setRevealMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getApproval(id)
      .then(setDetail)
      .catch(() => setError("Could not load this approval — it may have expired or already been decided."));
  }, [id]);

  async function decide(action: "approve" | "deny") {
    setBusy(true);
    setError(null);
    try {
      if (action === "approve") await approveCall(id);
      else await denyCall(id);
      onDecided();
    } catch (err) {
      const apiErr = err as ApiError;
      setError(`Could not ${action}: ${JSON.stringify(apiErr.body)}`);
    } finally {
      setBusy(false);
    }
  }

  if (error && !detail) {
    return (
      <div className="panel">
        <div className="error">{error}</div>
        <button onClick={onClose}>Back</button>
      </div>
    );
  }
  if (!detail) return <div className="panel">Loading…</div>;

  const shown = revealMode ? detail.argumentsRevealed : detail.argumentsRaw;

  return (
    <div className="panel">
      <div className="toolbar">
        <button onClick={onClose}>← Back</button>
        <div className="spacer" />
        <span className="badge">{detail.approval.serverId}</span>
        <span className="badge">{detail.approval.toolName}</span>
      </div>

      <div className="meta-row">
        <span>principal: {detail.approval.principal}</span>
        <span>expires: {detail.approval.expiresAt}</span>
      </div>

      <p>{detail.approval.reason}</p>

      <div className="toolbar">
        <strong style={{ fontSize: 13 }}>Exact arguments</strong>
        <div className="spacer" />
        <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={revealMode} onChange={(e) => setRevealMode(e.target.checked)} />
          reveal mode (surface zero-width / RTL-override / NBSP tricks)
        </label>
      </div>
      <div className="args-block">
        {JSON.stringify(shown, null, 2)
          .split("\n")
          .map((line, i) => (
            <div key={i} className={revealMode && /\[(ZWSP|ZWNJ|ZWJ|LRM|RLM|LRE|RLE|PDF|LRO|RLO|WJ|BOM|NBSP|U\+[0-9A-F]{4})\]/.test(line) ? "reveal-diff" : undefined}>
              {line}
            </div>
          ))}
      </div>

      <div className="toolbar">
        <button className="danger" disabled={busy} onClick={() => decide("deny")}>
          Deny
        </button>
        <button className="primary" disabled={busy} onClick={() => decide("approve")}>
          Approve exactly this call
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
