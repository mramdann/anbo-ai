fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    ensure_browser_sidecar_placeholder();
    tauri_build::build()
}

fn ensure_browser_sidecar_placeholder() {
    let target = std::env::var("TARGET").expect("Cargo did not provide TARGET");
    if !target.contains("windows") {
        return;
    }
    let directory =
        std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("binaries");
    let path = directory.join(format!("anbo-browser-{target}.exe"));
    if path.exists() {
        return;
    }
    std::fs::create_dir_all(&directory).expect("failed to create sidecar directory");
    std::fs::write(path, []).expect("failed to create sidecar placeholder");
}
