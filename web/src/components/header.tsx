import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { Search, Settings, X } from "lucide-react";
import { SettingsPanel } from "@/components/settings-panel";
import {
  SearchSuggestDropdown,
  useAutocomplete,
} from "@/components/search-suggest";
import type { SearchHit } from "@/lib/api";
import type { Page } from "@/components/sidebar";
import { useArtworkColors } from "@/lib/artwork-colors";
import { useCurrentTrack } from "@/player/store";

export type Theme = "light" | "dark" | "system";

const THEME_KEY = "songnest-theme";

export function loadTheme(): Theme {
  const raw = localStorage.getItem(THEME_KEY);
  return raw === "dark" || raw === "light" ? raw : "system";
}

/** Apply theme to <html> and persist. Follows the OS when "system". */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(loadTheme);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    function apply() {
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      document.documentElement.classList.toggle("dark", dark);
    }
    apply();
    localStorage.setItem(THEME_KEY, theme);
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  return { theme, setTheme };
}

export function Header({
  theme,
  onPickTheme,
  query,
  onQueryChange,
  onSubmitSearch,
  onClearSearch,
  onPickSuggest,
  onOpenDiagnostics,
  accountEmail,
  onOpenAccount,
  onOpenUpdates,
  className,
  page,
}: {
  theme: Theme;
  onPickTheme: (t: Theme) => void;
  query: string;
  onQueryChange: (q: string) => void;
  onSubmitSearch: () => void;
  onClearSearch: () => void;
  /** Typeahead pick: fills the query and runs the full search. */
  onPickSuggest?: (hit: SearchHit) => void;
  onOpenDiagnostics: () => void;
  accountEmail: string | null;
  onOpenAccount: () => void;
  onOpenUpdates: () => void;
  className?: string;
  page?: Page;
}) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLFormElement>(null);
  const reduceMotion = useReducedMotion();
  // Search button borrows the current artwork's palette (primary when idle).
  const track = useCurrentTrack();
  const artwork = useArtworkColors(track?.coverUrl ?? "");
  const artBg = track?.coverUrl !== undefined && track.coverUrl !== "" ? artwork.first : null;
  // pill widths in px, measured from the in-flow slot (never mutated)
  const [pillW, setPillW] = useState({ rest: 0, expanded: 0 });
  // overlay (pill expands over the wordmark, wordmark fades) only where
  // space is tight; on desktop the pill stays put and the logo never fades
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 767px)").matches
  );
  const overlaid = focused && narrow;
  // live typeahead under the pill (only while focused to avoid stray requests)
  const { suggestions, loading, clear } = useAutocomplete(focused ? query : "");
  const [highlight, setHighlight] = useState(-1);
  const suggestOpen =
    focused && (loading || suggestions.length > 0) && query.trim().length >= 2;
  useEffect(() => {
    setHighlight(-1);
  }, [suggestions]);
  function pickSuggest(hit: SearchHit) {
    clear();
    setHighlight(-1);
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (onPickSuggest !== undefined) {
      onPickSuggest(hit);
      return;
    }
    onQueryChange(`${hit.title} ${hit.artist}`);
    onSubmitSearch();
  }

  function measure(): { rest: number; expanded: number } {
    const slot = slotRef.current?.clientWidth ?? 0;
    // wordmark slot (104px) + header gap (12px) reclaimed on expand
    return { rest: slot, expanded: slot + 104 + 12 };
  }

  function expand() {
    setPillW(measure());
    setFocused(true);
  }

  // initial widths so the pill renders at rest size before first focus
  useEffect(() => {
    setPillW(measure());
    function onResize() {
      setNarrow(window.matchMedia("(max-width: 767px)").matches);
      setPillW((w) => (document.activeElement?.id === "songnest-search" ? w : measure()));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    function close(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open ]);

  return (
    <header
      id="app-header"
      className={`relative z-50 hidden h-14 flex-shrink-0 items-center gap-3 bg-card px-4 md:flex ${className ?? ""}`}
    >
      {page !== "search" && (
        <span className="w-[104px] flex-shrink-0 overflow-hidden" aria-hidden={overlaid}>
          <motion.span
            className="flex items-center gap-1.5 text-sm font-semibold tracking-tight text-foreground"
            initial={false}
            animate={overlaid ? { opacity: 0, x: -8 } : { opacity: 1, x: 0 }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { type: "spring", stiffness: 400, damping: 35 }
            }
            style={{ pointerEvents: overlaid ? "none" : "auto" }}
          >
            <img
              src="/songnest-logo.png"
              alt="Songnest"
              className="logo-mark h-8 w-8 flex-shrink-0 rounded-full object-cover"
            />
            Songnest
          </motion.span>
        </span>
      )}
      <form
        ref={slotRef}
        className="relative h-10 min-w-0 flex-1 self-center md:mx-auto md:max-w-[480px]"
        onSubmit={(e) => {
          e.preventDefault();
          // release focus so the wordmark returns (Enter-submit otherwise
          // keeps focus and the logo stays hidden behind the pill)
          (document.activeElement as HTMLElement | null)?.blur?.();
          clear();
          // keyboard-enter on a highlighted suggestion searches for it
          if (highlight >= 0 && suggestions[highlight] !== undefined) {
            pickSuggest(suggestions[highlight]);
            return;
          }
          onSubmitSearch();
        }}
      >
        {/* out-of-flow pill: width animates here only, header never reflows */}
        <div
          style={{ contain: "layout paint", transform: "translateZ(0)" }}
          className="absolute bottom-0 right-0 top-0"
        >
          <motion.div
            initial={false}
            animate={{ width: overlaid ? pillW.expanded : pillW.rest }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { type: "spring", stiffness: 400, damping: 35 }
            }
            className="flex h-full items-center gap-1 rounded-full border-0 bg-surface/80 py-0 pl-4 pr-1 backdrop-blur focus-within:outline-none"
            style={{
              zIndex: 10,
              backgroundColor:
                artBg !== null
                  ? `color-mix(in srgb, ${artBg} 22%, transparent)`
                  : undefined,
            }}
          >
            <input
              id="songnest-search"
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onFocus={() => expand()}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                if (!suggestOpen) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlight((h) =>
                    suggestions.length === 0
                      ? -1
                      : h >= suggestions.length - 1
                        ? 0
                        : h + 1
                  );
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlight((h) =>
                    suggestions.length === 0
                      ? -1
                      : h <= 0
                        ? suggestions.length - 1
                        : h - 1
                  );
                } else if (e.key === "Escape") {
                  clear();
                  setHighlight(-1);
                }
              }}
              placeholder="Search artist or song"
              aria-label="Search artist or song"
              role="combobox"
              aria-expanded={suggestOpen}
              aria-controls="songnest-search-suggest"
              aria-activedescendant={
                highlight >= 0 && suggestions[highlight] !== undefined
                  ? `songnest-suggest-${suggestions[highlight].dz}`
                  : undefined
              }
              className="h-full min-w-0 flex-1 whitespace-nowrap bg-transparent text-left text-sm text-foreground placeholder:text-muted-foreground focus:outline-none no-focus-ring"
            />
            {query !== "" && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={onClearSearch}
                className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
            <button
              type="submit"
              aria-label="Search"
              style={artBg !== null ? { backgroundColor: artBg } : undefined}
              className={`flex h-8 w-8 flex-none items-center justify-center rounded-full transition ${
                artBg !== null
                  ? "text-white hover:brightness-110 active:scale-95"
                  : "bg-primary text-primary-foreground hover:bg-primary/90"
              }`}
            >
              <Search className="h-4 w-4" />
            </button>
          </motion.div>
        </div>
        {suggestOpen && (
          <SearchSuggestDropdown
            listId="songnest-search-suggest"
            suggestions={suggestions}
            loading={loading}
            highlight={highlight}
            onHighlight={setHighlight}
            onPick={pickSuggest}
          />
        )}
      </form>
      {page !== "search" && (
        <div ref={menuRef} className="relative ml-auto flex-shrink-0">
          <button
            type="button"
            aria-label="Open settings"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className={`flex h-9 w-9 items-center justify-center rounded-full backdrop-blur transition-colors ${
              open
                ? "bg-foreground/5 text-foreground"
                : "bg-background/60 text-muted-foreground hover:text-foreground"
            }`}
          >
            <Settings className="h-4 w-4" />
          </button>
          <AnimatePresence>
            {open && (
              <motion.div
                key="settings-menu"
                initial={{ opacity: 0, scale: 0.96, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 400, damping: 35 }}
                className="absolute right-0 top-11 z-30 max-h-[70vh] w-72 overflow-y-auto rounded-3xl border-0 bg-background/95 p-4 shadow-[0_20px_60px_rgba(15,23,42,0.35)] backdrop-blur-2xl"
              >
                <SettingsPanel
                  theme={theme}
                  onPickTheme={onPickTheme}
                  accountEmail={accountEmail}
                  onOpenAccount={() => {
                    setOpen(false);
                    onOpenAccount();
                  }}
                  onOpenDiagnostics={() => {
                    setOpen(false);
                    onOpenDiagnostics();
                  }}
                  onOpenUpdates={() => {
                    setOpen(false);
                    onOpenUpdates();
                  }}
                />
              </motion.div>
          )}
        </AnimatePresence>
      </div>
      )}
    </header>
  );
}
