// On Windows release builds, run as a GUI subsystem app so no console window
// flashes up when the one-shot toast binary is spawned per notify. Debug keeps
// the console for troubleshooting; no-op on macOS/Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// cliplens-daemon: cross-platform notification daemon + clip-history picker.
//
// Modes:
//   (default)   one-shot toast, backward compatible with cliplens-toast
//               cliplens-daemon --emoji X --title Y --agent Z --duration N --position P
//   --notify    send a NotifyRequest to a running daemon (JSON over local socket)
//   --watch     run the daemon: IPC server + global hotkey (Shift+Alt+V, configurable) + picker
//   --send-json '<json>'   low-level: send a raw Message to the daemon
//
// Design notes captured in the task list: the card must fill the whole window
// (WebView2 transparency), undecorated shadow off on Windows, click-through
// via set_ignore_cursor_events.

mod history;
mod ipc;
mod preset;
mod reminder;
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

use ipc::{Message, NotifyRequest, RemindRequest};
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
        "--remind" => run_remind_cli(&argv),
        "--remind-cancel" => run_remind_cancel_cli(argv.get(2).cloned().unwrap_or_default()),
        "--reminders" => println!(
            "{}",
            std::fs::read_to_string(reminder::default_path()).unwrap_or_else(|_| "{\"items\":[]}".to_string())
        ),
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
        // Mode flags carry no value. Without this skip, `--notify` swallowed `--title` as its
        // "value" and every later pair was shifted by one -> ALL args silently ignored
        // (default "ClipLens" card at the bottom, no type/agent/position).
        if matches!(key, "--notify" | "--watch" | "--ping") {
            i += 1;
            continue;
        }
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
            "--type" | "--format" => req.format = val,
            "--id" => req.id = val,
            "--size" => req.size = val,
            "--width" => req.width = val.parse().unwrap_or(0.0),
            "--height" => req.height = val.parse().unwrap_or(0.0),
            "--scale" => req.scale = val.parse().unwrap_or(0.0),
            "--offset" => req.offset = val,
            "--keys" => req.keys = val,
            // Flag without a value: stay until clicked / clicked outside.
            "--sticky" => {
                req.sticky = true;
                i += 1;
                continue;
            }
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
    // `notify` kind is sticky by default (a standing notice waits for a click). An explicit
    // --sticky already set it true; this only fills the default when the caller didn't say.
    if !req.sticky && preset::kind_wants_sticky(&req.kind) {
        req.sticky = true;
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
    /// Move the picker selection up / down one row (arrow keys).
    PickerPrev,
    PickerNext,
    /// User clicked a toast card -> dismiss that one (by its internal token).
    DismissToast(u64),
    /// A button/checkbox on a reminder card: (token, "done" | "snooze:5|30|tomorrow").
    ToastAction(u64, String),
    Remind(RemindRequest),
    RemindCancel(String),
}

