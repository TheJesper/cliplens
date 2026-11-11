// reminder.rs -- scheduled, snoozable reminders. Pure logic + a tiny JSON store.
//
// Rules (Jesper):
//   * a reminder never vanishes silently: only the checkbox completes it
//   * clicking anywhere else (outside the card) = auto-snooze 30 minutes
//   * snooze choices: 5 min, 30 min, tomorrow (08:00 the next workday)
//
// The daemon is the only writer while it runs. The store survives restart/hibernate.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const MAX_TITLE: usize = 200;
pub const MAX_SUBTITLE: usize = 500;
pub const MAX_AGENT: usize = 40;
pub const MAX_ITEMS: usize = 500;
/// Completed reminders stay listed this long so an agent can ask "was it done?".
pub const DONE_KEEP_MS: i64 = 7 * 24 * 3600 * 1000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reminder {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    #[serde(default)]
    pub agent: String,
    pub due_ms: i64,
    pub created_ms: i64,
    #[serde(default)]
    pub done_ms: Option<i64>,
    #[serde(default)]
    pub snoozes: u32,
    /// Screen anchor (see POSITIONS); empty => default.
    #[serde(default)]
    pub position: String,
}

pub const POSITIONS: [&str; 7] = ["top-left", "top", "top-right", "center", "bottom-left", "bottom", "bottom-right"];

/// A valid anchor for a stored position, else CLIPLENS_REMINDER_POSITION, else bottom-right.
pub fn position_or_default(stored: &str) -> &'static str {
    let pick = |s: &str| POSITIONS.iter().copied().find(|p| *p == s.trim().to_lowercase());
    pick(stored)
        .or_else(|| std::env::var("CLIPLENS_REMINDER_POSITION").ok().and_then(|v| pick(&v)))
        .unwrap_or("bottom-right")
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Snooze {
    Min5,
    Min30,
    Tomorrow,
}

impl Snooze {
    pub fn parse(s: &str) -> Option<Snooze> {
        match s.trim().to_lowercase().as_str() {
            "5" => Some(Snooze::Min5),
            "30" => Some(Snooze::Min30),
            "tomorrow" => Some(Snooze::Tomorrow),
            _ => None,
        }
    }
}

/// New due time after a snooze. `tz_offset_s` = local offset from UTC in seconds.
pub fn snooze_due(s: Snooze, now_ms: i64, tz_offset_s: i64) -> i64 {
    match s {
        Snooze::Min5 => now_ms + 5 * 60_000,
        Snooze::Min30 => now_ms + 30 * 60_000,
        Snooze::Tomorrow => next_workday_8(now_ms, tz_offset_s),
    }
}

/// 08:00 local on the next Mon-Fri day after "today" (Fri/Sat/Sun -> Monday).
/// The offset is the one in force NOW; a DST switch in between can shift this by an hour.
pub fn next_workday_8(now_ms: i64, tz_offset_s: i64) -> i64 {
    let local_s = now_ms.div_euclid(1000) + tz_offset_s;
    let today = local_s.div_euclid(86_400);
    let mut day = today + 1;
    // 1970-01-01 was a Thursday; Monday = 0.
    match (day + 3).rem_euclid(7) {
        5 => day += 2, // Saturday -> Monday
        6 => day += 1, // Sunday -> Monday
        _ => {}
    }
    (day * 86_400 + 8 * 3600 - tz_offset_s) * 1000
}

/// Local UTC offset in seconds, right now.
#[cfg(windows)]
pub fn local_utc_offset_s() -> i64 {
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct SystemTime {
        a: [u16; 8],
    }
    #[repr(C)]
    struct Tzi {
        bias: i32,
        std_name: [u16; 32],
        std_date: SystemTime,
        std_bias: i32,
        dl_name: [u16; 32],
        dl_date: SystemTime,
        dl_bias: i32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTimeZoneInformation(p: *mut Tzi) -> u32;
    }
    unsafe {
        let mut t: Tzi = std::mem::zeroed();
        let id = GetTimeZoneInformation(&mut t);
        // 2 = TIME_ZONE_ID_DAYLIGHT. Bias is minutes WEST of UTC.
        let extra = if id == 2 { t.dl_bias } else { t.std_bias };
        -((t.bias + extra) as i64) * 60
    }
}

