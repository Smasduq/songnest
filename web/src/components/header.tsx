import { useEffect, useRef, useState } from "react";

import { Check, Monitor, Moon, Settings, Sun } from "lucide-react";
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
}: {
  theme: Theme;
  onPickTheme: (t: Theme) => void;
  server: Health | null;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
    <header className="relative z-50 flex h-14 flex-shrink-0 items-center gap-3 rounded-3xl border border-border/40 bg-background/60 px-4 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
      <span className="text-sm font-semibold tracking-tight text-foreground">
        songnest
      </span>
      <div ref={menuRef} className="relative ml-auto">
        <button
          type="button"
          aria-label="Open settings"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur transition-colors ${
            open
              ? "border-foreground/40 bg-foreground/[0.08] text-foreground"
              : "border-border/40 bg-background/60 text-foreground/60 hover:text-foreground"
          }`}
        >
          <Settings className="h-4 w-4" />
        </button>
        {open && (
          <div className="absolute right-0 top-11 z-30 w-64 overflow-hidden rounded-3xl border border-border/50 bg-background/95 p-3 shadow-[0_20px_60px_rgba(15,23,42,0.35)] backdrop-blur-2xl">
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
          </div>
        )}
      </div>
    </header>
  );
}