/// Hard limits: a flood of notifications/reminders or connections must not exhaust memory/windows.
const MAX_ACTIVE: usize = 6;
const MAX_REMINDER_CARDS: usize = 4;
const MAX_CONNS: usize = 16;
const MAX_MSG_BYTES: u64 = 64 * 1024;

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
        // Cross-platform default: Shift+Alt+V (Shift+Option+V on macOS) — global, and free of the
        // Ctrl+Shift+V "paste without formatting" clash.
        HotKey::new(Some(Modifiers::SHIFT | Modifiers::ALT), Code::KeyV),
        // Nordic § / ½ key candidates (layout-specific).
        HotKey::new(Some(Modifiers::CONTROL), Code::Backquote),
        HotKey::new(Some(Modifiers::CONTROL), Code::IntlBackslash),
        HotKey::new(Some(Modifiers::CONTROL), Code::Quote),
        // NOTE: Ctrl+Shift+V is deliberately NOT registered — on Windows and in
        // most apps it is the built-in "paste without formatting" shortcut, so
        // grabbing it globally would both clash and defeat ClipLens's rich pens.
    ];
    let mut hk_ids = Vec::new();
    for hk in candidates {
        if hotkey_mgr.register(hk).is_ok() {
            hk_ids.push(hk.id());
        }
    }
    // Escape / Enter / Arrows are grabbed ONLY while the picker is open
    // (registered on open, unregistered on close) so they never interfere with
    // normal typing.
    let esc_hotkey = HotKey::new(None, Code::Escape);
    let enter_hotkey = HotKey::new(None, Code::Enter);
    let up_hotkey = HotKey::new(None, Code::ArrowUp);
    let down_hotkey = HotKey::new(None, Code::ArrowDown);
    let esc_id = esc_hotkey.id();
    let enter_id = enter_hotkey.id();
    let up_id = up_hotkey.id();
    let down_id = down_hotkey.id();
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
                } else if ev.id == up_id {
                    let _ = hk_proxy.send_event(LoopCmd::PickerPrev);
                } else if ev.id == down_id {
                    let _ = hk_proxy.send_event(LoopCmd::PickerNext);
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
        // One short-lived thread per connection, each bounded in size, and a cap on concurrent
        // connections: a stalled or hostile client can no longer block every other sender.
        let live = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        for conn in listener.incoming().flatten() {
            use std::sync::atomic::Ordering::Relaxed;
            if live.load(Relaxed) >= MAX_CONNS {
                drop(conn);
                continue;
            }
            live.fetch_add(1, Relaxed);
            let ipc_proxy = ipc_proxy.clone();
            let live = live.clone();
            std::thread::spawn(move || {
            let mut conn = conn;
            let mut buf = String::new();
            if (&mut conn).take(MAX_MSG_BYTES).read_to_string(&mut buf).is_ok() {
                for line in buf.lines() {
                    if line.trim().is_empty() {
                        continue;
                    }
                    if let Ok(msg) = serde_json::from_str::<Message>(line) {
                        match msg {
                            Message::Notify(req) => {
                                let _ = ipc_proxy.send_event(LoopCmd::Notify(req));
                            }
                            // Opening the picker over IPC would let any local process grab Esc/Enter
                            // system-wide and trigger a clipboard overwrite: hotkey only.
                            Message::ShowPicker => {}
                            Message::Ping => {}
                            Message::Remind(r) => {
                                let _ = ipc_proxy.send_event(LoopCmd::Remind(r));
                            }
                            Message::RemindCancel { id } => {
                                let _ = ipc_proxy.send_event(LoopCmd::RemindCancel(id));
                            }
                        }
                    }
                }
            }
            live.fetch_sub(1, Relaxed);
            });
        }
    });

    // --- window state: a queue of active toasts (kombo) + optional picker ---
    let mut active: Vec<ActiveToast> = Vec::new();
    let mut picker: Option<Picker> = None;
    // Monotonic token per toast so a click on a card dismisses exactly that one.
    let mut next_token: u64 = 0;
    let toast_proxy = event_loop.create_proxy();
    // Reminders: the daemon is the only writer while it runs.
    let mut store = reminder::Store::open(&reminder::default_path());
    let mut last_due_check = Instant::now() - Duration::from_secs(10);
    let mut prev_mouse_down = false;

    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(60));

        match event {
            Event::UserEvent(LoopCmd::Notify(req)) => {
                // Flood guard: at the cap, drop the oldest plain toast; reminders are never evicted.
                if active.len() >= MAX_ACTIVE {
                    match active.iter().position(|t| t.reminder_id.is_none()) {
                        Some(i) => {
                            active.remove(i);
                        }
                        None => return,
                    }
                }
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
                    let token = next_token;
                    next_token = next_token.wrapping_add(1);
                    if let Some(t) =
                        ActiveToast::spawn(target, &req, active.len(), token, toast_proxy.clone())
                    {
                        active.push(t);
                    }
                }
            }
            Event::UserEvent(LoopCmd::DismissToast(token)) => {
                // Reminder cards are never dismissed by a plain click: only their controls act.
                active.retain(|t| t.token != token || t.reminder_id.is_some());
            }
            Event::UserEvent(LoopCmd::Remind(req)) => {
                let now = reminder::now_ms();
                if let Ok(id) = reminder::apply_remind(&mut store, req, now) {
                    let _ = store.save();
                    // Rescheduled while showing: drop the old card; the due check re-shows it.
                    active.retain(|t| t.reminder_id.as_deref() != Some(id.as_str()));
                    last_due_check = Instant::now() - Duration::from_secs(10);
                }
            }
            Event::UserEvent(LoopCmd::RemindCancel(id)) => {
                if store.cancel(&id) {
                    let _ = store.save();
                }
                active.retain(|t| t.reminder_id.as_deref() != Some(id.as_str()));
            }
            Event::UserEvent(LoopCmd::ToastAction(token, body)) => {
                let now = reminder::now_ms();
                if let Some(pos) = active.iter().position(|t| t.token == token) {
                    if let Some(id) = active[pos].reminder_id.clone() {
                        if body == "done" {
                            store.complete(&id, now);
                            let _ = store.save();
                            active.remove(pos);
                        } else if let Some(sn) = body.strip_prefix("snooze:").and_then(reminder::Snooze::parse) {
                            let due = reminder::snooze_due(sn, now, reminder::local_utc_offset_s());
                            store.snooze(&id, due);
                            let _ = store.save();
                            active.remove(pos);
                        }
                    }
                }
            }
            Event::UserEvent(LoopCmd::ShowPicker) => {
                if let Some(p) = &mut picker {
                    // Re-trigger of the open hotkey moves down one row (wrap).
                    p.next();
                } else if let Some(p) = Picker::spawn(target) {
                    // Grab Escape/Enter/Arrows only while the picker is open so
                    // they navigate/commit instead of leaking to the app behind.
                    let _ = hotkey_mgr.register(esc_hotkey);
                    let _ = hotkey_mgr.register(enter_hotkey);
                    let _ = hotkey_mgr.register(up_hotkey);
                    let _ = hotkey_mgr.register(down_hotkey);
                    picker = Some(p);
                }
            }
            Event::UserEvent(LoopCmd::PickerNext) => {
                if let Some(p) = &mut picker {
                    p.next();
                }
            }
            Event::UserEvent(LoopCmd::PickerPrev) => {
                if let Some(p) = &mut picker {
                    p.prev();
                }
            }
            Event::UserEvent(LoopCmd::DismissPicker) => {
                if let Some(p) = &picker {
                    p.close();
                    let _ = hotkey_mgr.unregister(esc_hotkey);
                    let _ = hotkey_mgr.unregister(enter_hotkey);
                    let _ = hotkey_mgr.unregister(up_hotkey);
                    let _ = hotkey_mgr.unregister(down_hotkey);
                    picker = None;
                }
            }
            Event::UserEvent(LoopCmd::CommitPicker) => {
                if let Some(p) = &picker {
                    p.commit();
                    let _ = hotkey_mgr.unregister(esc_hotkey);
                    let _ = hotkey_mgr.unregister(enter_hotkey);
                    let _ = hotkey_mgr.unregister(up_hotkey);
                    let _ = hotkey_mgr.unregister(down_hotkey);
                    picker = None;
                }
            }
            _ => {}
        }

        // Expire finished toasts. Reminders never expire; sticky cards have a 15 min hard cap.
        active.retain(|t| {
            if t.reminder_id.is_some() {
                true
            } else if t.sticky {
                t.start.elapsed() < Duration::from_secs(900)
            } else {
                t.start.elapsed() < t.duration
            }
        });

        // Show reminders that have come due.
        if last_due_check.elapsed() >= Duration::from_millis(500) {
            last_due_check = Instant::now();
            let now = reminder::now_ms();
            for id in store.due(now) {
                if active.iter().filter(|t| t.reminder_id.is_some()).count() >= MAX_REMINDER_CARDS {
                    break; // the rest stay due and appear as cards are cleared
                }
                if active.iter().any(|t| t.reminder_id.as_deref() == Some(id.as_str())) {
                    continue;
                }
                if let Some(r) = store.get(&id).cloned() {
                    let token = next_token;
                    next_token = next_token.wrapping_add(1);
                    if let Some(t) = ActiveToast::spawn_reminder(target, &r, active.len(), token, toast_proxy.clone()) {
                        active.push(t);
                    }
                }
            }
            // Forget completed reminders after a week.
            let before = store.items.len();
            store.prune(now);
            if store.items.len() != before {
                let _ = store.save();
            }
        }

        // Click anywhere outside the cards: reminders snooze 30 min (never vanish), sticky
        // notices close. A click inside ANY card is not "outside" for the others.
        let down = left_mouse_down();
        let rising = down && !prev_mouse_down;
        prev_mouse_down = down;
        if rising && !active.iter().any(|t| cursor_inside(&t._window)) {
            let now = reminder::now_ms();
            let mut closed: Vec<u64> = Vec::new();
            for t in active.iter() {
                if t.start.elapsed() < Duration::from_millis(600) {
                    continue; // the click that summoned it
                }
                if let Some(id) = &t.reminder_id {
                    let due = reminder::snooze_due(reminder::Snooze::Min30, now, 0);
                    store.snooze(id, due);
                    closed.push(t.token);
                } else if t.sticky {
                    closed.push(t.token);
                }
            }
            if !closed.is_empty() {
                let _ = store.save();
                active.retain(|t| !closed.contains(&t.token));
            }
        }

        // Picker timeout -> commit selection, and release the key grabs.
        if let Some(p) = &mut picker {
            if p.should_commit() {
                p.commit();
                let _ = hotkey_mgr.unregister(esc_hotkey);
                let _ = hotkey_mgr.unregister(enter_hotkey);
                let _ = hotkey_mgr.unregister(up_hotkey);
                let _ = hotkey_mgr.unregister(down_hotkey);
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
    token: u64,
    /// Some(..) for reminder cards (checkbox + snooze).
    reminder_id: Option<String>,
    sticky: bool,
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
        type_label: &req.format,
        keys: &req.keys,
        scale,
    };
    let html = ui::toast_html(&view);
    (resolved, w, h, scale, html)
}

