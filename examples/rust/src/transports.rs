use crate::{
    protocol::{Connection, MAX_FRAME},
    wire::{
        extension_server::{Extension, ExtensionServer},
        Frame,
    },
};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::Stream;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    convert::Infallible,
    io,
    net::{Ipv4Addr, SocketAddr},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, Semaphore},
};
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response as GrpcResponse, Status, Streaming};

const MAX_SESSIONS: usize = 32;
const IO_TIMEOUT: Duration = Duration::from_secs(5);

/// A line reader that never allocates an unbounded line (unlike read_line/read_until).
pub async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> io::Result<Option<String>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Incomplete frame",
                ))
            };
        }
        let newline = available.iter().position(|b| *b == b'\n');
        let n = newline.unwrap_or(available.len());
        if bytes.len() + n > MAX_FRAME {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Frame too large",
            ));
        }
        bytes.extend_from_slice(&available[..n]);
        reader.consume(n + usize::from(newline.is_some()));
        if newline.is_some() {
            return String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Invalid UTF-8"));
        }
    }
}

pub async fn stdio() -> io::Result<()> {
    let Connection {
        input,
        mut output,
        closed,
    } = Connection::spawn();
    let reader_closed = closed.clone();
    // Tokio stdin uses a blocking read internally. The process exits explicitly after a shutdown
    // reply is flushed, so an idle inherited stdin cannot delay runtime teardown.
    let reader = tokio::spawn(async move {
        let mut stdin = BufReader::new(tokio::io::stdin());
        loop {
            let frame = tokio::select! {
                _ = reader_closed.cancelled() => break,
                frame = read_frame(&mut stdin) => match frame { Ok(Some(frame)) => frame, _ => break },
            };
            let sent = tokio::select! {
                _ = reader_closed.cancelled() => false,
                sent = tokio::time::timeout(IO_TIMEOUT, input.send(frame)) => matches!(sent, Ok(Ok(()))),
            };
            if !sent {
                break;
            }
        }
        reader_closed.cancel();
    });
    let mut stdout = tokio::io::stdout();
    let result = async {
        while let Some(frame) = output.recv().await {
            tokio::time::timeout(IO_TIMEOUT, async {
                stdout.write_all(frame.as_bytes()).await?;
                stdout.write_all(b"\n").await?;
                stdout.flush().await
            })
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Output blocked"))??;
        }
        Ok(())
    }
    .await;
    closed.cancel();
    reader.abort();
    let _ = reader.await;
    result
}

fn authorized(actual: Option<&str>, token: &str) -> bool {
    let expected = format!("Bearer {token}");
    let actual = actual.unwrap_or("").as_bytes();
    let expected = expected.as_bytes();
    let mut diff = actual.len() ^ expected.len();
    for (index, byte) in expected.iter().enumerate() {
        diff |= usize::from(*byte ^ actual.get(index).copied().unwrap_or(0));
    }
    diff == 0
}

struct Session {
    input: mpsc::Sender<String>,
    output: Mutex<Option<mpsc::Receiver<String>>>,
    closed: CancellationToken,
    started: AtomicBool,
}
#[derive(Clone)]
struct HttpState {
    token: Arc<String>,
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
}
async fn auth(
    State(state): State<HttpState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if !header_authorized(request.headers(), &state.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(request).await
}
fn header_authorized(headers: &HeaderMap, token: &str) -> bool {
    headers.get_all("authorization").iter().count() == 1
        && authorized(
            headers.get("authorization").and_then(|h| h.to_str().ok()),
            token,
        )
}
async fn create(
    State(state): State<HttpState>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), StatusCode> {
    if !body.as_object().is_some_and(|p| p.is_empty()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let session = {
        let mut sessions = state.sessions.lock().unwrap();
        if sessions.len() >= MAX_SESSIONS {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        let Connection {
            input,
            output,
            closed,
        } = Connection::spawn();
        let session = Arc::new(Session {
            input,
            output: Mutex::new(Some(output)),
            closed,
            started: AtomicBool::new(false),
        });
        sessions.insert(id.clone(), session.clone());
        session
    };
    let cleanup_id = id.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = session.closed.cancelled() => (),
            _ = tokio::time::sleep(Duration::from_secs(30)) => {
                if session.started.load(Ordering::Acquire) {
                    tokio::select! {
                        _ = session.closed.cancelled() => (),
                        _ = tokio::time::sleep(Duration::from_secs(870)) => (),
                    }
                }
            },
        }
        session.closed.cancel();
        state.sessions.lock().unwrap().remove(&cleanup_id);
    });
    Ok((StatusCode::CREATED, Json(json!({"sessionId":id}))))
}
fn session(state: &HttpState, id: &str) -> Result<Arc<Session>, StatusCode> {
    state
        .sessions
        .lock()
        .unwrap()
        .get(id)
        .filter(|s| !s.closed.is_cancelled())
        .cloned()
        .ok_or(StatusCode::NOT_FOUND)
}
struct CloseOnDrop(CancellationToken);
impl Drop for CloseOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
async fn events(
    State(state): State<HttpState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, StatusCode> {
    let session = session(&state, &id)?;
    let mut output = session
        .output
        .lock()
        .unwrap()
        .take()
        .ok_or(StatusCode::CONFLICT)?;
    session.started.store(true, Ordering::Release);
    // Capture the guard outside the generator: dropping an unpolled body must close it too.
    let guard = CloseOnDrop(session.closed.clone());
    let stream = async_stream::stream! {
        let _guard = guard;
        yield Ok::<_, Infallible>(Event::default().comment("ready"));
        while let Some(frame) = output.recv().await { yield Ok(Event::default().data(frame)); }
    };
    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
}
async fn message(
    State(state): State<HttpState>,
    Path(id): Path<String>,
    body: String,
) -> StatusCode {
    let Ok(session) = session(&state, &id) else {
        return StatusCode::NOT_FOUND;
    };
    if !session.started.load(Ordering::Acquire) {
        return StatusCode::CONFLICT;
    }
    if body.len() > MAX_FRAME {
        return StatusCode::PAYLOAD_TOO_LARGE;
    }
    match session.input.try_send(body) {
        Ok(()) => StatusCode::ACCEPTED,
        Err(mpsc::error::TrySendError::Full(_)) => StatusCode::TOO_MANY_REQUESTS,
        Err(mpsc::error::TrySendError::Closed(_)) => StatusCode::GONE,
    }
}
async fn delete(State(state): State<HttpState>, Path(id): Path<String>) -> StatusCode {
    match state.sessions.lock().unwrap().remove(&id) {
        Some(session) => {
            session.closed.cancel();
            StatusCode::NO_CONTENT
        }
        None => StatusCode::NOT_FOUND,
    }
}

pub async fn http(port: u16, token: String) -> Result<(), Box<dyn std::error::Error>> {
    let state = HttpState {
        token: Arc::new(token),
        sessions: Arc::new(Mutex::new(HashMap::new())),
    };
    let app = Router::new()
        .route("/sessions", post(create))
        .route("/sessions/{id}/events", get(events))
        .route("/sessions/{id}/messages", post(message))
        .route("/sessions/{id}", axum::routing::delete(delete))
        .layer(DefaultBodyLimit::max(MAX_FRAME))
        .layer(middleware::from_fn_with_state(state.clone(), auth))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?;
    eprintln!("HTTP listening on {}", listener.local_addr()?);
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            for session in state.sessions.lock().unwrap().values() {
                session.closed.cancel();
            }
        })
        .await?;
    Ok(())
}

