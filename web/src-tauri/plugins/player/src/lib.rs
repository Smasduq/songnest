use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    id: String,
    url: String,
    title: String,
    artist: String,
    artwork: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    position: i64,
    duration: i64,
    playing: bool,
    current_index: i32,
    current_id: String,
}

pub struct Player<R: Runtime> {
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    handle: Option<PluginHandle<R>>,
}

async fn call<R: Runtime, T: serde::de::DeserializeOwned>(
    player: &Player<R>,
    command: &str,
    payload: impl Serialize,
) -> Result<T, String> {
    #[cfg(target_os = "android")]
    {
        let handle = player
            .handle
            .as_ref()
            .ok_or_else(|| "native Android player plugin is unavailable".to_string())?;
        handle
            .run_mobile_plugin_async(command, payload)
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (player, command, payload);
        Err("native Android playback is unavailable on this platform".to_string())
    }
}

#[tauri::command]
async fn set_queue<R: Runtime>(
    app: AppHandle<R>,
    tracks: Vec<Track>,
    start_index: usize,
    preserve_position: Option<bool>,
) -> Result<(), String> {
    let player = app.state::<Player<R>>();
    call(
        &player,
        "setQueue",
        serde_json::json!({
            "tracks": tracks,
            "startIndex": start_index,
            "preservePosition": preserve_position.unwrap_or(false),
        }),
    )
    .await
}

#[tauri::command]
async fn play<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let player = app.state::<Player<R>>();
    call(&player, "play", serde_json::json!({})).await
}

#[tauri::command]
async fn pause<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let player = app.state::<Player<R>>();
    call(&player, "pause", serde_json::json!({})).await
}

#[tauri::command]
async fn next<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let player = app.state::<Player<R>>();
    call(&player, "next", serde_json::json!({})).await
}

#[tauri::command]
async fn prev<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let player = app.state::<Player<R>>();
    call(&player, "prev", serde_json::json!({})).await
}

#[tauri::command]
async fn seek_to<R: Runtime>(app: AppHandle<R>, position_ms: i64) -> Result<(), String> {
    let player = app.state::<Player<R>>();
    call(
        &player,
        "seekTo",
        serde_json::json!({ "positionMs": position_ms }),
    )
    .await
}

#[tauri::command]
async fn get_state<R: Runtime>(app: AppHandle<R>) -> Result<PlayerState, String> {
    let player = app.state::<Player<R>>();
    call(&player, "getState", serde_json::json!({})).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("player")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle: Option<PluginHandle<R>> =
                Some(api.register_android_plugin("com.songnest.player", "PlayerPlugin")?);
            #[cfg(not(target_os = "android"))]
            let handle: Option<PluginHandle<R>> = {
                let _ = api;
                None
            };
            app.manage(Player::<R> { handle });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_queue, play, pause, next, prev, seek_to, get_state
        ])
        .build()
}
