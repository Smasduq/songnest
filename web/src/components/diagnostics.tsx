import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  fetchCookiesStatus,
  fetchDownloader,
  postCookies,
  postDownloaderRecheck,
  postDownloaderRuntime,
  postDownloaderUpdate,
  type DownloaderStatus,
} from "@/lib/api";

const RUNTIME_OPTIONS = ["auto", "deno", "node", "bun", "quickjs"] as const;

const INSTALL_HINTS: Record<string, string> = {
  deno: "Linux/macOS: curl -fsSL https://deno.land/install.sh | sh — Windows: irm https://deno.land/install.ps1 | iex",
  node: "Install Node.js 22+ from nodejs.org or your package manager (node --version must print 22.x or newer)",
};

export function Diagnostics({ onToast }: { onToast: (msg: string) => void }) {
  const [status, setStatus] = useState<DownloaderStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cookiesPresent, setCookiesPresent] = useState<boolean | null>(null);
  const [cookiesDraft, setCookiesDraft] = useState("");
  const [cookiesBusy, setCookiesBusy] = useState(false);

  const refreshCookies = useCallback(async () => {
    try {
      setCookiesPresent(await fetchCookiesStatus());
    } catch {
      setCookiesPresent(null);
    }
  }, []);

  // fetch-on-mount without a setState-in-effect lint hit: deferred work
  useEffect(() => {
    let alive = true;
    fetchCookiesStatus().then(
      (v) => {
        if (alive) setCookiesPresent(v);
      },
      () => {
        if (alive) setCookiesPresent(null);
      }
    );
    return () => {
      alive = false;
    };
  }, []);

  async function saveCookies() {
    const content = cookiesDraft.trim();
    if (content === "") return;
    setCookiesBusy(true);
    try {
      await postCookies(content);
      setCookiesDraft("");
      await refreshCookies();
      onToast("Cookies saved — throttling should ease off");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "cookies save failed");
    } finally {
      setCookiesBusy(false);
    }
  }

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchDownloader());
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "fetch failed");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function update() {
    setBusy(true);
    try {
      setStatus(await postDownloaderUpdate());
      onToast("Downloader updated");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "update failed");
    } finally {
      setBusy(false);
    }
  }

  async function setRuntime(setting: string) {
    try {
      setStatus(await postDownloaderRuntime(setting));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "setting failed");
    }
  }

  function row(label: string, value: React.ReactNode) {
    return (
      <div className="flex items-center justify-between gap-4 py-1.5">
        <dt className="text-sm text-muted-foreground">{label}</dt>
        <dd className="text-right text-sm text-foreground">{value}</dd>
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          Downloader diagnostics
          {status?.backend ? (
            <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {status.backend}
            </span>
          ) : null}
        </h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setStatus(await postDownloaderRecheck());
                setError(null);
              } catch (e: unknown) {
                setError(e instanceof Error ? e.message : "recheck failed");
              } finally {
                setBusy(false);
              }
            }}
            className="h-9 rounded-full px-4"
          >
            Check again
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={update}
            className="h-9 rounded-full px-4"
          >
            {busy ? "Updating…" : "Update downloader"}
          </Button>
        </div>
      </div>
      {error !== null && (
        <p className="text-sm text-muted-foreground">Error: {error}</p>
      )}
      {status === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <dl className="divide-y divide-border/40 rounded-3xl border border-border/40 bg-background/60 px-4 backdrop-blur-xl">
            {row("Binary", `${status.binary_source} (${status.path || "—"})`)}
            {row("Version", status.version || "—")}
            {row(
              "Latest known",
              status.latest_known_version ?? "unknown"
            )}
            {row(
              "Update available",
              status.update_available ? "yes" : "no"
            )}
            {row("Health", status.health)}
            {status.last_error !== "" && row("Last error", status.last_error)}
            {row(
              "ffmpeg",
              status.ffmpeg ?? "not found (needed for some formats)"
            )}
            {row(
              "EJS scripts",
              status.ejs_available === true
                ? "bundled"
                : status.ejs_available === false
                  ? "missing"
                  : "unknown"
            )}
            {row("EJS note", status.ejs_note || "—")}
            {row("Runtime in use", status.js_runtime_in_use ?? "none")}
          </dl>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-muted-foreground">
              JavaScript runtime
            </h3>
            <div className="flex flex-wrap gap-2">
              {RUNTIME_OPTIONS.map((o) => (
                <Button
                  key={o}
                  variant={
                    status.js_runtime_setting === o ? "default" : "outline"
                  }
                  size="sm"
                  onClick={() => setRuntime(o)}
                  className="h-9 rounded-full px-4"
                >
                  {o}
                </Button>
              ))}
            </div>
            <ul className="space-y-1">
              {status.js_runtimes.map((r) => (
                <li
                  key={`${r.name}-${r.path}`}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-foreground">
                    {r.name} {r.version}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {r.supported ? "supported" : "too old"} · {r.path}
                  </span>
                </li>
              ))}
              {status.js_runtimes.length === 0 && (
                <li className="text-sm text-muted-foreground">
                  No supported runtime found.{" "}
                  {INSTALL_HINTS.deno} {INSTALL_HINTS.node}
                </li>
              )}
            </ul>
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-muted-foreground">
              YouTube cookies
            </h3>
            <p className="text-sm text-muted-foreground">
              {cookiesPresent === null
                ? "Status unknown."
                : cookiesPresent
                  ? "Installed — downloads and streams run authenticated."
                  : "Not installed — after a few anonymous fetches the source throttles and downloads stall."}{" "}
              Export a Netscape-format cookie file while logged into YouTube
              (browser extension, youtube.com open) and paste it below. Same
              file the desktop reads as cookies.txt; refresh it every few
              weeks.
            </p>
            <textarea
              value={cookiesDraft}
              onChange={(e) => setCookiesDraft(e.target.value)}
              placeholder={"# Netscape HTTP Cookie File\n# https://curl.se/docs/http-cookies.html\n…paste export here…"}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              rows={4}
              aria-label="Cookie file contents"
              className="w-full rounded-2xl border border-border/40 bg-background/60 px-4 py-3 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <Button
              size="sm"
              disabled={cookiesBusy || cookiesDraft.trim() === ""}
              onClick={saveCookies}
              className="h-9 rounded-full px-4"
            >
              {cookiesBusy ? "Saving…" : "Save cookies"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
