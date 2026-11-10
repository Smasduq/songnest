#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(desktop)]
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(desktop)]
use tauri::Emitter;
use tauri::{Manager, RunEvent};

mod lyrics;
mod oauth;
mod player;

type ChildSlot = Arc<Mutex<Option<std::process::Child>>>;

/// Last backend launch failure, exposed to the UI so a missing/broken
/// sidecar shows a real explanation instead of a permanent "offline".
#[derive(Clone, serde::Serialize)]
struct BackendError {
    message: String,
    detail: String,
}

#[derive(Default, Clone)]
struct BackendState {
    last_error: Arc<Mutex<Option<BackendError>>>,
}

#[tauri::command]
fn backend_diagnostics(state: tauri::State<'_, BackendState>) -> Option<BackendError> {
    state.last_error.lock().unwrap().clone()
}

/// Write a line to stderr and to `<app-data>/songnest.log`. A Windows GUI
/// build has no console, so without the file a launch failure leaves no
/// evidence at all.
#[cfg(desktop)]
fn app_log(app: &tauri::AppHandle, line: &str) {
    eprintln!("songnest: {line}");
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("songnest.log");
    // Keep the log bounded; this is a support aid, not an audit trail.
    if std::fs::metadata(&path)
        .map(|m| m.len() > 1_000_000)
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{secs}] {line}");
    }
}

#[cfg(desktop)]
fn backend_error(
    app: &tauri::AppHandle,
    state: &BackendState,
    message: impl Into<String>,
    detail: impl Into<String>,
) {
    let err = BackendError {
        message: message.into(),
        detail: detail.into(),
    };
    app_log(
        app,
        &format!("backend error: {} ({})", err.message, err.detail),
    );
    *state.last_error.lock().unwrap() = Some(err.clone());
    // A late listener can still query backend_diagnostics; the event covers
    // failures that happen after the WebView is up (restarts, crashes).
    let _ = app.emit("backend-error", err);
}

/// Bundled backend names, relative to the install/resource directory.
/// `bin/` is where `bundle.resources` puts it; the root names are for
/// older layouts. The app's own executable is filtered out by path, so a
/// missing backend can never make the app spawn itself.
#[cfg(desktop)]
const SIDECAR_NAMES: &[&str] = &[
    "bin/songnest.exe",
    "bin/songnest",
    "bin/songnest-cli.exe",
    "bin/songnest-cli",
    "songnest-backend.exe",
    "songnest-backend",
    "songnest.exe",
    "songnest",
    "songnest-cli.exe",
    "songnest-cli",
];

#[cfg(desktop)]
fn same_file(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => a == b,
    }
}

#[cfg(all(desktop, debug_assertions))]
fn dev_sidecar_dirs() -> Vec<std::path::PathBuf> {
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    vec![
        manifest.join("../../target/debug"),
        manifest.join("../../target/release"),
        manifest.join("bin"),
    ]
}

/// Release binaries must not contain the build machine's paths.
#[cfg(all(desktop, not(debug_assertions)))]
fn dev_sidecar_dirs() -> Vec<std::path::PathBuf> {
    Vec::new()
}

/// Locate the songnest backend binary:
/// 1. `$SONGNEST_SIDECAR`, 2. next to the app, 3. bundled resources,
/// 4. workspace target dirs (dev builds only).
///
/// Returns the list of places we looked in the error so the UI can show it.
#[cfg(desktop)]
fn sidecar_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let current = std::env::current_exe().ok();
    let mut tried: Vec<String> = Vec::new();

    if let Ok(p) = std::env::var("SONGNEST_SIDECAR") {
        let p = std::path::PathBuf::from(p);
        if p.is_file() {
            return Ok(p);
        }
        tried.push(format!("{} (from SONGNEST_SIDECAR)", p.display()));
    }

    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    let mut push_dir = |dir: std::path::PathBuf| {
        if !dirs.iter().any(|d| d == &dir) {
            dirs.push(dir);
        }
    };
    if let Some(exe) = &current {
        if let Some(dir) = exe.parent() {
            push_dir(dir.to_path_buf());
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        push_dir(res);
    }
    for dir in dev_sidecar_dirs() {
        push_dir(dir);
    }

    if let Some(p) = find_sidecar(current.as_deref(), &dirs) {
        return Ok(p);
    }
    for dir in &dirs {
        tried.push(format!("{}/bin/songnest[.exe]", dir.display()));
    }

    Err(format!(
        "the songnest backend is missing from this installation; looked in {}",
        tried.join(", ")
    ))
}

/// Search `dirs` for a backend, skipping the running executable. Split out
/// from `sidecar_path` so the "never spawn yourself" rule is testable.
#[cfg(desktop)]
fn find_sidecar(
    current: Option<&std::path::Path>,
    dirs: &[std::path::PathBuf],
) -> Option<std::path::PathBuf> {
    for dir in dirs {
        for name in SIDECAR_NAMES {
            let p = dir.join(name);
            if !p.is_file() {
                continue;
            }
            // Never treat the running app as its own backend. This matters
            // on Windows, where the app and the backend are both
            // `songnest.exe` and `resource_dir` is the app's own folder.
            if current.is_some_and(|exe| same_file(&p, exe)) {
                continue;
            }
            return Some(p);
        }
    }
    None
}

