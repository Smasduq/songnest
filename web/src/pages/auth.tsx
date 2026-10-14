import { useEffect, useRef, useState } from "react";

import { AuthComponent, type AuthMode } from "@/components/ui/sign-up";
import {
  AccountsError,
  LOCAL_ACCOUNTS_URL,
  finishOAuthLogin,
  getAccountsUrl,
  login,
  pollGithubDevice,
  resetAccountsUrl,
  signup,
  startGithubDevice,
  startGoogleLogin,
  type GithubDeviceStart,
  type Session,
} from "@/lib/accounts";

/**
 * Songnest sign-in / sign-up page.
 *
 * Wraps AuthComponent (visuals untouched) with real API calls:
 * signup mode creates the account, login mode signs in. On success the
 * caller (`onAuthed`) runs the first merge + sync.
 *
 * OAuth (GitHub + Google): the provider button redirects via
 * `GET /auth/<provider>/start`; the provider returns to `/?code=…&state=…`
 * and this page exchanges the code via `POST /auth/<provider>/callback`.
 * The secret never leaves the accounts server. In Tauri bundles the same
 * buttons run the loopback flow instead (local callback server, system
 * browser) and log in without leaving the app.
 *
 * No props required besides `onAuthed`; renders full-screen.
 */

function SongnestLogo() {
  return (
    <img
      src="/songnest-logo.png"
      alt="Songnest"
      className="logo-mark h-8 w-8 rounded-full object-cover"
    />
  );
}

