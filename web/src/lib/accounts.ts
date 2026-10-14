/**
 * Accounts + liked-songs sync client for the songnest-accounts service.
 *
 * - Base URL: `VITE_ACCOUNTS_URL` build default, overridable at runtime
 *   (localStorage `songnest-accounts-url`) — same pattern as the music
 *   server in api.ts.
 * - Tokens live in the OS credential store (secure-store.ts), never in
 *   plaintext config. Access tokens refresh automatically; a dead refresh
 *   clears the session (clean logout).
 * - Local-first: like changes are queued in an outbox per user and pushed
 *   when possible; pulls apply server changes. All failures surface as
 *   non-technical `AccountsError`s.
 *
 * NOTE on clocks: conflict resolution (last-write-wins) trusts device
 * timestamps. Skewed device clocks can misorder concurrent edits from two
 * devices — acceptable for likes, documented in the README.
 */

import type { Song } from "./api";
import { secretDelete, secretGet, secretSet } from "./secure-store";

const URL_KEY = "songnest-accounts-url";
const SESSION_KEY = "songnest-accounts-session";
/** Local accounts API. Local builds always default to this; a production
 * URL is only used when baked in via `VITE_ACCOUNTS_URL` or explicitly
 * set at runtime (see `setAccountsUrl`). */
export const LOCAL_ACCOUNTS_URL = "http://127.0.0.1:8788";
const BUILD_DEFAULT =
  (import.meta.env.VITE_ACCOUNTS_URL as string | undefined) ??
  LOCAL_ACCOUNTS_URL;

export function getAccountsUrl(): string {
  try {
    return (
      window.localStorage.getItem(URL_KEY) ?? BUILD_DEFAULT
    ).replace(/\/+$/, "");
  } catch {
    return BUILD_DEFAULT;
  }
}

export function setAccountsUrl(url: string): void {
  try {
    window.localStorage.setItem(URL_KEY, url.replace(/\/+$/, ""));
  } catch {
    // Non-fatal: keeps running with the previous URL.
  }
}

/**
 * Forget any runtime accounts-URL override (e.g. a stale production URL)
 * so the build default — the local API for local builds — takes effect
 * again. Use when login fails with "can't reach the server" after moving
 * between local and hosted backends.
 */
export function resetAccountsUrl(): void {
  try {
    window.localStorage.removeItem(URL_KEY);
  } catch {
    // Best effort.
  }
}

/** User-facing error. `message` is always safe to show verbatim. */
export class AccountsError extends Error {
  readonly code:
    | "credentials"
    | "offline"
    | "unreachable"
    | "rate-limited"
    | "logged-out"
    | "invalid"
    | "server";
  constructor(code: AccountsError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface Session {
  userId: string;
  email: string;
  accessToken: string;
  accessExpiresAt: number;
}

export interface LikeChange {
  track_id: string;
  liked: boolean;
  updated_at: string;
  title: string;
  artist: string;
  album: string;
  cover: string;
}

export interface RemoteLike extends LikeChange {
  version: number;
}

interface StoredMeta {
  userId: string;
  email: string;
  accessExpiresAt: number;
}

const ACCESS_KEY = "accounts-access-token";
const REFRESH_KEY = "accounts-refresh-token";

async function request(
  path: string,
  init: RequestInit,
  token?: string
): Promise<{ status: number; json: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${getAccountsUrl()}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    // DNS/refused = server down; the browser reports both as TypeError.
    // Distinguish offline via navigator.onLine (best effort).
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new AccountsError("offline", "You're offline — changes are saved and will sync later.");
    }
    throw new AccountsError(
      "unreachable",
      "Can't reach the accounts server — check it's running and try again."
    );
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Empty/non-JSON body: keep status-only handling below.
  }
  return { status: res.status, json };
}

function serverMessage(json: unknown): string | null {
  if (
    typeof json === "object" &&
    json !== null &&
    "error" in json &&
    typeof (json as { error: unknown }).error === "string"
  ) {
    return (json as { error: string }).error;
  }
  return null;
}

function failFor(status: number, json: unknown, fallback: string): never {
  if (status === 429) {
    throw new AccountsError(
      "rate-limited",
      "Too many attempts — wait a minute and try again."
    );
  }
  if (status >= 500) {
    throw new AccountsError("server", "The server had a problem — try again in a bit.");
  }
  throw new AccountsError("invalid", serverMessage(json) ?? fallback);
}

