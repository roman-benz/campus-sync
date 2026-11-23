// Chadoodle als Tauri-App: Rust übernimmt alles, was in der Electron-Version der Hauptprozess
// an Betriebssystem-Arbeit erledigt hat (Fenster, Tray, Autostart, Dateisystem, DPAPI, Netzwerk,
// Benachrichtigungen, Updates). Die App-Logik (src/main/*.js) läuft unverändert in der WebView –
// wie in der Web-Version, nur mit echtem Dateisystem (siehe tauri/backend.js und tauri/shims).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod net;
mod protocol;
mod secrets;
mod textindex;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

const APP_NAME: &str = "Chadoodle";
// Interne Kennung bleibt gleich wie in der Electron-Version (Autostart-Eintrag, Taskleiste, Benachrichtigungen)
const LOGIN_ITEM: &str = "de.rbenz.moodledesktop";
const ORIGIN_HOST: &str = "chadoodle.localhost";

pub struct AppState {
    pub user_data: PathBuf,
    pub key: String,
    pub secrets: secrets::Secrets,
    pub index: textindex::TextIndex,
    pub http: reqwest::Client,
    pub http_manual: reqwest::Client,
    pub requests: Mutex<HashMap<u64, tokio_util::sync::CancellationToken>>,
    pub servers: Mutex<HashMap<u64, Arc<net::LocalServer>>>,
    /// Moodle-Seite und Token für /mfile/ (None = abgemeldet → nur Zwischenspeicher)
    pub media: RwLock<Option<(String, String)>>,
    /// Ordner, aus denen /vfs/ Dateien ausliefern darf
    pub allowed_dirs: RwLock<Vec<PathBuf>>,
    start_hidden: AtomicBool,
    js_ready: AtomicBool,
    tray_sync: Mutex<Option<MenuItem<tauri::Wry>>>,
    update: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
}

// ---------- Profilordner (wie main.js der Electron-Version) ----------
fn resolve_user_data() -> PathBuf {
    if let Ok(p) = std::env::var("MOODLE_DESKTOP_USERDATA") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let app_data = PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into()));
    let fresh = app_data.join(APP_NAME);
    let has_data = |d: &Path| d.join("settings.json").exists() || d.join("secrets.json").exists();
    // Frühere Namen („Moodle Desktop“ bis 1.2, „Campus Sync“ in 1.3): deren Profil weiterverwenden
    let old: Vec<PathBuf> = ["Moodle Desktop", "Campus Sync"].iter().map(|n| app_data.join(n)).collect();
    let legacy = old.iter().find(|d| has_data(d)).or_else(|| old.iter().find(|d| d.exists()));
    match legacy {
        Some(l) if !has_data(&fresh) => {
            let _ = std::fs::remove_dir(&fresh); // nur, wenn leer
            l.clone()
        }
        _ => fresh,
    }
}

fn fwd(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

// Alle Fenster teilen sich ein WebView2-Profil und brauchen deshalb dieselben Browser-Argumente
// (sonst schlägt das Anlegen weiterer Fenster mit ERROR_INVALID_STATE fehl).
// Hintergrund-Sync auch bei verstecktem Fenster nicht drosseln (wie Electrons Hauptprozess).
fn browser_args() -> String {
    format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows{}",
        // Nur Entwicklung: DevTools-Protokoll für automatische Tests
        if cfg!(debug_assertions) { " --remote-debugging-port=9333" } else { "" }
    )
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

// Im Tray (Fenster versteckt) gibt WebView2 möglichst viel Arbeitsspeicher frei; die Logik läuft weiter
fn memory_target(w: &WebviewWindow, low: bool) {
    let _ = w.with_webview(move |wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use windows_core::Interface;
        if let Ok(core) = wv.controller().CoreWebView2() {
            if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
                let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
                let _ = c19.SetMemoryUsageTargetLevel(level);
            }
        }
    });
}

fn show_main(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        memory_target(&w, false);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit_to("main", "app:shown", ());
    }
}

fn is_own(url: &url::Url) -> bool {
    url.host_str() == Some(ORIGIN_HOST) || url.scheme() == "chadoodle" || url.scheme() == "about" || url.scheme() == "blob" || url.scheme() == "data"
}

