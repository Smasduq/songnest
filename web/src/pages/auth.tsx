import { useState } from "react";

import { AuthComponent, type AuthMode } from "@/components/ui/sign-up";
import {
  AccountsError,
  LOCAL_ACCOUNTS_URL,
  getAccountsUrl,
  login,
  resetAccountsUrl,
  signup,
  type Session,
} from "@/lib/accounts";

/**
 * Songnest sign-in / sign-up page.
 *
 * Wraps AuthComponent (visuals untouched) with real API calls:
 * signup mode creates the account, login mode signs in. On success the
 * caller (`onAuthed`) runs the first merge + sync.
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
      />
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