impl ActiveToast {
    fn spawn(
        target: &tao::event_loop::EventLoopWindowTarget<LoopCmd>,
        req: &NotifyRequest,
        stack_index: usize,
        token: u64,
        proxy: tao::event_loop::EventLoopProxy<LoopCmd>,
    ) -> Option<Self> {
        let (resolved, win_w, win_h, _scale, html) = render_request(req);
        let window = build_window(target, win_w, win_h, true)?;
        position_window(&window, &req.position, win_w, win_h, stack_index, &req.offset);

        // Any IPC message from the card (its onclick) dismisses this toast.
        let webview = WebViewBuilder::new(&window)
            .with_transparent(true)
            .with_html(html)
            .with_ipc_handler(move |_req| {
                let _ = proxy.send_event(LoopCmd::DismissToast(token));
            })
            .build()
            .ok()?;

        // Interactive (not click-through) so a click can dismiss the card.
        window.set_visible(true);

        Some(ActiveToast {
            _window: window,
            webview,
            start: Instant::now(),
            duration: Duration::from_millis(resolved.duration),
            id: req.id.clone(),
            token,
            reminder_id: None,
            sticky: req.sticky,
        })
    }

    /// A reminder card: checkbox + snooze buttons. Never auto-closes.
    fn spawn_reminder(
        target: &tao::event_loop::EventLoopWindowTarget<LoopCmd>,
        r: &reminder::Reminder,
        stack_index: usize,
        token: u64,
        proxy: tao::event_loop::EventLoopProxy<LoopCmd>,
    ) -> Option<Self> {
        let (w, h) = (480.0, 132.0);
        let note = if r.snoozes > 0 { format!("snoozad {}x", r.snoozes) } else { String::new() };
        let html = ui::reminder_html(&ui::ReminderView {
            title: &r.title,
            subtitle: &r.subtitle,
            agent: &r.agent,
            note: &note,
            scale: 1.0,
        });
        let window = build_window(target, w, h, true)?;
        position_window(&window, reminder::position_or_default(&r.position), w, h, stack_index, "");
        let webview = WebViewBuilder::new(&window)
            .with_transparent(true)
            .with_html(html)
            .with_ipc_handler(move |req| {
                let _ = proxy.send_event(LoopCmd::ToastAction(token, req.body().to_string()));
            })
            .build()
            .ok()?;
        window.set_visible(true);
        Some(ActiveToast {
            _window: window,
            webview,
            start: Instant::now(),
            duration: Duration::from_secs(0),
            id: String::new(),
            token,
            reminder_id: Some(r.id.clone()),
            sticky: true,
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

    fn next(&mut self) {
        if self.entries.is_empty() {
            return;
        }
        self.selected = (self.selected + 1) % self.entries.len();
        self.last_interaction = Instant::now();
        // Move the highlight in-place via JS — reloading the whole document
        // flashed the window on every keypress.
        let _ = self.webview.evaluate_script(&format!("window.sel({})", self.selected));
    }

    fn prev(&mut self) {
        if self.entries.is_empty() {
            return;
        }
        self.selected = (self.selected + self.entries.len() - 1) % self.entries.len();
        self.last_interaction = Instant::now();
        let _ = self.webview.evaluate_script(&format!("window.sel({})", self.selected));
    }

    /// Commit after a period of no further cycling. 900ms was far too short to
    /// even read the list; give the user time to look and cycle (Shift+Alt+V)
    /// or dismiss (Esc). Enter commits immediately.
    fn should_commit(&self) -> bool {
        !self.entries.is_empty()
            && self.last_interaction.elapsed() > Duration::from_millis(5000)
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
        "top-left" | "top-right" | "top" => mon_y + margin + stack_offset,
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

#[cfg(target_os = "macos")]
fn cursor_monitor_area(window: &Window) -> Option<(f64, f64, f64, f64)> {
    use core_graphics::display::{CGDisplay, CGPoint};
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    // Get cursor position via CGEvent (most reliable, works even without
    // Accessibility permissions).
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
    let event = CGEvent::new(source).ok()?;
    let cursor: CGPoint = event.location();

    // Find which display contains the cursor point.
    let displays = CGDisplay::active_displays().ok()?;
    let scale = window.scale_factor();

    for id in displays {
        let d = CGDisplay::new(id);
        let bounds = d.bounds();
        if cursor.x >= bounds.origin.x
            && cursor.x < bounds.origin.x + bounds.size.width
            && cursor.y >= bounds.origin.y
            && cursor.y < bounds.origin.y + bounds.size.height
        {
            // CG coordinates are in points on modern macOS (post-Retina),
            // and tao uses logical coordinates, so pass through directly.
            let x = bounds.origin.x / scale;
            let y = bounds.origin.y / scale;
            let w = bounds.size.width / scale;
            let h = bounds.size.height / scale;
            return Some((x, y, w, h));
        }
    }
    None
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
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

/// Resolve a requested sound to a file, or None. SECURITY: the request is untrusted (IPC), so:
/// a NAME may only be [a-z0-9_-] and maps to <exe dir>/sounds/<name>.wav; a PATH must be local
/// and absolute (no UNC / network share: opening one leaks credentials and blocks the UI thread)
/// with a .wav (or .mp3 off Windows) extension.
fn resolve_sound_path(sound: &str, exe_dir: Option<&std::path::Path>) -> Option<std::path::PathBuf> {
    let s = sound.trim();
    if s.is_empty() || s == "off" || s.len() > 260 || s.chars().any(|c| c.is_control()) {
        return None;
    }
    let lower = s.to_lowercase();
    let is_path = s.contains('/') || s.contains('\\') || lower.ends_with(".wav") || lower.ends_with(".mp3");
    if !is_path {
        if !s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
            return None;
        }
        let p = exe_dir?.join("sounds").join(format!("{}.wav", s));
        return if p.exists() { Some(p) } else { None };
    }
    if s.starts_with("\\\\") || s.starts_with("//") {
        return None; // UNC / network path
    }
    let p = std::path::PathBuf::from(s);
    if !p.is_absolute() {
        return None;
    }
    let ok_ext = lower.ends_with(".wav") || (!cfg!(windows) && lower.ends_with(".mp3"));
    if !ok_ext || !p.is_file() {
        return None;
    }
    Some(p)
}

/// Play a named or file-path sound. Best-effort, never blocks the loop for long.
fn play_sound(sound: &str) {
    let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.to_path_buf()));
    let path = match resolve_sound_path(sound, exe_dir.as_deref()) {
        Some(p) => p,
        None => return,
    };
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (0x08000000) so PowerShell's WAV playback never flashes a console.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // Use PowerShell's SoundPlayer for WAV (no extra deps).
        // The path travels in an environment variable, never inside the script text.
        let _ = std::process::Command::new("powershell")
            .env("CLIPLENS_SND", &path)
            .args(["-NoProfile", "-Command", "(New-Object Media.SoundPlayer $env:CLIPLENS_SND).PlaySync();"])
            .creation_flags(CREATE_NO_WINDOW)
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

/// Does THIS process own the foreground window? Used by sticky cards: once we've been in front,
/// losing it means the user clicked somewhere else -> close. Focus events are unreliable here
/// because keyboard focus sits in the WebView2 child, not the tao window.
#[cfg(target_os = "windows")]
fn we_own_foreground(_window: &Window) -> bool {
    use std::os::raw::c_void;
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> *mut c_void;
        fn GetWindowThreadProcessId(hwnd: *mut c_void, pid: *mut u32) -> u32;
    }
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_null() {
            return false;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(fg, &mut pid);
        pid == std::process::id()
    }
}

#[cfg(not(target_os = "windows"))]
fn we_own_foreground(window: &Window) -> bool {
    window.is_focused()
}

fn show_toast_oneshot(req: NotifyRequest) {
    let event_loop = EventLoopBuilder::<()>::with_user_event().build();

    let (resolved, win_w, win_h, _scale, html) = render_request(&req);
    let window = match build_window(&event_loop, win_w, win_h, false) {
        Some(w) => w,
        None => return,
    };
    position_window(&window, &req.position, win_w, win_h, 0, &req.offset);

    // Click the card to dismiss early (ipc handler flips this flag).
    let dismissed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let dismissed_cb = dismissed.clone();
    let _webview = WebViewBuilder::new(&window)
        .with_transparent(true)
        .with_html(html)
        .with_ipc_handler(move |_req| {
            dismissed_cb.store(true, std::sync::atomic::Ordering::Relaxed);
        })
        .build();
    let _webview = match _webview {
        Ok(w) => w,
        Err(_) => return,
    };
    window.set_visible(true);
    // Sticky: take focus so "click anywhere else" = focus lost = close. Normal toasts never
    // steal focus (by design); sticky is an explicit opt-in, so here it's the point.
    if req.sticky {
        window.set_focus();
    }

    play_sound(&effective_sound(&req));

    let start = Instant::now();
    let total = Duration::from_millis(resolved.duration);
    let sticky = req.sticky;
    let mut was_front = false;
    event_loop.run(move |_event, _, control_flow| {
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(80));
        if sticky {
            if we_own_foreground(&window) {
                was_front = true;
            } else if was_front {
                *control_flow = ControlFlow::Exit; // clicked outside
                return;
            }
        }
        // Sticky never times out, but a 15 min hard cap stops an orphaned card living forever.
        let timed_out = if sticky { start.elapsed() >= Duration::from_secs(900) } else { start.elapsed() >= total };
        if timed_out || dismissed.load(std::sync::atomic::Ordering::Relaxed) {
            *control_flow = ControlFlow::Exit;
        }
    });
}

// ----- reminders: CLI + outside-click detection -------------------------

fn parse_remind_args(argv: &[String]) -> RemindRequest {
    let mut r = RemindRequest::default();
    let mut i = 2;
    while i < argv.len() {
        let val = argv.get(i + 1).cloned().unwrap_or_default();
        match argv[i].as_str() {
            "--title" => r.title = val,
            "--subtitle" => r.subtitle = val,
            "--agent" => r.agent = val,
            "--id" => r.id = val,
            "--position" => r.position = val,
            "--at" => r.at_ms = val.parse().unwrap_or(0),
            "--in" => r.in_s = val.parse().unwrap_or(0),
            _ => {}
        }
        i += 2;
    }
    if r.agent.trim().is_empty() {
        if let Ok(a) = std::env::var("CLIPLENS_AGENT") {
            r.agent = a;
        }
    }
    r
}

fn run_remind_cli(argv: &[String]) {
    let req = parse_remind_args(argv);
    if req.title.trim().is_empty() {
        eprintln!("--title is required");
        std::process::exit(2);
    }
    if send_message(&Message::Remind(req.clone())).is_ok() {
        println!("sent");
        return;
    }
    // No daemon: persist, then start one so it fires on time.
    let path = reminder::default_path();
    let mut store = reminder::Store::open(&path);
    match reminder::apply_remind(&mut store, req, reminder::now_ms()).and_then(|id| store.save().map(|_| id).map_err(|_| "could not write the reminder file")) {
        Ok(id) => {
            spawn_daemon_detached();
            println!("saved {id}; daemon started");
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

fn run_remind_cancel_cli(id: String) {
    if id.trim().is_empty() {
        eprintln!("usage: --remind-cancel <id>");
        std::process::exit(2);
    }
    if send_message(&Message::RemindCancel { id: id.clone() }).is_ok() {
        println!("sent");
        return;
    }
    let mut store = reminder::Store::open(&reminder::default_path());
    println!("{}", if store.cancel(&id) && store.save().is_ok() { "cancelled" } else { "not found" });
}

fn spawn_daemon_detached() {
    if let Ok(exe) = std::env::current_exe() {
        let mut c = std::process::Command::new(exe);
        c.arg("--watch")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0000_0008 | 0x0800_0000); // DETACHED_PROCESS | CREATE_NO_WINDOW
        }
        let _ = c.spawn();
    }
}

#[cfg(target_os = "windows")]
fn left_mouse_down() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetAsyncKeyState(vkey: i32) -> i16;
    }
    unsafe { (GetAsyncKeyState(0x01) as u16) & 0x8000 != 0 }
}

#[cfg(not(target_os = "windows"))]
fn left_mouse_down() -> bool {
    false // outside-click detection is Windows-only for now: cards stay until acted on
}

#[cfg(target_os = "windows")]
fn cursor_inside(window: &Window) -> bool {
    use std::os::raw::c_long;
    #[repr(C)]
    struct Point {
        x: c_long,
        y: c_long,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetCursorPos(p: *mut Point) -> i32;
    }
    let mut pt = Point { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut pt) } == 0 {
        return true; // unknown => treat as inside so we never snooze by mistake
    }
    match (window.outer_position(), window.outer_size()) {
        (Ok(p), s) => {
            let (x, y) = (pt.x as i64, pt.y as i64);
            x >= p.x as i64 && x < p.x as i64 + s.width as i64 && y >= p.y as i64 && y < p.y as i64 + s.height as i64
        }
        _ => true,
    }
}