#[cfg(unix)]
pub fn local_utc_offset_s() -> i64 {
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&now, &mut tm);
        tm.tm_gmtoff as i64
    }
}

/// Apply a remind request to the store: same open id => reschedule, else add. Returns the id.
pub fn apply_remind(store: &mut Store, req: crate::ipc::RemindRequest, now: i64) -> Result<String, &'static str> {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let id = if req.id.trim().is_empty() {
        format!("r{:x}{:x}", now, COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
    } else {
        clip(req.id.trim(), 64)
    };
    let due = if req.at_ms > 0 { req.at_ms } else { now + (req.in_s.min(366 * 86_400) as i64) * 1000 };
    // Validate BEFORE replacing: a bad request must not delete the existing reminder.
    let old = store.items.iter().position(|i| i.id == id && i.done_ms.is_none()).map(|p| store.items.remove(p));
    let res = store.add(Reminder { id, title: req.title, subtitle: req.subtitle, agent: req.agent, due_ms: due, created_ms: now, done_ms: None, snoozes: old.as_ref().map_or(0, |o| o.snoozes), position: req.position.trim().to_lowercase() });
    if res.is_err() {
        if let Some(o) = old {
            store.items.push(o);
        }
    }
    res
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn default_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cliplens")
        .join("reminders.json")
}

#[derive(Default, Serialize, Deserialize)]
struct FileShape {
    #[serde(default)]
    items: Vec<Reminder>,
}

pub struct Store {
    pub items: Vec<Reminder>,
    path: PathBuf,
}

fn clip(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control() || *c == '\n').take(max).collect()
}

impl Store {
    /// Missing file -> empty. A corrupt file is moved aside (never silently overwritten).
    pub fn open(path: &Path) -> Store {
        let mut s = Store::open_raw(path);
        // Limits apply to what is on disk too (a hand-edited or hostile file).
        s.items.truncate(MAX_ITEMS * 2);
        for i in s.items.iter_mut() {
            i.title = clip(&i.title, MAX_TITLE);
            i.subtitle = clip(&i.subtitle, MAX_SUBTITLE);
            i.agent = clip(&i.agent, MAX_AGENT);
            i.id = clip(&i.id, 64);
        }
        s
    }

    fn open_raw(path: &Path) -> Store {
        let items = match std::fs::read_to_string(path) {
            Ok(text) => match serde_json::from_str::<FileShape>(&text) {
                Ok(f) => f.items,
                Err(_) => {
                    let _ = std::fs::rename(path, path.with_extension("json.bad"));
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };
        Store { items, path: path.to_path_buf() }
    }

    /// Atomic: write a temp file next to the target, then rename over it.
    pub fn save(&self) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension(format!("json.{}.tmp", std::process::id()));
        let body = serde_json::to_string_pretty(&FileShape { items: self.items.clone() })
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, &self.path)
    }

