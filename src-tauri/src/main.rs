use tauri::{Emitter, Manager};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(target_os = "macos")]
use tauri_plugin_autostart::MacosLauncher;

#[tauri::command]
fn is_autostart_launch() -> bool {
    std::env::args().any(|arg| arg == "--autostart")
}

#[tauri::command]
fn get_click_protection() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("defaults")
            .args(["read", "com.apple.WindowManager", "EnableStandardClickToShowDesktop"])
            .output().map_err(|error| error.to_string())?;
        if !output.status.success() { return Ok(false); }
        let value = String::from_utf8_lossy(&output.stdout).trim().to_ascii_lowercase();
        return Ok(matches!(value.as_str(), "0" | "false" | "no"));
    }
    #[cfg(not(target_os = "macos"))]
    Ok(false)
}

#[tauri::command]
fn set_click_protection(enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("defaults")
            .args(["write", "com.apple.WindowManager", "EnableStandardClickToShowDesktop", "-bool", if enabled { "false" } else { "true" }])
            .status().map_err(|error| error.to_string())?;
        if !status.success() { return Err("macOS did not accept the Desktop & Dock preference".into()); }
        return Ok(enabled);
    }
    #[cfg(not(target_os = "macos"))]
    Err("This setting is available on macOS only".into())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    let autostart = tauri_plugin_autostart::Builder::new();
    #[cfg(target_os = "macos")]
    let autostart = autostart.macos_launcher(MacosLauncher::LaunchAgent);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(autostart.args(["--autostart"]).build())
        .invoke_handler(tauri::generate_handler![is_autostart_launch, get_click_protection, set_click_protection])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            if std::env::args().any(|arg| arg == "--autostart") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            let open = MenuItemBuilder::new("Open Drift").id("open").build(app)?;
            let toggle = MenuItemBuilder::new("Pause / Resume Motion").id("toggle").build(app)?;
            let stop = MenuItemBuilder::new("Stop Wallpaper").id("stop").build(app)?;
            let quit = MenuItemBuilder::new("Quit Drift").id("quit").build(app)?;
            let menu = MenuBuilder::new(app).item(&open).separator().item(&toggle).item(&stop).separator().item(&quit).build()?;
            let icon = app.default_window_icon().cloned().ok_or("Drift icon could not be loaded")?;
            TrayIconBuilder::with_id("drift")
                .icon(icon)
                .icon_as_template(true)
                .tooltip("Drift")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "toggle" => { let _ = app.emit("drift://toggle", ()); },
                    "stop" => { let _ = app.emit("drift://stop", ()); },
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Drift");
}
