// preset.rs -- semantic "kind" presets: intent -> coherent visual identity.
//
// Pure logic, no I/O. An agent says WHAT kind of event this is (success,
// error, question, celebrate, ...) and this module maps it to emoji, accent
// color, default duration, and default sound. Explicit overrides always win.

/// Resolved visual identity for a notification.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub emoji: String,
    pub accent: String,       // hex, e.g. "#30D158"
    pub duration: u64,        // ms
    pub default_sound: String, // named sound key, "" if none
    pub kind: String,         // normalized kind
}

/// Size preset in logical px (before `scale`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SizeBox {
    pub width: f64,
    pub height: f64,
}

// Clamp bounds (spec §5.5 / §10.8).
pub const W_MIN: f64 = 260.0;
pub const W_MAX: f64 = 720.0;
pub const H_MIN: f64 = 72.0;
pub const H_MAX: f64 = 320.0;
pub const SCALE_MIN: f64 = 0.8;
pub const SCALE_MAX: f64 = 1.6;

/// Hard cap for a `progress` card that is never completed (spec §10.5).
pub const PROGRESS_MAX_MS: u64 = 90_000;

/// Base table: (emoji, accent, duration_ms, default_sound).
fn base(kind: &str) -> (&'static str, &'static str, u64, &'static str) {
    match kind {
        "success" => ("\u{2705}", "#30D158", 2600, "success"), // white check mark
        "error" => ("\u{274C}", "#FF453A", 4500, "error"),      // cross mark
        "warning" => ("\u{26A0}\u{FE0F}", "#FF9F0A", 3800, "success"), // warning sign (reuse success chime)
        "info" => ("\u{2139}\u{FE0F}", "#0A84FF", 2600, "success"),    // information
        "question" => ("\u{1F4AC}", "#BF5AF2", 6000, "success"), // speech balloon
        "progress" => ("\u{23F3}", "#0A84FF", PROGRESS_MAX_MS, ""), // hourglass, self-caps at 90s
        "celebrate" => ("\u{1F389}", "#FF2D55", 4200, "celebrate"), // party popper (rainbow rail in CSS)
        "clip" => ("\u{1F4CB}", "#8E8E93", 2200, ""),           // clipboard, graphite
        // Unknown/empty -> info.
        _ => ("\u{2139}\u{FE0F}", "#0A84FF", 2600, "success"),
    }
}

/// Normalize an incoming kind string (trim/lowercase, empty -> "info").
pub fn normalize_kind(kind: &str) -> String {
    let k = kind.trim().to_lowercase();
    if k.is_empty() {
        "info".to_string()
    } else {
        k
    }
}

/// Resolve a kind + optional overrides into a concrete visual identity.
/// `emoji_override`/`accent_override` empty => use preset. `duration_override`
/// 0 => use preset.
pub fn resolve_kind(
    kind: &str,
    emoji_override: &str,
    accent_override: &str,
    duration_override: u64,
) -> Resolved {
    let k = normalize_kind(kind);
    let (emoji, accent, duration, sound) = base(&k);

    let emoji = if emoji_override.trim().is_empty() {
        emoji.to_string()
    } else {
        emoji_override.trim().to_string()
    };
    let accent = if accent_override.trim().is_empty() {
        accent.to_string()
    } else {
        accent_override.trim().to_string()
    };
    let duration = if duration_override == 0 {
        duration
    } else {
        duration_override
    };

    Resolved {
        emoji,
        accent,
        duration,
        default_sound: sound.to_string(),
        kind: k,
    }
}

/// Resolve the size preset for a size string, deriving from kind when empty.
/// clip -> small, celebrate -> large, everything else -> normal.
pub fn resolve_size(size: &str, kind: &str) -> SizeBox {
    let s = size.trim().to_lowercase();
    let s = if s.is_empty() {
        match normalize_kind(kind).as_str() {
            "clip" => "small",
            "celebrate" => "large",
            _ => "normal",
        }
    } else {
        s.as_str()
    };
    match s {
        "small" => SizeBox { width: 360.0, height: 84.0 },
        "large" => SizeBox { width: 560.0, height: 132.0 },
        _ => SizeBox { width: 440.0, height: 96.0 }, // normal
    }
}

