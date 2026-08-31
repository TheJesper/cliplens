// cliplens-daemon: cross-platform notification daemon + clip-history picker.
//
// Modes:
//   (default)   one-shot toast, backward compatible with cliplens-toast
//               cliplens-daemon --emoji X --title Y --agent Z --duration N --position P
//   --notify    send a NotifyRequest to a running daemon (JSON over local socket)
//   --watch     run the daemon: IPC server + global hotkey (Ctrl+Shift+V) + picker
//   --send-json '<json>'   low-level: send a raw Message to the daemon
//
// Design notes captured in the task list: the card must fill the whole window
// (WebView2 transparency), undecorated shadow off on Windows, click-through
// via set_ignore_cursor_events.

mod history;
mod ipc;
mod preset;
mod ui;

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use tao::{
    dpi::{LogicalPosition, LogicalSize},
    event::Event,
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{Window, WindowBuilder},
};
use wry::WebViewBuilder;

use ipc::{Message, NotifyRequest};
use preset::Resolved;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let mode = argv.get(1).map(|s| s.as_str()).unwrap_or("");

    match mode {
        "--watch" => run_daemon(),
        "--notify" => {
            let req = parse_notify_args(&argv);
            if send_message(&Message::Notify(req)).is_err() {
                // Daemon not running -- fall back to a one-shot toast so the
                // notification still shows.
                let req = parse_notify_args(&argv);
                show_toast_oneshot(req);
            }
        }
        "--ping" => {
            let ok = send_message(&Message::Ping).is_ok();
            println!("{}", if ok { "alive" } else { "down" });
            std::process::exit(if ok { 0 } else { 1 });
        }
        _ => {
            // Default: behave like the old cliplens-toast one-shot.
            let req = parse_notify_args(&argv);
            show_toast_oneshot(req);
        }
    }
}

// ----- argument parsing -------------------------------------------------

fn parse_notify_args(argv: &[String]) -> NotifyRequest {
    let mut req = NotifyRequest::default();
    let mut i = 1;
    while i < argv.len() {
        let key = argv[i].as_str();
        let val = argv.get(i + 1).cloned().unwrap_or_default();
        match key {
            "--emoji" => req.emoji = val,
            "--title" => req.title = val,
            "--subtitle" => req.subtitle = val,
            // --agent now sets the sender badge verbatim (was: "fran X-agent").
            "--agent" => req.agent = val,
            "--sound" => req.sound = val,
            "--position" => req.position = val,
            "--duration" => req.duration = val.parse().unwrap_or(2600),
            "--kind" => req.kind = val,
            "--accent" => req.accent = val,
            "--id" => req.id = val,
            "--size" => req.size = val,
            "--width" => req.width = val.parse().unwrap_or(0.0),
            "--height" => req.height = val.parse().unwrap_or(0.0),
            "--scale" => req.scale = val.parse().unwrap_or(0.0),
            "--offset" => req.offset = val,
            _ => {}
        }
        i += 2;
    }
    // If the caller left title as the built-in default but gave a kind, keep it;
    // the resolver handles emptiness. Fall back agent to CLIPLENS_AGENT env.
    if req.agent.trim().is_empty() {
        if let Ok(a) = std::env::var("CLIPLENS_AGENT") {
            req.agent = a;
        }
    }
    req
}

// ----- IPC client -------------------------------------------------------

fn send_message(msg: &Message) -> std::io::Result<()> {
    use interprocess::local_socket::{prelude::*, GenericFilePath, Stream};
    let name = ipc::socket_name();
    let name = name.as_str().to_fs_name::<GenericFilePath>()?;
    let mut conn = Stream::connect(name)?;
    let mut line = serde_json::to_string(msg).unwrap_or_default();
    line.push('\n');
    conn.write_all(line.as_bytes())?;
    conn.flush()?;
    Ok(())
}

// ----- daemon -----------------------------------------------------------

/// Commands the event loop reacts to, delivered from background threads.
enum LoopCmd {
    Notify(NotifyRequest),
    ShowPicker,
    DismissPicker,
    CommitPicker,
}

