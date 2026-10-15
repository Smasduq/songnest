fn main() {
    // Register app commands so tauri-build autogenerates
    // `allow-<command>` / `deny-<command>` permissions for them.
    // Without this the frontend `invoke()` calls below are denied by the
    // ACL at runtime (e.g. Google login fails with "Couldn't start login
    // on this device"). The allows live in capabilities/default.json.
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "secret_set",
            "secret_get",
            "secret_delete",
            "get_lyrics",
            "set_lyric_offset",
            "oauth_loopback_begin",
            "oauth_loopback_wait",
        ]),
    );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