    pub fn add(&mut self, mut r: Reminder) -> Result<String, &'static str> {
        r.title = clip(&r.title, MAX_TITLE);
        r.subtitle = clip(&r.subtitle, MAX_SUBTITLE);
        r.agent = clip(&r.agent, MAX_AGENT);
        if r.title.trim().is_empty() {
            return Err("title is required");
        }
        if self.items.iter().filter(|i| i.done_ms.is_none()).count() >= MAX_ITEMS {
            return Err("too many open reminders");
        }
        if self.items.iter().any(|i| i.id == r.id) {
            return Err("duplicate id");
        }
        let id = r.id.clone();
        self.items.push(r);
        Ok(id)
    }

    /// Ids that are open and due.
    pub fn due(&self, now: i64) -> Vec<String> {
        self.items
            .iter()
            .filter(|i| i.done_ms.is_none() && i.due_ms <= now)
            .map(|i| i.id.clone())
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<&Reminder> {
        self.items.iter().find(|i| i.id == id)
    }

    pub fn complete(&mut self, id: &str, now: i64) -> bool {
        match self.items.iter_mut().find(|i| i.id == id && i.done_ms.is_none()) {
            Some(i) => {
                i.done_ms = Some(now);
                true
            }
            None => false,
        }
    }

    pub fn snooze(&mut self, id: &str, new_due: i64) -> bool {
        match self.items.iter_mut().find(|i| i.id == id && i.done_ms.is_none()) {
            Some(i) => {
                i.due_ms = new_due;
                i.snoozes += 1;
                true
            }
            None => false,
        }
    }

    pub fn cancel(&mut self, id: &str) -> bool {
        let before = self.items.len();
        self.items.retain(|i| i.id != id);
        self.items.len() != before
    }

    /// Drop completed reminders older than `DONE_KEEP_MS`.
    pub fn prune(&mut self, now: i64) {
        self.items.retain(|i| match i.done_ms {
            Some(d) => now.saturating_sub(d) < DONE_KEEP_MS,
            None => true,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: i64 = 3_600_000;
    // 2026-09-22 is a Tuesday = epoch day 20718.
    const TUE_0000Z: i64 = 20718 * 86_400_000;

    fn rem(id: &str, due: i64) -> Reminder {
        Reminder { id: id.into(), title: "t".into(), subtitle: String::new(), agent: String::new(), due_ms: due, created_ms: 0, done_ms: None, snoozes: 0, position: String::new() }
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cliplens-rem-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d.join("reminders.json")
    }

    #[test]
    fn should_snooze_5_and_30_minutes_from_now() {
        assert_eq!(snooze_due(Snooze::Min5, 1000, 0), 1000 + 300_000);
        assert_eq!(snooze_due(Snooze::Min30, 1000, 0), 1000 + 1_800_000);
    }

    #[test]
    fn should_pick_0800_local_next_day_when_tomorrow_is_a_workday() {
        // Tuesday 10:00 UTC, UTC+2 -> Wednesday 08:00 local = 06:00 UTC.
        let due = next_workday_8(TUE_0000Z + 10 * H, 7200);
        assert_eq!(due, TUE_0000Z + 24 * H + 6 * H);
    }

    #[test]
    fn should_skip_the_weekend_when_snoozing_to_tomorrow_on_a_friday() {
        let fri = TUE_0000Z + 3 * 24 * H; // Friday 00:00Z
        let due = next_workday_8(fri + 12 * H, 0);
        assert_eq!(due, fri + 3 * 24 * H + 8 * H); // Monday 08:00Z
        let sat = fri + 24 * H;
        assert_eq!(next_workday_8(sat + H, 0), fri + 3 * 24 * H + 8 * H);
        let sun = sat + 24 * H;
        assert_eq!(next_workday_8(sun + H, 0), fri + 3 * 24 * H + 8 * H);
    }

    #[test]
    fn should_use_the_local_date_not_the_utc_date_near_midnight() {
        // Tue 23:30Z with UTC+2 is already Wed 01:30 local -> tomorrow is THURSDAY 08:00 local.
        let due = next_workday_8(TUE_0000Z + 23 * H + 30 * 60_000, 7200);
        assert_eq!(due, TUE_0000Z + 2 * 24 * H + 6 * H);
    }

    #[test]
    fn should_report_only_open_due_reminders() {
        let mut s = Store { items: vec![], path: PathBuf::new() };
        s.add(rem("a", 100)).unwrap();
        s.add(rem("b", 900)).unwrap();
        s.add(rem("c", 50)).unwrap();
        s.complete("c", 60);
        assert_eq!(s.due(500), vec!["a".to_string()]);
    }

    #[test]
    fn should_bring_a_snoozed_reminder_back_only_after_the_new_time() {
        let mut s = Store { items: vec![], path: PathBuf::new() };
        s.add(rem("a", 100)).unwrap();
        assert!(s.snooze("a", 1000));
        assert!(s.due(999).is_empty());
        assert_eq!(s.due(1000), vec!["a".to_string()]);
        assert_eq!(s.get("a").unwrap().snoozes, 1);
    }

    #[test]
    fn should_reject_empty_title_duplicate_id_and_overflow_and_trim_long_text() {
        let mut s = Store { items: vec![], path: PathBuf::new() };
        let mut r = rem("a", 1);
        r.title = "   ".into();
        assert!(s.add(r).is_err());
        let mut r = rem("a", 1);
        r.title = "x".repeat(MAX_TITLE + 50);
        r.agent = "a\u{0007}b".into();
        s.add(r).unwrap();
        assert_eq!(s.get("a").unwrap().title.chars().count(), MAX_TITLE);
        assert_eq!(s.get("a").unwrap().agent, "ab");
        assert!(s.add(rem("a", 2)).is_err());
        for i in 0..MAX_ITEMS {
            let _ = s.add(rem(&format!("n{i}"), 1));
        }
        assert!(s.add(rem("last", 1)).is_err());
    }

    #[test]
    fn should_not_complete_or_snooze_twice_and_should_prune_old_done_items() {
        let mut s = Store { items: vec![], path: PathBuf::new() };
        s.add(rem("a", 1)).unwrap();
        assert!(s.complete("a", 10));
        assert!(!s.complete("a", 20));
        assert!(!s.snooze("a", 99));
        s.prune(10 + DONE_KEEP_MS - 1);
        assert_eq!(s.items.len(), 1);
        s.prune(10 + DONE_KEEP_MS);
        assert!(s.items.is_empty());
    }

    #[test]
    fn should_survive_a_save_and_reopen() {
        let p = tmp("roundtrip");
        let mut s = Store::open(&p);
        s.add(rem("a", 5)).unwrap();
        s.save().unwrap();
        let again = Store::open(&p);
        assert_eq!(again.items, s.items);
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn should_move_a_corrupt_file_aside_instead_of_overwriting_it() {
        let p = tmp("corrupt");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "{ not json").unwrap();
        let s = Store::open(&p);
        assert!(s.items.is_empty());
        assert!(p.with_extension("json.bad").exists());
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn should_schedule_relative_and_absolute_and_reschedule_the_same_id() {
        let mut s = Store { items: vec![], path: PathBuf::new() };
        let mut q = crate::ipc::RemindRequest::default();
        q.title = "a".into();
        q.in_s = 60;
        let id = apply_remind(&mut s, q.clone(), 1000).unwrap();
        assert_eq!(s.get(&id).unwrap().due_ms, 61_000);
        q.id = "fixed".into();
        q.at_ms = 5000;
        apply_remind(&mut s, q.clone(), 1000).unwrap();
        q.at_ms = 9000;
        apply_remind(&mut s, q, 1000).unwrap();
        assert_eq!(s.items.iter().filter(|i| i.id == "fixed").count(), 1);
        assert_eq!(s.get("fixed").unwrap().due_ms, 9000);
    }

    #[test]
    fn should_accept_every_anchor_and_fall_back_to_bottom_right_for_junk() {
        for p in POSITIONS {
            assert_eq!(position_or_default(p), p);
        }
        assert_eq!(position_or_default(" Top "), "top");
        std::env::remove_var("CLIPLENS_REMINDER_POSITION");
        assert_eq!(position_or_default(""), "bottom-right");
        assert_eq!(position_or_default("left-ish"), "bottom-right");
    }

    #[test]
    fn should_keep_the_old_reminder_when_a_replacement_is_invalid() {
        let mut s = Store { items: vec![], path: PathBuf::new() };
        let mut q = crate::ipc::RemindRequest::default();
        q.id = "keep".into();
        q.title = "original".into();
        apply_remind(&mut s, q.clone(), 1000).unwrap();
        q.title = "   ".into();
        assert!(apply_remind(&mut s, q, 2000).is_err());
        assert_eq!(s.get("keep").unwrap().title, "original");
    }

    #[test]
    fn should_not_overflow_when_pruning_extreme_done_times() {
        let mut s = Store { items: vec![], path: PathBuf::new() };
        let mut r = rem("a", 1);
        r.done_ms = Some(i64::MIN);
        s.items.push(r);
        s.prune(i64::MAX);
        assert!(s.items.is_empty());
    }

    #[test]
    fn should_parse_snooze_choices() {
        assert_eq!(Snooze::parse("5"), Some(Snooze::Min5));
        assert_eq!(Snooze::parse(" Tomorrow "), Some(Snooze::Tomorrow));
        assert_eq!(Snooze::parse("999"), None);
    }

    #[test]
    fn should_return_a_plausible_local_offset() {
        let o = local_utc_offset_s();
        assert!((-14 * 3600..=14 * 3600).contains(&o));
    }
}
