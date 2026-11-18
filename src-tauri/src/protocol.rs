// Eigenes Protokoll „chadoodle“ (unter Windows http://chadoodle.localhost):
//   /cfs/…     synchrones Dateisystem für die JS-Module (Ersatz für Nodes „fs“, per synchronem XHR)
//   /vfs/…     lokale Dateien für die Oberfläche (Kurs- und Profilbilder, Kursdateien)
//   /mfile/…   Bilder/Dateien aus Moodle-Texten, mit Token geladen und offline zwischengespeichert
//   sonst      die App-Dateien (Oberfläche) aus dem Programm
// Alles läuft unter einem Ursprung – wie die Web-Version mit ihrem Service Worker.
use crate::AppState;
use base64::{engine::general_purpose::STANDARD as B64, engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use percent_encoding::percent_decode_str;
use serde::Deserialize;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::http::{Request, Response, StatusCode};

type Res = Response<Vec<u8>>;

fn resp(status: u16, ctype: &str, body: Vec<u8>) -> Res {
    Response::builder()
        .status(status)
        .header("Content-Type", ctype)
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap()
}

fn json_resp(status: u16, v: Value) -> Res {
    resp(status, "application/json", serde_json::to_vec(&v).unwrap())
}

fn query(req: &Request<Vec<u8>>) -> HashMap<String, String> {
    req.uri()
        .query()
        .map(|q| url::form_urlencoded::parse(q.as_bytes()).into_owned().collect())
        .unwrap_or_default()
}

// ---------- Fehler wie in Node (code + Meldung) ----------
fn io_code(e: &std::io::Error) -> &'static str {
    use std::io::ErrorKind::*;
    match e.kind() {
        NotFound => "ENOENT",
        AlreadyExists => "EEXIST",
        PermissionDenied => "EPERM",
        DirectoryNotEmpty => "ENOTEMPTY",
        IsADirectory => "EISDIR",
        NotADirectory => "ENOTDIR",
        _ => match e.raw_os_error() {
            Some(32) | Some(33) => "EBUSY",
            _ => "EIO",
        },
    }
}

fn io_err(e: std::io::Error, op: &str, p: &str) -> Res {
    let code = io_code(&e);
    let status = if code == "ENOENT" { 404 } else { 500 };
    json_resp(status, json!({ "code": code, "message": format!("{code}: {e}, {op} '{p}'") }))
}

fn err(code: &str, message: String) -> Res {
    json_resp(500, json!({ "code": code, "message": message }))
}

fn ms(t: std::io::Result<SystemTime>) -> f64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[derive(Deserialize)]
struct Op {
    op: String,
    p: String,
    #[serde(default)]
    p2: String,
    #[serde(default)]
    recursive: bool,
    #[serde(default)]
    force: bool,
    #[serde(default)]
    atime: f64,
    #[serde(default)]
    mtime: f64,
}