/// Spawn `songnest serve --data-dir <app-data>`; the UI talks to it on :8787.
/// On mobile there is no sidecar binary (see spawn_phone_server below),
/// so this is desktop-only.
#[cfg(desktop)]
fn spawn_backend(app: &tauri::AppHandle, slot: &ChildSlot, state: &BackendState) {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            backend_error(app, state, "Songnest has no data folder.", e.to_string());
            return;
        }
    };
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        backend_error(
            app,
            state,
            "Songnest can't create its data folder.",
            format!("{}: {e}", data_dir.display()),
        );
        return;
    }
    let bin = match sidecar_path(app) {
        Ok(bin) => bin,
        Err(detail) => {
            backend_error(
                app,
                state,
                "Songnest's local music service is missing from this installation.",
                detail,
            );
            return;
        }
    };
    app_log(
        app,
        &format!("backend {} data {}", bin.display(), data_dir.display()),
    );
    let mut command = std::process::Command::new(&bin);
    command.args(["serve", "--data-dir", &data_dir.to_string_lossy()]);
    command.stdin(std::process::Stdio::null());
    // Keep the backend's own log next to library.db. On Windows a GUI launch
    // has no console, so this is the only place its stderr survives.
    let log = data_dir.join("backend.log");
    if std::fs::metadata(&log)
        .map(|m| m.len() > 5_000_000)
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(&log);
    }
    if let Ok(f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
    {
        if let Ok(f2) = f.try_clone() {
            command.stdout(std::process::Stdio::from(f));
            command.stderr(std::process::Stdio::from(f2));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    match command.spawn() {
        Ok(child) => {
            *slot.lock().unwrap() = Some(child);
            *state.last_error.lock().unwrap() = None;
        }
        Err(e) => {
            backend_error(
                app,
                state,
                "Songnest's local music service couldn't start.",
                format!("{}: {e}", bin.display()),
            );
        }
    }
}

/// Keep the backend alive: an in-place update can briefly lock/replace
/// `bin/songnest.exe`, and a crash shouldn't leave the UI offline forever.
/// Stops as soon as the app takes the child (exit/close) or the shutdown
/// flag is set.
#[cfg(desktop)]
fn supervise_backend(
    app: tauri::AppHandle,
    slot: ChildSlot,
    state: BackendState,
    shutdown: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut failures = 0u32;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if shutdown.load(Ordering::SeqCst) {
                return;
            }
            let running = {
                let mut guard = slot.lock().unwrap();
                match guard.as_mut() {
                    None => false,
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => {
                            app_log(&app, &format!("backend exited ({status})"));
                            *guard = None;
                            false
                        }
                        Ok(None) => true,
                        Err(e) => {
                            app_log(&app, &format!("backend wait failed: {e}"));
                            *guard = None;
                            false
                        }
                    },
                }
            };
            if running {
                failures = 0;
                continue;
            }
            failures += 1;
            if failures > 5 {
                backend_error(
                    &app,
                    &state,
                    "Songnest's local music service keeps stopping.",
                    format!(
                        "The backend failed {failures} times. See songnest.log and backend.log in the app data folder."
                    ),
                );
                return;
            }
            let delay = std::time::Duration::from_secs(1 << failures.min(3));
            std::thread::sleep(delay);
            if shutdown.load(Ordering::SeqCst) {
                return;
            }
            app_log(&app, "restarting backend");
            spawn_backend(&app, &slot, &state);
        }
    });
}

/// On-device backend (phone): run songnest-server in-process with
/// SongnestPy — yt-dlp on the embedded CPython interpreter (Chaquopy),
/// reached over JNI. Serves 127.0.0.1:8787, the UI's default API base,
/// with data in the app data dir.
#[cfg(all(mobile, feature = "android-backend"))]
fn spawn_phone_server(app: &tauri::AppHandle) {
    use tauri::Manager;
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("songnest: no app data dir: {e}");
            return;
        }
    };
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("songnest: cannot create {}: {e}", data_dir.display());
        return;
    }
    // absolute data dir: the backend is built before run() chdirs. yt-dlp
    // picks up <data_dir>/cookies.txt here when present (else anonymous).
    let dir = data_dir.to_string_lossy().into_owned();
    let backend = match songnest_server::backend_songnestpy(&dir) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("songnest: phone backend init failed: {e}");
            return;
        }
    };
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                eprintln!("songnest: no tokio runtime: {e}");
                return;
            }
        };
        if let Err(e) = rt.block_on(songnest_server::run(Some(dir), backend, 8787)) {
            eprintln!("songnest: phone server exited: {e}");
        }
    });
}

