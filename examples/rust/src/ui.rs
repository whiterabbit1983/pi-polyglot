//! Opt-in hybrid UI. The host edits local controls; only the counter redraws remotely.
use super::*;

pub(super) struct View {
    id: String,
    kind: String,
    revision: u64,
    count: i64,
    busy: bool,
    closing: bool,
}

pub(super) fn negotiate(
    params: &Value,
    permissions: &HashSet<String>,
) -> Result<Option<Duration>, RpcError> {
    if params.get("optionalFeatures").is_none() && params.get("ui").is_none() {
        return Ok(None);
    }
    if !permissions.contains("ui.custom") {
        return Err(invalid());
    }
    let features = params["optionalFeatures"].as_array().ok_or_else(invalid)?;
    if features.iter().any(|v| !v.is_string()) {
        return Err(invalid());
    }
    exact_object(&params["ui"], &["timeoutMs"], &[])?;
    let ms = params["ui"]["timeoutMs"]
        .as_u64()
        .filter(|n| (1000..=900000).contains(n))
        .ok_or_else(invalid)?;
    Ok(features
        .iter()
        .any(|v| v == "tui_v1")
        .then_some(Duration::from_millis(ms)))
}

fn counter(count: i64) -> Value {
    json!({"type":"frame","lines":[
        [{"text":format!("Counter: {count}"),"style":"accent","bold":true}],
        [{"text":"Up/down: change; Enter: finish; Escape: cancel","style":"muted"}]
    ]})
}
fn form() -> Value {
    json!({"type":"column","children":[
        {"type":"frame","lines":[[{"text":"Choose a target","style":"accent","bold":true}]]},
        {"type":"input","id":"name","label":"Name","value":"Ada"},
        {"type":"select","id":"target","label":"Target","options":[{"value":"dev","label":"Development"},{"value":"prod","label":"Production"}],"value":"dev"},
        {"type":"button","id":"submit","label":"Deploy"}
    ]})
}

struct ViewGuard {
    state: Arc<State>,
    parent: String,
}
impl Drop for ViewGuard {
    fn drop(&mut self) {
        self.state.views.lock().unwrap().remove(&self.parent);
    }
}
pub(super) async fn command(state: &Arc<State>, parent: &str, kind: &str) -> RpcResult {
    if state.ui_timeout.lock().unwrap().is_none() {
        return Err(invalid());
    }
    let view_id = format!("view-{}", uuid::Uuid::new_v4());
    state.views.lock().unwrap().insert(
        parent.to_owned(),
        View {
            id: view_id.clone(),
            kind: kind.to_owned(),
            revision: 0,
            count: 0,
            busy: false,
            closing: false,
        },
    );
    let _guard = ViewGuard {
        state: state.clone(),
        parent: parent.to_owned(),
    };
    let document = if kind == "ui_form" {
        form()
    } else {
        counter(0)
    };
    let title = if kind == "ui_form" {
        "Deployment"
    } else {
        "Counter"
    };
    let result = state.reverse(parent, "ui.custom", "host.ui.open", json!({
        "parentRequestId":parent,"viewId":view_id,"title":title,"surface":"overlay","document":document
    })).await?;
    exact_object(&result, &["cancelled"], &["result", "reason"])
        .map_err(|_| failed("Invalid UI result"))?;
    match result["cancelled"].as_bool() {
        Some(true) if result["reason"].is_string() && result.get("result").is_none() => (),
        Some(false)
            if result["result"].is_object()
                && result["result"].to_string().len() <= 16384
                && result.get("reason").is_none() => {}
        _ => return Err(failed("Invalid UI result")),
    }
    Ok(json!({"text":format!("UI result: {result}")}))
}

