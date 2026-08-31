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
            title: "Clip ready".to_string(),
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
        }
    }
}

/// Control messages the daemon understands (title acts as a command channel
/// for internal use, but we keep a dedicated enum for clarity/future use).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Message {
    Notify(NotifyRequest),
    ShowPicker,
    Ping,
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
