import { useState } from "react";
import { login } from "./api";

export function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(token);
      onLoggedIn();
    } catch {
      setError("Wrong approver token.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ maxWidth: 360, margin: "80px auto" }}>
      <h1>gatekeep</h1>
      <p className="subtitle">Approval inbox — sign in with the approver token</p>
      <form onSubmit={submit}>
        <input
          type="password"
          placeholder="Approver token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
        />
        <div className="toolbar">
          <button type="submit" className="primary" disabled={busy || !token}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}
