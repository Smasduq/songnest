import { useEffect, useState } from "react";

import { fetchAutocomplete, type SearchHit } from "@/lib/api";
import { Search } from "lucide-react";

/** Debounced typeahead: min 2 chars, ~250ms, previous request aborted
 *  so fast typing never shows stale suggestions. */
export function useAutocomplete(query: string) {
  const [suggestions, setSuggestions] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    let alive = true;
    setLoading(true);
    const t = window.setTimeout(() => {
      fetchAutocomplete(q, ctrl.signal)
        .then((hits) => {
          if (alive) setSuggestions(hits);
        })
        .catch(() => {
          if (alive) setSuggestions([]);
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  function clear() {
    setSuggestions([]);
    setLoading(false);
  }

  return { suggestions, loading, clear };
}

export function SearchSuggestDropdown({
  listId,
  suggestions,
  loading,
  highlight,
  onHighlight,
  onPick,
}: {
  listId: string;
  suggestions: SearchHit[];
  loading: boolean;
  highlight: number;
  onHighlight: (i: number) => void;
  onPick: (hit: SearchHit) => void;
}) {
  if (!loading && suggestions.length === 0) return null;
  return (
    <div
      role="listbox"
      id={listId}
      aria-label="Search suggestions"
      className="absolute inset-x-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-border/50 bg-background/95 shadow-[0_20px_60px_rgba(15,23,42,0.35)] backdrop-blur-2xl"
    >
      {loading && suggestions.length === 0 ? (
        <div
          className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-muted-foreground"
          aria-live="polite"
        >
          <Search className="h-4 w-4 animate-pulse" />
          Searching…
        </div>
      ) : (
        <ul className="max-h-72 overflow-y-auto p-1.5">
          {suggestions.map((h, i) => (
            <li key={h.dz} role="option" aria-selected={i === highlight}>
              <button
                type="button"
                onMouseDown={(e) => {
                  // fire before input blur closes the list
                  e.preventDefault();
                  onPick(h);
                }}
                onMouseEnter={() => onHighlight(i)}
                className={`flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left ${
                  i === highlight ? "bg-primary/10" : "hover:bg-primary/5"
                }`}
              >
                {h.cover !== "" ? (
                  <img
                    src={h.cover}
                    alt=""
                    draggable={false}
                    loading="lazy"
                    className="h-9 w-9 flex-shrink-0 rounded-lg object-cover"
                  />
                ) : (
                  <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-foreground/10">
                    <Search className="h-4 w-4 text-muted-foreground" />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {h.title}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {h.artist}
                    {h.album !== "" ? ` · ${h.album}` : ""}
                  </span>
                </span>
                <Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
