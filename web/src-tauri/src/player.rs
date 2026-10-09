//! Background playback support (desktop).
//!
//! Desktop audio keeps playing in the WebView `<audio>` element (see
//! `frontend/src/player/store.ts`); what used to kill it was closing the
//! window. This module adds a system tray with transport actions and turns
//! close-into-hide, so playback survives in the background. Tray actions
//! reach the frontend as [`CONTROL_EVENT`] payloads (`"toggle"`, `"prev"`,
//! `"next"`); the MediaSession metadata itself is published from the
//! frontend (`frontend/src/native/background-player.ts`), which works on
//! Windows/macOS while the tray covers Linux MPRIS-less gaps.
//!
//! On mobile this module is a no-op: audio runs in the native player
//! (`tauri-plugin-native-audio`, Media3 on Android) with its own
//! notification, lockscreen controls, and foreground service.

/// Frontend event name for tray transport actions.
pub const CONTROL_EVENT: &str = "player-control";

/// Build the tray icon + menu. Desktop only; no-op elsewhere.
#[cfg(desktop)]
pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        Emitter,
    };

    let show = MenuItem::with_id(app, "show", "Show Songnest", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Play/Pause", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "Previous track", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Next track", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &toggle, &prev, &next, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or(tauri::Error::UnknownPath)?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Songnest")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            action @ ("toggle" | "prev" | "next") => {
                let _ = app.emit(CONTROL_EVENT, action);
                // Acting from the tray while hidden must not steal focus.
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(not(desktop))]
pub fn setup(_app: &mut tauri::App) -> tauri::Result<()> {
    Ok(())
}

#[cfg(desktop)]
fn show_main(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