export default function AuthPage({ onAuthed, onBack }: { onAuthed: (session: Session) => void; onBack?: () => void }) {
  const [mode, setMode] = useState<AuthMode>("signup");
  const [unreachableUrl, setUnreachableUrl] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  // GitHub device flow: code shown to the user, polled until approved.
  const [device, setDevice] = useState<GithubDeviceStart | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const pollTimer = useRef<number | undefined>(undefined);

  function stopDevicePolling(): void {
    window.clearTimeout(pollTimer.current);
  }

  useEffect(() => stopDevicePolling, []);

  // OAuth return trip: provider lands on `/?code=…&state=…`.
  // A denied/cancelled login returns `/?error=…` instead — surface that
  // as a real failure state, not a silent landing.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const error = params.get("error");
    if ((code === null || code === "") && (error === null || error === "")) return;
    if (code === null || code === "") {
      setOauthError(
        error === "access_denied"
          ? "Login was cancelled on the provider — try again when ready."
          : "Login failed before reaching Songnest — try again.",
      );
      const clean = new URL(window.location.href);
      clean.searchParams.delete("error");
      clean.searchParams.delete("error_description");
      clean.searchParams.delete("state");
      window.history.replaceState(null, "", clean.toString());
      return;
    }
    const state = params.get("state");
    setOauthBusy(true);
    setOauthError(null);
    finishOAuthLogin(code, state).then(
      ({ session }) => {
        // Drop the one-time code from the URL before continuing.
        const clean = new URL(window.location.href);
        clean.searchParams.delete("code");
        clean.searchParams.delete("state");
        window.history.replaceState(null, "", clean.toString());
        onAuthed(session);
      },
      (e: unknown) => {
        setOauthBusy(false);
        setOauthError(
          e instanceof AccountsError ? e.message : "Login failed — try again.",
        );
        const clean = new URL(window.location.href);
        clean.searchParams.delete("code");
        clean.searchParams.delete("state");
        window.history.replaceState(null, "", clean.toString());
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(email: string, password: string): Promise<void> {
    try {
      const session = mode === "login" ? await login(email, password) : await signup(email, password);
      setUnreachableUrl(null);
      onAuthed(session);
    } catch (e) {
      // The build already targets the local API; a stale runtime override
      // (e.g. a hosted URL from earlier testing) is the usual cause of
      // "can't reach the server" — offer a one-click way back to local.
      if (e instanceof AccountsError && e.code === "unreachable") {
        setUnreachableUrl(getAccountsUrl());
      }
      throw e;
    }
  }

  async function handleOAuth(start: () => Promise<Session | null>): Promise<void> {
    if (oauthBusy) return;
    setOauthBusy(true);
    setOauthError(null);
    try {
      const session = await start();
      if (session === null) {
        // Web flow: navigated away; busy stays true until navigation.
        return;
      }
      // Native flow: loopback login completed in-app.
      setOauthBusy(false);
      onAuthed(session);
    } catch (e) {
      setOauthBusy(false);
      if (e instanceof AccountsError && e.code === "unreachable") {
        setUnreachableUrl(getAccountsUrl());
      }
      setOauthError(
        e instanceof AccountsError ? e.message : "Login failed — try again.",
      );
    }
  }

  /** GitHub via device flow: no callback URL needed. Shows a code, polls
   *  until the user approves at github.com/login/device. The code is
   *  copied to the clipboard automatically (tap it to copy again). */
  async function handleGithubDevice(): Promise<void> {
    if (oauthBusy || device !== null) return;
    await runDeviceFlow();
  }

  async function runDeviceFlow(): Promise<void> {
    setOauthBusy(true);
    setOauthError(null);
    setDeviceError(null);
    setCopiedCode(false);
    try {
      const started = await startGithubDevice();
      setDevice(started);
      // Best effort: transient activation usually survives the fetch, so
      // this succeeds when launched from the button tap. The code stays
      // tappable as a fallback.
      setCopiedCode(await copyText(started.user_code));
      pollDevice(started, Date.now() + started.expires_in * 1000);
    } catch (e) {
      setOauthBusy(false);
      if (e instanceof AccountsError && e.code === "unreachable") {
        setUnreachableUrl(getAccountsUrl());
      }
      setOauthError(
        e instanceof AccountsError ? e.message : "GitHub login failed — try again.",
      );
    }
  }

  /** Retry from the modal's error view (bypasses the tap guard). */
  async function retryDevice(): Promise<void> {
    stopDevicePolling();
    setDevice(null);
    await runDeviceFlow();
  }

  /** Copy text to the clipboard, with an execCommand fallback. */
  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        return ok;
      } catch {
        return false;
      }
    }
  }

  function pollDevice(started: GithubDeviceStart, deadline: number): void {
    stopDevicePolling();
    if (Date.now() >= deadline) {
      // Keep the modal open on the error view so the user can retry.
      setDeviceError("Code expired — get a fresh one below.");
      return;
    }
    pollTimer.current = window.setTimeout(() => {
      pollGithubDevice(started.device_code).then(
        (session) => {
          if (session !== null) {
            setDevice(null);
            onAuthed(session);
            return;
          }
          pollDevice(started, deadline);
        },
        (e: unknown) => {
          // Keep the modal open on the error view (denied/expired).
          setDeviceError(
            e instanceof AccountsError ? e.message : "GitHub login failed — try again.",
          );
        },
      );
    }, Math.max(5, started.interval) * 1000);
  }

  function cancelDevice(): void {
    stopDevicePolling();
    setDevice(null);
    setOauthBusy(false);
    setDeviceError(null);
    setCopiedCode(false);
  }

  /** Open the device approval page: system browser in Tauri, new tab otherwise. */
  async function openVerificationUri(uri: string): Promise<void> {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(uri);
    } catch {
      window.open(uri, "_blank", "noopener,noreferrer");
    }
  }

  function useLocalServer(): void {
    resetAccountsUrl();
    setUnreachableUrl(null);
  }

  return (
    <div className="relative">
      {onBack !== undefined && (
        <button
          type="button"
          onClick={onBack}
          className="fixed left-4 top-16 z-30 rounded-full border border-border/60 bg-background/80 px-3 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur hover:text-foreground md:top-4 md:left-auto md:right-4"
        >
          ← Back to app
        </button>
      )}
      <AuthComponent
        key={mode}
        logo={<SongnestLogo />}
        brandName="Songnest"
        mode={mode}
        onModeChange={setMode}
        onSubmit={handleSubmit}
        onGithub={() => void handleGithubDevice()}
        onGoogle={() => void handleOAuth(startGoogleLogin)}
        oauthBusy={oauthBusy}
      />
      {device !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="relative mx-2 flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border-4 border-border bg-card/80 p-8">
            {deviceError === null ? (
              <>
                <p className="text-sm font-medium text-muted-foreground">
                  Enter this code on GitHub
                </p>
                <button
                  type="button"
                  title="Tap to copy"
                  onClick={() => void copyText(device.user_code).then(setCopiedCode)}
                  className="font-mono text-4xl font-bold tracking-widest text-foreground"
                >
                  {device.user_code}
                </button>
                <p className="text-center text-xs text-muted-foreground">
                  {copiedCode ? "Copied — paste it on GitHub." : "Copied to clipboard. Tap the code to copy again."}
                </p>
                <button
                  type="button"
                  onClick={() => void openVerificationUri(device.verification_uri)}
                  className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground"
                >
                  Open github.com/login/device
                </button>
                <p className="text-center text-xs text-muted-foreground">
                  Waiting for approval… this closes on its own.
                </p>
              </>
            ) : (
              <>
                <p className="text-lg font-medium text-foreground">GitHub login failed</p>
                <p className="text-center text-sm text-muted-foreground">{deviceError}</p>
                <button
                  type="button"
                  onClick={() => void retryDevice()}
                  className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground"
                >
                  Get a fresh code
                </button>
              </>
            )}
            <button
              type="button"
              onClick={cancelDevice}
              className="text-sm text-foreground/70 transition-colors hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {oauthError !== null && (
        <p className="mx-auto mt-4 max-w-sm text-center text-xs text-destructive">
          {oauthError}
        </p>
      )}
      {unreachableUrl !== null && unreachableUrl !== LOCAL_ACCOUNTS_URL && (
        <p className="mx-auto mt-4 max-w-sm text-center text-xs text-muted-foreground">
          Trying {unreachableUrl} —{" "}
          <button
            type="button"
            onClick={useLocalServer}
            className="underline underline-offset-2 hover:text-foreground"
          >
            use the local server instead
          </button>
        </p>
      )}
    </div>
  );
}
