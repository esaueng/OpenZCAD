use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    Emitter,
};

mod desktop_auth;

use desktop_auth::{
    cancel_desktop_sign_in, desktop_api_request, desktop_collaboration_url, poll_desktop_sign_in,
    start_desktop_sign_in, DesktopAuthState,
};

const MAX_NATIVE_FILE_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCadFile {
    name: String,
    bytes: Vec<u8>,
}

fn supported_import(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "step" | "stp" | "stl"
            )
        })
        .unwrap_or(false)
}

#[tauri::command]
async fn open_cad_file() -> Result<Option<NativeCadFile>, String> {
    let handle = rfd::AsyncFileDialog::new()
        .set_title("Open CAD model")
        .add_filter("CAD models", &["step", "stp", "stl"])
        .pick_file()
        .await;
    let Some(handle) = handle else {
        return Ok(None);
    };
    let path = handle.path();
    if !supported_import(path) {
        return Err("Choose a STEP, STP, or STL file.".to_string());
    }
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_NATIVE_FILE_BYTES {
        return Err("The selected file exceeds the 50 MB desktop safety limit.".to_string());
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "The selected file name is not valid UTF-8.".to_string())?
        .to_string();
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    Ok(Some(NativeCadFile { name, bytes }))
}

fn export_path(path: &Path, format: &str) -> Result<PathBuf, String> {
    let expected = if format == "step" {
        &["step", "stp"][..]
    } else {
        &["stl"][..]
    };
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if extension
        .as_deref()
        .map(|value| expected.contains(&value))
        .unwrap_or(false)
    {
        return Ok(path.to_path_buf());
    }
    if extension.is_none() {
        return Ok(path.with_extension(format));
    }
    Err(format!("Use a .{format} file extension."))
}

#[tauri::command]
async fn save_cad_file(
    suggested_name: String,
    format: String,
    contents: String,
) -> Result<bool, String> {
    if !matches!(format.as_str(), "step" | "stl") {
        return Err("Unsupported export format.".to_string());
    }
    if suggested_name.is_empty()
        || suggested_name.len() > 160
        || suggested_name.contains(['/', '\\', '\0'])
    {
        return Err("The suggested export name is invalid.".to_string());
    }
    if contents.len() as u64 > MAX_NATIVE_FILE_BYTES {
        return Err("The export exceeds the 50 MB desktop safety limit.".to_string());
    }
    let handle = rfd::AsyncFileDialog::new()
        .set_title(if format == "step" {
            "Export STEP"
        } else {
            "Export STL"
        })
        .set_file_name(&suggested_name)
        .add_filter(format.to_ascii_uppercase(), &[format.as_str()])
        .save_file()
        .await;
    let Some(handle) = handle else {
        return Ok(false);
    };
    let path = export_path(handle.path(), &format)?;
    std::fs::write(path, contents.as_bytes()).map_err(|error| error.to_string())?;
    Ok(true)
}

fn install_menu(app: &mut tauri::App) -> tauri::Result<()> {
    let open_model = MenuItemBuilder::with_id("open-model", "Open Model…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let save_project = MenuItemBuilder::with_id("save-project", "Save Project")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let undo = MenuItemBuilder::with_id("undo", "Undo")
        .accelerator("CmdOrCtrl+Z")
        .build(app)?;
    let redo = MenuItemBuilder::with_id("redo", "Redo")
        .accelerator("CmdOrCtrl+Shift+Z")
        .build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+Comma")
        .build(app)?;
    let quit_app = MenuItemBuilder::with_id("quit-app", "Quit OpenZCAD")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "OpenZCAD")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit_app)
        .build()?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open_model)
        .separator()
        .item(&save_project)
        .text("export-step", "Export STEP…")
        .text("export-stl", "Export STL…")
        .separator()
        .close_window()
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&undo)
        .item(&redo)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&settings)
        .separator()
        .fullscreen()
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().manage(DesktopAuthState::new());
    #[cfg(all(debug_assertions, feature = "webdriver"))]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            install_menu(app)?;
            #[cfg(all(debug_assertions, feature = "webdriver"))]
            if std::env::var_os("TAURI_WEBDRIVER_PORT").is_some() {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_title("OpenZCAD")?;
                    window.show()?;
                    window.set_focus()?;
                }
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if id == "quit-app" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
                return;
            }
            if matches!(
                id,
                "open-model"
                    | "save-project"
                    | "export-step"
                    | "export-stl"
                    | "undo"
                    | "redo"
                    | "settings"
            ) {
                let _ = app.emit("openzcad://menu", id);
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_cad_file,
            save_cad_file,
            start_desktop_sign_in,
            poll_desktop_sign_in,
            cancel_desktop_sign_in,
            desktop_api_request,
            desktop_collaboration_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenZCAD");
}

#[cfg(test)]
mod tests {
    use super::{export_path, supported_import};
    use std::path::Path;

    #[test]
    fn accepts_only_supported_import_extensions() {
        assert!(supported_import(Path::new("part.step")));
        assert!(supported_import(Path::new("part.STP")));
        assert!(supported_import(Path::new("part.stl")));
        assert!(!supported_import(Path::new("part.obj")));
    }

    #[test]
    fn appends_missing_export_extension_without_replacing_another_one() {
        assert_eq!(
            export_path(Path::new("part"), "step").unwrap(),
            Path::new("part.step")
        );
        assert!(export_path(Path::new("part.txt"), "step").is_err());
    }
}