/// OS-credential-store secrets for account tokens (see secure-store.ts).
///
/// Uses the platform keychain (macOS Keychain, Windows Credential Manager,
/// Linux Secret Service, mobile keystores) via the `keyring` crate. Any
/// platform failure is reported as a plain error string — never the secret
/// — so the frontend can fall back to localStorage (browser dev).
const SECRET_SERVICE: &str = "com.songnest.app";

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    keyring::Entry::new(SECRET_SERVICE, &key)
        .map_err(|e| format!("keychain unavailable: {e}"))?
        .set_password(&value)
        .map_err(|e| format!("keychain write failed: {e}"))
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SECRET_SERVICE, &key)
        .map_err(|e| format!("keychain unavailable: {e}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain read failed: {e}")),
    }
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SECRET_SERVICE, &key)
        .map_err(|e| format!("keychain unavailable: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {e}")),
    }
}

fn builder() {
    let backend: ChildSlot = Arc::new(Mutex::new(None));
    let slot = backend.clone();
    let exit_slot = backend.clone();
    let backend_state = BackendState::default();
    let managed_state = backend_state.clone();
    let shutdown = Arc::new(AtomicBool::new(false));
    let win_shutdown = shutdown.clone();
    let exit_shutdown = shutdown.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_native_audio::init())
        .plugin(tauri_plugin_player::init())
        .plugin(tauri_plugin_installer::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(oauth::OAuthSlot::default())
        .manage(managed_state)
        .invoke_handler(tauri::generate_handler![
            secret_set,
            secret_get,
            secret_delete,
            backend_diagnostics,
            lyrics::get_lyrics,
            lyrics::set_lyric_offset,
            oauth::oauth_loopback_begin,
            oauth::oauth_loopback_wait
        ])
        .setup(move |app| {
            // Tray + close-to-hide (desktop): the background player shell.
            // Mobile is a no-op here; its player lives in the native service.
            player::setup(app)?;
            #[cfg(desktop)]
            {
                spawn_backend(app.handle(), &slot, &backend_state);
                supervise_backend(
                    app.handle().clone(),
                    slot.clone(),
                    backend_state.clone(),
                    shutdown.clone(),
                );
            }
            #[cfg(not(desktop))]
            let _ = (&app, &slot, &backend_state, &shutdown);
            // Phone: the backend runs in-process (no sidecar, no subprocess
            // yt-dlp on Android) on 127.0.0.1:8787 — the UI's default API base.
            #[cfg(all(mobile, feature = "android-backend"))]
            spawn_phone_server(&app.handle());
            #[cfg(all(mobile, not(feature = "android-backend")))]
            eprintln!(
                "songnest: phone build without the android-backend feature: \
                 no on-device server, so /api/resolve has no full-song backend. \
                 Rebuild with the on-device SongnestPy server: \
                 npm run android:dev (or android:build)"
            );
            Ok(())
        })
        .on_window_event(move |window, event| {
            match event {
                // Desktop background playback: closing the window hides it
                // to the tray instead of stopping the music. Real exit goes
                // through the tray "Quit" item (RunEvent::ExitRequested).
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    #[cfg(desktop)]
                    {
                        let _ = window.hide();
                        api.prevent_close();
                    }
                    #[cfg(not(desktop))]
                    let _ = (window, api);
                }
                tauri::WindowEvent::Destroyed => {
                    win_shutdown.store(true, Ordering::SeqCst);
                    if let Some(mut child) = backend.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running songnest")
        .run(move |_, event| {
            if let RunEvent::ExitRequested { .. } = event {
                exit_shutdown.store(true, Ordering::SeqCst);
                if let Some(mut child) = exit_slot.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}

#[cfg(mobile)]
#[tauri::mobile_entry_point]
fn main() {
    builder();
}

#[cfg(not(mobile))]
pub fn run() {
    builder();
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("songnest-sidecar-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_bundled_backend_in_bin() {
        let root = scratch("bundled");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        let backend = root.join("bin").join("songnest");
        std::fs::write(&backend, b"x").unwrap();
        assert_eq!(
            find_sidecar(None, std::slice::from_ref(&root)),
            Some(backend)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn never_returns_the_running_executable() {
        let root = scratch("self");
        let app = root.join("songnest");
        std::fs::write(&app, b"app").unwrap();
        // A Windows install has the app at the root and the backend in
        // bin/. With only the app present, resolution must fail instead of
        // spawning the app recursively.
        assert_eq!(find_sidecar(Some(&app), std::slice::from_ref(&root)), None);

        std::fs::create_dir_all(root.join("bin")).unwrap();
        let backend = root.join("bin").join("songnest");
        std::fs::write(&backend, b"backend").unwrap();
        assert_eq!(
            find_sidecar(Some(&app), std::slice::from_ref(&root)),
            Some(backend)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn prefers_the_windows_exe_name() {
        let root = scratch("exe");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        let exe = root.join("bin").join("songnest.exe");
        std::fs::write(&exe, b"x").unwrap();
        assert_eq!(find_sidecar(None, std::slice::from_ref(&root)), Some(exe));
        let _ = std::fs::remove_dir_all(root);
    }
}
