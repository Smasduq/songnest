import { Loader2 } from "lucide-react";

/**
 * Account status card (used at the top of Diagnostics, reachable from
 * both desktop and mobile). Shows sign-in state, manual sync, and the
 * last sync error in plain language.
 */
export function AccountCard({
  email,
  syncing,
  lastError,
  onSignIn,
  onSignOut,
  onSyncNow,
}: {
  email: string | null;
  syncing: boolean;
  lastError: string | null;
  onSignIn: () => void;
  onSignOut: () => void;
  onSyncNow: () => void;
}) {
  return (
    <div className="rounded-2xl border border-border/40 bg-background/60 px-4 py-3 backdrop-blur-xl">
      <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
        Songnest account
      </p>
      {email === null ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="flex-1 text-sm text-muted-foreground">
            Not signed in — sync likes across devices.
          </span>
          <button
            type="button"
            onClick={onSignIn}
            className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
          >
            Sign in
          </button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate text-sm text-foreground">{email}</span>
            <button
              type="button"
              onClick={onSyncNow}
              disabled={syncing}
              className="rounded-full border border-border/60 px-3 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {syncing ? "Syncing…" : "Sync now"}
            </button>
            <button
              type="button"
              onClick={onSignOut}
              className="rounded-full border border-border/60 px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Sign out
            </button>
          </div>
          {syncing && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Syncing likes…
            </p>
          )}
          {lastError !== null && !syncing && (
            <p className="text-xs text-muted-foreground">{lastError}</p>
          )}
        </div>
      )}
    </div>
  );
}
