use std::io::{Read, Write};
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

#[tauri::command]
async fn get_monitors(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    #[cfg(target_os = "macos")]
    let native_names: Vec<String> = {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let scheduled = app.run_on_main_thread(move || {
            let names = objc2::MainThreadMarker::new()
                .map(|marker| objc2_app_kit::NSScreen::screens(marker).iter().map(|screen| screen.localizedName().to_string()).collect())
                .unwrap_or_default();
            let _ = sender.send(names);
        });
        if scheduled.is_ok() { receiver.await.unwrap_or_default() } else { Vec::new() }
    };
    #[cfg(not(target_os = "macos"))]
    let native_names: Vec<String> = Vec::new();

    let Some(window) = app.get_webview_window("main") else { return Vec::new(); };
    let Ok(monitors) = window.available_monitors() else { return Vec::new(); };
    let primary_index = monitors.iter().enumerate().min_by_key(|(_, monitor)| {
        let position = monitor.position();
        (position.x.abs() as i64) + (position.y.abs() as i64)
    }).map(|(index, _)| index).unwrap_or(0);

    monitors.iter().enumerate().map(|(index, monitor)| {
        let size = monitor.size();
        let position = monitor.position();
        let scale = monitor.scale_factor();
        let hardware_name = native_names.get(index).cloned().or_else(|| monitor.name().cloned().filter(|name| !name.trim().is_empty()));
        let name = hardware_name.clone().unwrap_or_else(|| if index == primary_index { "Built-in / Primary Display".into() } else { format!("External Display {}", index + 1) });
        serde_json::json!({
            "name": name,
            "deviceName": hardware_name,
            "isPrimary": index == primary_index,
            "index": index,
            "size": { "width": (size.width as f64 / scale).round() as u32, "height": (size.height as f64 / scale).round() as u32 },
            "position": { "x": (position.x as f64 / scale).round() as i32, "y": (position.y as f64 / scale).round() as i32 },
            "scaleFactor": scale,
            "dimensionsAreLogical": true
        })
    }).collect()
}

fn toggle_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

fn main() {
    let single_instance_listener = match std::net::TcpListener::bind("127.0.0.1:49682") {
        Ok(listener) => listener,
        Err(_) => {
            if let Ok(mut stream) = std::net::TcpStream::connect("127.0.0.1:49682") {
                let _ = stream.write_all(b"open");
            }
            return;
        }
    };
    let autostart = tauri_plugin_autostart::Builder::new();
    #[cfg(target_os = "macos")]
    let autostart = autostart.macos_launcher(MacosLauncher::LaunchAgent);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(autostart.args(["--autostart"]).build())
        .invoke_handler(tauri::generate_handler![is_autostart_launch, get_click_protection, set_click_protection, get_monitors])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            if std::env::args().any(|arg| arg == "--autostart") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            let instance_listener = single_instance_listener.try_clone()?;
            std::thread::spawn(move || {
                for connection in instance_listener.incoming() {
                    if let Ok(mut stream) = connection {
                        let mut message = [0_u8; 8];
                        let _ = stream.read(&mut message);
                    }
                }
            });

            let open = MenuItemBuilder::new("Show / Hide Drift").id("open").build(app)?;
            let toggle = MenuItemBuilder::new("Pause / Resume Motion").id("toggle").build(app)?;
            let stop = MenuItemBuilder::new("Stop Wallpaper").id("stop").build(app)?;
            let quit = MenuItemBuilder::new("Quit Drift").id("quit").build(app)?;
            let menu = MenuBuilder::new(app).item(&open).separator().item(&toggle).item(&stop).separator().item(&quit).build()?;
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;
            TrayIconBuilder::with_id("drift")
                .icon(icon)
                .icon_as_template(true)
                .tooltip("Drift")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        toggle_main(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => toggle_main(app),
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