fn fs_op(o: Op) -> Res {
    let p = Path::new(&o.p);
    match o.op.as_str() {
        "exists" => json_resp(200, json!({ "v": p.exists() })),
        "stat" => match std::fs::metadata(p) {
            Ok(m) => json_resp(200, json!({ "size": m.len(), "mtimeMs": ms(m.modified()), "atimeMs": ms(m.accessed()), "birthtimeMs": ms(m.created()), "isFile": m.is_file(), "isDir": m.is_dir() })),
            Err(e) => io_err(e, "stat", &o.p),
        },
        "readdir" => match std::fs::read_dir(p) {
            Ok(rd) => {
                let mut list: Vec<(String, bool)> = rd
                    .filter_map(|e| e.ok())
                    .map(|e| (e.file_name().to_string_lossy().into_owned(), e.file_type().map(|t| t.is_dir()).unwrap_or(false)))
                    .collect();
                list.sort_by(|a, b| a.0.cmp(&b.0));
                json_resp(200, json!({ "names": list.iter().map(|x| &x.0).collect::<Vec<_>>(), "dirs": list.iter().map(|x| x.1).collect::<Vec<_>>() }))
            }
            Err(e) => io_err(e, "scandir", &o.p),
        },
        "mkdir" => {
            let r = if o.recursive { std::fs::create_dir_all(p) } else { std::fs::create_dir(p) };
            match r {
                Ok(()) => json_resp(200, json!({})),
                Err(e) => io_err(e, "mkdir", &o.p),
            }
        }
        "rm" => match std::fs::symlink_metadata(p) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && o.force => json_resp(200, json!({})),
            Err(e) => io_err(e, "rm", &o.p),
            Ok(m) if m.is_dir() => {
                if !o.recursive {
                    return err("ERR_FS_EISDIR", format!("Path is a directory: rm returned EISDIR (is a directory) {}", o.p));
                }
                match std::fs::remove_dir_all(p) {
                    Ok(()) => json_resp(200, json!({})),
                    Err(e) => io_err(e, "rm", &o.p),
                }
            }
            Ok(_) => match std::fs::remove_file(p) {
                Ok(()) => json_resp(200, json!({})),
                Err(e) => io_err(e, "rm", &o.p),
            },
        },
        "rmdir" => match std::fs::remove_dir(p) {
            Ok(()) => json_resp(200, json!({})),
            Err(e) => io_err(e, "rmdir", &o.p),
        },
        "rename" => match std::fs::rename(p, &o.p2) {
            Ok(()) => json_resp(200, json!({})),
            Err(e) => io_err(e, "rename", &o.p),
        },
        "utimes" => {
            let t = |s: f64| UNIX_EPOCH + Duration::from_secs_f64(s.max(0.0));
            let r = std::fs::File::options()
                .write(true)
                .open(p)
                .and_then(|f| f.set_times(std::fs::FileTimes::new().set_accessed(t(o.atime)).set_modified(t(o.mtime))));
            match r {
                Ok(()) => json_resp(200, json!({})),
                Err(e) => io_err(e, "utime", &o.p),
            }
        }
        other => err("EINVAL", format!("unbekannte Dateioperation {other}")),
    }
}

// ---------- Synchrone Hilfsfunktionen (DPAPI, Hashes, Signaturen) ----------
fn native(state: &AppState, body: &[u8]) -> Res {
    let v: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return err("EINVAL", e.to_string()),
    };
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    match v.get("fn").and_then(|x| x.as_str()).unwrap_or("") {
        "encrypt" => match state.secrets.encrypt(&s("text")) {
            Ok(b) => json_resp(200, json!({ "b64": B64.encode(b) })),
            Err(e) => err("ECRYPT", e),
        },
        "decrypt" => match B64.decode(s("b64")).map_err(|e| e.to_string()).and_then(|b| state.secrets.decrypt(&b)) {
            Ok(t) => json_resp(200, json!({ "text": t })),
            Err(e) => err("ECRYPT", e),
        },
        "sha256" => match B64.decode(s("b64")) {
            Ok(b) => json_resp(200, json!({ "b64": B64.encode(sha2::Sha256::digest(&b)) })),
            Err(e) => err("EINVAL", e.to_string()),
        },
        "jwtVerify" => json_resp(200, json!({ "ok": jwt_verify(&v).unwrap_or(false) })),
        // Volltextindex (src-tauri/src/textindex.rs)
        "indexLoad" => json_resp(200, state.index.load(&s("dir"))),
        "indexPut" => {
            let pages: Vec<String> = v.get("pages").and_then(|p| serde_json::from_value(p.clone()).ok()).unwrap_or_default();
            match state.index.put(&s("dir"), &s("id"), v.get("tm").cloned().unwrap_or(Value::Null), pages) {
                Ok(r) => json_resp(200, r),
                Err(e) => err("EIO", e),
            }
        }
        "indexPages" => {
            let n = |k: &str| v.get(k).and_then(|x| x.as_u64()).unwrap_or(1) as usize;
            match state.index.pages(&s("dir"), &s("id"), n("from"), n("to")) {
                Ok(r) => json_resp(200, r),
                Err(e) => err("ENOENT", e),
            }
        }
        "indexSearch" => {
            let terms: Vec<String> = v.get("terms").and_then(|p| serde_json::from_value(p.clone()).ok()).unwrap_or_default();
            let files: Vec<(String, String)> = v.get("files").and_then(|p| serde_json::from_value(p.clone()).ok()).unwrap_or_default();
            let n = |k: &str, d: u64| v.get(k).and_then(|x| x.as_u64()).unwrap_or(d) as usize;
            json_resp(200, state.index.search(&terms, &files, n("limit", 40), n("perFile", 4)))
        }
        other => err("EINVAL", format!("unbekannte Funktion {other}")),
    }
}

