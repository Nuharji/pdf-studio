// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pdfbuild;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, State, WebviewWindow,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri::Emitter;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

/// A file the UI can open with `read_file`.
#[derive(Serialize, Clone)]
struct FileInfo {
    path: String,
    name: String,
    size: u64,
}

#[derive(Serialize)]
struct Saved {
    path: String,
    name: String,
}

/// Files requested before the UI was ready (command-line args, macOS "Open with").
struct Pending {
    ready: bool,
    paths: Vec<PathBuf>,
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document.pdf".into())
}

fn info(path: &Path) -> FileInfo {
    FileInfo {
        path: path.to_string_lossy().into_owned(),
        name: file_name(path),
        size: fs::metadata(path).map(|m| m.len()).unwrap_or(0),
    }
}

fn is_pdf(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

/// Header values are percent-encoded by the UI so non-ASCII paths survive.
fn header(req: &Request, key: &str) -> Option<String> {
    let raw = req.headers().get(key)?.to_str().ok()?;
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    Some(String::from_utf8_lossy(&out).into_owned()).filter(|s| !s.is_empty())
}

#[tauri::command]
async fn pick_pdfs(app: AppHandle) -> Vec<FileInfo> {
    app.dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| info(&p))
        .collect()
}

#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

/// Writes the raw request body. Header `x-path` saves to that file; otherwise a save
/// dialog opens, using `x-name`, `x-filter` and `x-ext`.
#[tauri::command]
async fn save_binary(app: AppHandle, request: Request<'_>) -> Result<Option<Saved>, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a binary body".into());
    };
    let target = match header(&request, "x-path") {
        Some(p) => PathBuf::from(p),
        None => {
            let name = header(&request, "x-name").unwrap_or_else(|| "document.pdf".into());
            let filter = header(&request, "x-filter").unwrap_or_else(|| "PDF".into());
            let ext = header(&request, "x-ext").unwrap_or_else(|| "pdf".into());
            match app
                .dialog()
                .file()
                .set_file_name(&name)
                .add_filter(&filter, &[ext.as_str()])
                .blocking_save_file()
            {
                Some(f) => f.into_path().map_err(|e| e.to_string())?,
                None => return Ok(None),
            }
        }
    };
    fs::write(&target, bytes).map_err(|e| format!("{}: {e}", target.display()))?;
    Ok(Some(Saved {
        path: target.to_string_lossy().into_owned(),
        name: file_name(&target),
    }))
}

#[tauri::command]
async fn confirm(app: AppHandle, title: String, message: String, ok_label: String, cancel_label: String) -> bool {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok_label, cancel_label))
        .blocking_show()
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let allowed = ["https://", "http://", "mailto:"].iter().any(|p| url.starts_with(p));
    if !allowed {
        return Err(format!("Refusing to open {url}"));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn print_page(window: WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

#[tauri::command]
fn initial_files(state: State<Mutex<Pending>>) -> Vec<FileInfo> {
    let mut pending = state.lock().unwrap();
    pending.ready = true;
    pending.paths.drain(..).map(|p| info(&p)).collect()
}

/// One entry of a native context menu; an entry without `id` is a separator.
#[derive(Deserialize)]
struct MenuEntry {
    id: Option<String>,
    label: Option<String>,
    enabled: Option<bool>,
    checked: Option<bool>,
    accel: Option<String>,
}

/// Shows a native (OS) context menu at the mouse position. The chosen item's id
/// reaches the UI as a "context-menu" event (see `on_menu_event` in `main`).
#[tauri::command]
fn context_menu(app: AppHandle, window: tauri::Window, items: Vec<MenuEntry>) -> Result<(), String> {
    use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
    let mut menu = MenuBuilder::new(&app);
    for entry in items {
        let Some(id) = entry.id else {
            menu = menu.separator();
            continue;
        };
        let label = entry.label.unwrap_or_default();
        let enabled = entry.enabled.unwrap_or(true);
        if let Some(checked) = entry.checked {
            let item = CheckMenuItemBuilder::with_id(id, label)
                .enabled(enabled)
                .checked(checked)
                .build(&app)
                .map_err(|e| e.to_string())?;
            menu = menu.item(&item);
            continue;
        }
        let plain = || MenuItemBuilder::with_id(id.clone(), label.clone()).enabled(enabled);
        // The shortcut is only shown as a hint; leave it out if the OS can't display it.
        let item = match entry.accel.as_deref() {
            Some(a) => plain().accelerator(a).build(&app).or_else(|_| plain().build(&app)),
            None => plain().build(&app),
        }
        .map_err(|e| e.to_string())?;
        menu = menu.item(&item);
    }
    let menu = menu.build().map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

#[tauri::command]
fn clipboard_read(app: AppHandle) -> String {
    app.clipboard().read_text().unwrap_or_default()
}

#[tauri::command]
fn clipboard_write(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}
/// The app's texts in English and German (i18n/*.json, built into the program).
#[tauri::command]
fn texts() -> serde_json::Value {
    let parse = |s: &str| serde_json::from_str::<serde_json::Value>(s).unwrap_or_default();
    serde_json::json!({"en": parse(include_str!("../i18n/en.json")), "de": parse(include_str!("../i18n/de.json"))})
}

fn main() {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).filter(|p| is_pdf(p)).collect();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_menu_event(|app, event| {
            let _ = app.emit("context-menu", event.id().as_ref());
        })
        .manage(Mutex::new(Pending { ready: false, paths: args }))
        .manage(pdfbuild::Sources::default())
        .invoke_handler(tauri::generate_handler![
            texts,
            pdfbuild::pdf_cache,
            pdfbuild::pdf_forget,
            pdfbuild::pdf_build,
            context_menu,
            clipboard_read,
            clipboard_write,
            pick_pdfs,
            read_file,
            save_binary,
            confirm,
            open_url,
            print_page,
            initial_files
        ])
        .build(tauri::generate_context!())
        .expect("error while building PDF Studio");

    app.run(|_app, _event| {
        // macOS delivers "Open with" / double-clicked files as an event instead of argv.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            use tauri::Manager;
            let paths: Vec<PathBuf> = urls.into_iter().filter_map(|u| u.to_file_path().ok()).collect();
            let state = _app.state::<Mutex<Pending>>();
            let mut pending = state.lock().unwrap();
            if pending.ready {
                let files: Vec<FileInfo> = paths.iter().map(|p| info(p)).collect();
                let _ = _app.emit("open-files", files);
            } else {
                pending.paths.extend(paths);
            }
        }
    });
}
