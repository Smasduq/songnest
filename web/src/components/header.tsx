import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { Check, Monitor, Moon, Search, Settings, Sun, Wrench, X } from "lucide-react";
import type { Health } from "@/lib/api";

export type Theme = "light" | "dark" | "system";

const THEME_KEY = "songnest-theme";

export function loadTheme(): Theme {
  const raw = localStorage.getItem(THEME_KEY);
  return raw === "dark" || raw === "system" ? raw : "light";
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

const options: { id: Theme; label: string; icon: typeof Sun }[] = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
];

export function Header({
  theme,
  onPickTheme,
  server,
  query,
  onQueryChange,
  onSubmitSearch,
  onClearSearch,
  serverUrl,
  onSaveServerUrl,
  onOpenDiagnostics,
}: {
  theme: Theme;
  onPickTheme: (t: Theme) => void;
  server: Health | null;
  query: string;
  onQueryChange: (q: string) => void;
  onSubmitSearch: () => void;
  onClearSearch: () => void;
  serverUrl: string;
  onSaveServerUrl: (url: string) => void;
  onOpenDiagnostics: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [serverDraft, setServerDraft] = useState(serverUrl);
  const menuRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLFormElement>(null);
  const reduceMotion = useReducedMotion();
  // pill widths in px, measured from the in-flow slot (never mutated)
  const [pillW, setPillW] = useState({ rest: 0, expanded: 0 });
  // overlay (pill expands over the wordmark, wordmark fades) only where
  // space is tight; on desktop the pill stays put and the logo never fades
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 767px)").matches
  );
  const overlaid = focused && narrow;

  function measure(): { rest: number; expanded: number } {
    const slot = slotRef.current?.clientWidth ?? 0;
    // wordmark slot (68px) + header gap (12px) reclaimed on expand
    return { rest: slot, expanded: slot + 68 + 12 };
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
      className="glass-bar relative z-50 flex h-14 flex-shrink-0 items-center gap-3 rounded-3xl border border-border/40 px-4 pt-[env(safe-area-inset-top)] max-md:fixed max-md:inset-x-3 max-md:top-3"
    >
      <span className="w-[68px] flex-shrink-0 overflow-hidden" aria-hidden={overlaid}>
        <motion.span
          className="block text-sm font-semibold tracking-tight text-foreground"
          initial={false}
          animate={overlaid ? { opacity: 0, x: -8 } : { opacity: 1, x: 0 }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { type: "spring", stiffness: 400, damping: 35 }
          }
          style={{ pointerEvents: overlaid ? "none" : "auto" }}
        >
          Songnest
        </motion.span>
      </span>
      <form
        ref={slotRef}
        className="relative h-10 min-w-0 flex-1 self-center md:mx-auto md:max-w-[480px]"
        onSubmit={(e) => {
          e.preventDefault();
          // release focus so the wordmark returns (Enter-submit otherwise
          // keeps focus and the logo stays hidden behind the pill)
          (document.activeElement as HTMLElement | null)?.blur?.();
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
            className="flex h-full items-center gap-1 rounded-full border border-border/60 bg-surface/80 py-0 pl-4 pr-1 backdrop-blur focus-within:outline-none focus-within:ring-2 focus-within:ring-foreground/40"
            style={{ zIndex: 10 }}
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
              placeholder="Search artist or song"
              aria-label="Search artist or song"
              className="h-full min-w-0 flex-1 whitespace-nowrap bg-transparent text-left text-sm text-foreground placeholder:text-foreground/40 focus:outline-none"
            />
            {query !== "" && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={onClearSearch}
                className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-foreground/50 hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
            <button
              type="submit"
              aria-label="Search"
              className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-foreground text-background hover:bg-foreground/90"
            >
              <Search className="h-4 w-4" />
            </button>
          </motion.div>
        </div>
      </form>
      <div ref={menuRef} className="relative ml-auto flex-shrink-0">
        <button
          type="button"
          aria-label="Open settings"
          aria-expanded={open}
          onClick={() => {
            setServerDraft(serverUrl);
            setOpen((o) => !o);
          }}
          className={`flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur transition-colors ${
            open
              ? "border-foreground/40 bg-foreground/[0.08] text-foreground"
              : "border-border/40 bg-background/60 text-foreground/60 hover:text-foreground"
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
              className="absolute right-0 top-11 z-30 w-64 overflow-hidden rounded-3xl border border-border/50 bg-background/95 p-3 shadow-[0_20px_60px_rgba(15,23,42,0.35)] backdrop-blur-2xl"
            >
            <p className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-[0.2em] text-foreground/50">
              Appearance
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {options.map((o) => {
                const Icon = o.icon;
                const on = theme === o.id;
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => onPickTheme(o.id)}
                    aria-pressed={on}
                    className={`flex flex-col items-center gap-1.5 rounded-2xl border px-2 py-3 text-xs transition-colors ${
                      on
                        ? "border-foreground/40 bg-foreground/[0.08] text-foreground"
                        : "border-border/30 text-foreground/60 hover:border-border/60 hover:text-foreground"
                    }`}
                  >
                    <span className="flex items-center gap-1">
                      <Icon className="h-4 w-4" />
                      {on && <Check className="h-3 w-3" />}
                    </span>
                    {o.label}
                  </button>
                );
              })}
            </div>
            <p className="px-2 pb-1.5 pt-3 text-[11px] font-medium uppercase tracking-[0.2em] text-foreground/50">
              Server
            </p>
            <form
              className="flex gap-1.5 px-2 pb-2"
              onSubmit={(e) => {
                e.preventDefault();
                onSaveServerUrl(serverDraft);
              }}
            >
              <input
                value={serverDraft}
                onChange={(e) => setServerDraft(e.target.value)}
                placeholder="http://192.168.1.10:8787"
                autoComplete="off"
                autoCorrect="off"
                aria-label="Server URL"
                className="h-8 min-w-0 flex-1 rounded-full border border-border/60 bg-surface/80 px-3 text-xs text-foreground placeholder:text-foreground/40 focus:outline-none focus:ring-2 focus:ring-foreground/40"
              />
              <button
                type="submit"
                className="h-8 flex-shrink-0 rounded-full bg-foreground px-3 text-xs font-medium text-background hover:bg-foreground/90"
              >
                Set
              </button>
            </form>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenDiagnostics();
              }}
              className="mt-1 flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-foreground/80 hover:bg-foreground/5"
            >
              <Wrench className="h-4 w-4" />
              Downloader diagnostics
            </button>
            {server === null ? (
              <p className="px-2 text-xs text-foreground/60">
                Unreachable — is the backend on :8787?
              </p>
            ) : (
              <dl className="space-y-1 px-2 text-xs text-foreground/60">
                <div className="flex justify-between">
                  <dt>yt-dlp</dt>
                  <dd className="text-foreground/85">{server.yt_dlp || "?"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Queued</dt>
                  <dd className="text-foreground/85">{server.queue_depth}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Cooldown</dt>
                  <dd className="text-foreground/85">
                    {server.cooldown_secs > 0
                      ? `${server.cooldown_secs}s`
                      : "none"}
                  </dd>
                </div>
              </dl>
            )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </header>
  );
}
