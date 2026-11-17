//! Transport-independent, bounded, bidirectional JSON-RPC connection.
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

pub const MAX_FRAME: usize = 1024 * 1024;
pub const QUEUE: usize = 32;
pub const MAX_ACTIVE: usize = 32;
const MAX_IDS: usize = 4096;
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(10);

type RpcResult = Result<Value, RpcError>;
#[derive(Debug)]
struct RpcError(i64, &'static str);
fn invalid() -> RpcError {
    RpcError(-32602, "Invalid params")
}
fn cancelled() -> RpcError {
    RpcError(-32800, "Request cancelled")
}
fn failed(message: &'static str) -> RpcError {
    RpcError(-32000, message)
}

pub struct Connection {
    pub input: mpsc::Sender<String>,
    pub output: mpsc::Receiver<String>,
    pub closed: CancellationToken,
}
impl Connection {
    pub fn spawn() -> Self {
        let (input, rx) = mpsc::channel(QUEUE);
        let (tx, output) = mpsc::channel(QUEUE);
        let closed = CancellationToken::new();
        let state = Arc::new(State {
            output: tx,
            closed: closed.clone(),
            callbacks: Mutex::new(HashMap::new()),
            active: Mutex::new(HashMap::new()),
            permissions: Mutex::new(None),
        });
        tokio::spawn(run(rx, state));
        Self {
            input,
            output,
            closed,
        }
    }
}
struct State {
    output: mpsc::Sender<String>,
    closed: CancellationToken,
    callbacks: Mutex<HashMap<String, oneshot::Sender<RpcResult>>>,
    active: Mutex<HashMap<String, CancellationToken>>,
    permissions: Mutex<Option<HashSet<String>>>,
}
impl State {
    async fn send(&self, value: Value) -> bool {
        let frame = value.to_string();
        if frame.len() > MAX_FRAME {
            self.closed.cancel();
            return false;
        }
        let sent = tokio::select! {
            _ = self.closed.cancelled() => false,
            result = tokio::time::timeout(SEND_TIMEOUT, self.output.send(frame)) => matches!(result, Ok(Ok(()))),
        };
        if !sent {
            self.closed.cancel();
        }
        sent
    }
    async fn reply(&self, id: &str, result: RpcResult) {
        let value = match result {
            Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
            Err(RpcError(code, message)) => {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
            }
        };
        self.send(value).await;
    }
    async fn reverse(
        self: &Arc<Self>,
        parent: &str,
        permission: &str,
        method: &str,
        params: Value,
    ) -> RpcResult {
        let allowed = self
            .permissions
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|p| p.contains(permission));
        if !allowed {
            return Err(failed("Required UI permission is missing"));
        }
        let id = format!("ext-{}", uuid::Uuid::new_v4());
        let (tx, rx) = oneshot::channel();
        self.callbacks.lock().unwrap().insert(id.clone(), tx);
        let _guard = CallbackGuard {
            state: self.clone(),
            id: id.clone(),
        };
        if !self.active.lock().unwrap().contains_key(parent) {
            return Err(cancelled());
        }
        if !self
            .send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await
        {
            return Err(failed("Connection closed"));
        }
        match tokio::time::timeout(CALLBACK_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            _ => Err(failed("Host callback timed out")),
        }
    }
}
struct CallbackGuard {
    state: Arc<State>,
    id: String,
}
impl Drop for CallbackGuard {
    fn drop(&mut self) {
        self.state.callbacks.lock().unwrap().remove(&self.id);
    }
}

fn valid_id(value: &Value, prefix: &str) -> Option<String> {
    let id = value.as_str()?;
    if !id.starts_with(prefix) || id.chars().count() > 128 {
        return None;
    }
    Some(id.to_owned())
}

