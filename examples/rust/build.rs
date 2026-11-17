fn main() -> Result<(), Box<dyn std::error::Error>> {
    // No system protoc installation or Pi SDK is required.
    std::env::set_var("PROTOC", protoc_bin_vendored::protoc_bin_path()?);
    println!("cargo:rerun-if-changed=../../proto/extension.proto");
    // The RPC is named Connect, so omit tonic's same-named convenience constructor.
    // Clients use ExtensionClient::new(Channel) instead.
    tonic_build::configure()
        .build_transport(false)
        .compile_protos(&["../../proto/extension.proto"], &["../../proto"])?;
    Ok(())
}