async function storeSession(
  userId: string,
  email: string,
  accessToken: string,
  refreshToken: string,
  expiresIn: number
): Promise<Session> {
  const session: Session = {
    userId,
    email,
    accessToken,
    accessExpiresAt: Date.now() + expiresIn * 1000,
  };
  await secretSet(ACCESS_KEY, accessToken);
  await secretSet(REFRESH_KEY, refreshToken);
  try {
    const meta: StoredMeta = { userId, email, accessExpiresAt: session.accessExpiresAt };
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(meta));
  } catch {
    // Tokens are safe; only the cached profile is lost.
  }
  return session;
}

/** Current session, or null when logged out. Never throws. */
export async function loadSession(): Promise<Session | null> {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (raw === null) return null;
    const meta = JSON.parse(raw) as StoredMeta;
    const [accessToken, refreshToken] = await Promise.all([
      secretGet(ACCESS_KEY),
      secretGet(REFRESH_KEY),
    ]);
    if (accessToken === null || refreshToken === null) return null;
    return {
      userId: meta.userId,
      email: meta.email,
      accessToken,
      accessExpiresAt: meta.accessExpiresAt,
    };
  } catch {
    return null;
  }
}

async function clearSession(): Promise<void> {
  await Promise.all([secretDelete(ACCESS_KEY), secretDelete(REFRESH_KEY)]);
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    // Best effort.
  }
}