/// Final window box: start from size preset, override with explicit width/height
/// (0 => keep preset), clamp, then multiply by clamped scale.
pub fn resolve_box(
    size: &str,
    kind: &str,
    width: f64,
    height: f64,
    scale: f64,
) -> (f64, f64, f64) {
    let preset = resolve_size(size, kind);
    let w = if width > 0.0 { width } else { preset.width };
    let h = if height > 0.0 { height } else { preset.height };
    let w = w.clamp(W_MIN, W_MAX);
    let h = h.clamp(H_MIN, H_MAX);
    let scale = if scale <= 0.0 { 1.0 } else { scale.clamp(SCALE_MIN, SCALE_MAX) };
    (w * scale, h * scale, scale)
}

/// Parse an "x,y" offset string into (dx, dy). Malformed => (0.0, 0.0).
pub fn parse_offset(offset: &str) -> (f64, f64) {
    let mut parts = offset.split(',');
    let x = parts
        .next()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .unwrap_or(0.0);
    let y = parts
        .next()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .unwrap_or(0.0);
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_kind_resolves_to_info() {
        let r = resolve_kind("", "", "", 0);
        assert_eq!(r.kind, "info");
        assert_eq!(r.accent, "#0A84FF");
        assert_eq!(r.duration, 2600);
    }

    #[test]
    fn kind_is_case_insensitive_and_trimmed() {
        let r = resolve_kind("  SUCCESS ", "", "", 0);
        assert_eq!(r.kind, "success");
        assert_eq!(r.accent, "#30D158");
        assert_eq!(r.default_sound, "success");
    }

    #[test]
    fn explicit_overrides_win() {
        let r = resolve_kind("error", "\u{1F525}", "#123456", 1234);
        assert_eq!(r.emoji, "\u{1F525}");
        assert_eq!(r.accent, "#123456");
        assert_eq!(r.duration, 1234);
    }

    #[test]
    fn progress_caps_at_90s() {
        let r = resolve_kind("progress", "", "", 0);
        assert_eq!(r.duration, PROGRESS_MAX_MS);
        assert_eq!(r.default_sound, "");
    }

    #[test]
    fn celebrate_has_sound_and_long_duration() {
        let r = resolve_kind("celebrate", "", "", 0);
        assert_eq!(r.default_sound, "celebrate");
        assert_eq!(r.duration, 4200);
    }

    #[test]
    fn size_derives_from_kind() {
        assert_eq!(resolve_size("", "clip"), SizeBox { width: 360.0, height: 84.0 });
        assert_eq!(resolve_size("", "celebrate"), SizeBox { width: 560.0, height: 132.0 });
        assert_eq!(resolve_size("", "success"), SizeBox { width: 440.0, height: 96.0 });
    }

    #[test]
    fn explicit_size_overrides_kind() {
        assert_eq!(resolve_size("large", "clip"), SizeBox { width: 560.0, height: 132.0 });
    }

    #[test]
    fn box_clamps_and_scales() {
        // Oversized width clamps to W_MAX, scale clamps to SCALE_MAX.
        let (w, h, s) = resolve_box("", "success", 9999.0, 10.0, 5.0);
        assert_eq!(s, SCALE_MAX);
        assert_eq!(w, W_MAX * SCALE_MAX);
        assert_eq!(h, H_MIN * SCALE_MAX);
    }

    #[test]
    fn box_default_scale_is_one() {
        let (w, h, s) = resolve_box("normal", "info", 0.0, 0.0, 0.0);
        assert_eq!(s, 1.0);
        assert_eq!(w, 440.0);
        assert_eq!(h, 96.0);
    }

    #[test]
    fn offset_parses_and_defaults() {
        assert_eq!(parse_offset("10,-40"), (10.0, -40.0));
        assert_eq!(parse_offset(" 5 , 6 "), (5.0, 6.0));
        assert_eq!(parse_offset("garbage"), (0.0, 0.0));
        assert_eq!(parse_offset(""), (0.0, 0.0));
        assert_eq!(parse_offset("7"), (7.0, 0.0));
    }
}