fn run_daemon() {
    use global_hotkey::{
        hotkey::{Code, HotKey, Modifiers},
        GlobalHotKeyEvent, GlobalHotKeyManager,
    };
    use interprocess::local_socket::{
        prelude::*, GenericFilePath, ListenerOptions,
    };

    let event_loop = EventLoopBuilder::<LoopCmd>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    // --- global hotkey for the picker ---
    // The § / ½ key on a Nordic layout does not map to a single portable
    // `Code`. Different layouts surface it as Backquote, IntlBackslash, or
    // Quote, so register several candidates and treat any of them as "open
    // picker". Also register Ctrl+Shift+V as a layout-independent fallback.
    let hotkey_mgr = GlobalHotKeyManager::new().expect("hotkey manager");
    let candidates = [
        HotKey::new(Some(Modifiers::CONTROL), Code::Backquote),
        HotKey::new(Some(Modifiers::CONTROL), Code::IntlBackslash),
        HotKey::new(Some(Modifiers::CONTROL), Code::Quote),
        HotKey::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyV),
    ];
    let mut hk_ids = Vec::new();
    for hk in candidates {
        if hotkey_mgr.register(hk).is_ok() {
            hk_ids.push(hk.id());
        }
    }
    // Escape / Enter are grabbed ONLY while the picker is open (registered on
    // open, unregistered on close) so they never interfere with normal typing.
    let esc_hotkey = HotKey::new(None, Code::Escape);
    let enter_hotkey = HotKey::new(None, Code::Enter);
    let esc_id = esc_hotkey.id();
    let enter_id = enter_hotkey.id();
    let hk_proxy = proxy.clone();
    std::thread::spawn(move || {
        let rx = GlobalHotKeyEvent::receiver();
        loop {
            if let Ok(ev) = rx.recv() {
                if ev.state != global_hotkey::HotKeyState::Pressed {
                    continue;
                }
                if ev.id == esc_id {
                    let _ = hk_proxy.send_event(LoopCmd::DismissPicker);
                } else if ev.id == enter_id {
                    let _ = hk_proxy.send_event(LoopCmd::CommitPicker);
                } else if hk_ids.contains(&ev.id) {
                    let _ = hk_proxy.send_event(LoopCmd::ShowPicker);
                }
            }
        }
    });

    // --- IPC listener thread ---
    let ipc_proxy = proxy.clone();
    std::thread::spawn(move || {
        let name = ipc::socket_name();
        // Best-effort cleanup of a stale unix socket path.
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&name);
        }
        let fs_name = match name.as_str().to_fs_name::<GenericFilePath>() {
            Ok(n) => n,
            Err(_) => return,
        };
        let listener = match ListenerOptions::new().name(fs_name).create_sync() {
            Ok(l) => l,
            Err(_) => return,
        };
        for conn in listener.incoming().flatten() {
            let mut conn = conn;
            let mut buf = String::new();
            if conn.read_to_string(&mut buf).is_ok() {
                for line in buf.lines() {
                    if line.trim().is_empty() {
                        continue;
                    }
                    if let Ok(msg) = serde_json::from_str::<Message>(line) {
                        match msg {
                            Message::Notify(req) => {
                                let _ = ipc_proxy.send_event(LoopCmd::Notify(req));
                            }
                            Message::ShowPicker => {
                                let _ = ipc_proxy.send_event(LoopCmd::ShowPicker);
                            }
                            Message::Ping => {}
                        }
                    }
                }
            }
        }
    });

    // --- window state: a queue of active toasts (kombo) + optional picker ---
    let mut active: Vec<ActiveToast> = Vec::new();
    let mut picker: Option<Picker> = None;

    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(60));

        match event {
            Event::UserEvent(LoopCmd::Notify(req)) => {
                // Resolve the effective sound (explicit wins, else kind default,
                // else silent). Visual-first: empty/off => no sound.
                let sound = effective_sound(&req);
                play_sound(&sound);

                // Update-in-place: if this notify carries an id that matches a
                // live toast, morph it (new content + reset timer) instead of
                // stacking a second card.
                let mut handled = false;
                if !req.id.trim().is_empty() {
                    if let Some(t) = active.iter_mut().find(|t| t.id == req.id) {
                        t.update(&req);
                        handled = true;
                    }
                }
                if !handled {
                    if let Some(t) = ActiveToast::spawn(target, &req, active.len()) {
                        active.push(t);
                    }
                }
            }
            Event::UserEvent(LoopCmd::ShowPicker) => {
                if let Some(p) = &mut picker {
                    // Toggle/cycle to next entry.
                    p.cycle();
                } else if let Some(p) = Picker::spawn(target) {
                    // Grab Escape/Enter only while the picker is open so they
                    // dismiss/commit instead of leaking to the app behind.
                    let _ = hotkey_mgr.register(esc_hotkey);
                    let _ = hotkey_mgr.register(enter_hotkey);
                    picker = Some(p);
                }
            }
            Event::UserEvent(LoopCmd::DismissPicker) => {
                if let Some(p) = &picker {
                    p.close();
                    let _ = hotkey_mgr.unregister(esc_hotkey);
                    let _ = hotkey_mgr.unregister(enter_hotkey);
                    picker = None;
                }
            }
            Event::UserEvent(LoopCmd::CommitPicker) => {
                if let Some(p) = &picker {
                    p.commit();
                    let _ = hotkey_mgr.unregister(esc_hotkey);
                    let _ = hotkey_mgr.unregister(enter_hotkey);
                    picker = None;
                }
            }
            _ => {}
        }

        // Expire finished toasts.
        active.retain(|t| t.start.elapsed() < t.duration);

        // Picker timeout -> commit selection, and release Escape/Enter grabs.
        if let Some(p) = &mut picker {
            if p.should_commit() {
                p.commit();
                let _ = hotkey_mgr.unregister(esc_hotkey);
                let _ = hotkey_mgr.unregister(enter_hotkey);
                picker = None;
            }
        }
    });
}

