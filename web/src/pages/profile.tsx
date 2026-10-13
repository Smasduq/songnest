import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  Camera,
  Check,
  Cloud,
  Heart,
  Library,
  Loader2,
  LogOut,
  Music2,
  RefreshCw,
  Trash2,
  UserRound,
} from "lucide-react";
import {
  AVATAR_ACCEPT,
  AVATAR_MAX_BYTES,
  AccountsError,
  deleteAvatar,
  fetchProfile,
  uploadAvatar,
  type Session,
} from "@/lib/accounts";

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Music2;
  label: string;
  value: number;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-border/50 bg-background/65 p-3.5 sm:p-4">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-4 w-4" aria-hidden />
      </div>
      <p className="mt-4 truncate text-2xl font-semibold tracking-tight text-foreground">
        {formatCount(value)}
      </p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

/**
 * Account profile and sync controls. Only expose profile actions supported
 * by the accounts API; account email is read-only and the avatar is editable.
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
  const [remoteProfile, setRemoteProfile] = useState<{
    userId: string;
    email: string;
    avatarUrl: string | null;
  } | null>(null);
  const [profileNotice, setProfileNotice] = useState<{
    userId: string;
    message: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [photoMessage, setPhotoMessage] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const accountUserId = account?.userId ?? null;

  useEffect(() => {
    if (accountUserId === null) return;
    let alive = true;
    fetchProfile().then(
      (profile) => {
        if (!alive) return;
        setRemoteProfile({
          userId: accountUserId,
          email: profile.email,
          avatarUrl: profile.avatar_url,
        });
        setProfileNotice(null);
      },
      (error: unknown) => {
        if (!alive) return;
        if (error instanceof AccountsError && error.code === "logged-out") {
          onLoggedOut();
        } else {
          setProfileNotice({
            userId: accountUserId,
            message:
              error instanceof AccountsError
                ? `Showing saved account details. ${error.message}`
                : "Showing saved account details. Profile details could not be refreshed.",
          });
        }
      }
    );
    return () => {
      alive = false;
    };
  }, [accountUserId, onLoggedOut]);

  async function handleFile(file: File): Promise<void> {
    if (account === null) return;
    const { userId, email } = account;
    setPhotoError(null);
    setPhotoMessage(null);
    if (file.size > AVATAR_MAX_BYTES) {
      setPhotoError("Choose a photo smaller than 512 KB.");
      return;
    }
    if (!AVATAR_ACCEPT.split(",").includes(file.type)) {
      setPhotoError("Choose a JPEG, PNG, WebP, or GIF image.");
      return;
    }

    setUploading(true);
    try {
      const url = await uploadAvatar(await file.arrayBuffer(), file.type);
      setRemoteProfile((profile) =>
        profile?.userId === userId
          ? { ...profile, avatarUrl: url }
          : { userId, email, avatarUrl: url }
      );
      setPhotoMessage("Your profile photo has been updated.");
    } catch (error: unknown) {
      if (error instanceof AccountsError && error.code === "logged-out") {
        onLoggedOut();
        return;
      }
      setPhotoError(
        error instanceof AccountsError
          ? error.message
          : "Couldn't upload your photo. Please try again."
      );
    } finally {
      setUploading(false);
      if (fileRef.current !== null) fileRef.current.value = "";
    }
  }

  async function handleRemovePhoto(): Promise<void> {
    if (account === null) return;
    const { userId, email } = account;
    setPhotoError(null);
    setPhotoMessage(null);
    setUploading(true);
    try {
      await deleteAvatar();
      setRemoteProfile((profile) =>
        profile?.userId === userId
          ? { ...profile, avatarUrl: null }
          : { userId, email, avatarUrl: null }
      );
      setPhotoMessage("Your profile photo has been removed.");
    } catch (error: unknown) {
      if (error instanceof AccountsError && error.code === "logged-out") {
        onLoggedOut();
        return;
      }
      setPhotoError(
        error instanceof AccountsError
          ? error.message
          : "Couldn't remove your photo. Please try again."
      );
    } finally {
      setUploading(false);
    }
  }

  const currentProfile =
    remoteProfile?.userId === accountUserId ? remoteProfile : null;
  const currentProfileNotice =
    profileNotice?.userId === accountUserId ? profileNotice.message : null;
  const loading =
    account !== null && currentProfile === null && currentProfileNotice === null;

  if (account === null) {
    return (
      <section
        aria-label="Profile"
        className="mx-auto w-full max-w-2xl px-4 pb-6 md:px-0"
      >
        <div className="overflow-hidden rounded-3xl border border-border/50 bg-background/70 shadow-sm">
          <div className="relative isolate overflow-hidden px-6 pb-7 pt-8 text-center sm:px-10 sm:pt-10">
            <div
              aria-hidden
              className="absolute -right-10 -top-20 -z-10 h-56 w-56 rounded-full bg-primary/10 blur-3xl"
            />
            <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-primary/10 text-primary">
              <UserRound className="h-8 w-8" aria-hidden />
            </span>
            <p className="mt-5 text-2xl font-semibold tracking-tight text-foreground">
              Make it yours
            </p>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
              Sign in to personalize your profile and keep your liked songs in sync
              across devices.
            </p>
            <button
              type="button"
              onClick={onSignIn}
              className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98] sm:w-auto sm:min-w-48"
            >
              Sign in or create account
            </button>
          </div>
          <div className="grid grid-cols-2 border-t border-border/50">
            <div className="p-4 text-center">
              <p className="text-sm font-medium text-foreground">Your way</p>
              <p className="mt-1 text-xs text-muted-foreground">Build a library that feels like you</p>
            </div>
            <div className="border-l border-border/50 p-4 text-center">
              <p className="text-sm font-medium text-foreground">Everywhere</p>
              <p className="mt-1 text-xs text-muted-foreground">Keep likes close across devices</p>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const email = currentProfile?.email ?? account.email;
  const avatarUrl = currentProfile?.avatarUrl ?? null;
  const initial = (email.trim()[0] ?? "?").toUpperCase();
  const hasPendingChanges = pendingCount > 0;

  return (
    <section
      aria-label="Profile"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-8 md:px-0"
    >
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24, ease: "easeOut" }}
        className="relative isolate overflow-hidden rounded-3xl border border-border/50 bg-card p-5 shadow-sm sm:p-7"
      >
        <div
          aria-hidden
          className="absolute -right-12 -top-20 -z-10 h-64 w-64 rounded-full bg-primary/10 blur-3xl"
        />
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-6">
          <div className="relative mx-auto sm:mx-0">
            {avatarUrl !== null ? (
              <img
                src={avatarUrl}
                alt={`${email}'s profile`}
                className="h-24 w-24 rounded-[1.75rem] border border-border/60 object-cover shadow-md sm:h-28 sm:w-28"
              />
            ) : (
              <span
                aria-hidden
                className="flex h-24 w-24 items-center justify-center rounded-[1.75rem] border border-primary/15 bg-primary/10 text-4xl font-semibold text-primary shadow-sm sm:h-28 sm:w-28"
              >
                {initial}
              </span>
            )}
            <button
              type="button"
              aria-label={avatarUrl === null ? "Add profile photo" : "Change profile photo"}
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              className="absolute -bottom-2 -right-2 flex h-11 w-11 items-center justify-center rounded-full border-4 border-card bg-primary text-primary-foreground shadow-md transition-transform hover:scale-105 active:scale-95 disabled:opacity-60"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Camera className="h-4 w-4" aria-hidden />
              )}
            </button>
          </div>

          <div className="min-w-0 flex-1 text-center sm:text-left">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/15 bg-primary/5 px-2.5 py-1 text-[11px] font-medium text-primary">
              <Check className="h-3 w-3" aria-hidden />
              Songnest account
            </div>
            <h1 className="mt-3 truncate text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
              {email}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Your music, your space.
            </p>
            {loading && (
              <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                Refreshing account details
              </p>
            )}
            {currentProfileNotice !== null && !loading && (
              <p role="status" className="mt-2 text-xs leading-5 text-muted-foreground">
                {currentProfileNotice}
              </p>
            )}
          </div>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept={AVATAR_ACCEPT}
          className="sr-only"
          aria-label="Choose a profile photo"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void handleFile(file);
          }}
        />
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2 border-t border-border/50 pt-4 sm:justify-start">
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-border/60 bg-background/70 px-4 text-sm font-medium text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-50"
          >
            <Camera className="h-4 w-4" aria-hidden />
            {uploading ? "Updating photo…" : avatarUrl !== null ? "Change photo" : "Add a photo"}
          </button>
          {avatarUrl !== null && (
            <button
              type="button"
              disabled={uploading}
              onClick={() => void handleRemovePhoto()}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              Remove
            </button>
          )}
          <p className="basis-full text-center text-xs text-muted-foreground sm:basis-auto sm:text-left">
            JPEG, PNG, WebP or GIF · up to 512 KB
          </p>
        </div>
        <div aria-live="polite">
          {photoError !== null && (
            <p className="mt-3 flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
              {photoError}
            </p>
          )}
          {photoMessage !== null && (
            <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
              <Check className="h-4 w-4 text-primary" aria-hidden />
              {photoMessage}
            </p>
          )}
        </div>
      </motion.div>

      <div>
        <h2 className="px-1 text-sm font-semibold text-foreground">Your collection</h2>
        <div className="mt-3 grid grid-cols-3 gap-2.5 sm:gap-3">
          <StatCard icon={Library} label="Downloaded" value={libraryCount} />
          <StatCard icon={Heart} label="Liked songs" value={likedCount} />
          <StatCard icon={Cloud} label="To sync" value={pendingCount} />
        </div>
        <p className="mt-2 px-1 text-xs leading-5 text-muted-foreground">
          Downloads stay on this device. Liked songs sync with your account.
        </p>
      </div>

      <div className="rounded-3xl border border-border/50 bg-card p-4 shadow-sm sm:p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-2xl bg-primary/10 text-primary">
            {syncing ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Cloud className="h-4 w-4" aria-hidden />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-foreground">Library sync</h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {syncing
                ? "Keeping your liked songs up to date…"
                : hasPendingChanges
                  ? `${formatCount(pendingCount)} ${pendingCount === 1 ? "change" : "changes"} waiting to sync`
                  : "Your liked songs are up to date"}
            </p>
          </div>
          {!syncing && !hasPendingChanges && lastError === null && (
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
              <Check className="h-3 w-3" aria-hidden />
              Synced
            </span>
          )}
        </div>

        {lastError !== null && (
          <p
            role="status"
            className="mt-3 rounded-2xl bg-destructive/10 px-3.5 py-3 text-sm leading-5 text-destructive"
          >
            {lastError}
          </p>
        )}

        <button
          type="button"
          onClick={onSyncNow}
          disabled={syncing}
          className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.99] disabled:cursor-wait disabled:opacity-60"
        >
          {syncing ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden />
          )}
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>

      <div className="rounded-3xl border border-border/50 bg-card p-4 sm:p-5">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-2xl bg-foreground/5 text-muted-foreground">
            <UserRound className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">Account email</p>
            <p className="mt-0.5 truncate text-sm font-medium text-foreground">{email}</p>
          </div>
          <span className="rounded-full bg-foreground/5 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            Signed in
          </span>
        </div>
        <div className="mt-4 border-t border-border/50 pt-4">
          <AnimatePresence mode="wait" initial={false}>
            {confirmSignOut ? (
              <motion.div
                key="confirm-signout"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">Sign out of this account?</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Your downloaded music stays on this device.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmSignOut(false)}
                    className="min-h-11 flex-1 rounded-full border border-border/60 px-4 text-sm font-medium text-foreground sm:flex-none"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={onSignOut}
                    className="min-h-11 flex-1 rounded-full bg-destructive px-4 text-sm font-medium text-destructive-foreground sm:flex-none"
                  >
                    Sign out
                  </button>
                </div>
              </motion.div>
            ) : (
              <motion.button
                key="signout"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                type="button"
                onClick={() => setConfirmSignOut(true)}
                className="inline-flex min-h-11 w-full items-center gap-2 rounded-full px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <LogOut className="h-4 w-4" aria-hidden />
                Sign out
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}
