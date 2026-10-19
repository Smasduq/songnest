//! Android in-place updater built on `PackageInstaller.Session`.
//!
//! Android has no silent self-update for ordinary apps: the platform always
//! shows its own confirmation dialog before an APK is installed. The session
//! API is the closest thing to a one-tap update — the download, signature
//! check and install are all handed to the system, and the user taps Install
//! once. Without it the file lands in the browser's Downloads folder and the
//! user has to find and open it themselves.
//!
//! The flow, all on the Kotlin side:
//!   1. download the APK into the app cache,
//!   2. stream it into a `MODE_FULL_INSTALL` session,
//!   3. `commit()` — the OS shows the confirm dialog,
//!   4. report the outcome back over a plugin event.
//!
//! `install` resolves once the download is staged and the dialog is shown;
//! the final result arrives as an `install-finished` event, because the user
//! can take arbitrarily long on the dialog (or background the app).
//!
//! Desktop builds compile this as a no-op: the Tauri updater already does a
//! real in-place install there (see `updates.ts` / `checkTauriUpdate`).

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

/// Whether this device can install an APK at all. `needsPermission` drives
/// the "Allow installing from this app" step in the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCapability {
    /// The session installer is usable on this device/Android version.
    pub available: bool,
    /// `REQUEST_INSTALL_PACKAGES` is not granted yet — the UI must send the
    /// user to the system settings screen before calling `install`.
    pub needs_permission: bool,
}

/// Outcome of a session install, delivered via the `install-finished` event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    /// "installed" | "cancelled" | "failed"
    pub status: String,
    /// Human-readable reason, present when status is "failed".
    pub message: Option<String>,
}

pub struct Installer<R: Runtime> {
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    handle: Option<PluginHandle<R>>,
}

async fn call<R: Runtime, T: serde::de::DeserializeOwned>(
    installer: &Installer<R>,
    command: &str,
    payload: impl Serialize,
) -> Result<T, String> {
    #[cfg(target_os = "android")]
    {
        let handle = installer
            .handle
            .as_ref()
            .ok_or_else(|| "native Android installer plugin is unavailable".to_string())?;
        handle
            .run_mobile_plugin_async(command, payload)
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (installer, command, payload);
        Err("native Android install is unavailable on this platform".to_string())
    }
}

#[tauri::command]
async fn can_install<R: Runtime>(app: AppHandle<R>) -> Result<InstallCapability, String> {
    let installer = app.state::<Installer<R>>();
    call(&installer, "canInstall", serde_json::json!({})).await
}

/// Send the user to the "Install unknown apps" screen for this app. Android
/// only opens this for the calling package, so no extra scope is needed.
#[tauri::command]
async fn open_install_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let installer = app.state::<Installer<R>>();
    call(&installer, "openInstallSettings", serde_json::json!({})).await
}

/// Download `url`, stage it into an install session and show the system
/// confirm dialog. Resolves once the dialog is up; the result comes later
/// as an `install-finished` event.
#[tauri::command]
async fn install<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    let installer = app.state::<Installer<R>>();
    call(&installer, "install", serde_json::json!({ "url": url })).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("installer")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle: Option<PluginHandle<R>> =
                Some(api.register_android_plugin("com.songnest.installer", "InstallerPlugin")?);
            #[cfg(not(target_os = "android"))]
            let handle: Option<PluginHandle<R>> = {
                let _ = api;
                None
            };
            app.manage(Installer::<R> { handle });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            can_install,
            open_install_settings,
            install
        ])
        .build()
}