// ----- active toast (daemon) --------------------------------------------

struct ActiveToast {
    _window: Window,
    webview: wry::WebView,
    start: Instant,
    duration: Duration,
    id: String,
}

/// Build the resolved view, scaled window box, and HTML for a request.
fn render_request(req: &NotifyRequest) -> (Resolved, f64, f64, f64, String) {
    let resolved = preset::resolve_kind(&req.kind, &req.emoji, &req.accent, req.duration);
    let (w, h, scale) = preset::resolve_box(&req.size, &req.kind, req.width, req.height, req.scale);
    let title = if req.title.is_empty() { "" } else { req.title.as_str() };
    let view = ui::ToastView {
        resolved: &resolved,
        title,
        subtitle: &req.subtitle,
        agent: &req.agent,
        scale,
    };
    let html = ui::toast_html(&view);
    (resolved, w, h, scale, html)
}

impl ActiveToast {
    fn spawn<T: 'static>(
        target: &tao::event_loop::EventLoopWindowTarget<T>,
        req: &NotifyRequest,
        stack_index: usize,
    ) -> Option<Self> {
        let (resolved, win_w, win_h, _scale, html) = render_request(req);
        let window = build_window(target, win_w, win_h, false)?;
        position_window(&window, &req.position, win_w, win_h, stack_index, &req.offset);

        let webview = WebViewBuilder::new(&window)
            .with_transparent(true)
            .with_html(html)
            .build()
            .ok()?;

        let _ = window.set_ignore_cursor_events(true);
        window.set_visible(true);

        Some(ActiveToast {
            _window: window,
            webview,
            start: Instant::now(),
            duration: Duration::from_millis(resolved.duration),
            id: req.id.clone(),
        })
    }

    /// Morph an existing card in place: reload HTML + reset the expiry timer.
    /// Used for progress -> progress -> success flows sharing one id.
    fn update(&mut self, req: &NotifyRequest) {
        let (resolved, _w, _h, _scale, html) = render_request(req);
        let _ = self.webview.load_html(&html);
        self.start = Instant::now();
        self.duration = Duration::from_millis(resolved.duration);
    }
}

// ----- picker (daemon) --------------------------------------------------

struct Picker {
    window: Window,
    webview: wry::WebView,
    entries: Vec<history::ClipEntry>,
    selected: usize,
    last_interaction: Instant,
}

