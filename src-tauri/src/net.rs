// Netzwerk für die JS-Module: fetch ohne CORS-Grenzen (wie Nodes fetch im Electron-Hauptprozess),
// Downloads direkt auf die Platte und kleine lokale HTTP-Server für Anmelde-Rückrufe.
use crate::AppState;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpReq {
    id: u64,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body_text: Option<String>,
    body_b64: Option<String>,
    redirect: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpHead {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    url: String,
    redirected: bool,
}

fn build(state: &AppState, req: &HttpReq) -> Result<reqwest::RequestBuilder, String> {
    let client = if req.redirect.as_deref() == Some("manual") || req.redirect.as_deref() == Some("error") { &state.http_manual } else { &state.http };
    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let mut b = client.request(method, &req.url);
    let mut has_ua = false;
    for (k, v) in &req.headers {
        if k.eq_ignore_ascii_case("user-agent") {
            has_ua = true;
        }
        if k.eq_ignore_ascii_case("host") || k.eq_ignore_ascii_case("content-length") || k.eq_ignore_ascii_case("connection") {
            continue;
        }
        b = b.header(k, v);
    }
    // Wie Nodes fetch (undici)
    if !has_ua {
        b = b.header("user-agent", "node");
    }
    if let Some(t) = &req.body_text {
        b = b.body(t.clone());
    } else if let Some(t) = &req.body_b64 {
        b = b.body(B64.decode(t).map_err(|e| e.to_string())?);
    }
    Ok(b)
}

fn head(res: &reqwest::Response, original: &str) -> HttpHead {
    HttpHead {
        status: res.status().as_u16(),
        status_text: res.status().canonical_reason().unwrap_or("").to_string(),
        headers: res.headers().iter().map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned())).collect(),
        url: res.url().to_string(),
        redirected: res.url().as_str() != original,
    }
}

#[tauri::command]
pub async fn http_request(state: State<'_, Arc<AppState>>, req: HttpReq, on_body: Channel<InvokeResponseBody>) -> Result<HttpHead, String> {
    let token = CancellationToken::new();
    state.requests.lock().unwrap().insert(req.id, token.clone());
    let id = req.id;
    let send = build(&state, &req)?.send();
    let res = tokio::select! {
        r = send => r,
        _ = token.cancelled() => {
            state.requests.lock().unwrap().remove(&id);
            return Err("aborted".into());
        }
    };
    let res = match res {
        Ok(r) => r,
        Err(e) => {
            state.requests.lock().unwrap().remove(&id);
            let mut msg = e.to_string();
            let mut src = std::error::Error::source(&e);
            while let Some(s) = src {
                msg = format!("{msg}: {s}");
                src = s.source();
            }
            return Err(msg);
        }
    };
    if req.redirect.as_deref() == Some("error") && res.status().is_redirection() {
        state.requests.lock().unwrap().remove(&id);
        return Err("redirect mode is set to error".into());
    }
    let h = head(&res, &req.url);
    let st = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut stream = res.bytes_stream();
        loop {
            tokio::select! {
                chunk = stream.next() => match chunk {
                    Some(Ok(b)) => {
                        if on_body.send(InvokeResponseBody::Raw(b.to_vec())).is_err() { break; }
                    }
                    Some(Err(e)) => {
                        let _ = on_body.send(InvokeResponseBody::Json(json!({ "error": e.to_string() }).to_string()));
                        break;
                    }
                    None => {
                        let _ = on_body.send(InvokeResponseBody::Json(json!({ "end": true }).to_string()));
                        break;
                    }
                },
                _ = token.cancelled() => {
                    let _ = on_body.send(InvokeResponseBody::Json(json!({ "error": "aborted" }).to_string()));
                    break;
                }
            }
        }
        st.requests.lock().unwrap().remove(&id);
    });
    Ok(h)
}

#[tauri::command]
pub fn http_abort(state: State<'_, Arc<AppState>>, id: u64) {
    if let Some(t) = state.requests.lock().unwrap().remove(&id) {
        t.cancel();
    }
}

