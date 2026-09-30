fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    ensure_browser_sidecar_placeholder();
    tauri_build::build();
    expose_resource_to_lib_tests();
}

// tauri-build links its resource (icon, version and the Common Controls v6
// manifest) into binaries only. The lib's unit-test executable needs that
// manifest once its code reaches comctl32 v6 entry points, or Windows refuses
// to start it (0xc0000139); lib.rs links the resource under cfg(test).
fn expose_resource_to_lib_tests() {
    let target = std::env::var("TARGET").expect("Cargo did not provide TARGET");
    if target.ends_with("windows-msvc") {
        let out = std::env::var("OUT_DIR").expect("Cargo did not provide OUT_DIR");
        println!("cargo:rustc-link-search=native={out}");
    }
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
