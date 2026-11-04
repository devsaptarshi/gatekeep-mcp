import { useEffect, useState } from "react";
import { listApprovals, logout } from "./api";
import type { ApprovalSummary } from "./types";

export function ApprovalListView({
  onSelect,
  onLoggedOut,
}: {
  onSelect: (id: string) => void;
  onLoggedOut: () => void;
}) {
  const [approvals, setApprovals] = useState<ApprovalSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const body = await listApprovals();
      setApprovals(body.approvals);
      setError(null);
    } catch {
      setError("Session expired — please sign in again.");
      onLoggedOut();
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="panel">
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Pending approvals</h1>
        <div className="spacer" />
        <button
          onClick={() => {
            logout().finally(onLoggedOut);
          }}
        >
          Sign out
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {approvals.length === 0 ? (
        <div className="empty">No pending approvals right now.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Principal</th>
              <th>Reason</th>
              <th>Expires</th>
            </tr>
          </thead>
          <tbody>
            {approvals.map((a) => (
              <tr key={a.id} className="row" onClick={() => onSelect(a.id)}>
                <td>
                  <span className="badge">{a.serverId}</span> {a.toolName}
                </td>
                <td>{a.principal}</td>
                <td>{a.reason}</td>
                <td>{a.expiresAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
