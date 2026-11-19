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
    /// ISO time written by the Node side (`ts`); entries older than the TTL are not shown.
    #[serde(default)]
    pub ts: String,
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
    // Bounded: a huge or hostile file must not stall the UI thread.
    if std::fs::metadata(&path).map(|m| m.len() > 4 * 1024 * 1024).unwrap_or(true) {
        return Vec::new();
    }
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let ttl_min: i64 = std::env::var("CLIPLENS_HISTORY_TTL_MIN").ok().and_then(|v| v.parse().ok()).filter(|n| *n > 0).map(|n: i64| n.min(1440)).unwrap_or(60);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    match serde_json::from_str::<HistoryFile>(&raw) {
        Ok(h) => h.entries.into_iter().filter(|e| iso_secs(&e.ts).is_none_or(|t| now - t <= ttl_min * 60)).take(50).collect(),
        Err(_) => Vec::new(),
    }
}

/// Seconds since 1970 of an ISO time like `2026-09-22T10:00:00.000Z` (UTC only, which is what JS writes).
fn iso_secs(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let n = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d, hh, mm, ss) = (n(0, 4)?, n(5, 7)?, n(8, 10)?, n(11, 13)?, n(14, 16)?, n(17, 19)?);
    // days from civil (Howard Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

#[cfg(test)]
mod ttl_tests {
    use super::iso_secs;

    #[test]
    fn should_parse_js_iso_times_and_reject_junk() {
        assert_eq!(iso_secs("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(iso_secs("2026-09-22T10:00:00.000Z"), Some(1_790_071_200));
        assert_eq!(iso_secs(""), None);
        assert_eq!(iso_secs("yesterday"), None);
    }
}
