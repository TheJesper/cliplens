// ipc.rs -- shared notification request type + transport helpers.
//
// Transport: a local socket via the `interprocess` crate.
//   Windows: named pipe  \\.\pipe\cliplens-daemon
//   Unix:    unix socket  $TMPDIR/cliplens-daemon.sock (path-based)
//
// Protocol: one JSON object per connection, newline-terminated.

use serde::{Deserialize, Serialize};

/// A notification request sent from any program to the daemon.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotifyRequest {
    #[serde(default = "default_emoji")]
    pub emoji: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    /// Named sound: "success" | "error" | "celebrate" | "info" | "off", or a file path.
    #[serde(default)]
    pub sound: String,
    #[serde(default = "default_duration")]
    pub duration: u64,
    /// "bottom" | "center" | "top-right" | "top-left" | "bottom-left" | "bottom-right"
    #[serde(default = "default_position")]
    pub position: String,
    /// Semantic preset key: success|error|warning|info|question|progress|clip|celebrate.
    #[serde(default)]
    pub kind: String,
    /// Accent hex override (e.g. "#30D158"); empty => derive from kind.
    #[serde(default)]
    pub accent: String,
    /// Clip type/format label shown as a chip (e.g. "Slack", "Mural", "Image", "Prompt", "Normal").
    #[serde(default)]
    pub format: String,
    /// Stable id for in-place update; empty => always a new card.
    #[serde(default)]
    pub id: String,
    /// Sending agent, shown as a small badge; empty => CLIPLENS_AGENT env or hidden.
    #[serde(default)]
    pub agent: String,
    /// Size preset: "small"|"normal"|"large"; empty => derive from kind.
    #[serde(default)]
    pub size: String,
    /// Explicit px width; 0 => from size (clamped 260-720).
    #[serde(default)]
    pub width: f64,
    /// Explicit px height; 0 => from size (clamped 72-320).
    #[serde(default)]
    pub height: f64,
    /// Uniform card scale 0.8-1.6; 0/absent => 1.0.
    #[serde(default)]
    pub scale: f64,
    /// "x,y" px nudge from the anchor; empty => "0,0".
    #[serde(default)]
    pub offset: String,
    /// Sticky: no auto-close. The card stays until the user clicks it or clicks anywhere else.
    #[serde(default)]
    pub sticky: bool,
    /// Shortcut hint shown as discreet keycaps in the bottom-right corner (e.g. "Ctrl+V").
    /// Empty => no keycaps. On macOS Ctrl renders as the Command symbol.
    #[serde(default)]
    pub keys: String,
}

fn default_emoji() -> String {
    "\u{1F4CB}".to_string()
}
fn default_duration() -> u64 {
    2600
}
fn default_position() -> String {
    "bottom".to_string()
}

impl Default for NotifyRequest {
    fn default() -> Self {
        NotifyRequest {
            emoji: default_emoji(),
            // Neutral fallback: never "Clip ready" — a missing title must not
            // mislabel a read (image save / lens) as a fresh clip write.
            title: "ClipLens".to_string(),
            subtitle: String::new(),
            sound: String::new(),
            duration: default_duration(),
            position: default_position(),
            kind: String::new(),
            accent: String::new(),
            format: String::new(),
            id: String::new(),
            agent: String::new(),
            size: String::new(),
            width: 0.0,
            height: 0.0,
            scale: 0.0,
            offset: String::new(),
            sticky: false,
            keys: String::new(),
        }
    }
}

/// Ask the daemon to show a reminder (a checkbox card) now or at a later time.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RemindRequest {
    /// Caller-chosen id (so it can be cancelled later); empty => daemon generates one.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    #[serde(default)]
    pub agent: String,
    /// Absolute due time, unix ms. 0 => use `in_s`.
    #[serde(default)]
    pub at_ms: i64,
    /// Seconds from now (used when `at_ms` is 0). 0 => due immediately.
    #[serde(default)]
    pub in_s: u64,
    /// Where the card appears: top-left | top | top-right | center | bottom-left | bottom |
    /// bottom-right. Empty/unknown => CLIPLENS_REMINDER_POSITION, else bottom-right.
    #[serde(default)]
    pub position: String,
}

/// Control messages the daemon understands (title acts as a command channel
/// for internal use, but we keep a dedicated enum for clarity/future use).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum Message {
    Notify(NotifyRequest),
    ShowPicker,
    Ping,
    Remind(RemindRequest),
    RemindCancel { id: String },
}

/// Platform-appropriate socket name.
#[cfg(windows)]
pub fn socket_name() -> String {
    r"\\.\pipe\cliplens-daemon".to_string()
}

#[cfg(unix)]
pub fn socket_name() -> String {
    let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
    format!("{}/cliplens-daemon.sock", base.trim_end_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_roundtrip_remind_and_cancel_messages() {
        let mut r = RemindRequest::default();
        r.title = "ring mamma".into();
        r.in_s = 600;
        let line = serde_json::to_string(&Message::Remind(r)).unwrap();
        match serde_json::from_str::<Message>(&line).unwrap() {
            Message::Remind(x) => assert_eq!((x.title.as_str(), x.in_s), ("ring mamma", 600)),
            other => panic!("{other:?}"),
        }
        let line = serde_json::to_string(&Message::RemindCancel { id: "r1".into() }).unwrap();
        assert!(matches!(serde_json::from_str::<Message>(&line).unwrap(), Message::RemindCancel { .. }));
    }

    #[test]
    fn should_roundtrip_a_notify_that_carries_its_own_kind_field() {
        let mut req = NotifyRequest::default();
        req.title = "hej".into();
        req.kind = "success".into();
        let line = serde_json::to_string(&Message::Notify(req)).unwrap();
        println!("{line}");
        match serde_json::from_str::<Message>(&line) {
            Ok(Message::Notify(r)) => {
                assert_eq!(r.title, "hej");
                assert_eq!(r.kind, "success");
            }
            other => panic!("did not roundtrip: {other:?} from {line}"),
        }
    }
}
