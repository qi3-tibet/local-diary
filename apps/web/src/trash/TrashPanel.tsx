import type { Entry } from "@diary/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";

type TrashPanelProps = {
  onRestore(entry: Entry): Promise<void>;
};

export function TrashPanel({ onRestore }: TrashPanelProps) {
  const trashQuery = useQuery({
    queryKey: ["trash"],
    queryFn: api.listTrash,
  });
  const [error, setError] = useState<string>();

  async function restore(entry: Entry): Promise<void> {
    setError(undefined);
    try {
      await onRestore(entry);
    } catch {
      setError("THE ENTRY COULD NOT BE RESTORED");
    }
  }

  return (
    <main className="management-page" aria-label="Trash">
      <header className="management-heading">
        <span>TRASH · 30 DAY RETENTION</span>
      </header>

      {trashQuery.isPending ? (
        <p className="management-status" role="status">OPENING TRASH</p>
      ) : trashQuery.isError ? (
        <p className="management-status" role="alert">TRASH COULD NOT BE OPENED</p>
      ) : error ? (
        <p className="management-status" role="alert">{error}</p>
      ) : trashQuery.data.length === 0 ? (
        <p className="management-status">TRASH IS EMPTY</p>
      ) : (
        <ul className="management-list">
          {trashQuery.data.map((entry) => (
            <li key={entry.id}>
              <span className="management-title">{entry.title}</span>
              <div className="management-actions">
                <button
                  type="button"
                  aria-label="Restore entry"
                  onClick={() => void restore(entry)}
                >
                  RESTORE
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