// RS256/ES256-Signatur eines ID-Tokens mit einem JWK prüfen (Ersatz für crypto.verify)
fn jwt_verify(v: &Value) -> Option<bool> {
    use ring::signature;
    let jwk = v.get("jwk")?;
    let field = |k: &str| jwk.get(k).and_then(|x| x.as_str()).and_then(|s| B64URL.decode(s.trim_end_matches('=')).ok());
    let data = v.get("data")?.as_str()?.as_bytes();
    let sig = B64.decode(v.get("sig")?.as_str()?).ok()?;
    match v.get("alg")?.as_str()? {
        "RS256" => {
            let key = signature::RsaPublicKeyComponents { n: field("n")?, e: field("e")? };
            Some(key.verify(&signature::RSA_PKCS1_2048_8192_SHA256, data, &sig).is_ok())
        }
        "ES256" => {
            let mut point = vec![4u8];
            point.extend(field("x")?);
            point.extend(field("y")?);
            Some(signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point).verify(data, &sig).is_ok())
        }
        _ => Some(false),
    }
}

// ---------- Inhaltstypen (wie der Service Worker der Web-Version) ----------
fn type_for(name: &str, head: &[u8]) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let t = match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "txt" | "csv" | "md" => "text/plain; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "json" => "application/json",
        "xml" => "text/xml",
        _ => "",
    };
    if !t.is_empty() {
        return t.into();
    }
    sniff(head)
}

fn sniff(b: &[u8]) -> String {
    if b.starts_with(&[0x89, 0x50]) {
        return "image/png".into();
    }
    if b.starts_with(&[0xff, 0xd8]) {
        return "image/jpeg".into();
    }
    if b.starts_with(b"GI") {
        return "image/gif".into();
    }
    if b.len() > 11 && &b[8..12] == b"WEBP" {
        return "image/webp".into();
    }
    let head = String::from_utf8_lossy(&b[..b.len().min(256)]).trim_start().to_ascii_lowercase();
    if head.starts_with("<svg") || (head.starts_with("<?xml") && head.contains("<svg")) {
        return "image/svg+xml".into();
    }
    "application/octet-stream".into()
}

// Fremde Inhalte, die Skripte enthalten können, laufen abgeschottet (kein Zugriff auf die App)
fn isolate(builder: tauri::http::response::Builder, ctype: &str) -> tauri::http::response::Builder {
    let safe = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-icon", "video/", "audio/", "text/plain"];
    let b = builder.header("X-Content-Type-Options", "nosniff");
    if safe.iter().any(|s| ctype.to_ascii_lowercase().starts_with(s)) {
        b
    } else {
        b.header("Content-Security-Policy", "sandbox")
    }
}