fn open_external(app: &AppHandle, url: &str) {
    if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

// ---------- Befehle für die Oberfläche ----------
#[tauri::command]
fn win_ready(app: AppHandle, state: State<'_, Arc<AppState>>) {
    state.js_ready.store(true, Ordering::SeqCst);
    if let Some(w) = main_window(&app) {
        if state.start_hidden.load(Ordering::SeqCst) {
            memory_target(&w, true);
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

#[tauri::command]
fn win_show(app: AppHandle) {
    if let Some(w) = main_window(&app) {
        memory_target(&w, false);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn win_hide(app: AppHandle) {
    if let Some(w) = main_window(&app) {
        let _ = w.hide();
        memory_target(&w, true);
    }
}

#[tauri::command]
fn win_visible(app: AppHandle) -> bool {
    main_window(&app).and_then(|w| w.is_visible().ok()).unwrap_or(false)
}

#[tauri::command]
fn app_quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn set_theme(app: AppHandle, theme: String) {
    let t = match theme.as_str() {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None,
    };
    for w in app.webview_windows().values() {
        let _ = w.set_theme(t);
    }
}

#[tauri::command]
fn tray_update(app: AppHandle, state: State<'_, Arc<AppState>>, tooltip: String, can_sync: bool) {
    if let Some(t) = app.tray_by_id("main") {
        let _ = t.set_tooltip(Some(tooltip));
    }
    if let Some(item) = state.tray_sync.lock().unwrap().as_ref() {
        let _ = item.set_enabled(can_sync);
    }
}

// App-Symbol für Benachrichtigungen (Windows braucht eine Datei; der Installer liefert keinen icons-Ordner)
fn notify_icon(state: &AppState) -> Option<PathBuf> {
    let p = state.user_data.join("cache").join("notify-icon.png");
    if !p.exists() {
        let _ = std::fs::create_dir_all(p.parent()?);
        std::fs::write(&p, include_bytes!("../icons/128x128@2x.png")).ok()?;
    }
    Some(p)
}

// Windows-Benachrichtigung. important: bleibt stehen, bis man sie wegklickt (Erinnerung mit Ton)
// und hat einen Knopf; route: Bereich, den ein Klick in der App öffnet (z. B. „grades“).
#[tauri::command]
fn notify(app: AppHandle, state: State<'_, Arc<AppState>>, title: String, body: String, important: Option<bool>, route: Option<String>, button: Option<String>) {
    use tauri_winrt_notification::{IconCrop, Scenario, Sound, Toast};
    let aumid = if cfg!(debug_assertions) { Toast::POWERSHELL_APP_ID.to_string() } else { app.config().identifier.clone() };
    let mut lines = body.splitn(2, '\n');
    let first = lines.next().unwrap_or("").to_string();
    let rest = lines.next().unwrap_or("").to_string();
    let icon = notify_icon(&state);
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut toast = Toast::new(&aumid).title(&title).text1(&first);
        if !rest.is_empty() {
            toast = toast.text2(&rest);
        }
        if let Some(i) = &icon {
            toast = toast.icon(i, IconCrop::Square, "Chadoodle");
        }
        if important.unwrap_or(false) {
            toast = toast.scenario(Scenario::Reminder).sound(Some(Sound::Reminder)).add_button(button.as_deref().unwrap_or("Ansehen"), "open");
        }
        let h = handle.clone();
        let _ = toast
            .on_activated(move |_| {
                show_main(&h);
                if let Some(r) = &route {
                    let _ = h.emit_to("main", "app:navigate", r.clone());
                }
                Ok(())
            })
            .show();
    });
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) -> String {
    match app.opener().open_path(path, None::<&str>) {
        Ok(()) => String::new(),
        Err(e) => e.to_string(),
    }
}

#[tauri::command]
fn show_item(app: AppHandle, path: String) {
    let _ = app.opener().reveal_item_in_dir(path);
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) {
    open_external(&app, &url);
}

#[tauri::command]
async fn pick_folder(app: AppHandle, default_path: String) -> Option<String> {
    let mut d = app.dialog().file();
    if let Some(w) = main_window(&app) {
        d = d.set_parent(&w);
    }
    if !default_path.is_empty() {
        d = d.set_directory(default_path);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    d.pick_folder(move |p| {
        let _ = tx.send(p.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()));
    });
    rx.await.ok().flatten()
}

#[tauri::command]
fn set_login_item(enabled: bool) -> Result<(), String> {
    // Wie app.isPackaged in Electron: in Entwicklungs-Builds nichts eintragen
    if cfg!(debug_assertions) {
        return Ok(());
    }
    let run = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
        .map_err(|e| e.to_string())?
        .0;
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        run.set_value(LOGIN_ITEM, &format!("\"{}\" --hidden", exe.display())).map_err(|e| e.to_string())
    } else {
        let _ = run.delete_value(LOGIN_ITEM);
        Ok(())
    }
}

#[tauri::command]
fn set_media(state: State<'_, Arc<AppState>>, site_url: Option<String>, token: Option<String>) {
    *state.media.write().unwrap() = match (site_url, token) {
        (Some(s), Some(t)) if !s.is_empty() && !t.is_empty() => Some((s, t)),
        _ => None,
    };
}

#[tauri::command]
fn set_allowed_dirs(state: State<'_, Arc<AppState>>, dirs: Vec<String>) {
    *state.allowed_dirs.write().unwrap() = dirs.into_iter().filter(|d| !d.is_empty()).map(PathBuf::from).collect();
}

// SSO-Anmeldung: Moodle in einem eigenen Fenster; die Umleitung auf moodlemobile://token=…
// wird abgefangen und an die JS-Seite gegeben (die prüft die Signatur wie bisher).
#[tauri::command]
async fn moodle_login_window(app: AppHandle, launch: String) -> Result<String, String> {
    if let Some(old) = app.get_webview_window("moodle-login") {
        let _ = old.destroy();
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let url: url::Url = launch.parse().map_err(|e: url::ParseError| e.to_string())?;
    let capture = {
        let tx = tx.clone();
        let app = app.clone();
        move |u: &str| -> bool {
            if !u.to_ascii_lowercase().starts_with("moodlemobile://token=") {
                return false;
            }
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(Ok(u.to_string()));
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(w) = app.get_webview_window("moodle-login") {
                    let _ = w.close();
                }
            });
            true
        }
    };
    let cap_nav = capture.clone();
    let cap_new = capture.clone();
    let mut b = WebviewWindowBuilder::new(&app, "moodle-login", WebviewUrl::External(url))
        .title("Bei Moodle anmelden")
        .additional_browser_args(&browser_args())
        .inner_size(980.0, 760.0)
        .on_navigation(move |u| !cap_nav(u.as_str()))
        .on_new_window(move |u, _| {
            cap_new(u.as_str());
            tauri::webview::NewWindowResponse::Deny
        });
    if let Some(main) = main_window(&app) {
        b = b.parent(&main).map_err(|e| e.to_string())?;
    }
    let win = b.build().map_err(|e| e.to_string())?;
    let tx_close = tx.clone();
    win.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            if let Some(tx) = tx_close.lock().unwrap().take() {
                let _ = tx.send(Err("cancelled".into()));
            }
        }
    });
    rx.await.map_err(|_| "cancelled".to_string())?
}