impl Picker {
    fn spawn<T: 'static>(
        target: &tao::event_loop::EventLoopWindowTarget<T>,
    ) -> Option<Self> {
        let entries = history::read_history();
        let rows = entries.len().max(1) as f64;
        let (win_w, win_h) = (520.0_f64, 70.0 + rows * 50.0);
        let window = build_window(target, win_w, win_h, true)?;
        position_window(&window, "center", win_w, win_h, 0, "");

        let html = ui::picker_html(&entries, 0);
        let webview = WebViewBuilder::new(&window)
            .with_transparent(true)
            .with_html(html)
            .build()
            .ok()?;

        // Picker is interactive-ish but we drive selection via hotkey; keep it
        // click-through so it never traps the user.
        let _ = window.set_ignore_cursor_events(true);
        window.set_visible(true);

        Some(Picker {
            window,
            webview,
            entries,
            selected: 0,
            last_interaction: Instant::now(),
        })
    }

    fn cycle(&mut self) {
        if self.entries.is_empty() {
            return;
        }
        self.selected = (self.selected + 1) % self.entries.len();
        self.last_interaction = Instant::now();
        let html = ui::picker_html(&self.entries, self.selected);
        // Re-render by loading fresh HTML.
        let _ = self.webview.load_html(&html);
    }

    /// Commit after ~900ms of no further cycling.
    fn should_commit(&self) -> bool {
        !self.entries.is_empty()
            && self.last_interaction.elapsed() > Duration::from_millis(900)
    }

    fn commit(&self) {
        if let Some(entry) = self.entries.get(self.selected) {
            if let Ok(mut cb) = arboard::Clipboard::new() {
                let _ = cb.set_text(entry.text.clone());
            }
        }
        let _ = self.window.set_visible(false);
    }

    /// Dismiss without changing the clipboard.
    fn close(&self) {
        let _ = self.window.set_visible(false);
    }
}

// ----- shared window helpers --------------------------------------------

fn build_window<T: 'static>(
    target: &tao::event_loop::EventLoopWindowTarget<T>,
    w: f64,
    h: f64,
    _interactive: bool,
) -> Option<Window> {
    let builder = WindowBuilder::new()
        .with_decorations(false)
        .with_transparent(true)
        .with_always_on_top(true)
        .with_resizable(false)
        .with_visible(false)
        .with_inner_size(LogicalSize::new(w, h));

    #[cfg(target_os = "windows")]
    let builder = {
        use tao::platform::windows::WindowBuilderExtWindows;
        builder.with_undecorated_shadow(false).with_skip_taskbar(true)
    };

    builder.build(target).ok()
}

fn position_window(
    window: &Window,
    position: &str,
    w: f64,
    h: f64,
    stack_index: usize,
    offset: &str,
) {
    // Determine the target monitor's work area. Prefer the monitor under the
    // mouse cursor (the "current" screen the user is looking at), falling back
    // to the window's current monitor.
    let (mon_x, mon_y, mon_w, mon_h) = match cursor_monitor_area(window) {
        Some(area) => area,
        None => match window.current_monitor() {
            Some(monitor) => {
                let scale = monitor.scale_factor();
                let pos = monitor.position().to_logical::<f64>(scale);
                let size = monitor.size().to_logical::<f64>(scale);
                (pos.x, pos.y, size.width, size.height)
            }
            None => (0.0, 0.0, 1920.0, 1080.0),
        },
    };

    let gap = 12.0;
    let margin = 24.0;
    let stack_offset = stack_index as f64 * (h + gap);
    let (dx, dy) = preset::parse_offset(offset);

    // Horizontal anchor.
    let x = match position {
        "top-left" | "bottom-left" => mon_x + margin,
        "top-right" | "bottom-right" => mon_x + mon_w - w - margin,
        _ => mon_x + (mon_w - w) / 2.0, // bottom, center, top-right handled below
    };
    // top-right keeps its historical right-edge placement.
    let x = if position == "top-right" {
        mon_x + mon_w - w - margin
    } else {
        x
    };

    // Vertical anchor. Bottom anchors stack upward; top anchors stack downward.
    let y = match position {
        "center" => mon_y + (mon_h - h) / 2.0,
        "top-left" | "top-right" => mon_y + margin + stack_offset,
        "bottom-left" | "bottom-right" => mon_y + mon_h - h - margin - stack_offset,
        _ => mon_y + mon_h * 0.82 - h / 2.0 - stack_offset, // "bottom" (default)
    };

    window.set_outer_position(LogicalPosition::new(x + dx, y + dy));
}