// ---------- /vfs/: lokale Dateien ----------
fn norm_key(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

fn vfs(state: &AppState, req: &Request<Vec<u8>>) -> Res {
    let raw = req.uri().path().trim_start_matches("/vfs");
    let decoded: Vec<String> = raw.split('/').map(|s| percent_decode_str(s).decode_utf8_lossy().into_owned()).collect();
    if decoded.iter().any(|s| s == "..") {
        return resp(403, "text/plain", b"nicht erlaubt".to_vec());
    }
    let mut p = decoded.join("/");
    if p.len() > 2 && p.starts_with('/') && p.as_bytes()[2] == b':' {
        p.remove(0);
    }
    let path = PathBuf::from(&p);
    let key = norm_key(&path);
    let allowed = state.allowed_dirs.read().unwrap().iter().any(|d| {
        let d = norm_key(d);
        !d.is_empty() && (key == d || key.starts_with(&(d + "\\")))
    });
    if !allowed {
        return resp(403, "text/plain", b"nicht erlaubt".to_vec());
    }
    let mut f = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return resp(404, "text/plain", b"nicht vorhanden".to_vec()),
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut head = vec![0u8; 256.min(len as usize)];
    let _ = f.read_exact(&mut head);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let ctype = type_for(&name, &head);
    // Einfache Range-Anfragen (Videos/Audio vorspulen)
    let range = req.headers().get("range").and_then(|v| v.to_str().ok()).and_then(|r| {
        let r = r.strip_prefix("bytes=")?;
        let (a, b) = r.split_once('-')?;
        let start: u64 = if a.is_empty() { len.saturating_sub(b.parse().ok()?) } else { a.parse().ok()? };
        let end: u64 = if a.is_empty() || b.is_empty() { len.saturating_sub(1) } else { b.parse::<u64>().ok()?.min(len.saturating_sub(1)) };
        (start <= end && start < len).then_some((start, end))
    });
    let disp = format!("inline; filename*=UTF-8''{}", percent_encoding::utf8_percent_encode(&name, percent_encoding::NON_ALPHANUMERIC));
    let builder = isolate(Response::builder(), &ctype)
        .header("Content-Type", &ctype)
        .header("Content-Disposition", disp)
        .header("Cache-Control", "no-store")
        .header("Accept-Ranges", "bytes");
    match range {
        Some((start, end)) => {
            let mut buf = vec![0u8; (end - start + 1) as usize];
            if f.seek(SeekFrom::Start(start)).and_then(|_| f.read_exact(&mut buf)).is_err() {
                return resp(500, "text/plain", Vec::new());
            }
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header("Content-Range", format!("bytes {start}-{end}/{len}"))
                .body(buf)
                .unwrap()
        }
        None => {
            let mut buf = Vec::with_capacity(len as usize);
            let _ = f.seek(SeekFrom::Start(0));
            if f.read_to_end(&mut buf).is_err() {
                return resp(500, "text/plain", Vec::new());
            }
            builder.status(200).body(buf).unwrap()
        }
    }
}

// ---------- /mfile/: Moodle-Medien (wie das mfile://-Protokoll der Electron-Version) ----------
pub fn is_site_url(raw: &str, site: &str) -> bool {
    let (Ok(u), Ok(s)) = (url::Url::parse(raw), url::Url::parse(site)) else { return false };
    let base = s.path().trim_end_matches('/');
    u.origin() == s.origin() && (base.is_empty() || u.path() == base || u.path().starts_with(&format!("{base}/")))
}

pub fn file_url(raw: &str, token: &str) -> String {
    if !raw.contains("/pluginfile.php/") {
        return raw.to_string();
    }
    let u = raw.replacen("/pluginfile.php/", "/webservice/pluginfile.php/", 1).replacen("/webservice/webservice/", "/webservice/", 1);
    let sep = if u.contains('?') { '&' } else { '?' };
    format!("{u}{sep}token={}", percent_encoding::utf8_percent_encode(token, percent_encoding::NON_ALPHANUMERIC))
}

async fn mfile(state: Arc<AppState>, path: String) -> Res {
    let raw = percent_decode_str(path.trim_start_matches("/mfile/")).decode_utf8_lossy().into_owned();
    let session = state.media.read().unwrap().clone();
    if let Some((site, _)) = &session {
        if !is_site_url(&raw, site) {
            return resp(403, "text/plain", "nicht erlaubt".as_bytes().to_vec());
        }
    }
    let dir = state.user_data.join("cache").join("media");
    let key = dir.join(hex::encode(Sha1::digest(raw.split('?').next().unwrap_or("").as_bytes())));
    let type_file = PathBuf::from(format!("{}.type", key.display()));
    let fetched: Result<(Vec<u8>, String), String> = async {
        let (_, token) = session.ok_or("offline")?;
        let res = state.http.get(file_url(&raw, &token)).header("user-agent", "node").send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("HTTP {}", res.status().as_u16()));
        }
        let ctype = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let body = res.bytes().await.map_err(|e| e.to_string())?.to_vec();
        Ok((body, ctype))
    }
    .await;
    let (body, ctype) = match fetched {
        Ok((body, ctype)) => {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(&key, &body);
            let _ = std::fs::write(&type_file, &ctype);
            (body, ctype)
        }
        Err(_) => match std::fs::read(&key) {
            Ok(b) => (b, std::fs::read_to_string(&type_file).unwrap_or_else(|_| "application/octet-stream".into())),
            Err(_) => return resp(404, "text/plain", "nicht verfügbar".as_bytes().to_vec()),
        },
    };
    let ctype = if ctype.is_empty() { sniff(&body) } else { ctype };
    isolate(Response::builder(), &ctype).status(200).header("Content-Type", &ctype).body(body).unwrap()
}

