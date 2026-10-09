import { useState } from "react";

import { AuthComponent, type AuthMode } from "@/components/ui/sign-up";
import { login, signup, type Session } from "@/lib/accounts";

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

  async function handleSubmit(email: string, password: string): Promise<void> {
    const session = mode === "login" ? await login(email, password) : await signup(email, password);
    onAuthed(session);
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
    </div>
  );
}
