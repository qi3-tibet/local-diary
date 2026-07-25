import type { Entry } from "@diary/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";

type SearchPanelProps = {
  onEdit(entry: Entry): void;
  onOpen(entry: Entry): void;
  onTrash(entry: Entry): Promise<void>;
};

export function SearchPanel({ onEdit, onOpen, onTrash }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const normalizedQuery = query.trim();
  const resultsQuery = useQuery({
    queryKey: ["search", normalizedQuery],
    queryFn: () => api.searchEntries(normalizedQuery),
    enabled: normalizedQuery.length > 0,
  });
  const results = normalizedQuery ? (resultsQuery.data ?? []) : [];

  async function moveToTrash(entry: Entry): Promise<void> {
    setError(undefined);
    try {
      await onTrash(entry);
    } catch {
      setError("THE ENTRY COULD NOT BE MOVED TO TRASH");
    }
  }

  return (
    <main className="management-page" aria-label="Diary search">
      <header className="management-heading">
        <span>SEARCH</span>
        <input
          aria-label="Search diary"
          autoFocus
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </header>

      {resultsQuery.isError ? (
        <p className="management-status" role="alert">THE DIARY COULD NOT BE SEARCHED</p>
      ) : error ? (
        <p className="management-status" role="alert">{error}</p>
      ) : normalizedQuery && resultsQuery.isFetching ? (
        <p className="management-status" role="status">SEARCHING</p>
      ) : normalizedQuery && results.length === 0 ? (
        <p className="management-status">NO MATCHING ENTRIES</p>
      ) : (
        <ul className="management-list">
          {results.map((entry) => (
            <li key={entry.id}>
              <button className="management-title" type="button" onClick={() => onOpen(entry)}>
                {entry.title}
              </button>
              {entry.edited ? <span className="edited-mark">EDITED</span> : null}
              <div className="management-actions">
                <button type="button" aria-label="Edit entry" onClick={() => onEdit(entry)}>
                  EDIT
                </button>
                <button
                  type="button"
                  aria-label="Move to trash"
                  onClick={() => void moveToTrash(entry)}
                >
                  MOVE TO TRASH
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