// Offizielle Bestellseite von my-mensa in einem eigenen Fenster; fremde Links → Browser
#[tauri::command]
// async: Fenster aus einem synchronen Befehl anzulegen blockiert unter Windows den Haupt-Thread
async fn mensa_order_window(app: AppHandle, url: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("mensa-order") {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    let is_mensa = |u: &url::Url| u.host_str().map(|h| h == "my-mensa.de" || h.ends_with(".my-mensa.de")).unwrap_or(false);
    let a1 = app.clone();
    let a2 = app.clone();
    WebviewWindowBuilder::new(&app, "mensa-order", WebviewUrl::External(url.parse().map_err(|e: url::ParseError| e.to_string())?))
        .title(format!("Mensa bestellen – {APP_NAME}"))
        .additional_browser_args(&browser_args())
        .inner_size(1120.0, 880.0)
        .min_inner_size(720.0, 560.0)
        .on_navigation(move |u| {
            if is_mensa(u) || u.scheme() == "about" {
                return true;
            }
            open_external(&a1, u.as_str());
            false
        })
        .on_new_window(move |u, _| {
            open_external(&a2, u.as_str());
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- Updates (GitHub-Releases, signiert) ----------
#[tauri::command]
async fn update_check(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    let ev = |v: Value| {
        let _ = app.emit_to("main", "update:event", v);
    };
    if state.update.lock().unwrap().is_some() {
        return Ok(());
    }
    ev(json!({ "type": "checking" }));
    let result: Result<(), String> = async {
        let updater = app.updater().map_err(|e| e.to_string())?;
        let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
            ev(json!({ "type": "none" }));
            return Ok(());
        };
        let version = update.version.clone();
        ev(json!({ "type": "available", "version": version }));
        let mut got: u64 = 0;
        let mut last = 0u64;
        let bytes = update
            .download(
                |chunk, total| {
                    got += chunk as u64;
                    if let Some(t) = total.filter(|t| *t > 0) {
                        let pct = got * 100 / t;
                        if pct != last {
                            last = pct;
                            let _ = app.emit_to("main", "update:event", json!({ "type": "progress", "percent": pct }));
                        }
                    }
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;
        *state.update.lock().unwrap() = Some((update, bytes));
        ev(json!({ "type": "downloaded", "version": version }));
        Ok(())
    }
    .await;
    if let Err(e) = &result {
        ev(json!({ "type": "error", "message": e }));
    }
    Ok(())
}

#[tauri::command]
fn update_install(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let Some((update, bytes)) = state.update.lock().unwrap().take() else { return Ok(()) };
    // Startet den Installer und beendet die App; der Installer startet sie danach neu
    update.install(bytes).map_err(|e| e.to_string())
}

fn main() {
    let user_data = resolve_user_data();
    let _ = std::fs::create_dir_all(&user_data);
    let args: Vec<String> = std::env::args().collect();
    // Versteckt starten: Autostart (--hidden) oder Neustart nach einem stillen Hintergrund-Update
    let hidden_flag = user_data.join("start-hidden");
    let start_hidden = args.iter().any(|a| a == "--hidden") || hidden_flag.exists();
    let _ = std::fs::remove_file(&hidden_flag);

    let mut key = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut key);
    let http = reqwest::Client::builder().build().expect("HTTP-Client");
    let http_manual = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().expect("HTTP-Client");
    let state = Arc::new(AppState {
        secrets: secrets::Secrets::new(&user_data),
        index: Default::default(),
        allowed_dirs: RwLock::new(vec![user_data.join("cache").join("img")]),
        user_data,
        key: hex::encode(key),
        http,
        http_manual,
        requests: Default::default(),
        servers: Default::default(),
        media: RwLock::new(None),
        start_hidden: AtomicBool::new(start_hidden),
        js_ready: AtomicBool::new(false),
        tray_sync: Mutex::new(None),
        update: Mutex::new(None),
    });

    unsafe {
        let id: Vec<u16> = LOGIN_ITEM.encode_utf16().chain(std::iter::once(0)).collect();
        let _ = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(windows::core::PCWSTR(id.as_ptr()));
    }

    // Volltextindex nach 2 Minuten ohne Suche freigeben (wird bei Bedarf in ~0,2 s neu geladen)
    let idle_state = state.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        idle_state.index.unload_if_idle(std::time::Duration::from_secs(120));
    });

    let proto_state = state.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if !argv.iter().any(|a| a == "--hidden") {
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state.clone())
        .register_asynchronous_uri_scheme_protocol("chadoodle", move |ctx, req, responder| {
            protocol::handle(ctx.app_handle(), proto_state.clone(), req, responder);
        })
        .invoke_handler(tauri::generate_handler![
            win_ready,
            win_show,
            win_hide,
            win_visible,
            app_quit,
            set_theme,
            tray_update,
            notify,
            open_path,
            show_item,
            open_url,
            pick_folder,
            set_login_item,
            set_media,
            set_allowed_dirs,
            moodle_login_window,
            mensa_order_window,
            update_check,
            update_install,
            net::http_request,
            net::http_abort,
            net::download,
            net::server_listen,
            net::server_respond,
            net::server_close,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let st = state.clone();
            let docs = app.path().document_dir().unwrap_or_else(|_| st.user_data.clone());
            let app_data = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_default();
            let env = json!({
                "userData": fwd(&st.user_data),
                "documents": fwd(&docs),
                "appData": fwd(&app_data),
                "version": app.package_info().version.to_string(),
                "packaged": !cfg!(debug_assertions),
                "startHidden": start_hidden,
                "key": st.key,
            });
            let init = format!("window.__CHADOODLE__ = Object.freeze({env});");
            let dark = std::fs::read_to_string(st.user_data.join("settings.json"))
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .and_then(|v| v.get("theme").and_then(|t| t.as_str()).map(|t| t == "dark"))
                .unwrap_or(false);

            let nav_app = handle.clone();
            let new_app = handle.clone();
            let mut wb = WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol("chadoodle://localhost/index.html".parse().unwrap()))
                .title(APP_NAME)
                .inner_size(1360.0, 880.0)
                .min_inner_size(960.0, 600.0)
                .visible(false)
                // HTML5-Drag&Drop (Bilder in den Chat ziehen) statt Tauris eigener Datei-Ablage
                .disable_drag_drop_handler()
                .background_color(if dark { tauri::window::Color(0x12, 0x15, 0x1b, 255) } else { tauri::window::Color(0xff, 0xff, 0xff, 255) })
                .initialization_script(&init)
                // Hintergrund-Sync auch bei verstecktem Fenster nicht drosseln (wie Electrons Hauptprozess)
                .additional_browser_args(&browser_args())
                .on_navigation(move |u| {
                    if is_own(u) {
                        return true;
                    }
                    open_external(&nav_app, u.as_str());
                    false
                })
                .on_new_window(move |u, _| {
                    let _ = new_app.emit_to("main", "app:open-external", u.as_str());
                    tauri::webview::NewWindowResponse::Deny
                });
            if let Some(icon) = app.default_window_icon() {
                wb = wb.icon(icon.clone())?;
            }
            let win = wb.build()?;
            if dark {
                let _ = win.set_theme(Some(Theme::Dark));
            }
            let close_app = handle.clone();
            let close_state = st.clone();
            win.on_window_event(move |e| {
                if let WindowEvent::CloseRequested { api, .. } = e {
                    // Ob die App im Hintergrund weiterläuft, entscheidet die Logik (Einstellung, Anmeldung)
                    if close_state.js_ready.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = close_app.emit_to("main", "win:close", ());
                    } else {
                        close_app.exit(0);
                    }
                }
            });

            // Tray
            let open = MenuItem::with_id(app, "open", format!("{APP_NAME} öffnen"), true, None::<&str>)?;
            let sync = MenuItem::with_id(app, "sync", "Jetzt synchronisieren", false, None::<&str>)?;
            let folder = MenuItem::with_id(app, "folder", "Download-Ordner öffnen", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &sync, &folder, &sep, &quit])?;
            *st.tray_sync.lock().unwrap() = Some(sync);
            let mut tb = TrayIconBuilder::with_id("main")
                .tooltip(format!("{APP_NAME} {}", app.package_info().version))
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id().as_ref() {
                    "open" => show_main(app),
                    "sync" => {
                        let _ = app.emit_to("main", "tray:sync", ());
                    }
                    "folder" => {
                        let _ = app.emit_to("main", "tray:folder", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tb = tb.icon(icon.clone());
            }
            tb.build(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Chadoodle konnte nicht starten");

    app.run(|_app, event| {
        // Alle Fenster zu (z. B. nur das Login-Fenster war offen) ≠ beenden; beendet wird über app.exit
        if let RunEvent::ExitRequested { code: None, api, .. } = event {
            api.prevent_exit();
        }
    });
}
