pub mod protocol;
pub mod transports;

// tonic's generated API returns Status by value; do not modify generated bindings.
#[allow(clippy::result_large_err)]
pub mod wire {
    tonic::include_proto!("pi.polyglot.v1");
}