// Kursdatei herunterladen: direkt in eine eindeutige .part-Datei, dann umbenennen.
// Moodle liefert Fehler als JSON statt als Datei – die gehen als Daten an die JS-Seite zurück.
#[tauri::command]
pub async fn download(state: State<'_, Arc<AppState>>, url: String, dest: String) -> Result<Value, String> {
    let res = state.http.get(&url).header("user-agent", "node").send().await.map_err(|e| format!("fetch failed: {e}"))?;
    let status = res.status().as_u16();
    let ctype = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if !res.status().is_success() || ctype.contains("application/json") {
        let body = res.text().await.unwrap_or_default();
        return Ok(json!({ "ok": false, "status": status, "contentType": ctype, "body": body }));
    }
    let dest = std::path::PathBuf::from(dest);
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    }
    let tmp = std::path::PathBuf::from(format!("{}.{:08x}.part", dest.display(), rand::random::<u32>()));
    let result: Result<(), String> = async {
        let mut f = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            f.write_all(&chunk.map_err(|e| format!("fetch failed: {e}"))?).await.map_err(|e| e.to_string())?;
        }
        f.flush().await.map_err(|e| e.to_string())?;
        drop(f);
        tokio::fs::rename(&tmp, &dest).await.map_err(|e| e.to_string())
    }
    .await;
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    Ok(json!({ "ok": true }))
}

// ---------- Lokale HTTP-Server (Ersatz für Nodes http.createServer) ----------
pub struct LocalServer {
    server: Arc<tiny_http::Server>,
    pending: std::sync::Mutex<std::collections::HashMap<u64, tiny_http::Request>>,
}

#[tauri::command]
pub fn server_listen(state: State<'_, Arc<AppState>>, port: u16, host: String, on_request: Channel<Value>) -> Result<Value, String> {
    let server = match tiny_http::Server::http(format!("{host}:{port}")) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            let in_use = e.downcast_ref::<std::io::Error>().map(|e| e.kind() == std::io::ErrorKind::AddrInUse).unwrap_or(false) || e.to_string().contains("10048");
            return Err(if in_use { format!("EADDRINUSE: address already in use {host}:{port}") } else { e.to_string() });
        }
    };
    let real_port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(port);
    let id: u64 = rand::random::<u32>() as u64;
    let local = Arc::new(LocalServer { server: server.clone(), pending: Default::default() });
    state.servers.lock().unwrap().insert(id, local.clone());
    std::thread::spawn(move || {
        let mut n: u64 = 0;
        for rq in local.server.incoming_requests() {
            n += 1;
            let headers: Vec<(String, String)> = rq.headers().iter().map(|h| (h.field.as_str().as_str().to_ascii_lowercase(), h.value.as_str().to_string())).collect();
            let msg = json!({ "req": n, "method": rq.method().as_str(), "url": rq.url(), "headers": headers });
            local.pending.lock().unwrap().insert(n, rq);
            if on_request.send(msg).is_err() {
                break;
            }
        }
    });
    Ok(json!({ "id": id, "port": real_port }))
}

#[tauri::command]
pub fn server_respond(state: State<'_, Arc<AppState>>, id: u64, req: u64, status: u16, headers: Vec<(String, String)>, body: String) {
    let Some(srv) = state.servers.lock().unwrap().get(&id).cloned() else { return };
    let Some(rq) = srv.pending.lock().unwrap().remove(&req) else { return };
    let mut res = tiny_http::Response::from_data(body.into_bytes()).with_status_code(status);
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("content-length") {
            continue;
        }
        if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
            res.add_header(h);
        }
    }
    let _ = rq.respond(res);
}

#[tauri::command]
pub fn server_close(state: State<'_, Arc<AppState>>, id: u64) {
    if let Some(srv) = state.servers.lock().unwrap().remove(&id) {
        srv.pending.lock().unwrap().clear();
        srv.server.unblock();
    }
}