/// Work area (logical coords: x, y, width, height) of the monitor under the
/// mouse cursor. Windows-only; returns None elsewhere so callers fall back.
#[cfg(target_os = "windows")]
fn cursor_monitor_area(window: &Window) -> Option<(f64, f64, f64, f64)> {
    use std::os::raw::{c_long, c_void};

    #[repr(C)]
    struct Point {
        x: c_long,
        y: c_long,
    }
    #[repr(C)]
    struct Rect {
        left: c_long,
        top: c_long,
        right: c_long,
        bottom: c_long,
    }
    #[repr(C)]
    struct MonitorInfo {
        cb_size: u32,
        rc_monitor: Rect,
        rc_work: Rect,
        dw_flags: u32,
    }

    const MONITOR_DEFAULTTONEAREST: u32 = 2;

    #[link(name = "user32")]
    extern "system" {
        fn GetCursorPos(p: *mut Point) -> i32;
        fn MonitorFromPoint(p: Point, flags: u32) -> *mut c_void;
        fn GetMonitorInfoW(hmon: *mut c_void, info: *mut MonitorInfo) -> i32;
    }

    unsafe {
        let mut pt = Point { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return None;
        }
        let hmon = MonitorFromPoint(
            Point { x: pt.x, y: pt.y },
            MONITOR_DEFAULTTONEAREST,
        );
        if hmon.is_null() {
            return None;
        }
        let mut mi = MonitorInfo {
            cb_size: std::mem::size_of::<MonitorInfo>() as u32,
            rc_monitor: Rect { left: 0, top: 0, right: 0, bottom: 0 },
            rc_work: Rect { left: 0, top: 0, right: 0, bottom: 0 },
            dw_flags: 0,
        };
        if GetMonitorInfoW(hmon, &mut mi) == 0 {
            return None;
        }
        // Convert physical pixels to logical using the window's scale factor.
        let scale = window.scale_factor();
        let work = &mi.rc_work;
        let x = work.left as f64 / scale;
        let y = work.top as f64 / scale;
        let w = (work.right - work.left) as f64 / scale;
        let h = (work.bottom - work.top) as f64 / scale;
        Some((x, y, w, h))
    }
}

#[cfg(not(target_os = "windows"))]
fn cursor_monitor_area(_window: &Window) -> Option<(f64, f64, f64, f64)> {
    None
}

// ----- sound ------------------------------------------------------------

/// Resolve the sound to actually play: explicit `sound` wins; if empty, use the
/// kind's default sound; "off" or empty result => silence (visual-first).
fn effective_sound(req: &NotifyRequest) -> String {
    let s = req.sound.trim();
    if s == "off" {
        return String::new();
    }
    if !s.is_empty() {
        return s.to_string();
    }
    // Empty => fall back to the kind's default (may itself be empty).
    let resolved = preset::resolve_kind(&req.kind, "", "", 0);
    resolved.default_sound
}

/// Play a named or file-path sound. Best-effort, never blocks the loop for long.
fn play_sound(sound: &str) {
    if sound.is_empty() || sound == "off" {
        return;
    }
    // Resolve named sounds to bundled files next to the binary: sounds/<name>.wav
    let path = if sound.ends_with(".wav") || sound.ends_with(".mp3") {
        std::path::PathBuf::from(sound)
    } else if let Ok(exe) = std::env::current_exe() {
        exe.parent()
            .map(|d| d.join("sounds").join(format!("{}.wav", sound)))
            .unwrap_or_default()
    } else {
        return;
    };
    if !path.exists() {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        // Use PowerShell's SoundPlayer for WAV (no extra deps).
        let p = path.to_string_lossy().replace('\'', "''");
        let script = format!("(New-Object Media.SoundPlayer '{}').PlaySync();", p);
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("afplay").arg(&path).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("paplay").arg(&path).spawn();
    }
}

// ----- one-shot toast (default mode, no daemon) -------------------------

fn show_toast_oneshot(req: NotifyRequest) {
    let event_loop = EventLoopBuilder::<()>::with_user_event().build();

    let (resolved, win_w, win_h, _scale, html) = render_request(&req);
    let window = match build_window(&event_loop, win_w, win_h, false) {
        Some(w) => w,
        None => return,
    };
    position_window(&window, &req.position, win_w, win_h, 0, &req.offset);

    let _webview = WebViewBuilder::new(&window)
        .with_transparent(true)
        .with_html(html)
        .build();
    let _webview = match _webview {
        Ok(w) => w,
        Err(_) => return,
    };
    let _ = window.set_ignore_cursor_events(true);
    window.set_visible(true);

    play_sound(&effective_sound(&req));

    let start = Instant::now();
    let total = Duration::from_millis(resolved.duration);
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(80));
        let _ = &event;
        if start.elapsed() >= total {
            *control_flow = ControlFlow::Exit;
        }
    });
}
