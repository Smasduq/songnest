fn main() {
    tauri_plugin::Builder::new(&[
        "set_queue",
        "play",
        "pause",
        "next",
        "prev",
        "seek_to",
        "get_state",
    ])
    .android_path("android")
    .build();
}