async fn run(mut input: mpsc::Receiver<String>, state: Arc<State>) {
    let mut tasks = JoinSet::new();
    let mut seen = HashSet::new();
    loop {
        let frame = tokio::select! {
            _ = state.closed.cancelled() => break,
            _ = tasks.join_next(), if !tasks.is_empty() => continue,
            frame = input.recv() => match frame { Some(frame) => frame, None => break },
        };
        if frame.len() > MAX_FRAME {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(&frame) else {
            break;
        };
        let Some(obj) = value.as_object() else {
            break;
        };
        if value.get("jsonrpc") != Some(&json!("2.0")) {
            break;
        }
        if let Some(method) = value.get("method") {
            let Some(method) = method.as_str() else {
                break;
            };
            if obj.contains_key("result") || obj.contains_key("error") {
                break;
            }
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            let Some(id_value) = value.get("id") else {
                if method == "$/cancelRequest" {
                    if let Some(id) = params.get("id").and_then(Value::as_str) {
                        if let Some(token) = state.active.lock().unwrap().get(id) {
                            token.cancel();
                        }
                    }
                }
                // The other host methods are requests, not notifications. Never answer a notification.
                continue;
            };
            let Some(id) = valid_id(id_value, "pi-") else {
                break;
            };
            // Refuse duplicate IDs and bound their history rather than risking ambiguous callbacks.
            if seen.len() >= MAX_IDS || !seen.insert(id.clone()) {
                break;
            }
            // Initialize synchronously: later handlers cannot race with the permissions snapshot.
            if method == "initialize" {
                state.reply(&id, initialize(&state, &params)).await;
                continue;
            }
            if method == "shutdown" {
                if !params.as_object().is_some_and(|p| p.is_empty()) {
                    state.reply(&id, Err(invalid())).await;
                    continue;
                }
                state.reply(&id, Ok(json!({}))).await;
                break;
            }
            // Shutdown and callback/cancel traffic must still work at the handler limit.
            if state.active.lock().unwrap().len() >= MAX_ACTIVE {
                state
                    .reply(&id, Err(failed("Too many active requests")))
                    .await;
                continue;
            }
            let token = state.closed.child_token();
            state
                .active
                .lock()
                .unwrap()
                .insert(id.clone(), token.clone());
            let state = state.clone();
            let method = method.to_owned();
            tasks.spawn(async move {
                let result = tokio::select! {
                    biased;
                    _ = token.cancelled() => Err(cancelled()),
                    result = tokio::time::timeout(REQUEST_TIMEOUT, handle(&state, &id, &method, params)) =>
                        result.unwrap_or_else(|_| Err(failed("Request timed out"))),
                };
                // Drop the handler (and its callback guard) before retiring its parent.
                state.active.lock().unwrap().remove(&id);
                state.reply(&id, result).await;
            });
        } else {
            let Some(id) = value.get("id").and_then(|v| valid_id(v, "ext-")) else {
                break;
            };
            if obj.contains_key("params") || obj.contains_key("result") == obj.contains_key("error")
            {
                break;
            }
            let result = if let Some(error) = value.get("error") {
                if error.get("code").and_then(Value::as_i64).is_none()
                    || error.get("message").and_then(Value::as_str).is_none()
                {
                    break;
                }
                // Do not reflect host error text or credentials into tool results.
                Err(failed("Host UI request failed"))
            } else {
                Ok(value["result"].clone())
            };
            if let Some(tx) = state.callbacks.lock().unwrap().remove(&id) {
                let _ = tx.send(result);
            }
            // A late reply to a cancelled callback is harmless.
        }
    }
    state.closed.cancel();
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    state.callbacks.lock().unwrap().clear();
    state.active.lock().unwrap().clear();
    // Dropping the last writer closes the output only after the queued shutdown reply is drained.
}

fn exact_object<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a serde_json::Map<String, Value>, RpcError> {
    let object = value.as_object().ok_or_else(invalid)?;
    if required.iter().any(|k| !object.contains_key(*k))
        || object
            .keys()
            .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
    {
        return Err(invalid());
    }
    Ok(object)
}
fn context(value: &Value) -> Result<(), RpcError> {
    exact_object(value, &["cwd"], &[])?;
    value["cwd"].as_str().ok_or_else(invalid)?;
    Ok(())
}
fn initialize(state: &State, params: &Value) -> RpcResult {
    exact_object(
        params,
        &["protocolVersion", "client", "permissions", "context"],
        &[],
    )?;
    if params["protocolVersion"] != "0.1" {
        return Err(invalid());
    }
    exact_object(&params["client"], &["name", "version"], &[])?;
    params["client"]["name"].as_str().ok_or_else(invalid)?;
    params["client"]["version"].as_str().ok_or_else(invalid)?;
    context(&params["context"])?;
    let permissions = params["permissions"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(invalid))
        .collect::<Result<HashSet<_>, _>>()?;
    let mut current = state.permissions.lock().unwrap();
    if current.is_some() {
        return Err(failed("Already initialized"));
    }
    *current = Some(permissions);
    Ok(catalog())
}

pub fn catalog() -> Value {
    json!({
        "protocolVersion":"0.1", "name":"demo",
        "tools":[
            {"name":"greet","description":"Greet a person","parameters":{
                "type":"object","properties":{"name":{"type":"string","maxLength":100}},
                "required":["name"],"additionalProperties":false}},
            {"name":"wait","description":"Wait with progress and cancellation","parameters":{
                "type":"object","properties":{"milliseconds":{"type":"integer","minimum":0,"maximum":10000}},
                "required":["milliseconds"],"additionalProperties":false}}
        ],
        "commands":[{"name":"hello","description":"Show a greeting"}],
        "hooks":["session_start","before_agent_start","tool_call"]
    })
}

async fn handle(state: &Arc<State>, id: &str, method: &str, params: Value) -> RpcResult {
    if !matches!(method, "tool.call" | "command.execute" | "hook.run") {
        return Err(RpcError(-32601, "Method not found"));
    }
    if state.permissions.lock().unwrap().is_none() {
        return Err(failed("Initialize first"));
    }
    match method {
        "tool.call" => {
            exact_object(&params, &["name", "arguments", "context"], &[])?;
            context(&params["context"])?;
            match params["name"].as_str().ok_or_else(invalid)? {
                "greet" => {
                    exact_object(&params["arguments"], &["name"], &[])?;
                    let name = params["arguments"]["name"].as_str().ok_or_else(invalid)?;
                    if name.chars().count() > 100 {
                        return Err(invalid());
                    }
                    // Both permissions are needed; fail before requesting any UI if either is absent.
                    if !state
                        .permissions
                        .lock()
                        .unwrap()
                        .as_ref()
                        .is_some_and(|p| p.contains("ui.confirm") && p.contains("ui.notify"))
                    {
                        return Err(failed("Required UI permission is missing"));
                    }
                    let confirmation = state.reverse(id, "ui.confirm", "host.ui.confirm", json!({
                        "parentRequestId":id,"title":"Greeting","message":format!("Greet {name}?")
                    })).await?;
                    exact_object(&confirmation, &["confirmed"], &[])
                        .map_err(|_| failed("Invalid confirmation response"))?;
                    match confirmation["confirmed"].as_bool() {
                        Some(true) => (),
                        Some(false) => return Err(failed("Greeting was not confirmed")),
                        None => return Err(failed("Invalid confirmation response")),
                    }
                    let text = format!("Hello, {name}!");
                    let notification = state
                        .reverse(
                            id,
                            "ui.notify",
                            "host.ui.notify",
                            json!({
                                "parentRequestId":id,"message":text,"level":"info"
                            }),
                        )
                        .await?;
                    exact_object(&notification, &[], &[])
                        .map_err(|_| failed("Invalid notification response"))?;
                    Ok(json!({"content":[{"type":"text","text":text}],"details":{}}))
                }
                "wait" => {
                    exact_object(&params["arguments"], &["milliseconds"], &[])?;
                    let ms = params["arguments"]["milliseconds"]
                        .as_u64()
                        .filter(|ms| *ms <= 10000)
                        .ok_or_else(invalid)?;
                    state.send(json!({"jsonrpc":"2.0","method":"progress","params":{
                        "requestId":id,"content":[{"type":"text","text":format!("Waiting {ms} ms...")}]
                    }})).await;
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    Ok(json!({"content":[{"type":"text","text":"Finished waiting."}],"details":{}}))
                }
                _ => Err(invalid()),
            }
        }
        "command.execute" => {
            exact_object(&params, &["name", "arguments", "context"], &[])?;
            context(&params["context"])?;
            if params["name"] != "hello" {
                return Err(invalid());
            }
            let args = params["arguments"].as_str().ok_or_else(invalid)?;
            let who = if args.is_empty() { "world" } else { args };
            Ok(json!({"text":format!("Hello, {who}!")}))
        }
        "hook.run" => {
            exact_object(&params, &["name", "event", "context"], &[])?;
            context(&params["context"])?;
            let event = &params["event"];
            match params["name"].as_str().ok_or_else(invalid)? {
                "session_start" => {
                    exact_object(event, &["reason"], &[])?;
                    event["reason"].as_str().ok_or_else(invalid)?;
                }
                "before_agent_start" => {
                    exact_object(event, &["prompt", "systemPrompt"], &[])?;
                    event["prompt"].as_str().ok_or_else(invalid)?;
                    event["systemPrompt"].as_str().ok_or_else(invalid)?;
                }
                "tool_call" => {
                    exact_object(event, &["toolName", "toolCallId", "input"], &[])?;
                    event["toolName"].as_str().ok_or_else(invalid)?;
                    event["toolCallId"].as_str().ok_or_else(invalid)?;
                }
                _ => return Err(invalid()),
            }
            Ok(json!({}))
        }
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn send(c: &Connection, value: Value) {
        c.input.send(value.to_string()).await.unwrap();
    }
    async fn recv(c: &mut Connection) -> Value {
        serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(2), c.output.recv())
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap()
    }
    fn request(id: &str, method: &str, params: Value) -> Value {
        json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
    }
    async fn init(c: &mut Connection) {
        send(c, request("pi-init", "initialize", json!({"protocolVersion":"0.1","client":{"name":"test","version":"1"},"permissions":["ui.confirm","ui.notify"],"context":{"cwd":"/tmp"}}))).await;
        assert_eq!(recv(c).await["result"], catalog());
    }
    fn tool(id: &str, name: &str, args: Value) -> Value {
        request(
            id,
            "tool.call",
            json!({"name":name,"arguments":args,"context":{"cwd":"/tmp"}}),
        )
    }
    #[tokio::test]
    async fn reverse_calls_and_concurrent_cancellation() {
        let mut c = Connection::spawn();
        init(&mut c).await;
        send(&c, tool("pi-g", "greet", json!({"name":"Rust"}))).await;
        let confirm = recv(&mut c).await;
        assert_eq!(confirm["method"], "host.ui.confirm");
        assert_eq!(confirm["params"]["parentRequestId"], "pi-g");
        send(&c, tool("pi-w", "wait", json!({"milliseconds":10000}))).await;
        assert_eq!(recv(&mut c).await["method"], "progress");
        send(
            &c,
            json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":"pi-w"}}),
        )
        .await;
        assert_eq!(recv(&mut c).await["error"]["code"], -32800);
        send(
            &c,
            json!({"jsonrpc":"2.0","id":confirm["id"],"result":{"confirmed":true}}),
        )
        .await;
        let notify = recv(&mut c).await;
        assert_eq!(notify["method"], "host.ui.notify");
        send(&c, json!({"jsonrpc":"2.0","id":notify["id"],"result":{}})).await;
        assert_eq!(
            recv(&mut c).await["result"]["content"][0]["text"],
            "Hello, Rust!"
        );
        send(&c, request("pi-stop", "shutdown", json!({}))).await;
        assert_eq!(recv(&mut c).await["result"], json!({}));
        assert!(c.output.recv().await.is_none());
    }
    #[tokio::test]
    async fn validation_hooks_rejection_and_late_callback() {
        let mut c = Connection::spawn();
        init(&mut c).await;
        for (i, args) in [
            json!({"milliseconds":-1}),
            json!({"milliseconds":10001}),
            json!({"milliseconds":1.5}),
            json!({"milliseconds":0,"extra":true}),
        ]
        .into_iter()
        .enumerate()
        {
            send(&c, tool(&format!("pi-bad{i}"), "wait", args)).await;
            assert_eq!(recv(&mut c).await["error"]["code"], -32602);
        }
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
            send(
                &c,
                request(
                    &format!("pi-hook{i}"),
                    "hook.run",
                    json!({"name":name,"event":event,"context":{"cwd":"/tmp"}}),
                ),
            )
            .await;
            assert_eq!(recv(&mut c).await["result"], json!({}));
        }
        send(&c, tool("pi-no", "greet", json!({"name":"No"}))).await;
        let confirm = recv(&mut c).await;
        send(
            &c,
            json!({"jsonrpc":"2.0","id":confirm["id"],"result":{"confirmed":false}}),
        )
        .await;
        assert_eq!(recv(&mut c).await["error"]["code"], -32000);
        send(&c, tool("pi-cancel", "greet", json!({"name":"Cancel"}))).await;
        let confirm = recv(&mut c).await;
        send(
            &c,
            json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":"pi-cancel"}}),
        )
        .await;
        assert_eq!(recv(&mut c).await["error"]["code"], -32800);
        send(
            &c,
            json!({"jsonrpc":"2.0","id":confirm["id"],"result":{"confirmed":true}}),
        )
        .await;
        send(&c, request("pi-unknown", "unknown", json!({}))).await;
        assert_eq!(recv(&mut c).await["error"]["code"], -32601);
        c.closed.cancel();
    }
    #[tokio::test]
    async fn permissions_and_active_request_bound() {
        let mut denied = Connection::spawn();
        send(&denied, request("pi-init", "initialize", json!({"protocolVersion":"0.1","client":{"name":"test","version":"1"},"permissions":[],"context":{"cwd":"/tmp"}}))).await;
        assert!(recv(&mut denied).await.get("result").is_some());
        send(&denied, tool("pi-denied", "greet", json!({"name":"No UI"}))).await;
        assert_eq!(recv(&mut denied).await["error"]["code"], -32000);
        denied.closed.cancel();

        let mut c = Connection::spawn();
        init(&mut c).await;
        for index in 0..MAX_ACTIVE {
            send(
                &c,
                tool(
                    &format!("pi-w{index}"),
                    "wait",
                    json!({"milliseconds":10000}),
                ),
            )
            .await;
            assert_eq!(recv(&mut c).await["method"], "progress");
        }
        send(&c, tool("pi-overflow", "wait", json!({"milliseconds":0}))).await;
        assert_eq!(recv(&mut c).await["error"]["code"], -32000);
        // Control traffic still works with every handler slot occupied.
        send(
            &c,
            json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":"pi-w0"}}),
        )
        .await;
        assert_eq!(recv(&mut c).await["error"]["code"], -32800);
        send(
            &c,
            request(
                "pi-available",
                "command.execute",
                json!({"name":"hello","arguments":"","context":{"cwd":"/tmp"}}),
            ),
        )
        .await;
        assert_eq!(recv(&mut c).await["result"]["text"], "Hello, world!");
        send(&c, tool("pi-refill", "wait", json!({"milliseconds":10000}))).await;
        assert_eq!(recv(&mut c).await["method"], "progress");
        send(&c, request("pi-full-shutdown", "shutdown", json!({}))).await;
        assert_eq!(recv(&mut c).await["result"], json!({}));
        assert!(
            tokio::time::timeout(Duration::from_secs(2), c.output.recv())
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn oversized_and_malformed_frames_close_connection() {
        for frame in [
            "x".repeat(MAX_FRAME + 1),
            "not json".to_owned(),
            json!({"jsonrpc":"2.0","id":"ext-x","result":{},"error":{}}).to_string(),
        ] {
            let mut c = Connection::spawn();
            c.input.send(frame).await.unwrap();
            assert!(
                tokio::time::timeout(Duration::from_secs(2), c.output.recv())
                    .await
                    .unwrap()
                    .is_none()
            );
        }
    }
}
