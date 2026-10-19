import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowDownToLine,
  Check,
  Loader2,
  RefreshCw,
  Rocket,
} from "lucide-react";

import {
  checkTauriUpdate,
  compareTags,
  detectOs,
  fetchLatestRelease,
  formatBytes,
  formatDate,
  getCurrentVersion,
  isDesktopTauri,
  openDownload,
  pickAsset,
  type AppRelease,
  type OsKey,
  type TauriUpdate,
} from "@/lib/updates";

type Status =
  | { kind: "checking" }
  | { kind: "current"; label: string }
  | { kind: "available" }
  | { kind: "failed"; message: string }
  | { kind: "none" };

/**
 * App update page (desktop + mobile). One Update button — the app picks
 * the right path itself:
 * - Desktop Tauri: signed updater bundle, installed in place, then relaunch.
 * - Mobile / browser: downloads the right installer for this OS (install
 *   it by opening the file; Android: open the APK).
 */
export default function UpdatePage() {
  const [status, setStatus] = useState<Status>({ kind: "checking" });
  const [current, setCurrent] = useState<string | null>(null);
  const [os, setOs] = useState<OsKey>("other");
  const [desktop, setDesktop] = useState(false);
  // Desktop updater state.
  const [pending, setPending] = useState<TauriUpdate | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number | null } | null>(null);
  const [installed, setInstalled] = useState(false);
  const [working, setWorking] = useState(false);
  // Download-flow state (mobile / browser).
  const [latest, setLatest] = useState<AppRelease | null>(null);
  // Set after a mobile/browser download is handed to the OS. Without this the
  // button looked dead: on Android openUrl() silently sends the APK to the
  // system browser's Downloads folder, with no in-app progress or result.
  const [downloadedName, setDownloadedName] = useState<string | null>(null);

  const check = useCallback(async () => {
    setStatus({ kind: "checking" });
    setPending(null);
    setProgress(null);
    setInstalled(false);
    setLatest(null);
    setDownloadedName(null);
    try {
      const platform = await detectOs();
      setOs(platform);
      if (isDesktopTauri(platform)) {
        setDesktop(true);
        const [version, update] = await Promise.all([getCurrentVersion(), checkTauriUpdate()]);
        setCurrent(version);
        if (update === null) {
          setStatus({ kind: "current", label: version });
        } else {
          setPending(update);
          setStatus({ kind: "available" });
        }
        return;
      }
      setDesktop(false);
      const [version, release] = await Promise.all([getCurrentVersion(), fetchLatestRelease()]);
      setCurrent(version);
      if (release === null) {
        setStatus({ kind: "none" });
        return;
      }
      setLatest(release);
      const cmp = compareTags(release.tag_name, version);
      if (cmp === null || cmp <= 0) {
        setStatus({ kind: "current", label: cmp === null ? release.tag_name : version });
      } else {
        setStatus({ kind: "available" });
      }
    } catch (e) {
      setStatus({
        kind: "failed",
        message: e instanceof Error ? e.message : "Couldn't check for updates.",
      });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  async function install(): Promise<void> {
    if (pending === null || working) return;
    setWorking(true);
    try {
      let done = 0;
      await pending.downloadAndInstall((chunk, _total, finished) => {
        if (!finished) {
          done += chunk;
          setProgress({ done, total: _total });
        }
      });
      setInstalled(true);
    } catch {
      setStatus({ kind: "failed", message: "Download failed — check your connection and try again." });
    } finally {
      setWorking(false);
    }
  }

  async function restart(): Promise<void> {
    if (pending === null) return;
    try {
      await pending.relaunch();
    } catch {
      setStatus({ kind: "failed", message: "Couldn't restart — reopen the app manually." });
    }
  }

  async function downloadBest(): Promise<void> {
    if (latest === null || working) return;
    const asset = pickAsset(latest.assets, os);
    if (asset === null) {
      setStatus({ kind: "failed", message: "No installer for this device in the latest release." });
      return;
    }
    setWorking(true);
    setDownloadedName(null);
    try {
      await openDownload(asset.browser_download_url);
      // On Android the browser takes over; confirm here so the button does not
      // look like it did nothing.
      setDownloadedName(asset.name);
    } catch {
      setStatus({ kind: "failed", message: "Couldn't start the download — try again." });
    } finally {
      setWorking(false);
    }
  }

  const best = latest !== null ? pickAsset(latest.assets, os) : null;
  const notes = pending?.body ?? latest?.body ?? null;
  const newVersion = pending?.version ?? latest?.tag_name ?? "";

  return (
    <section aria-label="App updates" className="mx-auto w-full max-w-2xl px-4 pb-6 md:px-0">
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
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 flex-none items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Rocket className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">App updates</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {current !== null ? `This build: ${current}` : "Checking this build…"}
            </p>
          </div>
        </div>

        <div className="mt-6" aria-live="polite">
          {status.kind === "checking" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Checking for updates…
            </p>
          )}

          {status.kind === "failed" && (
            <div className="rounded-2xl bg-destructive/10 px-3.5 py-3 text-sm leading-5 text-destructive">
              {status.message}
            </div>
          )}

          {status.kind === "none" && (
            <p className="text-sm leading-6 text-muted-foreground">
              No releases published yet. New versions appear here once the first
              release ships.
            </p>
          )}

          {status.kind === "current" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Check className="h-4 w-4 text-primary" aria-hidden />
              You're up to date — {status.label}.
            </p>
          )}

          {status.kind === "available" && (
            <div className="rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3">
              <p className="text-sm font-medium text-foreground">
                {newVersion} is available
                {latest?.published_at !== undefined && latest?.published_at !== null && formatDate(latest.published_at) !== ""
                  ? ` · ${formatDate(latest.published_at)}`
                  : ""}
              </p>
              {notes !== null && notes.trim() !== "" && (
                <details className="mt-2 text-sm text-muted-foreground">
                  <summary className="cursor-pointer text-xs font-medium">What's new</summary>
                  <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-5">
                    {notes.slice(0, 2000)}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>

        {status.kind === "available" && desktop && !installed && (
          <div className="mt-4">
            <button
              type="button"
              disabled={working}
              onClick={() => void install()}
              className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.99] disabled:opacity-60"
            >
              {working ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <ArrowDownToLine className="h-4 w-4" aria-hidden />
              )}
              {working ? "Updating…" : "Update"}
            </button>
            {progress !== null && (
              <div className="mt-3">
                <div className="h-2 overflow-hidden rounded-full bg-foreground/10">
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{
                      width:
                        progress.total !== null && progress.total > 0
                          ? `${Math.min(100, (progress.done / progress.total) * 100)}%`
                          : "30%",
                    }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {progress.total !== null && progress.total > 0
                    ? `${formatBytes(progress.done)} of ${formatBytes(progress.total)}`
                    : `${formatBytes(progress.done)} downloaded`}
                </p>
              </div>
            )}
            <p className="mt-2 px-1 text-xs leading-5 text-muted-foreground">
              Installs in place — your library and likes stay put.
            </p>
          </div>
        )}

        {status.kind === "available" && desktop && installed && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => void restart()}
              className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.99]"
            >
              Restart now
            </button>
            <p className="mt-2 px-1 text-xs leading-5 text-muted-foreground">
              Update installed — restart to run {newVersion}.
            </p>
          </div>
        )}

        {status.kind === "available" && !desktop && best !== null && (
          <div className="mt-4">
            <button
              type="button"
              disabled={working}
              onClick={() => void downloadBest()}
              className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.99] disabled:opacity-60"
            >
              {working ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : downloadedName !== null ? (
                <Check className="h-4 w-4" aria-hidden />
              ) : (
                <ArrowDownToLine className="h-4 w-4" aria-hidden />
              )}
              {working ? "Starting download…" : downloadedName !== null ? "Download started" : "Update"}
            </button>
            {downloadedName !== null ? (
              <p className="mt-2 px-1 text-xs leading-5 text-muted-foreground" aria-live="polite">
                {os === "android"
                  ? "Saved to your Downloads. Open it from your notifications or the Files app to install — Android will ask you to allow installing from this source."
                  : "Saved to your Downloads. Open the file to install."}
              </p>
            ) : (
              <p className="mt-2 px-1 text-xs leading-5 text-muted-foreground">
                {os === "android"
                  ? "Downloads the new APK — then open it to install."
                  : "Downloads the new version — then open the file to install."}
              </p>
            )}
          </div>
        )}

        <div className="mt-4 border-t border-border/50 pt-4">
          <button
            type="button"
            onClick={() => void check()}
            disabled={status.kind === "checking" || working}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border/60 px-4 text-sm font-medium text-foreground disabled:opacity-50"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Check again
          </button>
        </div>
      </motion.div>
    </section>
  );
}
