import { useEffect, useState } from "react";

import { Check, Monitor, Moon, Sun, Wrench, WifiOff, KeyRound, Server, Palette } from "lucide-react";
import type { DeviceCode, Health } from "@/lib/api";
import { logoutAuth, pollAuthStatus, requestDeviceCode } from "@/lib/api";
import type { Theme } from "@/components/header";

const THEMES: { id: Theme; label: string; icon: typeof Sun }[] = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
];

function Section({ icon: Icon, title, children }: { icon: typeof Sun; title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="flex items-center gap-1.5 px-2 pb-2 text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {title}
      </p>
      {children}
    </section>
  );
}

export function SettingsPanel({
  theme,
  onPickTheme,
  server,
  serverUrl,
  onSaveServerUrl,
  onOpenDiagnostics,
  authed,
  onAuthChange,
  active,
}: {
  theme: Theme;
  onPickTheme: (t: Theme) => void;
  server: Health | null;
  serverUrl: string;
  onSaveServerUrl: (url: string) => void;
  onOpenDiagnostics: () => void;
  authed: boolean;
  onAuthChange: () => void;
  /** whether the panel is visible — drives sign-in polling */
  active: boolean;
}) {
  // fresh mount per open (AnimatePresence), so the initial draft is current
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

  // device-code sign-in polling: once a code is showing, poll on the
  // server's interval until it resolves or the panel closes
  useEffect(() => {
    if (!active || code === null || authed) return;
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
  }, [active, code, authed, onAuthChange]);

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
    <div className="space-y-5">
      <Section icon={Palette} title="Appearance">
        <div
          role="group"
          aria-label="Theme"
          className="grid grid-cols-3 gap-1 rounded-2xl bg-foreground/5 p-1"
        >
          {THEMES.map((o) => {
            const Icon = o.icon;
            const on = theme === o.id;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => onPickTheme(o.id)}
                aria-pressed={on}
                className={`flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-medium transition-colors ${
                  on
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {o.label}
                {on && <Check className="h-3 w-3" aria-hidden />}
              </button>
            );
          })}
        </div>
      </Section>

      <Section icon={Server} title="Server">
        <form
          className="flex items-center gap-2 rounded-2xl bg-foreground/5 py-1 pl-4 pr-1"
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
            className="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none no-focus-ring"
          />
          <button
            type="submit"
            className="h-9 flex-shrink-0 rounded-xl bg-primary px-4 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Set
          </button>
        </form>
      </Section>

      <Section icon={KeyRound} title="YouTube sign-in">
        <div className="rounded-2xl bg-foreground/5 px-4 py-3">
          {authed ? (
            <div className="flex items-center gap-2">
              <span className="flex-1 text-xs text-muted-foreground">
                Signed in — sources treat requests as yours.
              </span>
              <button
                type="button"
                disabled={authBusy}
                onClick={() => void signOut()}
                className="h-8 flex-shrink-0 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
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
              className="h-9 w-full rounded-xl bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
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
      </Section>

      <button
        type="button"
        onClick={onOpenDiagnostics}
        className="flex w-full items-center gap-2.5 rounded-2xl bg-foreground/5 px-4 py-3 text-left text-sm text-muted-foreground hover:text-foreground"
      >
        <Wrench className="h-4 w-4" aria-hidden />
        Downloader diagnostics
      </button>

      {server === null ? (
        <p className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
          <span>Offline</span>
        </p>
      ) : (
        <dl className="flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
          <div className="flex gap-1">
            <dt>yt-dlp</dt>
            <dd className="text-foreground">{server.yt_dlp || "?"}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Queued</dt>
            <dd className="text-foreground">{server.queue_depth}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Cooldown</dt>
            <dd className="text-foreground">
              {server.cooldown_secs > 0 ? `${server.cooldown_secs}s` : "none"}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}