struct GrpcService {
    token: String,
    slots: Arc<Semaphore>,
    stopping: CancellationToken,
}
#[tonic::async_trait]
impl Extension for GrpcService {
    type ConnectStream = Pin<Box<dyn Stream<Item = Result<Frame, Status>> + Send + 'static>>;
    async fn connect(
        &self,
        request: Request<Streaming<Frame>>,
    ) -> Result<GrpcResponse<Self::ConnectStream>, Status> {
        if request.metadata().get_all("authorization").iter().count() != 1
            || !authorized(
                request
                    .metadata()
                    .get("authorization")
                    .and_then(|v| v.to_str().ok()),
                &self.token,
            )
        {
            return Err(Status::unauthenticated("Authentication required"));
        }
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Status::resource_exhausted("Too many connections"))?;
        let Connection {
            input,
            mut output,
            closed,
        } = Connection::spawn();
        let mut incoming = request.into_inner();
        let input_closed = closed.clone();
        let stopping = self.stopping.clone();
        tokio::spawn(async move {
            loop {
                let frame = tokio::select! {
                    _ = input_closed.cancelled() => break,
                    _ = stopping.cancelled() => break,
                    frame = incoming.message() => match frame { Ok(Some(frame)) => frame.json, _ => break },
                };
                if frame.len() > MAX_FRAME {
                    break;
                }
                let sent = tokio::select! {
                    _ = input_closed.cancelled() => false,
                    _ = stopping.cancelled() => false,
                    result = tokio::time::timeout(IO_TIMEOUT, input.send(frame)) => matches!(result, Ok(Ok(()))),
                };
                if !sent {
                    break;
                }
            }
            input_closed.cancel();
        });
        let guard = CloseOnDrop(closed);
        let output = async_stream::stream! {
            let (_guard, _permit) = (guard, permit);
            while let Some(json) = output.recv().await { yield Ok(Frame { json }); }
        };
        Ok(GrpcResponse::new(Box::pin(output)))
    }
}

pub async fn grpc(port: u16, token: String) -> Result<(), Box<dyn std::error::Error>> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let stopping = CancellationToken::new();
    let service = ExtensionServer::new(GrpcService {
        token,
        slots: Arc::new(Semaphore::new(MAX_SESSIONS)),
        stopping: stopping.clone(),
    })
    .max_decoding_message_size(MAX_FRAME + 16)
    .max_encoding_message_size(MAX_FRAME + 16);
    eprintln!("gRPC listening on {addr}");
    tonic::transport::Server::builder()
        .add_service(service)
        .serve_with_shutdown(addr, async move {
            let _ = tokio::signal::ctrl_c().await;
            stopping.cancel();
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn bounded_line_reader() {
        let mut reader = BufReader::new(&b"{}\n[]\n"[..]);
        assert_eq!(read_frame(&mut reader).await.unwrap(), Some("{}".into()));
        assert_eq!(read_frame(&mut reader).await.unwrap(), Some("[]".into()));
        assert_eq!(read_frame(&mut reader).await.unwrap(), None);
        for bytes in [vec![b'x'; MAX_FRAME + 1], vec![255, b'\n'], b"{}".to_vec()] {
            assert!(read_frame(&mut BufReader::new(bytes.as_slice()))
                .await
                .is_err());
        }
    }
    #[test]
    fn exact_bearer_auth() {
        assert!(authorized(Some("Bearer secret"), "secret"));
        for value in [
            None,
            Some("secret"),
            Some("Bearer secret "),
            Some("Bearer secreT"),
        ] {
            assert!(!authorized(value, "secret"));
        }
    }
}
