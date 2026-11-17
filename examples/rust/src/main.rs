use polyglot_example::transports;

fn options() -> Result<(String, u16), &'static str> {
    let mut transport = "stdio".to_owned();
    let mut port = 8787;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--transport" => transport = args.next().ok_or("Missing transport")?,
            "--port" => {
                port = args
                    .next()
                    .ok_or("Missing port")?
                    .parse::<u16>()
                    .map_err(|_| "Invalid port")?
            }
            "--help" | "-h" => {
                return Err("Usage: polyglot-example --transport stdio|http|grpc --port <port>")
            }
            _ => return Err("Unknown argument"),
        }
    }
    if !matches!(transport.as_str(), "stdio" | "http" | "grpc") {
        return Err("Invalid transport");
    }
    if port == 0 {
        return Err("Port must be 1..65535");
    }
    Ok((transport, port))
}
#[tokio::main]
async fn main() {
    let (transport, port) = options().unwrap_or_else(|message| {
        eprintln!("{message}");
        std::process::exit(2)
    });
    let result = match transport.as_str() {
        "stdio" => transports::stdio()
            .await
            .map_err(|e| Box::new(e) as Box<dyn std::error::Error>),
        _ => {
            let token = std::env::var("POLYGLOT_TOKEN")
                .ok()
                .filter(|s| {
                    !s.is_empty() && s.len() <= 4096 && s.bytes().all(|b| (33..=126).contains(&b))
                })
                .unwrap_or_else(|| {
                    eprintln!("POLYGLOT_TOKEN must be 1..4096 visible ASCII characters");
                    std::process::exit(2)
                });
            if transport == "http" {
                transports::http(port, token).await
            } else {
                transports::grpc(port, token).await
            }
        }
    };
    // Never print library errors that could contain peer-controlled data or credentials.
    let code = if result.is_ok() {
        0
    } else {
        eprintln!("Transport failed");
        1
    };
    // See the stdin teardown note in transports::stdio. All protocol output has been flushed.
    std::process::exit(code);
}
