import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  AccountsError,
  fetchProfile,
  type Session,
} from "@/lib/accounts";

/**
 * Dedicated profile page (`#profile`).
 *
 * Shows the signed-in user's identity (fresh from `GET /me` when
 * reachable, falling back to the cached session), library stats, sync
 * state, and sign-out. When signed out it prompts to sign in.
 */
export default function ProfilePage({
  account,
  syncing,
  lastError,
  libraryCount,
  likedCount,
  pendingCount,
  onSignIn,
  onSignOut,
  onSyncNow,
  onLoggedOut,
}: {
  account: Session | null;
  syncing: boolean;
  lastError: string | null;
  libraryCount: number;
  likedCount: number;
  pendingCount: number;
  onSignIn: () => void;
  onSignOut: () => void;
  onSyncNow: () => void;
  onLoggedOut: () => void;
}) {
  const [serverEmail, setServerEmail] = useState<string | null>(null);
  const [serverId, setServerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (account === null) {
      setServerEmail(null);
      setServerId(null);
      return;
    }
    let alive = true;
    setLoading(true);
    fetchProfile().then(
      (p) => {
        if (!alive) return;
        setServerEmail(p.email);
        setServerId(p.id);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setLoading(false);
        if (e instanceof AccountsError && e.code === "logged-out") {
          onLoggedOut();
        }
        // Other errors (offline/unreachable): keep cached session values.
      }
    );
    return () => {
      alive = false;
    };
  }, [account, onLoggedOut]);

  if (account === null) {
    return (
      <section className="space-y-3 md:mx-4" aria-label="Profile">
        <div className="rounded-2xl border border-border/40 bg-background/60 px-4 py-6 text-center backdrop-blur-xl">
          <p className="text-base font-semibold text-foreground">Your profile</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Not signed in — sign in to sync likes across devices.
          </p>
          <button
            type="button"
            onClick={onSignIn}
            className="mt-4 rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground"
          >
            Sign in
          </button>
        </div>
      </section>
    );
  }

  const email = serverEmail ?? account.email;
  const userId = serverId ?? account.userId;
  const initial = (email.trim()[0] ?? "?").toUpperCase();

  return (
    <section className="space-y-3 md:mx-4" aria-label="Profile">
      <div className="rounded-2xl border border-border/40 bg-background/60 px-4 py-4 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold text-primary"
          >
            {initial}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-foreground">{email}</p>
            <p className="truncate font-mono text-xs text-muted-foreground" title={userId}>
              {userId}
            </p>
          </div>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />}
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-foreground/5 px-2 py-2.5">
            <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Tracks</dt>
            <dd className="text-lg font-semibold text-foreground">{libraryCount}</dd>
          </div>
          <div className="rounded-xl bg-foreground/5 px-2 py-2.5">
            <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Liked</dt>
            <dd className="text-lg font-semibold text-foreground">{likedCount}</dd>
          </div>
          <div className="rounded-xl bg-foreground/5 px-2 py-2.5">
            <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Pending</dt>
            <dd className="text-lg font-semibold text-foreground">{pendingCount}</dd>
          </div>
        </dl>

        {syncing && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Syncing likes…
          </p>
        )}
        {lastError !== null && !syncing && (
          <p className="mt-3 text-xs text-muted-foreground">{lastError}</p>
        )}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onSyncNow}
            disabled={syncing}
            className="flex-1 rounded-full border border-border/60 px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          <button
            type="button"
            onClick={onSignOut}
            className="flex-1 rounded-full border border-border/60 px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            Sign out
          </button>
        </div>
      </div>
    </section>
  );
}
