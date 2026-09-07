fn main() {
    println!("cargo:rerun-if-changed=native/bridge.cpp");
    println!("cargo:rerun-if-changed=vendor/nvEncodeAPI.h");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        cc::Build::new().cpp(true).file("native/bridge.cpp").include("vendor")
            .flag_if_supported("/std:c++17").flag_if_supported("/EHsc")
            .define("NOMINMAX", None).compile("belay_nvenc_bridge");
    }
}