#[cfg(not(target_os = "windows"))]
fn cursor_inside(_window: &Window) -> bool {
    true
}

#[cfg(test)]
mod sound_tests {
    use super::resolve_sound_path;
    use std::path::Path;

    #[test]
    fn should_refuse_unc_relative_odd_extension_and_weird_names() {
        for bad in ["\\\\evil\\share\\x.wav", "//evil/share/x.wav", "..\\x.wav", "x.wav", "C:\\Windows\\win.ini", "Evil Name", "a'b", "../../x", "off", ""] {
            assert!(resolve_sound_path(bad, Some(Path::new("."))).is_none(), "{bad}");
        }
    }

    #[test]
    fn should_accept_an_existing_absolute_wav_only() {
        let dir = std::env::temp_dir().join(format!("cl-snd-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sounds")).unwrap();
        std::fs::write(dir.join("sounds").join("ding.wav"), b"RIFF").unwrap();
        let abs = dir.join("sounds").join("ding.wav");
        assert_eq!(resolve_sound_path(abs.to_str().unwrap(), None), Some(abs.clone()));
        assert_eq!(resolve_sound_path("ding", Some(&dir)), Some(abs));
        assert!(resolve_sound_path("missing", Some(&dir)).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod arg_tests {
    use super::parse_notify_args;

    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn should_read_every_arg_when_called_with_notify_mode_flag() {
        let r = parse_notify_args(&argv(&[
            "cliplens-daemon", "--notify", "--title", "Slack-clip klar", "--subtitle", "Ctrl+V",
            "--agent", "pp", "--type", "Write \u{00b7} Slack", "--position", "center", "--kind", "clip",
        ]));
        assert_eq!(r.title, "Slack-clip klar");
        assert_eq!(r.subtitle, "Ctrl+V");
        assert_eq!(r.agent, "pp");
        assert_eq!(r.format, "Write \u{00b7} Slack");
        assert_eq!(r.position, "center");
        assert_eq!(r.kind, "clip");
    }

    #[test]
    fn should_read_every_arg_when_called_without_a_mode_flag() {
        let r = parse_notify_args(&argv(&["cliplens-daemon", "--title", "Bild inläst", "--kind", "info"]));
        assert_eq!(r.title, "Bild inläst");
        assert_eq!(r.kind, "info");
    }
}
