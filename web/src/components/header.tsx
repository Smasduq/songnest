import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { Check, Monitor, Moon, Search, Settings, Sun, Wrench, X } from "lucide-react";
import type { DeviceCode, Health } from "@/lib/api";
import { logoutAuth, pollAuthStatus, requestDeviceCode } from "@/lib/api";

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
  authed,
  onAuthChange,
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
  authed: boolean;
  onAuthChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [serverDraft, setServerDraft] = useState(serverUrl);
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNote, setAuthNote] = useState<string | null>(null);

  /** System browser via Tauri opener, else a new tab (desktop dev). */
  async function openExternal(url: string): Promise<boolean> {
    try {
      const mod = await import("@tauri-apps/plugin-opener").catch(() => null);
      const openUrl = mod?.openUrl as ((u: string) => Promise<void>) | undefined;
      if (openUrl !== undefined) {
        await openUrl(url);
        return true;
      }
    } catch {
      // fall through to window.open
    }
    return window.open(url, "_blank", "noopener") !== null;
  }

  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // clipboard API unavailable (permissions, old webview): legacy path
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
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

  // device-code sign-in polling: once a code is showing, poll on the
  // server's interval until it resolves or the menu closes
  useEffect(() => {
    if (!open || code === null || authed) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await pollAuthStatus();
        if (!alive) return;
        if (s === "logged_in") {
          setCode(null);
          setAuthError(null);
          setAuthNote(null);
          onAuthChange();
        } else if (s === "expired") {
          setCode(null);
          setAuthError("Code expired — get a new one and try again.");
        }
      } catch {
        if (alive) setAuthError("Login check failed — will keep trying.");
      }
    };
    const id = window.setInterval(tick, Math.max(3, code.interval) * 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [open, code, authed, onAuthChange]);

  async function startSignIn() {
    setAuthBusy(true);
    setAuthError(null);
    setAuthNote(null);
    try {
      const dc = await requestDeviceCode();
      setCode(dc);
      // one tap: code on the clipboard, verification page in the browser
      const copied = await copyText(dc.user_code);
      const opened = await openExternal(dc.verification_url);
      if (copied && opened) {
        setAuthNote("Code copied — finish signing in in your browser.");
      } else if (copied) {
        setAuthNote("Code copied — enter it at google.com/device.");
      } else if (opened) {
        setAuthNote("Enter the code shown above in your browser.");
      }
    } catch (e: unknown) {
      setAuthError(e instanceof Error ? e.message : "sign-in failed");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    setAuthBusy(true);
    try {
      await logoutAuth();
      onAuthChange();
    } catch {
      // ignore
    } finally {
      setAuthBusy(false);
    }
  }

  return (
    <header
      id="app-header"
      className="glass-bar relative z-50 flex h-14 flex-shrink-0 items-center gap-3 rounded-3xl border border-border/40 px-4 max-md:fixed max-md:inset-x-3 max-md:top-[calc(0.75rem+env(safe-area-inset-top))]"
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
              className="h-full min-w-0 flex-1 whitespace-nowrap bg-transparent text-left text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
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
              className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
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
              ? "border-foreground/40 bg-foreground/5 text-foreground"
              : "border-border/40 bg-background/60 text-muted-foreground hover:text-foreground"
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
            <p className="px-2 pb-1.5 text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
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
                        ? "border-foreground/40 bg-foreground/5 text-foreground"
                        : "border-border/30 text-muted-foreground hover:border-border/60 hover:text-foreground"
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
            <p className="px-2 pb-1.5 pt-3 text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
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
                className="h-8 min-w-0 flex-1 rounded-full border border-border/60 bg-surface/80 px-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="submit"
                className="h-8 flex-shrink-0 rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                Set
              </button>
            </form>
            <p className="px-2 pb-1.5 pt-3 text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              YouTube sign-in
            </p>
            <div className="px-2 pb-2">
              {authed ? (
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-xs text-muted-foreground">
                    Signed in — sources treat requests as yours.
                  </span>
                  <button
                    type="button"
                    disabled={authBusy}
                    onClick={() => void signOut()}
                    className="h-8 flex-shrink-0 rounded-full border border-border/60 px-3 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    Sign out
                  </button>
                </div>
              ) : code !== null ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">
                    Enter this code at{" "}
                    <span className="font-medium text-foreground">
                      {code.verification_url.replace(/^https?:\/\//, "")}
                    </span>{" "}
                    in your browser:
                  </p>
                  <p className="text-center text-2xl font-bold tracking-[0.2em] text-foreground">
                    {code.user_code}
                  </p>
                  <p className="text-center text-xs text-muted-foreground">
                    Waiting for you — valid about {Math.max(1, Math.round(code.expires_in / 60))} min.
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={authBusy}
                  onClick={() => void startSignIn()}
                  className="h-8 w-full rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {authBusy ? "Starting…" : "Sign in with YouTube"}
                </button>
              )}
              {authError !== null && (
                <p className="pt-1 text-xs text-muted-foreground">{authError}</p>
              )}
              {authNote !== null && (
                <p className="pt-1 text-xs text-muted-foreground">{authNote}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenDiagnostics();
              }}
              className="mt-1 flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-muted-foreground hover:bg-foreground/5"
            >
              <Wrench className="h-4 w-4" />
              Downloader diagnostics
            </button>
            {server === null ? (
              <p className="px-2 text-xs text-foreground/60">
                Unreachable — is the backend on :8787?
              </p>
            ) : (
              <dl className="space-y-1 px-2 text-xs text-muted-foreground">
                <div className="flex justify-between">
                  <dt>yt-dlp</dt>
                  <dd className="text-foreground">{server.yt_dlp || "?"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Queued</dt>
                  <dd className="text-foreground">{server.queue_depth}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Cooldown</dt>
                  <dd className="text-foreground">
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
