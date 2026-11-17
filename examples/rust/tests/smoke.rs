//! Real-process tests: no Pi SDK, model, or external service is involved.
use polyglot_example::{
    transports::read_frame,
    wire::{extension_client::ExtensionClient, Frame},
};
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::mpsc,
};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{transport::Channel, Request, Streaming};

const TOKEN: &str = "local-smoke-test-token";
const BIN: &str = env!("CARGO_BIN_EXE_polyglot-example");

enum Peer {
    Stdio {
        input: ChildStdin,
        output: BufReader<ChildStdout>,
    },
    Http {
        client: reqwest::Client,
        url: String,
        events: reqwest::Response,
        buffer: Vec<u8>,
    },
    Grpc {
        input: mpsc::Sender<Frame>,
        output: Box<Streaming<Frame>>,
    },
}
impl Peer {
    async fn send(&mut self, message: Value) {
        match self {
            Self::Stdio { input, .. } => {
                input
                    .write_all(format!("{message}\n").as_bytes())
                    .await
                    .unwrap();
                input.flush().await.unwrap();
            }
            Self::Http { client, url, .. } => {
                assert_eq!(
                    client
                        .post(format!("{url}/messages"))
                        .bearer_auth(TOKEN)
                        .json(&message)
                        .send()
                        .await
                        .unwrap()
                        .status(),
                    202
                );
            }
            Self::Grpc { input, .. } => input
                .send(Frame {
                    json: message.to_string(),
                })
                .await
                .unwrap(),
        }
    }
    async fn next(&mut self) -> Option<Value> {
        tokio::time::timeout(Duration::from_secs(5), async {
            match self {
                Self::Stdio { output, .. } => read_frame(output)
                    .await
                    .unwrap()
                    .map(|s| serde_json::from_str(&s).unwrap()),
                Self::Grpc { output, .. } => output
                    .message()
                    .await
                    .unwrap()
                    .map(|f| serde_json::from_str(&f.json).unwrap()),
                Self::Http { events, buffer, .. } => loop {
                    if let Some(end) = buffer.windows(2).position(|w| w == b"\n\n") {
                        let event = String::from_utf8(buffer.drain(..end + 2).collect()).unwrap();
                        if let Some(data) =
                            event.lines().find_map(|line| line.strip_prefix("data: "))
                        {
                            break Some(serde_json::from_str(data).unwrap());
                        }
                        continue;
                    }
                    match events.chunk().await.unwrap() {
                        Some(chunk) => {
                            buffer.extend_from_slice(&chunk);
                            assert!(buffer.len() <= 2 * 1024 * 1024);
                        }
                        None => break None,
                    }
                },
            }
        })
        .await
        .expect("peer response timeout")
    }
    async fn recv(&mut self) -> Value {
        self.next().await.expect("unexpected connection close")
    }
}
fn request(id: &str, method: &str, params: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
}
fn tool(id: &str, name: &str, arguments: Value) -> Value {
    request(
        id,
        "tool.call",
        json!({"name":name,"arguments":arguments,"context":{"cwd":"/tmp"}}),
    )
}
async fn init(peer: &mut Peer) {
    peer.send(request("pi-init", "initialize", json!({"protocolVersion":"0.1","client":{"name":"smoke","version":"1"},"permissions":["ui.confirm","ui.notify"],"context":{"cwd":"/tmp"}}))).await;
    assert_eq!(
        peer.recv().await["result"],
        polyglot_example::protocol::catalog()
    );
}
async fn hello(peer: &mut Peer, id: &str) {
    peer.send(request(
        id,
        "command.execute",
        json!({"name":"hello","arguments":"","context":{"cwd":"/tmp"}}),
    ))
    .await;
    assert_eq!(peer.recv().await["result"]["text"], "Hello, world!");
}
async fn finish_greet(peer: &mut Peer, confirm: Value, parent: &str) {
    assert_eq!(confirm["method"], "host.ui.confirm");
    assert_eq!(confirm["params"]["parentRequestId"], parent);
    peer.send(json!({"jsonrpc":"2.0","id":confirm["id"],"result":{"confirmed":true}}))
        .await;
    let notify = peer.recv().await;
    assert_eq!(notify["method"], "host.ui.notify");
    assert_eq!(notify["params"]["parentRequestId"], parent);
    peer.send(json!({"jsonrpc":"2.0","id":notify["id"],"result":{}}))
        .await;
    let result = peer.recv().await;
    assert_eq!(result["id"], parent);
    assert_eq!(result["result"]["content"][0]["text"], "Hello, Rust!");
}
async fn shutdown(peer: &mut Peer) {
    peer.send(request("pi-stop", "shutdown", json!({}))).await;
    assert_eq!(peer.recv().await["result"], json!({}));
    assert!(peer.next().await.is_none());
}
async fn exercise(peer: &mut Peer) {
    init(peer).await;
    peer.send(tool("pi-greet", "greet", json!({"name":"Rust"})))
        .await;
    let confirm = peer.recv().await;
    // A pending reverse call must not prevent a new request or its cancellation.
    peer.send(tool("pi-wait", "wait", json!({"milliseconds":10000})))
        .await;
    let progress = peer.recv().await;
    assert_eq!(progress["method"], "progress");
    assert_eq!(progress["params"]["requestId"], "pi-wait");
    peer.send(json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":"pi-wait"}}))
        .await;
    let error = peer.recv().await;
    assert_eq!(error["id"], "pi-wait");
    assert_eq!(error["error"]["code"], -32800);
    hello(peer, "pi-hello").await;
    finish_greet(peer, confirm, "pi-greet").await;
    peer.send(tool("pi-zero", "wait", json!({"milliseconds":0})))
        .await;
    assert_eq!(peer.recv().await["method"], "progress");
    assert_eq!(
        peer.recv().await["result"]["content"][0]["text"],
        "Finished waiting."
    );
    for (i, (name, event)) in [
        ("session_start", json!({"reason":"new"})),
        (
            "before_agent_start",
            json!({"prompt":"p","systemPrompt":"s"}),
        ),
        (
            "tool_call",
            json!({"toolName":"x","toolCallId":"y","input":{}}),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        peer.send(request(
            &format!("pi-hook{i}"),
            "hook.run",
            json!({"name":name,"event":event,"context":{"cwd":"/tmp"}}),
        ))
        .await;
        assert_eq!(peer.recv().await["result"], json!({}));
    }
    peer.send(tool("pi-invalid", "greet", json!({"name":12})))
        .await;
    assert_eq!(peer.recv().await["error"]["code"], -32602);
}
async fn server(transport: &str) -> (Child, u16) {
    let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = socket.local_addr().unwrap().port();
    drop(socket);
    let mut child = Command::new(BIN)
        .args(["--transport", transport, "--port", &port.to_string()])
        .env("POLYGLOT_TOKEN", TOKEN)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return (child, port);
        }
        assert!(
            child.try_wait().unwrap().is_none(),
            "server exited at startup"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("server startup timeout");
}
async fn http_peer(port: u16) -> Peer {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let response = client
        .post(format!("{base}/sessions"))
        .bearer_auth(TOKEN)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 201);
    let id = response.json::<Value>().await.unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let url = format!("{base}/sessions/{id}");
    // Authenticate every route, not only creation.
    assert_eq!(
        client
            .post(format!("{base}/sessions"))
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        client
            .get(format!("{url}/events"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        client
            .post(format!("{url}/messages"))
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(client.delete(&url).send().await.unwrap().status(), 401);
    assert_eq!(
        client
            .post(format!("{url}/messages"))
            .bearer_auth(TOKEN)
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        409
    );
    let events = tokio::time::timeout(
        Duration::from_secs(2),
        client
            .get(format!("{url}/events"))
            .bearer_auth(TOKEN)
            .send(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(events.status(), 200);
    assert!(events.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("text/event-stream"));
    assert_eq!(
        client
            .get(format!("{url}/events"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .status(),
        409
    );
    Peer::Http {
        client,
        url,
        events,
        buffer: Vec::new(),
    }
}
async fn grpc_peer(port: u16) -> Peer {
    let channel = Channel::from_shared(format!("http://127.0.0.1:{port}"))
        .unwrap()
        .connect()
        .await
        .unwrap();
    let mut client = ExtensionClient::new(channel);
    let (_tx, rx) = mpsc::channel::<Frame>(32);
    let error = client
        .connect(Request::new(ReceiverStream::new(rx)))
        .await
        .unwrap_err();
    assert_eq!(error.code(), tonic::Code::Unauthenticated);
    let (input, rx) = mpsc::channel(32);
    let mut request = Request::new(ReceiverStream::new(rx));
    request
        .metadata_mut()
        .insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
    let output = client.connect(request).await.unwrap().into_inner();
    Peer::Grpc {
        input,
        output: Box::new(output),
    }
}
async fn isolation(first: &mut Peer, second: &mut Peer) {
    init(second).await;
    // Same host ID is valid in different connections; callback maps must still be separate.
    first
        .send(tool("pi-isolated", "greet", json!({"name":"Rust"})))
        .await;
    second
        .send(tool("pi-isolated", "greet", json!({"name":"Rust"})))
        .await;
    let first_confirm = first.recv().await;
    let second_confirm = second.recv().await;
    assert_ne!(first_confirm["id"], second_confirm["id"]);
    second
        .send(json!({"jsonrpc":"2.0","id":first_confirm["id"],"result":{"confirmed":true}}))
        .await;
    // This callback belongs to the first connection and cannot settle the second connection.
    hello(second, "pi-during-callback").await;
    first
        .send(json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":"pi-isolated"}}))
        .await;
    assert_eq!(first.recv().await["error"]["code"], -32800);
    finish_greet(second, second_confirm, "pi-isolated").await;
    shutdown(first).await;
    hello(second, "pi-after-other-shutdown").await;
    shutdown(second).await;
}

#[tokio::test]
async fn stdio_smoke() {
    let mut child = Command::new(BIN)
        .args(["--transport", "stdio"])
        .env_remove("POLYGLOT_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut peer = Peer::Stdio {
        input: child.stdin.take().unwrap(),
        output: BufReader::new(child.stdout.take().unwrap()),
    };
    exercise(&mut peer).await;
    shutdown(&mut peer).await;
    // Keep stdin open: explicit shutdown must still exit without waiting for EOF.
    assert!(tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .unwrap()
        .unwrap()
        .success());
}
#[tokio::test]
async fn http_smoke_auth_isolation_and_shutdown() {
    let (mut child, port) = server("http").await;
    let mut first = http_peer(port).await;
    exercise(&mut first).await;
    let mut second = http_peer(port).await;
    isolation(&mut first, &mut second).await;
    let mut third = http_peer(port).await;
    if let Peer::Http { client, url, .. } = &third {
        assert_eq!(
            client
                .post(format!("{url}/messages"))
                .bearer_auth(TOKEN)
                .body("x".repeat(polyglot_example::protocol::MAX_FRAME + 1))
                .send()
                .await
                .unwrap()
                .status(),
            413
        );
    }
    init(&mut third).await;
    if let Peer::Http { client, url, .. } = &third {
        assert_eq!(
            client
                .delete(url)
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap()
                .status(),
            204
        );
    }
    assert!(third.next().await.is_none());
    assert!(child.try_wait().unwrap().is_none());
    child.kill().await.unwrap();
}
#[tokio::test]
async fn grpc_smoke_auth_isolation_and_shutdown() {
    let (mut child, port) = server("grpc").await;
    let mut first = grpc_peer(port).await;
    exercise(&mut first).await;
    let mut second = grpc_peer(port).await;
    isolation(&mut first, &mut second).await;
    let mut oversized = grpc_peer(port).await;
    if let Peer::Grpc { input, .. } = &mut oversized {
        input
            .send(Frame {
                json: "x".repeat(polyglot_example::protocol::MAX_FRAME + 1),
            })
            .await
            .unwrap();
    }
    assert!(oversized.next().await.is_none());
    let mut third = grpc_peer(port).await;
    init(&mut third).await;
    shutdown(&mut third).await;
    assert!(child.try_wait().unwrap().is_none());
    child.kill().await.unwrap();
}
#[tokio::test]
async fn network_servers_require_token() {
    for transport in ["http", "grpc"] {
        let output = Command::new(BIN)
            .args(["--transport", transport])
            .env_remove("POLYGLOT_TOKEN")
            .output()
            .await
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8(output.stderr)
            .unwrap()
            .contains("POLYGLOT_TOKEN"));
    }
}
