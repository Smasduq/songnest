"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, Search, Settings, X } from "lucide-react";

interface Props {
  page: "home" | "search" | "library" | "liked" | "diagnostics";
  onNavigate: (page: "home" | "search" | "library" | "liked" | "diagnostics") => void;
  query: string;
  onQueryChange: (q: string) => void;
  onSubmitSearch: () => void;
  onClearSearch: () => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  className?: string;
}

export function MobileHeader({
  page,
  onNavigate,
  query,
  onQueryChange,
  onSubmitSearch,
  onClearSearch,
  onOpenSettings,
  onOpenSearch,
  className,
}: Props) {
  const [showBack, setShowBack] = useState(false);

  useEffect(() => {
    setShowBack(page !== "home" && page !== "search");
  }, [page]);

  const isSearchPage = page === "search";

  return (
    <header
      id="mobile-header"
      className={`glass-bar fixed left-0 right-0 top-0 z-40 flex h-14 flex-shrink-0 items-center gap-2 px-3 md:hidden ${className ?? ""}`}
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {isSearchPage ? (
        <form
          className="relative h-10 min-w-0 flex-1 self-center"
          onSubmit={(e) => {
            e.preventDefault();
            (document.activeElement as HTMLElement | null)?.blur?.();
            onSubmitSearch();
          }}
        >
          <div className="flex h-full items-center gap-1 rounded-full border-0 bg-surface/80 px-3 pr-1 backdrop-blur focus-within:outline-none">
            <input
              id="mobile-songnest-search"
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search artist or song"
              aria-label="Search artist or song"
              className="h-full min-w-0 flex-1 whitespace-nowrap bg-transparent text-left text-base text-foreground placeholder:text-muted-foreground focus:outline-none no-focus-ring"
            />
            {query !== "" && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={onClearSearch}
                className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-foreground/10"
              >
                <X className="h-4 w-4" />
              </button>
            )}
            <button
              type="submit"
              aria-label="Search"
              className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Search className="h-4 w-4" />
            </button>
          </div>
        </form>
      ) : showBack ? (
        <button
          type="button"
          onClick={() => onNavigate("home")}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-foreground/5"
          aria-label="Back"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      ) : (
        <img
          src="/songnest-logo.png"
          alt="Songnest"
          className="logo-mark h-8 w-8 flex-shrink-0 rounded-full object-cover"
        />
      )}

      {!isSearchPage && (
        <span className="flex min-w-0 flex-1 truncate text-base font-semibold text-foreground">
          {page === "library" ? "Your Library" : page === "liked" ? "Liked Songs" : page === "diagnostics" ? "Diagnostics" : "Home"}
        </span>
      )}

      {!isSearchPage && page === "home" && (
        <button
          type="button"
          onClick={onOpenSearch}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-foreground/5"
          aria-label="Search"
        >
          <Search className="h-5 w-5" />
        </button>
      )}

      {!isSearchPage && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-foreground/5"
          aria-label="Settings"
        >
          <Settings className="h-5 w-5" />
        </button>
      )}
    </header>
  );
}