# songnest
If you can't pay Spotify or any other music platform. This is for you.

Serve with `cargo run -p songnest-cli -- serve` (http://127.0.0.1:8787).

Env knobs: `SONGNEST_BACKEND=ytdlp|rustypipe` (default `ytdlp`;
`rustypipe` needs `--features rp` and uses the pure-Rust extractor —
no yt-dlp/ffmpeg subprocesses), `SONGNEST_PORT` (default `8787`),
`SONGNEST_DATA_DIR` / `--data-dir`, `SONGNEST_COOKIES`.

## Phone (on-device backend, no PC needed)

The Android app runs the server in-process on `127.0.0.1:8787` with the
rustypipe backend — streaming, downloads, library all on the phone:

```
cd web && npx tauri android build --apk --debug -f android-backend
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

The Rust backend needs NDK C toolchains in the environment (ring,
rusqlite, quickjs bindgen) — with `NDK_HOME` pointing at the NDK:

```
TC=$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin
export BINDGEN_EXTRA_CLANG_ARGS="--sysroot=$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/sysroot"
export CC_aarch64_linux_android=$TC/aarch64-linux-android24-clang
export CC_armv7_linux_androideabi=$TC/armv7a-linux-androideabi24-clang
export CC_i686_linux_android=$TC/i686-linux-android24-clang
export CC_x86_64_linux_android=$TC/x86_64-linux-android24-clang
# (+ matching CXX_* …-clang++); API level 24 = app minSdk
```

No `adb reverse` needed in this mode (the UI's default API base already
points at device localhost). Data lives in the app data dir. The old
thin-client mode (PC server + `adb reverse tcp:8787 tcp:8787`) still works
with a build without `-f android-backend`.

Caveats (2026-10-04): rustypipe 0.11.4 can only resolve via the iOS
client right now (its player-JS deobfuscation parse fails upstream, so
Android/TV/Desktop clients error out); iOS media URLs are throttled
harder than yt-dlp's. On a throttled network, streaming falls back per
range and downloads may 403 — the queue backs off with the usual
5-minute cooldown.

## YouTube throttling (502 / "no candidates")

Undownloaded streaming shells out to `yt-dlp`. YouTube 429/bot-checks
datacenter IPs, and throttled searches return zero entries. If that hits:

1. Log into YouTube in your browser.
2. Export `cookies.txt` (e.g. Get cookies.txt LOCALLY extension).
3. Drop it next to `library.db` (or set `SONGNEST_COOKIES=/path/to/cookies.txt`).
4. No restart needed — it is picked up on the next request.

`cookies.txt` is gitignored. Never commit it.

> Use a **throwaway YouTube account** for the cookies. Heavy automated
> use can get the account flagged — don't risk your main Google account.

## Download queue

Bulk downloads go through a queue: max 2 at a time, sleeps between
tracks, 5-minute cooldown when YouTube 429s. `POST /api/enqueue?dz=<id>`,
progress at `/queue` or `GET /api/downloads`, `GET /api/health` shows
yt-dlp version, update status, and cooldown.