interface PairResponse {
  user: { id: string; email: string };
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function toSession(pair: PairResponse): Promise<Session> {
  return storeSession(
    pair.user.id,
    pair.user.email,
    pair.access_token,
    pair.refresh_token,
    pair.expires_in
  );
}

/** Sign up. Throws AccountsError with a showable message. */
export async function signup(email: string, password: string): Promise<Session> {
  const { status, json } = await request("/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (status === 201) return toSession(json as PairResponse);
  return failFor(status, json, "Couldn't create your account.");
}

/** Log in. Wrong credentials → "credentials" error. */
export async function login(email: string, password: string): Promise<Session> {
  const { status, json } = await request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (status === 200) return toSession(json as PairResponse);
  if (status === 401) {
    throw new AccountsError("credentials", "Wrong email or password — try again.");
  }
  return failFor(status, json, "Couldn't log you in.");
}

/** Callback URL sent to OAuth providers. Root origin keeps receiving
 *  simple: the provider redirects to `/?code=…&state=…` and the app
 *  finishes login. Works for browser dev, Tauri dev (localhost:1420),
 *  and Tauri bundles (`tauri://localhost` / `http://tauri.localhost`). */
export function oauthRedirectUri(): string {
  return `${window.location.origin}/`;
}

const OAUTH_STATE_KEY = "songnest-oauth-state";
const OAUTH_PROVIDER_KEY = "songnest-oauth-provider";

export type OAuthProvider = "github" | "google";

/** True inside the Tauri bundle (desktop or mobile), where the webview
 *  origin is app-internal and OAuth must use the loopback flow. */
function isNativeApp(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

async function invokeNative<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Open a URL in the system browser (Tauri) or a new tab (web).
 *  OAuth providers block embedded webviews, so this must never
 *  navigate the app's own webview away. */
async function openSystemBrowser(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

interface AuthorizeUrl {
  url: string;
  state: string | null;
}

/** Ask the API for the provider authorize URL for `redirect_uri`. */
async function fetchAuthorizeUrl(
  provider: OAuthProvider,
  redirect_uri: string
): Promise<AuthorizeUrl> {
  const { status, json } = await request(
    `/auth/${provider}/start?redirect_uri=${encodeURIComponent(redirect_uri)}`,
    { method: "GET" },
  );
  if (status !== 200) {
    return failFor(status, json, "Login isn't available right now.");
  }
  const url = (json as { authorize_url?: string }).authorize_url;
  if (typeof url !== "string" || url === "") {
    throw new AccountsError("server", "Login isn't available right now.");
  }
  let state: string | null = null;
  try {
    state = new URL(url).searchParams.get("state");
    if (state !== null) {
      window.sessionStorage.setItem(OAUTH_STATE_KEY, state);
      window.sessionStorage.setItem(OAUTH_PROVIDER_KEY, provider);
    }
  } catch {
    // Non-fatal: the callback still exchanges the code without the check.
  }
  return { url, state };
}

/** Start OAuth login: ask the API for the provider authorize URL, remember
 *  `state` + provider for the CSRF check, then redirect there. */
async function startOAuthLogin(provider: OAuthProvider): Promise<void> {
  const { url } = await fetchAuthorizeUrl(provider, oauthRedirectUri());
  window.location.href = url;
}

interface NativeOAuthCallback {
  code?: string | null;
  state?: string | null;
  error?: string | null;
}

/** Native OAuth login (Tauri desktop + mobile) via loopback.
 *
 *  Bundle origins (`tauri://…`, `http://tauri.localhost`) are rejected
 *  by providers and unreachable from the system browser, so the app
 *  serves one loopback callback (`http://127.0.0.1:<port>/callback` —
 *  accepted by Desktop-type OAuth clients without registration),
 *  opens the provider page in the system browser, and exchanges the
 *  captured code. Resolves with the Songnest session. */
async function startNativeOAuthLogin(provider: OAuthProvider): Promise<Session> {
  let port: number;
  try {
    port = await invokeNative<number>("oauth_loopback_begin");
  } catch {
    throw new AccountsError(
      "invalid",
      "Couldn't start login on this device — try again."
    );
  }
  const redirect_uri = `http://127.0.0.1:${port}/callback`;
  const { url } = await fetchAuthorizeUrl(provider, redirect_uri);
  await openSystemBrowser(url);
  let callback: NativeOAuthCallback;
  try {
    callback = await invokeNative<NativeOAuthCallback>("oauth_loopback_wait", {
      timeoutSecs: 300,
    });
  } catch (e) {
    // Rust-side messages are plain, user-safe strings (timeout, busy…).
    throw new AccountsError(
      "invalid",
      typeof e === "string" ? e : "Login failed — try again."
    );
  }
  if (
    callback.error !== undefined &&
    callback.error !== null &&
    callback.error !== ""
  ) {
    throw new AccountsError(
      "invalid",
      callback.error === "access_denied"
        ? "Login was cancelled with the provider — try again when ready."
        : "Login failed with the provider — try again."
    );
  }
  if (callback.code === undefined || callback.code === null || callback.code === "") {
    throw new AccountsError("invalid", "Login failed — try again.");
  }
  return (await finishOAuthLogin(callback.code, callback.state ?? null)).session;
}

/** Finish OAuth login after the redirect back with `?code=…`. Verifies
 *  the stored `state`, then exchanges the code for a Songnest session.
 *  Returns the provider so callers can show the right errors. */
export async function finishOAuthLogin(
  code: string,
  state: string | null,
): Promise<{ session: Session; provider: OAuthProvider }> {
  let provider: OAuthProvider = "github";
  try {
    const storedProvider = window.sessionStorage.getItem(OAUTH_PROVIDER_KEY);
    if (storedProvider === "google") provider = "google";
    const expected = window.sessionStorage.getItem(OAUTH_STATE_KEY);
    if (expected !== null && state !== null && expected !== state) {
      throw new AccountsError("invalid", "Login expired — try again.");
    }
  } catch (e) {
    if (e instanceof AccountsError) throw e;
    // Storage blocked: continue without the CSRF check.
  }
  const { status, json } = await request(`/auth/${provider}/callback`, {
    method: "POST",
    body: JSON.stringify({ code, redirect_uri: oauthRedirectUri() }),
  });
  try {
    window.sessionStorage.removeItem(OAUTH_STATE_KEY);
    window.sessionStorage.removeItem(OAUTH_PROVIDER_KEY);
  } catch {
    // Best effort.
  }
  if (status === 200) return { session: await toSession(json as PairResponse), provider };
  return failFor(status, json, "Couldn't log you in.");
}

/** @deprecated Use oauthRedirectUri. */
export function githubRedirectUri(): string {
  return oauthRedirectUri();
}

/** Start GitHub login via redirect (see startOAuthLogin). In the native
 *  app this completes the loopback flow and resolves with the session;
 *  on the web it navigates away and resolves null. */
export async function startGithubLogin(): Promise<Session | null> {
  if (isNativeApp()) return startNativeOAuthLogin("github");
  await startOAuthLogin("github");
  return null;
}

/** Start Google login (see startOAuthLogin). In the native app this
 *  completes the loopback flow and resolves with the session; on the
 *  web it navigates away and resolves null. */
export async function startGoogleLogin(): Promise<Session | null> {
  if (isNativeApp()) return startNativeOAuthLogin("google");
  await startOAuthLogin("google");
  return null;
}

/** Device-flow session from `POST /auth/github/device/start`. */
export interface GithubDeviceStart {
  user_code: string;
  verification_uri: string;
  device_code: string;
  expires_in: number;
  interval: number;
}

/** Start GitHub device login: no callback URL needed. Shows `user_code`
 *  to the user, who approves at `verification_uri` in any browser. */
export async function startGithubDevice(): Promise<GithubDeviceStart> {
  const { status, json } = await request("/auth/github/device/start", {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (status === 200) return json as GithubDeviceStart;
  return failFor(status, json, "GitHub login isn't available right now.");
}

/** Poll once after device approval. Returns the session when approved,
 *  `null` while still pending. Throws when expired/denied (stop polling). */
export async function pollGithubDevice(device_code: string): Promise<Session | null> {
  const { status, json } = await request("/auth/github/device/poll", {
    method: "POST",
    body: JSON.stringify({ device_code }),
  });
  if (status === 200) return toSession(json as PairResponse);
  if (status === 202) return null;
  return failFor(status, json, "GitHub login expired or was denied.");
}

/** Finish GitHub login (provider-aware; see finishOAuthLogin). */
export async function finishGithubLogin(code: string, state: string | null): Promise<Session> {
  return (await finishOAuthLogin(code, state)).session;
}

/** Refresh the access token.
 *
 *  Returns the rotated pair, or null when the refresh token is dead
 *  (expired, revoked, unknown → 401). Transient failures (offline,
 *  unreachable, rate-limited, server errors) throw — callers must NOT
 *  treat those as logout, or a hiccup signs the user out. */
async function refreshSession(refreshToken: string): Promise<Session | null> {
  const { status, json } = await request("/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (status === 200) return toSession(json as PairResponse);
  if (status === 401) return null;
  if (status === 429) {
    throw new AccountsError(
      "rate-limited",
      "Too many attempts — wait a minute and try again."
    );
  }
  if (status >= 500) {
    throw new AccountsError("server", "The server had a problem — try again in a bit.");
  }
  return failFor(status, json, "Couldn't refresh your login.");
}

/**
 * Session with a fresh access token (refreshes when <60s remain).
 *
 * Only a dead refresh clears storage (`logged-out`): refresh tokens live
 * 30 days and slide on every rotation, so an active user stays signed
 * in. Transient refresh failures propagate as retryable errors with
 * stored tokens intact — the sync engine backs off and the UI shows the
 * message instead of dropping the session.
 */
export async function ensureSession(): Promise<Session> {
  const session = await loadSession();
  if (session === null) {
    throw new AccountsError("logged-out", "You're logged out — log in to sync.");
  }
  if (session.accessExpiresAt - Date.now() > 60_000) return session;
  const refreshToken = await secretGet(REFRESH_KEY);
  if (refreshToken === null) {
    await clearSession();
    throw new AccountsError("logged-out", "You're logged out — log in to sync.");
  }
  let next: Session | null;
  try {
    next = await refreshSession(refreshToken);
  } catch (e) {
    if (e instanceof AccountsError) throw e;
    // Secret-store hiccup (e.g. locked keychain), not a dead login:
    // keep stored tokens so the next attempt can still refresh.
    throw new AccountsError("server", "Couldn't read your saved login — try again.");
  }
  if (next === null) {
    await clearSession();
    throw new AccountsError("logged-out", "Your login expired — please log in again.");
  }
  return next;
}

/** Log out: revoke the refresh token (best effort), then wipe storage. */
export async function logout(): Promise<void> {
  try {
    const refreshToken = await secretGet(REFRESH_KEY);
    if (refreshToken !== null) {
      await request("/auth/logout", {
        method: "POST",
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    }
  } catch {
    // Revocation is best effort; local wipe is what matters.
  }
  await clearSession();
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    // Best effort.
  }
}

/** Push a batch of local changes. Returns the server cursor. */
export async function pushLikes(
  changes: LikeChange[]
): Promise<{ cursor: number; applied: number; skipped: number }> {
  const session = await ensureSession();
  const { status, json } = await request(
    "/sync/likes",
    { method: "POST", body: JSON.stringify({ changes }) },
    session.accessToken
  );
  if (status === 200) {
    const body = json as { cursor: number; applied: number; skipped: number };
    return { cursor: body.cursor, applied: body.applied, skipped: body.skipped };
  }
  if (status === 401) {
    await clearSession();
    throw new AccountsError("logged-out", "Your login expired — please log in again.");
  }
  return failFor(status, json, "Couldn't upload likes.");
}

/** Fetch the caller's profile (`GET /me`). Throws `logged-out` when the
 *  refresh is dead (storage is cleared), otherwise a showable AccountsError. */
export interface UserProfile {
  id: string;
  email: string;
  avatar_url: string | null;
  username: string | null;
}

export async function fetchProfile(): Promise<UserProfile> {
  const session = await ensureSession();
  const { status, json } = await request(
    "/me",
    { method: "GET" },
    session.accessToken
  );
  if (status === 200) {
    const body = json as { id: string; email: string; avatar_url?: string | null; username?: string | null };
    return { id: body.id, email: body.email, avatar_url: body.avatar_url ?? null, username: body.username ?? null };
  }
  if (status === 401) {
    await clearSession();
    throw new AccountsError("logged-out", "Your login expired — please log in again.");
  }
  return failFor(status, json, "Couldn't load your profile.");
}

/** Max avatar upload size (must stay in sync with the server default:
 *  `SONGNEST_AVATAR_MAX_BYTES`, 512 KiB). The server is authoritative —
 *  this is only a fast client-side check for a friendly error. */
export const AVATAR_MAX_BYTES = 512 * 1024;

/** Accepted avatar image types (mirrors the server's magic-byte sniffing). */
export const AVATAR_ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

/**
 * Upload a profile picture (`PUT /me/avatar`). `data` is the raw image
 * bytes; returns the public URL. Throws `logged-out` on stale sessions,
 * otherwise a showable AccountsError (too big / not an image / unavailable).
 */
export async function uploadAvatar(data: ArrayBuffer, contentType: string): Promise<string> {
  const session = await ensureSession();
  const { status, json } = await request(
    "/me/avatar",
    { method: "PUT", body: data, headers: { "Content-Type": contentType } },
    session.accessToken
  );
  if (status === 200) {
    return (json as { avatar_url: string }).avatar_url;
  }
  if (status === 401) {
    await clearSession();
    throw new AccountsError("logged-out", "Your login expired — please log in again.");
  }
  return failFor(status, json, "Couldn't upload your picture.");
}

/** Remove the profile picture (`DELETE /me/avatar`). Idempotent. */
export async function deleteAvatar(): Promise<void> {
  const session = await ensureSession();
  const { status, json } = await request(
    "/me/avatar",
    { method: "DELETE" },
    session.accessToken
  );
  if (status === 200) return;
  if (status === 401) {
    await clearSession();
    throw new AccountsError("logged-out", "Your login expired — please log in again.");
  }
  return failFor(status, json, "Couldn't remove your picture.");
}

/**
 * Set or change the account email (`PUT /me/email`). Returns the updated
 * profile view. Throws `logged-out` on stale sessions, otherwise a
 * showable AccountsError (invalid / already in use / unavailable).
 */
export async function changeEmail(email: string): Promise<{ email: string; username: string | null }> {
  const session = await ensureSession();
  const { status, json } = await request(
    "/me/email",
    { method: "PUT", body: JSON.stringify({ email }) },
    session.accessToken
  );
  if (status === 200) {
    const body = json as { email: string; username?: string | null };
    return { email: body.email, username: body.username ?? null };
  }
  if (status === 401) {
    await clearSession();
    throw new AccountsError("logged-out", "Your login expired — please log in again.");
  }
  return failFor(status, json, "Couldn't change your email.");
}

/** Persist an email change to the cached session (profile edits). */
export async function updateStoredEmail(email: string): Promise<void> {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (raw === null) return;
    const meta = JSON.parse(raw) as StoredMeta;
    meta.email = email;
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(meta));
  } catch {
    // Best effort: in-memory session still carries the new email.
  }
}
/**
 * Set or change the public handle (`PUT /me/username`). Returns the saved
 * handle. Throws `logged-out` on stale sessions, otherwise a showable
 * AccountsError ("username is taken", validation, unavailable).
 */
export async function setUsername(username: string): Promise<string> {
  const session = await ensureSession();
  const { status, json } = await request(
    "/me/username",
    { method: "PUT", body: JSON.stringify({ username }) },
    session.accessToken
  );
  if (status === 200) {
    return (json as { username?: string }).username ?? username.trim();
  }
  if (status === 401) {
    await clearSession();
    throw new AccountsError("logged-out", "Your login expired — please log in again.");
  }
  return failFor(status, json, "Couldn't save your username.");
}

/** Pull changes after `since`. Returns changes + new cursor. */
export async function pullLikes(since: number): Promise<{ changes: RemoteLike[]; cursor: number }> {
  const session = await ensureSession();
  const { status, json } = await request(
    `/sync/likes?since=${since}`,
    { method: "GET" },
    session.accessToken
  );
  if (status === 200) {
    const body = json as { changes: RemoteLike[]; cursor: number };
    return { changes: body.changes, cursor: body.cursor };
  }
  if (status === 401) {
    await clearSession();
    throw new AccountsError("logged-out", "Your login expired — please log in again.");
  }
  return failFor(status, json, "Couldn't download likes.");
}

// --- Sync identity -------------------------------------------------------

/**
 * Canonical cross-device key for a song: `dz:<deezer_id>` whenever a
 * Deezer ID is known (streamed tracks and downloaded rows alike).
 * Returns null for device-local likes (db: rows without a Deezer ID) —
 * those are never uploaded (see isLocalOnly).
 */
export function canonicalSyncKey(song: Song): string | null {
  if (song.deezerId !== null && song.deezerId !== undefined && song.deezerId !== 0) {
    return `dz:${song.deezerId}`;
  }
  return null;
}

/**
 * True for likes that can't sync (library rows without a Deezer ID).
 * The UI marks these "local only".
 *
 * TODO: a "resolve" step using Deezer search + match scoring to upgrade
 * these to dz: IDs, after which they sync normally.
 */
export function isLocalOnly(song: Song): boolean {
  return song.id.startsWith("db-") && canonicalSyncKey(song) === null;
}

/** Build an uploadable change from a song + new state. */
export function toChange(song: Song, liked: boolean, at?: Date): LikeChange | null {
  const track_id = canonicalSyncKey(song);
  if (track_id === null) return null;
  return {
    track_id,
    liked,
    updated_at: (at ?? new Date()).toISOString(),
    title: song.title,
    artist: song.artist,
    album: song.album,
    cover: song.coverUrl,
  };
}

// --- Outbox + cursor (per user, localStorage) ------------------------------

function outboxKey(userId: string): string {
  return `songnest-sync-outbox:${userId}`;
}

function cursorKey(userId: string): string {
  return `songnest-sync-cursor:${userId}`;
}

export function loadOutbox(userId: string): LikeChange[] {
  try {
    const raw = window.localStorage.getItem(outboxKey(userId));
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as LikeChange[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Queue a change, collapsing older entries for the same track. */
export function enqueueChange(userId: string, change: LikeChange): void {
  try {
    const rest = loadOutbox(userId).filter((c) => c.track_id !== change.track_id);
    rest.push(change);
    window.localStorage.setItem(outboxKey(userId), JSON.stringify(rest));
  } catch {
    // Storage full/blocked: sync degrades, local likes still work.
  }
}

export function dropPushed(userId: string, count: number): void {
  try {
    const rest = loadOutbox(userId).slice(count);
    window.localStorage.setItem(outboxKey(userId), JSON.stringify(rest));
  } catch {
    // Best effort.
  }
}

export function getCursor(userId: string): number {
  try {
    return Number(window.localStorage.getItem(cursorKey(userId)) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function setCursor(userId: string, cursor: number): void {
  try {
    window.localStorage.setItem(cursorKey(userId), String(cursor));
  } catch {
    // Best effort.
  }
}

// --- Sync identity -------------------------------------------------------
