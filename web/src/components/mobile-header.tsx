"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, Search, Mic } from "lucide-react";

interface Props {
  theme: "light" | "dark" | "system";
  onPickTheme: (t: "light" | "dark" | "system") => void;
  page: "home" | "search" | "library" | "liked" | "diagnostics";
  onNavigate: (page: "home" | "search" | "library" | "liked" | "diagnostics") => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  className?: string;
}

export function MobileHeader({
  page,
  onNavigate,
  onOpenSearch,
  onOpenSettings,
  className,
}: Props) {
  const [showBack, setShowBack] = useState(false);

  useEffect(() => {
    setShowBack(page !== "home" && page !== "search");
  }, [page]);

  return (
    <header
      id="mobile-header"
      className={`glass-bar fixed top-0 left-0 right-0 z-40 h-14 flex-shrink-0 items-center gap-2 px-3 md:hidden ${className ?? ""}`}
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {showBack ? (
        <button
          type="button"
          onClick={() => onNavigate("home")}
          className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-foreground/5"
          aria-label="Back"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 truncate text-base font-semibold text-foreground">
          {page === "search" ? "Search" : page === "library" ? "Your Library" : page === "liked" ? "Liked Songs" : "Home"}
        </span>
      )}

      {page === "home" ? (
        <button
          type="button"
          onClick={onOpenSearch}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-foreground/5"
          aria-label="Search"
        >
          <Search className="h-5 w-5" />
        </button>
      ) : page === "search" ? (
        <button
          type="button"
          onClick={onOpenSearch}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-foreground/5"
          aria-label="Voice search"
        >
          <Mic className="h-5 w-5" />
        </button>
      ) : (
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-foreground/5"
          aria-label="Settings"
        >
          <Search className="h-5 w-5" />
        </button>
      )}
    </header>
  );
}