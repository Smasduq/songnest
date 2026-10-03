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
    eprintln!("songnest: backend {} data {}", bin.display(), data_dir.display());
    match std::process::Command::new(&bin)
        .args([
            "serve",
            "--data-dir",
            &data_dir.to_string_lossy(),
        ])
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

fn main() {
    let backend: ChildSlot = Arc::new(Mutex::new(None));
    let slot = backend.clone();
    let exit_slot = backend.clone();
    tauri::Builder::default()
        .setup(move |app| {
            spawn_backend(&app.handle(), &slot);
            Ok(())
        })
        .on_window_event({
            let slot = backend.clone();
            move |_, event| {
                if let tauri::WindowEvent::Destroyed = event {
                    if let Some(mut child) = slot.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running songnest")
        .run(move |_, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // belt and suspenders alongside the window-destroyed kill
                if let Some(mut child) = exit_slot.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
