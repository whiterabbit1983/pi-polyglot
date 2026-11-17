use super::*;

fn connection() -> (Connection, Arc<State>) {
    let (input, rx) = mpsc::channel(QUEUE);
    let (tx, output) = mpsc::channel(QUEUE);
    let closed = CancellationToken::new();
    let state = Arc::new(State {
        output: tx,
        closed: closed.clone(),
        callbacks: Mutex::new(HashMap::new()),
        active: Mutex::new(HashMap::new()),
        permissions: Mutex::new(None),
        ui_timeout: Mutex::new(None),
        views: Mutex::new(HashMap::new()),
    });
    tokio::spawn(run(rx, state.clone()));
    (
        Connection {
            input,
            output,
            closed,
        },
        state,
    )
}
async fn send(c: &Connection, value: Value) {
    c.input.send(value.to_string()).await.unwrap();
}
async fn recv(c: &mut Connection) -> Value {
    serde_json::from_str(
        &tokio::time::timeout(Duration::from_secs(3), c.output.recv())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap()
}
fn request(id: &str, method: &str, params: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
}
fn init_params() -> Value {
    json!({"protocolVersion":"0.1","client":{"name":"test","version":"1"},"permissions":["ui.custom"],"context":{"cwd":"/tmp"},"optionalFeatures":["tui_v1"],"ui":{"timeoutMs":1000}})
}
async fn init(c: &mut Connection) {
    send(c, request("pi-init", "initialize", init_params())).await;
    let result = recv(c).await;
    assert_eq!(result["result"]["features"], json!(["tui_v1"]));
    assert_eq!(result["result"]["commands"].as_array().unwrap().len(), 3);
}
async fn open(c: &mut Connection, parent: &str, kind: &str) -> Value {
    send(
        c,
        request(
            parent,
            "command.execute",
            json!({"name":kind,"arguments":"","context":{"cwd":"/tmp"}}),
        ),
    )
    .await;
    let open = recv(c).await;
    assert_eq!(open["method"], "host.ui.open");
    assert_eq!(open["params"]["parentRequestId"], parent);
    assert!(open["params"]["viewId"]
        .as_str()
        .unwrap()
        .starts_with("view-"));
    open
}
fn event(id: &str, open: &Value, revision: u64, event: Value) -> Value {
    request(
        id,
        "ui.event",
        json!({"parentRequestId":open["params"]["parentRequestId"],"viewId":open["params"]["viewId"],"revision":revision,"event":event}),
    )
}
async fn reply(c: &Connection, req: &Value, result: Value) {
    send(c, json!({"jsonrpc":"2.0","id":req["id"],"result":result})).await;
}
async fn result(c: &mut Connection, id: &str) -> Value {
    let msg = recv(c).await;
    assert_eq!(msg["id"], id);
    assert!(msg.get("error").is_none(), "{msg}");
    msg["result"].clone()
}
async fn error(c: &mut Connection, id: &str, code: i64) {
    let msg = recv(c).await;
    assert_eq!(msg["id"], id);
    assert_eq!(msg["error"]["code"], code, "{msg}");
}
async fn clean(state: &Arc<State>) {
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if state.views.lock().unwrap().is_empty()
                && state.callbacks.lock().unwrap().is_empty()
                && state.active.lock().unwrap().is_empty()
            {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("UI state retained");
}
#[tokio::test]
async fn counter_events_are_concurrent_and_keep_command_parent() {
    let (mut c, state) = connection();
    init(&mut c).await;
    let opened = open(&mut c, "pi-counter", "ui_counter").await;
    assert_eq!(
        opened["params"]["document"]["lines"][0][0]["text"],
        "Counter: 0"
    );
    send(
        &c,
        request(
            "pi-hello",
            "command.execute",
            json!({"name":"hello","arguments":"","context":{"cwd":"/tmp"}}),
        ),
    )
    .await;
    result(&mut c, "pi-hello").await;
    send(
        &c,
        event(
            "pi-resize",
            &opened,
            0,
            json!({"type":"resize","width":80,"height":24}),
        ),
    )
    .await;
    assert_eq!(result(&mut c, "pi-resize").await, json!({}));
    for (i, key) in ["up", "down", "up"].into_iter().enumerate() {
        let id = format!("pi-key{i}");
        send(
            &c,
            event(&id, &opened, i as u64, json!({"type":"key","key":key})),
        )
        .await;
        let update = recv(&mut c).await;
        assert_eq!(update["method"], "host.ui.update");
        assert_eq!(update["params"]["parentRequestId"], "pi-counter");
        assert_eq!(update["params"]["viewId"], opened["params"]["viewId"]);
        assert_eq!(update["params"]["revision"], i + 1);
        reply(&c, &update, json!({"applied":true})).await;
        result(&mut c, &id).await;
    }
    send(
        &c,
        event("pi-stale", &opened, 0, json!({"type":"key","key":"up"})),
    )
    .await;
    error(&mut c, "pi-stale", -32602).await;
    send(
        &c,
        event("pi-enter", &opened, 3, json!({"type":"key","key":"enter"})),
    )
    .await;
    let close = recv(&mut c).await;
    assert_eq!(close["method"], "host.ui.close");
    assert_eq!(close["params"]["parentRequestId"], "pi-counter");
    assert_eq!(close["params"]["result"], json!({"count":1}));
    let open_result = json!({"cancelled":false,"result":{"count":1}});
    // The open/command may settle before the close acknowledgement arrives.
    reply(&c, &opened, open_result.clone()).await;
    let summary = result(&mut c, "pi-counter").await;
    assert_eq!(
        serde_json::from_str::<Value>(
            summary["text"]
                .as_str()
                .unwrap()
                .strip_prefix("UI result: ")
                .unwrap()
        )
        .unwrap(),
        open_result
    );
    reply(&c, &close, json!({})).await;
    result(&mut c, "pi-enter").await;
    send(
        &c,
        event("pi-late", &opened, 3, json!({"type":"key","key":"enter"})),
    )
    .await;
    error(&mut c, "pi-late", -32001).await;
    clean(&state).await;
    c.closed.cancel();
}
#[tokio::test]
async fn form_is_local_and_bad_events_are_rejected() {
    let (mut c, state) = connection();
    init(&mut c).await;
    let opened = open(&mut c, "pi-form", "ui_form").await;
    assert_eq!(opened["params"]["document"]["children"][1]["type"], "input");
    assert_eq!(
        opened["params"]["document"]["children"][2]["type"],
        "select"
    );
    for (i, bad) in [
        json!({"type":"unknown"}),
        json!({"type":"key","key":1}),
        json!({"type":"resize","width":0,"height":24}),
        json!({"type":"text","text":"\u{1b}"}),
        json!({"type":"change","id":"unknown","value":"x"}),
    ]
    .into_iter()
    .enumerate()
    {
        let id = format!("pi-invalid{i}");
        send(&c, event(&id, &opened, 0, bad)).await;
        error(&mut c, &id, -32602).await;
    }
    for (i, field) in ["parentRequestId", "viewId"].into_iter().enumerate() {
        let id = format!("pi-wrong{i}");
        let mut wrong = event(&id, &opened, 0, json!({"type":"key","key":"up"}));
        wrong["params"][field] = json!("other");
        send(&c, wrong).await;
        error(&mut c, &id, -32001).await;
    }
    send(
        &c,
        event(
            "pi-change",
            &opened,
            0,
            json!({"type":"change","id":"name","value":"Grace"}),
        ),
    )
    .await;
    result(&mut c, "pi-change").await;
    let open_result = json!({"cancelled":false,"result":{"action":"submit","values":{"name":"Grace","target":"prod"}}});
    reply(&c, &opened, open_result.clone()).await;
    let summary = result(&mut c, "pi-form").await;
    assert_eq!(
        serde_json::from_str::<Value>(
            summary["text"]
                .as_str()
                .unwrap()
                .strip_prefix("UI result: ")
                .unwrap()
        )
        .unwrap(),
        open_result
    );
    clean(&state).await;
    c.closed.cancel();
}
#[tokio::test]
async fn ui_lifetime_cleanup_and_late_events() {
    for mode in ["escape", "cancel", "timeout", "disconnect", "host-error"] {
        let (mut c, state) = connection();
        init(&mut c).await;
        assert_eq!(
            *state.ui_timeout.lock().unwrap(),
            Some(Duration::from_secs(1))
        );
        let opened = open(&mut c, "pi-open", "ui_counter").await;
        match mode {
            "escape" => {
                reply(&c, &opened, json!({"cancelled":true,"reason":"escape"})).await;
                result(&mut c, "pi-open").await;
            }
            "cancel" => {
                send(
                    &c,
                    json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":"pi-open"}}),
                )
                .await;
                error(&mut c, "pi-open", -32800).await;
            }
            "timeout" => {
                error(&mut c, "pi-open", -32000).await;
            }
            "disconnect" => c.closed.cancel(),
            "host-error" => {
                send(&c,json!({"jsonrpc":"2.0","id":opened["id"],"error":{"code":-32001,"message":"Unavailable"}})).await;
                error(&mut c, "pi-open", -32000).await;
            }
            _ => unreachable!(),
        }
        clean(&state).await;
        if mode != "disconnect" {
            send(
                &c,
                event("pi-late", &opened, 0, json!({"type":"key","key":"up"})),
            )
            .await;
            error(&mut c, "pi-late", -32001).await;
        }
        c.closed.cancel();
    }
}
#[tokio::test]
async fn parent_settlement_retires_inflight_updates() {
    for mode in ["complete", "cancel", "disconnect"] {
        let (mut c, state) = connection();
        init(&mut c).await;
        let opened = open(&mut c, "pi-open", "ui_counter").await;
        send(
            &c,
            event("pi-update", &opened, 0, json!({"type":"key","key":"up"})),
        )
        .await;
        assert_eq!(recv(&mut c).await["method"], "host.ui.update");
        match mode {
            "complete" => reply(&c, &opened, json!({"cancelled":true,"reason":"escape"})).await,
            "cancel" => {
                send(
                    &c,
                    json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":"pi-open"}}),
                )
                .await
            }
            "disconnect" => c.closed.cancel(),
            _ => unreachable!(),
        }
        if mode != "disconnect" {
            let mut seen = HashSet::new();
            for _ in 0..2 {
                let msg = recv(&mut c).await;
                seen.insert(msg["id"].as_str().unwrap().to_owned());
                if msg["id"] == "pi-update" || mode == "cancel" {
                    assert_eq!(msg["error"]["code"], -32800);
                } else {
                    assert!(msg.get("result").is_some());
                }
            }
            assert!(seen.contains("pi-open") && seen.contains("pi-update"));
        }
        clean(&state).await;
        c.closed.cancel();
    }
}

#[tokio::test]
async fn feature_negotiation_preserves_legacy_catalog() {
    for mode in [
        "legacy",
        "permission-only",
        "unoffered",
        "denied",
        "bad-timeout",
        "missing-ui",
    ] {
        let (mut c, state) = connection();
        let mut params = init_params();
        match mode {
            "legacy" | "permission-only" => {
                params.as_object_mut().unwrap().remove("optionalFeatures");
                params.as_object_mut().unwrap().remove("ui");
                if mode == "legacy" {
                    params["permissions"] = json!([]);
                }
            }
            "unoffered" => params["optionalFeatures"] = json!(["future"]),
            "denied" => params["permissions"] = json!([]),
            "bad-timeout" => params["ui"]["timeoutMs"] = json!(0),
            "missing-ui" => {
                params.as_object_mut().unwrap().remove("ui");
            }
            _ => unreachable!(),
        }
        send(&c, request("pi-init", "initialize", params)).await;
        if matches!(mode, "denied" | "bad-timeout" | "missing-ui") {
            error(&mut c, "pi-init", -32602).await;
        } else {
            assert_eq!(result(&mut c, "pi-init").await, catalog());
            send(
                &c,
                request(
                    "pi-no-ui",
                    "command.execute",
                    json!({"name":"ui_counter","arguments":"","context":{"cwd":"/tmp"}}),
                ),
            )
            .await;
            error(&mut c, "pi-no-ui", -32602).await;
        }
        clean(&state).await;
        c.closed.cancel();
    }
}