// ---------- Verteiler ----------
pub fn handle(app: &tauri::AppHandle, state: Arc<AppState>, req: Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    let path = req.uri().path().to_string();
    if path.starts_with("/cfs/") {
        // Nur die eigene Oberfläche (Schlüssel aus dem Startskript) – andere Fenster wie der
        // Moodle-Login dürfen das Dateisystem nicht ansprechen
        let ok = req.headers().get("x-chadoodle-key").and_then(|v| v.to_str().ok()) == Some(state.key.as_str());
        if !ok {
            return responder.respond(resp(403, "text/plain", b"forbidden".to_vec()));
        }
        std::thread::spawn(move || {
            let q = query(&req);
            let p = q.get("p").cloned().unwrap_or_default();
            let out = match path.as_str() {
                "/cfs/read" => match std::fs::read(&p) {
                    Ok(b) => resp(200, "application/octet-stream", b),
                    Err(e) => io_err(e, "open", &p),
                },
                "/cfs/write" => {
                    let r = if q.get("append").map(|s| s == "1").unwrap_or(false) {
                        use std::io::Write;
                        std::fs::OpenOptions::new().create(true).append(true).open(&p).and_then(|mut f| f.write_all(req.body()))
                    } else {
                        std::fs::write(&p, req.body())
                    };
                    match r {
                        Ok(()) => json_resp(200, json!({})),
                        Err(e) => io_err(e, "open", &p),
                    }
                }
                "/cfs/op" => match serde_json::from_slice::<Op>(req.body()) {
                    Ok(o) => fs_op(o),
                    Err(e) => err("EINVAL", e.to_string()),
                },
                "/cfs/native" => native(&state, req.body()),
                _ => resp(404, "text/plain", Vec::new()),
            };
            responder.respond(out);
        });
        return;
    }
    if path.starts_with("/vfs/") {
        std::thread::spawn(move || responder.respond(vfs(&state, &req)));
        return;
    }
    if path.starts_with("/mfile/") {
        tauri::async_runtime::spawn(async move { responder.respond(mfile(state, path).await) });
        return;
    }
    // App-Dateien
    let mut name = path.trim_start_matches('/').to_string();
    if name.is_empty() {
        name = "index.html".into();
    }
    let name = percent_decode_str(&name).decode_utf8_lossy().into_owned();
    match app.asset_resolver().get(name.clone()) {
        Some(asset) => {
            let ctype = if name.ends_with(".mjs") || name.ends_with(".js") { "text/javascript".to_string() } else { asset.mime_type().to_string() };
            responder.respond(Response::builder().status(200).header("Content-Type", ctype).body(asset.bytes().to_vec()).unwrap())
        }
        None => responder.respond(resp(404, "text/plain", Vec::new())),
    }
}
