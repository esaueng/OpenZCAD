fn main() {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=src/spacemouse.c");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=IOKit");
        cc::Build::new()
            .file("src/spacemouse.c")
            .compile("openzcad_spacemouse");
    }
    tauri_build::build()
}
