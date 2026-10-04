#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent};

type ChildSlot = Arc<Mutex<Option<std::process::Child>>>;

/// Locate the songnest-cli backend binary:
/// 1. $SONGNEST_SIDECAR override, 2. bundled resources, 3. workspace target (dev).
fn sidecar_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    if let Ok(p) = std::env::var("SONGNEST_SIDECAR") {
        let p = std::path::PathBuf::from(p);
        if p.exists() {
            return p;
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        for name in ["bin/songnest-cli", "songnest-cli"] {
            let p = res.join(name);
            if p.exists() {
                return p;
            }
        }
    }
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/debug/songnest-cli")
}

/// Spawn `songnest-cli serve --data-dir <app-data>`; the UI talks to it on :8787.
/// On mobile there is no sidecar binary (see spawn_phone_server below),
/// so this is desktop-only.
#[cfg(desktop)]
fn spawn_backend(app: &tauri::AppHandle, slot: &ChildSlot) {
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
    let bin = sidecar_path(app);
    eprintln!(
        "songnest: backend {} data {}",
        bin.display(),
        data_dir.display()
    );
    match std::process::Command::new(&bin)
        .args(["serve", "--data-dir", &data_dir.to_string_lossy()])
        .spawn()
    {
        Ok(child) => {
            *slot.lock().unwrap() = Some(child);
        }
        Err(e) => {
            eprintln!(
                "songnest: cannot spawn backend {} (is another copy on :8787?): {e}",
                bin.display()
            );
        }
    }
}

/// On-device backend (phone): run songnest-server in-process with the
/// rustypipe backend — no Python/yt-dlp/ffmpeg exists on Android. Serves
/// 127.0.0.1:8787, the UI's default API base, with data in the app data dir.
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
    // absolute cache path: the backend is built before run() chdirs.
    let cache = data_dir.join(".rustypipe");
    let backend = match songnest_server::backend_rustypipe(&cache.to_string_lossy()) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("songnest: phone backend init failed: {e}");
            return;
        }
    };
    let dir = data_dir.to_string_lossy().into_owned();
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

fn builder() {
    let backend: ChildSlot = Arc::new(Mutex::new(None));
    let slot = backend.clone();
    let exit_slot = backend.clone();
    tauri::Builder::default()
        .setup(move |app| {
            #[cfg(desktop)]
            spawn_backend(&app.handle(), &slot);
            #[cfg(not(desktop))]
            let _ = (&app, &slot);
            // Phone: the backend runs in-process (no sidecar, no yt-dlp on
            // Android) on 127.0.0.1:8787 — the UI's default API base.
            #[cfg(all(mobile, feature = "android-backend"))]
            spawn_phone_server(&app.handle());
            #[cfg(all(mobile, not(feature = "android-backend")))]
            eprintln!(
                "songnest: phone build without the android-backend feature: \
                 no on-device server (rebuild with -F android-backend)"
            );
            Ok(())
        })
        .on_window_event(move |_, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(mut child) = backend.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running songnest")
        .run(move |_, event| {
            if let RunEvent::ExitRequested { .. } = event {
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
