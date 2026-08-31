// history.rs -- read the agent-clip ring buffer written by cliplens-clip (Node).
//
// The daemon only READS this file for the picker. cliplens-clip owns writing.
// Path: ~/.cliplens/history.json  { "entries": [ {text,title,format,agent,ts}, ... ] }

use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
pub struct ClipEntry {
    pub text: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub agent: String,
}

#[derive(Debug, Deserialize)]
struct HistoryFile {
    #[serde(default)]
    entries: Vec<ClipEntry>,
}

pub fn history_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".cliplens").join("history.json"))
}

/// Read the clip history (newest first). Returns empty on any error.
pub fn read_history() -> Vec<ClipEntry> {
    let Some(path) = history_path() else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<HistoryFile>(&raw) {
        Ok(h) => h.entries,
        Err(_) => Vec::new(),
    }
}