fn safe_text(value: &Value) -> Result<&str, RpcError> {
    let text = value.as_str().ok_or_else(invalid)?;
    if text.chars().count() > 4096
        || text
            .chars()
            .any(|c| matches!(c as u32, 0..=31 | 127..=159 | 0x202a..=0x202e | 0x2066..=0x2069))
    {
        return Err(invalid());
    }
    Ok(text)
}
fn control_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 48
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}
fn validate_event(event: &Value) -> Result<&str, RpcError> {
    let kind = event["type"].as_str().ok_or_else(invalid)?;
    match kind {
        "key" => {
            exact_object(event, &["type", "key"], &[])?;
            let key = safe_text(&event["key"])?;
            if key.is_empty() || key.len() > 128 {
                return Err(invalid());
            }
        }
        "text" => {
            exact_object(event, &["type", "text"], &[])?;
            safe_text(&event["text"])?;
        }
        "resize" => {
            exact_object(event, &["type", "width", "height"], &[])?;
            for key in ["width", "height"] {
                event[key]
                    .as_u64()
                    .filter(|n| (1..=9007199254740991).contains(n))
                    .ok_or_else(invalid)?;
            }
        }
        "change" => {
            exact_object(event, &["type", "id", "value"], &[])?;
            if !control_id(safe_text(&event["id"])?) {
                return Err(invalid());
            }
            safe_text(&event["value"])?;
        }
        _ => return Err(invalid()),
    }
    Ok(kind)
}

// The guard resets the in-flight flag even if an event is cancelled mid-callback.
struct EventGuard {
    state: Arc<State>,
    parent: String,
}
impl Drop for EventGuard {
    fn drop(&mut self) {
        if let Some(view) = self.state.views.lock().unwrap().get_mut(&self.parent) {
            view.busy = false;
        }
    }
}
pub(super) async fn event(state: &Arc<State>, params: Value) -> RpcResult {
    exact_object(
        &params,
        &["parentRequestId", "viewId", "revision", "event"],
        &[],
    )?;
    let parent = params["parentRequestId"].as_str().ok_or_else(invalid)?;
    let id = params["viewId"]
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        })
        .ok_or_else(invalid)?;
    let revision = params["revision"]
        .as_u64()
        .filter(|n| *n <= 9007199254740991)
        .ok_or_else(invalid)?;
    let event = &params["event"];
    let kind = validate_event(event)?;
    let live = state
        .active
        .lock()
        .unwrap()
        .get(parent)
        .is_some_and(|t| !t.is_cancelled());
    let action = {
        let mut views = state.views.lock().unwrap();
        // Only a command handler creates a view. Event request IDs never become parents.
        let view = views
            .get_mut(parent)
            .filter(|v| v.id == id && !v.closing && live)
            .ok_or(RpcError(-32001, "Unknown or stale UI parent/view"))?;
        if revision != view.revision || view.busy {
            return Err(invalid());
        }
        if kind == "change"
            && (view.kind != "ui_form"
                || !matches!(event["id"].as_str(), Some("name" | "target"))
                || (event["id"] == "target"
                    && !matches!(event["value"].as_str(), Some("dev" | "prod"))))
        {
            return Err(invalid());
        }
        if view.kind == "ui_counter" && kind == "key" {
            match event["key"].as_str().unwrap() {
                "up" | "down" => {
                    view.count += if event["key"] == "up" { 1 } else { -1 };
                    view.revision += 1;
                    Some(("host.ui.update", json!({"parentRequestId":parent,"viewId":id,"revision":view.revision,"document":counter(view.count)})))
                }
                "enter" => {
                    view.closing = true;
                    Some(("host.ui.close", json!({"parentRequestId":parent,"viewId":id,"result":{"count":view.count}})))
                }
                _ => None,
            }
        } else { None }.inspect(|_| view.busy = true)
    };
    if let Some((method, args)) = action {
        let _guard = EventGuard {
            state: state.clone(),
            parent: parent.to_owned(),
        };
        let result = state.reverse(parent, "ui.custom", method, args).await?;
        if method == "host.ui.update" {
            exact_object(&result, &["applied"], &[])
                .map_err(|_| failed("Invalid UI update result"))?;
            if result["applied"] != true {
                return Err(failed("UI update was not applied"));
            }
        } else {
            exact_object(&result, &[], &[]).map_err(|_| failed("Invalid UI close result"))?;
        }
    }
    Ok(json!({}))
}
