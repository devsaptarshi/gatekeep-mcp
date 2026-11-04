import { useState } from "react";
import { LoginScreen } from "./LoginScreen";
import { ApprovalListView } from "./ApprovalListView";
import { ApprovalDetailView } from "./ApprovalDetailView";

export function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (!loggedIn) {
    return <LoginScreen onLoggedIn={() => setLoggedIn(true)} />;
  }

  if (selectedId) {
    return (
      <ApprovalDetailView
        id={selectedId}
        onDecided={() => setSelectedId(null)}
        onClose={() => setSelectedId(null)}
      />
    );
  }

  return (
    <ApprovalListView
      onSelect={setSelectedId}
      onLoggedOut={() => {
        setLoggedIn(false);
        setSelectedId(null);
      }}
    />
  );
}
