fn main() {
    tauri_plugin::Builder::new(&[
        "can_install",
        "open_install_settings",
        "install",
    ])
    .android_path("android")
    .build();
}
