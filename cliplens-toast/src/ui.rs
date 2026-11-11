// ui.rs -- HTML/CSS for the toast card and the clip picker.
//
// The window is frameless + transparent; the card fills the whole window so
// WebView2 never renders an opaque border box (see #1 learnings).
//
// A single CSS custom property `--scale` drives emoji size, text size, gaps and
// padding coherently so one multiplier resizes the whole card (spec §5.5).

use crate::history::ClipEntry;
use crate::preset::Resolved;

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Options driving how a toast card renders.
pub struct ToastView<'a> {
    pub resolved: &'a Resolved,
    pub title: &'a str,
    pub subtitle: &'a str,
    pub agent: &'a str,
    pub type_label: &'a str,
    pub keys: &'a str,
    pub scale: f64,
}

/// A single toast card: accent rail + emoji + title/subtitle + agent badge.
/// Kind drives animation (calm wiggle / progress shimmer / celebrate confetti).
pub fn toast_html(v: &ToastView) -> String {
    let kind = v.resolved.kind.as_str();
    let accent = esc(&v.resolved.accent);
    let emoji = esc(&v.resolved.emoji);

    // Meta row: sender first (bold), then the detail. Shortcut keys live in the corner, not here.
    let keys_html = keys_corner_html(v.keys);
    let sub = meta_html(v.agent, v.subtitle, !keys_html.is_empty());
    let badge = String::new();

    // Per-kind emoji animation class.
    let emoji_anim = match kind {
        "progress" => "pulse",
        "celebrate" => "bounce",
        _ => "wiggle",
    };

    // Progress shimmer bar along the bottom edge.
    let shimmer = if kind == "progress" {
        r#"<div class="shimmer"></div>"#
    } else {
        ""
    };

    // Celebrate: rainbow rail + one-shot confetti burst (pure CSS).
    let (rail_style, confetti) = if kind == "celebrate" {
        (
            "background:linear-gradient(180deg,#FF2D55,#FF9F0A,#30D158,#0A84FF,#BF5AF2);\
             background-size:100% 300%;animation:railflow 2.2s linear infinite;"
                .to_string(),
            confetti_html(),
        )
    } else {
        (format!("background:{};", accent), String::new())
    };

    // `notify` gets its own calmer card tint (a touch of teal over the warm base) so a standing
    // notice reads differently from a clip receipt, while staying in the solarized family.
    let card_bg = if kind == "notify" {
        "linear-gradient(135deg,rgba(60,66,66,0.93),rgba(74,54,40,0.93))"
    } else {
        "rgba(74,54,40,0.90)"
    };

    // FatCow icon for clips AND for any labelled read/write (e.g. "Read · Image"), so a read
    // shows the magnifier instead of a generic emoji. Other kinds (notify, success, ...) keep
    // their emoji glyph in the tile so the meaning reads at a glance.
    let labelled = !v.type_label.trim().is_empty();
    let use_img = (kind == "clip" || labelled) && kind != "notify";
    let icon_el = if use_img {
        format!(r#"<div class="tile"><img class="emoji {a}" src="data:image/png;base64,{ic}"/></div>"#, a = emoji_anim, ic = icon_for(v.type_label))
    } else {
        format!(r#"<div class="tile"><div class="emoji {a}">{e}</div></div>"#, a = emoji_anim, e = emoji)
    };

    // Clip-type chip: "READ · IMAGE" / "WRITE · SLACK". Reads get a blue chip, writes neutral.
    let is_read = {
        let l = v.type_label.trim().to_lowercase();
        l.starts_with("read") || l.starts_with("läst")
    };
    let chip = if !labelled {
        String::new()
    } else {
        format!(
            r#"<span class="chip{r}">{t}</span>"#,
            r = if is_read { " read" } else { "" },
            t = esc(v.type_label)
        )
    };

    format!(
        r#"<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>
{base}
:root{{--scale:{scale};--accent:{accent};}}
.wrap{{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;}}
.toast{{position:relative;display:flex;align-items:center;gap:calc(16px*var(--scale));
  width:100%;height:100%;box-sizing:border-box;
  padding:0 calc(24px*var(--scale)) 0 calc(22px*var(--scale));
  background:{card_bg};border-radius:calc(22px*var(--scale));color:#F5EFE8;
  cursor:pointer;animation:pop 420ms cubic-bezier(0.22,1,0.36,1);}}
.toast:active{{transform:scale(0.98);}}
.rail{{position:absolute;left:0;top:14%;bottom:14%;width:4px;border-radius:4px;{rail_style}}}
.emoji{{font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif;
  font-size:calc(52px*var(--scale));line-height:1;
  filter:drop-shadow(0 0 calc(14px*var(--scale)) {accent}88);}}
.tile{{flex:0 0 auto;width:calc(50px*var(--scale));height:calc(50px*var(--scale));
  border-radius:calc(15px*var(--scale));background:rgba(255,255,255,0.07);
  display:flex;align-items:center;justify-content:center;}}
.tile .emoji{{font-size:calc(30px*var(--scale));line-height:1;}}
img.emoji{{width:calc(32px*var(--scale));height:calc(32px*var(--scale));object-fit:contain;filter:none;image-rendering:-webkit-optimize-contrast;}}
.text{{flex:1;min-width:0;display:flex;flex-direction:column;gap:calc(4px*var(--scale));}}
.title{{display:flex;align-items:center;gap:calc(9px*var(--scale));min-width:0;
  font-size:calc(21px*var(--scale));font-weight:600;line-height:1.15;}}
.title .t{{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}}
.chip{{flex:0 0 auto;font-size:calc(10px*var(--scale));font-weight:700;text-transform:uppercase;letter-spacing:0.4px;
  line-height:1;color:#F5EFE8;background:rgba(255,255,255,0.16);
  padding:calc(3px*var(--scale)) calc(7px*var(--scale));border-radius:calc(6px*var(--scale));}}
.chip.read{{background:rgba(10,132,255,0.38);}}
.meta{{display:flex;align-items:baseline;gap:calc(6px*var(--scale));min-width:0;
  font-size:calc(13.5px*var(--scale));color:rgba(235,235,245,0.62);}}
.meta .who{{flex:0 0 auto;color:#F5EFE8;font-weight:700;}}
.meta .sep{{flex:0 0 auto;opacity:0.4;}}
.meta .detail{{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}}
.meta.wrap-detail .detail{{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere;}}
.meta.has-keys{{padding-right:calc(60px*var(--scale));}}
.keys{{position:absolute;right:calc(20px*var(--scale));bottom:calc(10px*var(--scale));
  display:flex;gap:calc(3px*var(--scale));opacity:0.5;}}
kbd{{display:inline-block;min-width:calc(8px*var(--scale));text-align:center;
  font:600 calc(10.5px*var(--scale))/1 "Segoe UI",-apple-system,sans-serif;color:#F5EFE8;
  background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.22);border-bottom-width:2px;
  border-radius:calc(4px*var(--scale));padding:calc(2px*var(--scale)) calc(5px*var(--scale));}}
.meta kbd{{margin:0 calc(1.5px*var(--scale));}}
.emoji.wiggle{{animation:wiggle 2s ease-in-out infinite;}}
.emoji.pulse{{animation:pulse 1.3s ease-in-out infinite;}}
.emoji.bounce{{animation:bounce 900ms cubic-bezier(0.22,1.4,0.4,1);}}
.badge{{position:absolute;top:calc(10px*var(--scale));right:calc(14px*var(--scale));
  font-size:calc(9px*var(--scale));text-transform:uppercase;letter-spacing:0.6px;font-weight:700;
  color:rgba(235,235,245,0.55);background:rgba(255,255,255,0.08);
  padding:calc(2px*var(--scale)) calc(7px*var(--scale));border-radius:calc(6px*var(--scale));}}
.shimmer{{position:absolute;left:8%;right:8%;bottom:calc(8px*var(--scale));height:3px;border-radius:3px;
  background:linear-gradient(90deg,transparent,{accent},transparent);
  background-size:200% 100%;animation:shimmer 1.4s linear infinite;opacity:0.9;}}
{anim}
</style></head><body><div class="wrap"><div class="toast" onclick="window.ipc.postMessage('dismiss')">
{icon}
<div class="text"><div class="title"><span class="t">{title}</span>{chip}</div>{sub}</div>
{keys_html}
{badge}
{shimmer}
{confetti}
</div></div></body></html>"#,
        base = BASE_CSS,
        anim = ANIM_CSS,
        scale = v.scale,
        accent = accent,
        card_bg = card_bg,
        rail_style = rail_style,
        icon = icon_el,
        chip = chip,
        title = esc(v.title),
        sub = sub,
        keys_html = keys_html,
        badge = badge,
        shimmer = shimmer,
        confetti = confetti,
    )
}

/// 14 confetti particles with staggered fall/rotate/fade. Pure CSS, one-shot.
fn confetti_html() -> String {
    let colors = ["#FF2D55", "#FF9F0A", "#30D158", "#0A84FF", "#BF5AF2", "#5AC8FA", "#FFD60A"];
    let mut out = String::from(r#"<div class="confetti">"#);
    for i in 0..14 {
        let left = 6 + (i * 6) % 88; // spread across the card
        let color = colors[i % colors.len()];
        let delay = (i as f64 * 45.0) as u32; // ms stagger
        let dur = 800 + (i % 5) * 120; // ms
        let rot = (i * 57) % 360;
        out.push_str(&format!(
            r#"<span style="left:{left}%;background:{color};animation-delay:{delay}ms;animation-duration:{dur}ms;--rot:{rot}deg;"></span>"#,
            left = left, color = color, delay = delay, dur = dur, rot = rot,
        ));
    }
    out.push_str("</div>");
    out
}

/// Render a single clip line with light markdown: *bold*, _italic_, `code`.
/// Escapes HTML first, then applies the three inline styles. Newlines collapse
/// to a space so the row stays a one-liner.
fn md_line(s: &str) -> String {
    let mut t = esc(s);
    t = t.replace('\n', " ").replace('\r', " ");
    // `code` first so * / _ inside code aren't re-processed as emphasis.
    t = apply_pair(&t, '`', "<code>", "</code>");
    t = apply_pair(&t, '*', "<b>", "</b>");
    t = apply_pair(&t, '_', "<i>", "</i>");
    t
}

/// Replace balanced pairs of a single delimiter char with open/close tags.
/// Only matched pairs are converted; a trailing unmatched delimiter is kept.
fn apply_pair(s: &str, delim: char, open: &str, close: &str) -> String {
    let total = s.matches(delim).count();
    if total < 2 {
        return s.to_string();
    }
    // Convert only complete pairs; if odd count, the last delimiter is literal.
    let convertible = total - (total % 2);
    let mut out = String::with_capacity(s.len() + convertible * open.len());
    let mut open_next = true;
    let mut done = 0;
    for ch in s.chars() {
        if ch == delim && done < convertible {
            out.push_str(if open_next { open } else { close });
            open_next = !open_next;
            done += 1;
        } else {
            out.push(ch);
        }
    }
    out
}

/// The clip picker: a vertical list of recent agent clips, one highlighted.
/// Each row shows a type icon (incl. image), the sender (agent) as a small
/// badge, and the clip text with light markdown rendering.
pub fn picker_html(entries: &[ClipEntry], selected: usize) -> String {
    let mut rows = String::new();
    for (i, e) in entries.iter().enumerate() {
        let active = if i == selected { " active" } else { "" };
        let type_label = if e.format.is_empty() { "Normal" } else { &e.format };
        let icon_b64 = icon_for(type_label).trim();
        let sender = if e.agent.is_empty() { "cliplens" } else { &e.agent };
        rows.push_str(&format!(
            r#"<div class="row{active}" data-idx="{idx}">
  <img class="ico" src="data:image/png;base64,{icon}" alt=""/>
  <div class="text">
    <div class="label">{label}</div>
    <div class="meta"><span class="who">{who}</span><span class="fmt">{fmt}</span></div>
  </div>
</div>"#,
            active = active,
            idx = i,
            icon = icon_b64,
            label = md_line(&e.title),
            who = esc(sender),
            fmt = esc(type_label),
        ));
    }
    if entries.is_empty() {
        rows.push_str(r#"<div class="empty">Inga clips ännu</div>"#);
    }
    format!(
        r#"<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>
{base}
.wrap{{position:fixed;inset:0;padding:14px;box-sizing:border-box;
  background:rgba(74,54,40,0.94);border-radius:20px;color:#F5EFE8;
  animation:pop 220ms cubic-bezier(0.22,1,0.36,1);}}
.head{{display:flex;align-items:center;gap:10px;margin:2px 6px 12px;}}
.head .e{{font-family:"Segoe UI Emoji","Apple Color Emoji",sans-serif;font-size:22px;}}
.head .h{{font-size:14px;font-weight:600;color:rgba(235,235,245,0.85);}}
.head .hint{{margin-left:auto;font-size:11px;color:rgba(235,235,245,0.5);}}
.row{{display:flex;align-items:center;gap:12px;padding:9px 12px;border-radius:12px;
  margin-bottom:6px;background:rgba(255,255,255,0.04);transition:background 120ms;}}
.row.active{{background:rgba(10,132,255,0.24);outline:1.5px solid rgba(10,132,255,0.7);}}
.ico{{width:24px;height:24px;flex:none;image-rendering:auto;}}
.text{{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;}}
.label{{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}}
.label code{{font-family:"Cascadia Code",Consolas,monospace;font-size:12.5px;
  background:rgba(255,255,255,0.12);padding:1px 5px;border-radius:5px;}}
.label b{{font-weight:700;}} .label i{{font-style:italic;}}
.meta{{display:flex;align-items:center;gap:8px;font-size:11px;}}
.meta .who{{color:#FFD79A;font-weight:600;}}
.meta .fmt{{color:rgba(235,235,245,0.45);text-transform:uppercase;letter-spacing:0.4px;}}
.empty{{padding:20px;text-align:center;color:rgba(235,235,245,0.5);}}
{anim}
</style></head><body><div class="wrap">
<div class="head"><span class="e">📋</span><span class="h">Senaste clips</span>
<span class="hint">↑ ↓ välj • Enter kopiera • Esc stäng</span></div>
{rows}
</div>
<script>
// Move the highlight WITHOUT reloading the document (reloading caused a visible
// flash on every arrow press). The Rust side calls window.sel(i) on navigation.
window.sel = function(i) {{
  var rows = document.querySelectorAll('.row');
  for (var r = 0; r < rows.length; r++) {{
    var on = String(r) === String(i);
    rows[r].classList.toggle('active', on);
    if (on && rows[r].scrollIntoView) rows[r].scrollIntoView({{block:'nearest'}});
  }}
}};
</script>
</body></html>"#,
        base = BASE_CSS,
        anim = ANIM_CSS,
        rows = rows,
    )
}

const ICON_CLIP: &str = include_str!("icon_clip.b64");
const ICON_SLACK: &str = include_str!("icon_slack.b64");
const ICON_MURAL: &str = include_str!("icon_mural.b64");
const ICON_IMAGE: &str = include_str!("icon_image.b64");
const ICON_PROMPT: &str = include_str!("icon_prompt.b64");
const ICON_TEAMS: &str = include_str!("icon_teams.b64");
const ICON_OUTLOOK: &str = include_str!("icon_outlook.b64");
const ICON_CONSOLE: &str = include_str!("icon_console.b64");
const ICON_FIGMA: &str = include_str!("icon_figma.b64");
const ICON_URL: &str = include_str!("icon_url.b64");
const ICON_PLAIN: &str = include_str!("icon_plain.b64");
const ICON_READ: &str = include_str!("icon_read.b64");

/// Meta row ("sender · detail"). `has_keys` reserves right-hand room so the detail text
/// never runs under the corner keycaps. `detail` is escaped text (may still contain inline
/// markup from an earlier `esc`+`keycaps` pass if the caller chose to keep Ctrl+V inline).
fn meta_html(agent: &str, detail: &str, has_keys: bool) -> String {
    let agent = agent.trim();
    if agent.is_empty() && detail.is_empty() {
        return String::new();
    }
    let cls = if has_keys { " has-keys" } else { "" };
    // Long details (file paths) may wrap to 2 lines; short ones stay on one line (no odd mid-phrase break).
    let wrap = if detail.chars().count() > 32 { " wrap-detail" } else { "" };
    let who = if agent.is_empty() {
        String::new()
    } else {
        format!("<b class=\"who\">{}</b>", esc(agent))
    };
    let sep = if !agent.is_empty() && !detail.is_empty() { "<span class=\"sep\">\u{00b7}</span>" } else { "" };
    let det = if detail.is_empty() { String::new() } else { format!("<span class=\"detail\">{}</span>", esc(detail)) };
    format!("<div class=\"meta{cls}{wrap}\">{who}{sep}{det}</div>", cls = cls, wrap = wrap, who = who, sep = sep, det = det)
}

/// The discreet shortcut hint, bottom-right. `keys` is raw text like "Ctrl+V" or
/// "Ctrl+Shift+V"; empty => nothing rendered. Reuses the same shortcut parser as `keycaps`.
fn keys_corner_html(keys: &str) -> String {
    if keys.trim().is_empty() {
        return String::new();
    }
    format!("<div class=\"keys\">{}</div>", keycaps(&esc(keys)))
}

#[cfg(test)]
mod layout_tests {
    use super::{keys_corner_html, meta_html, toast_html, ToastView};

    #[test]
    fn should_render_nothing_when_meta_is_fully_empty() {
        assert_eq!(meta_html("", "", false), "");
    }

    #[test]
    fn should_render_only_the_agent_when_there_is_no_detail() {
        assert_eq!(meta_html("pp", "", false), "<div class=\"meta\"><b class=\"who\">pp</b></div>");
    }

    #[test]
    fn should_separate_agent_and_detail_with_a_middle_dot() {
        let html = meta_html("pp", "142 tecken", false);
        assert!(html.contains("<b class=\"who\">pp</b>"));
        assert!(html.contains("<span class=\"sep\">\u{00b7}</span>"));
        assert!(html.contains("<span class=\"detail\">142 tecken</span>"));
    }

    #[test]
    fn should_reserve_room_for_keys_when_present() {
        assert!(meta_html("pp", "x", true).contains("meta has-keys"));
        assert!(!meta_html("pp", "x", false).contains("has-keys"));
    }

    #[test]
    fn should_render_empty_corner_when_no_keys_given() {
        assert_eq!(keys_corner_html(""), "");
        assert_eq!(keys_corner_html("   "), "");
    }

    #[test]
    fn should_render_keycaps_in_the_corner_when_keys_given() {
        let html = keys_corner_html("Ctrl+V");
        assert!(html.starts_with("<div class=\"keys\">"));
        assert!(html.contains("<kbd>"));
    }

    #[test]
    fn notify_kind_uses_megaphone_glyph_teal_tint_and_no_clip_image() {
        let resolved = crate::preset::resolve_kind("notify", "", "", 0);
        let v = ToastView { resolved: &resolved, title: "Deploy klar", subtitle: "pp 4.2.0", agent: "pp", type_label: "", keys: "", scale: 1.0 };
        let html = toast_html(&v);
        assert!(html.contains("\u{1F4E3}"), "megaphone glyph present");
        assert!(!html.contains("<img class=\"emoji"), "no FatCow clip image for notify");
        assert!(html.contains("linear-gradient(135deg,rgba(60,66,66"), "solarized-teal card tint");
    }

    #[test]
    fn clip_kind_still_uses_the_fatcow_image() {
        let resolved = crate::preset::resolve_kind("clip", "", "", 0);
        let v = ToastView { resolved: &resolved, title: "Text klar", subtitle: "", agent: "pp", type_label: "Write \u{00b7} Slack", keys: "Ctrl+V", scale: 1.0 };
        let html = toast_html(&v);
        assert!(html.contains("<img class=\"emoji"), "clip uses the FatCow image");
    }
}
/// Labels may carry the operation: "Read · Image" -> magnifier (every read looks the same),
/// "Write · Slack" -> the Slack icon. Unknown falls back to the clipboard glyph.
fn icon_for(type_label: &str) -> &'static str {
    let l = type_label.trim().to_lowercase();
    if l.starts_with("read") || l.starts_with("läst") || l.starts_with("lens") {
        return ICON_READ;
    }
    // "write · slack" -> "slack"
    let key = l.rsplit('\u{00b7}').next().unwrap_or(&l).trim().to_string();
    match key.as_str() {
        "read" | "läst" | "lens" => ICON_READ,
        "slack" => ICON_SLACK,
        "mural" | "mural-widgets" => ICON_MURAL,
        "image" | "bild" => ICON_IMAGE,
        "prompt" => ICON_PROMPT,
        "teams" | "html" => ICON_TEAMS,
        "outlook" | "email" | "mail" => ICON_OUTLOOK,
        "console" => ICON_CONSOLE,
        "figma" => ICON_FIGMA,
        "url" | "link" => ICON_URL,
        "plain" | "normal" | "vanilla" | "text" => ICON_PLAIN,
        _ => ICON_CLIP,
    }
}
const BASE_CSS: &str = r#"html,body{margin:0;padding:0;height:100%;width:100%;background:transparent;overflow:hidden;
font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,sans-serif;user-select:none;cursor:default;}
.text{display:flex;flex-direction:column;}"#;

const ANIM_CSS: &str = r#"@keyframes pop{0%{opacity:0;transform:scale(0.97);}100%{opacity:1;transform:scale(1);}}
@keyframes wiggle{0%,100%{transform:rotate(0) scale(1);}25%{transform:rotate(-4deg) scale(1.03);}75%{transform:rotate(4deg) scale(1.03);}}
@keyframes pulse{0%,100%{transform:scale(1);opacity:0.85;}50%{transform:scale(1.12);opacity:1;}}
@keyframes bounce{0%{transform:translateY(-40%) scale(0.6);opacity:0;}55%{transform:translateY(8%) scale(1.15);opacity:1;}100%{transform:translateY(0) scale(1);}}
@keyframes shimmer{0%{background-position:200% 0;}100%{background-position:-200% 0;}}
@keyframes railflow{0%{background-position:0 0;}100%{background-position:0 300%;}}
.confetti{position:absolute;inset:0;pointer-events:none;overflow:hidden;}
.confetti span{position:absolute;top:-12px;width:7px;height:11px;border-radius:2px;opacity:0;
  animation-name:confall;animation-timing-function:cubic-bezier(0.3,0.7,0.4,1);animation-iteration-count:1;animation-fill-mode:forwards;}
@keyframes confall{0%{transform:translateY(-12px) rotate(0);opacity:0;}
  12%{opacity:1;}100%{transform:translateY(120px) rotate(var(--rot));opacity:0;}}"#;

/// Turn shortcut text like "Ctrl+V" / "Ctrl+Shift+V" (in already-escaped HTML) into subtle
/// keycaps. On macOS Ctrl -> Command (U+2318) and Shift -> U+21E7, as a Mac user expects.
/// Anything that is not a full shortcut ("Ctrl+" alone, "Ctrl+Vx") is left as plain text.
pub fn keycaps(escaped: &str) -> String {
    keycaps_for(escaped, cfg!(target_os = "macos"))
}

fn keycaps_for(escaped: &str, mac: bool) -> String {
    let (ctrl, shift) = if mac { ("\u{2318}", "\u{21E7}") } else { ("Ctrl", "Shift") };
    let cap = |k: &str| format!("<kbd>{}</kbd>", k);
    let mut out = String::with_capacity(escaped.len() + 32);
    let mut rest = escaped;
    while let Some(pos) = rest.find("Ctrl+") {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 5..];
        let (has_shift, tail) = match after.strip_prefix("Shift+") {
            Some(t) => (true, t),
            None => (false, after),
        };
        let mut chars = tail.chars();
        let key = chars.next();
        let next = chars.next();
        match key {
            Some(k) if k.is_ascii_alphanumeric() && !next.map_or(false, |n| n.is_ascii_alphanumeric()) => {
                out.push_str(&cap(ctrl));
                if has_shift {
                    out.push_str(&cap(shift));
                }
                out.push_str(&cap(&k.to_ascii_uppercase().to_string()));
                rest = &tail[k.len_utf8()..];
            }
            _ => {
                out.push_str("Ctrl+"); // not a shortcut, keep the text
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod keycap_tests {
    use super::keycaps_for;

    #[test]
    fn should_render_ctrl_v_as_two_keycaps_on_windows() {
        assert_eq!(keycaps_for("142 tecken · Ctrl+V", false), "142 tecken · <kbd>Ctrl</kbd><kbd>V</kbd>");
    }

    #[test]
    fn should_use_command_and_shift_symbols_on_mac() {
        assert_eq!(keycaps_for("Ctrl+Shift+V i Slack", true), "<kbd>\u{2318}</kbd><kbd>\u{21E7}</kbd><kbd>V</kbd> i Slack");
    }

    #[test]
    fn should_leave_text_alone_when_it_is_not_a_full_shortcut() {
        assert_eq!(keycaps_for("Ctrl+ alone, Ctrl+Vx", false), "Ctrl+ alone, Ctrl+Vx");
        assert_eq!(keycaps_for("no shortcut here", false), "no shortcut here");
    }
}

/// What a reminder card shows.
pub struct ReminderView<'a> {
    pub title: &'a str,
    pub subtitle: &'a str,
    pub agent: &'a str,
    /// "snoozed 2x" etc, empty when none.
    pub note: &'a str,
    pub scale: f64,
}

/// A reminder card: a real checkbox (the only way to finish it) and three snooze buttons.
/// Clicking the card body does nothing; clicking OUTSIDE the window is handled by the daemon
/// (auto-snooze 30 min). The page talks to the daemon with `window.ipc.postMessage`:
/// `done`, `snooze:5`, `snooze:30`, `snooze:tomorrow`.
pub fn reminder_html(v: &ReminderView) -> String {
    let sub = meta_html(v.agent, v.subtitle, false);
    let note = if v.note.is_empty() {
        String::new()
    } else {
        format!(r#"<span class="chip">{}</span>"#, esc(v.note))
    };
    format!(
        r#"<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>
{base}
:root{{--scale:{scale};}}
.wrap{{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;}}
.toast{{position:relative;display:flex;flex-direction:column;justify-content:center;gap:calc(12px*var(--scale));
  width:100%;height:100%;box-sizing:border-box;padding:0 calc(24px*var(--scale));
  background:linear-gradient(135deg,rgba(60,66,66,0.93),rgba(74,54,40,0.93));
  border-radius:calc(22px*var(--scale));color:#F5EFE8;animation:pop 420ms cubic-bezier(0.22,1,0.36,1);}}
.top{{display:flex;align-items:center;gap:calc(14px*var(--scale));min-width:0;}}
.box{{flex:0 0 auto;width:calc(30px*var(--scale));height:calc(30px*var(--scale));box-sizing:border-box;
  border:2px solid #2AA198;border-radius:calc(9px*var(--scale));background:rgba(255,255,255,0.06);
  cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:calc(20px*var(--scale));color:transparent;}}
.box:hover{{background:rgba(42,161,152,0.28);color:#2AA198;}}
.box.on{{background:#2AA198;color:#fff;}}
.text{{flex:1;min-width:0;display:flex;flex-direction:column;gap:calc(4px*var(--scale));}}
.title{{display:flex;align-items:center;gap:calc(9px*var(--scale));min-width:0;font-size:calc(20px*var(--scale));font-weight:600;line-height:1.15;}}
.title .t{{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}}
.chip{{flex:0 0 auto;font-size:calc(10px*var(--scale));font-weight:700;text-transform:uppercase;letter-spacing:0.4px;line-height:1;
  background:rgba(255,255,255,0.16);padding:calc(3px*var(--scale)) calc(7px*var(--scale));border-radius:calc(6px*var(--scale));}}
.meta{{display:flex;align-items:baseline;gap:calc(6px*var(--scale));min-width:0;font-size:calc(13.5px*var(--scale));color:rgba(235,235,245,0.62);}}
.meta .who{{flex:0 0 auto;color:#F5EFE8;font-weight:700;}}
.meta .sep{{flex:0 0 auto;opacity:0.4;}}
.meta .detail{{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}}
.snooze{{display:flex;align-items:center;gap:calc(8px*var(--scale));padding-left:calc(44px*var(--scale));}}
.snooze .lbl{{font-size:calc(12px*var(--scale));opacity:0.55;margin-right:calc(2px*var(--scale));}}
.sn{{cursor:pointer;font:600 calc(12.5px*var(--scale))/1 "Segoe UI",-apple-system,sans-serif;color:#F5EFE8;
  background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.22);border-radius:calc(8px*var(--scale));
  padding:calc(6px*var(--scale)) calc(11px*var(--scale));}}
.sn:hover{{background:rgba(255,255,255,0.22);}}
{anim}
</style></head><body><div class="wrap"><div class="toast">
<div class="top"><div class="box" id="box" role="checkbox" aria-checked="false" aria-label="Done" onclick="this.classList.add('on');this.textContent='\u2713';window.ipc.postMessage('done')">&#10003;</div>
<div class="text"><div class="title"><span class="t">{title}</span>{note}</div>{sub}</div></div>
<div class="snooze"><span class="lbl">Snooze</span>
<button class="sn" onclick="window.ipc.postMessage('snooze:5')">5 min</button>
<button class="sn" onclick="window.ipc.postMessage('snooze:30')">30 min</button>
<button class="sn" onclick="window.ipc.postMessage('snooze:tomorrow')">Imorgon</button></div>
</div></div></body></html>"#,
        base = BASE_CSS,
        anim = ANIM_CSS,
        scale = v.scale,
        title = esc(v.title),
        note = note,
        sub = sub,
    )
}

#[cfg(test)]
mod reminder_tests {
    use super::*;

    fn view<'a>(title: &'a str) -> ReminderView<'a> {
        ReminderView { title, subtitle: "", agent: "tooling", note: "", scale: 1.0 }
    }

    #[test]
    fn should_offer_a_checkbox_and_the_three_snoozes() {
        let h = reminder_html(&view("Ring mamma"));
        assert!(h.contains("role=\"checkbox\""));
        assert!(h.contains("postMessage('done')"));
        for s in ["snooze:5", "snooze:30", "snooze:tomorrow"] {
            assert!(h.contains(s), "missing {s}");
        }
    }

    #[test]
    fn should_not_close_or_post_anything_when_the_card_body_is_clicked() {
        let h = reminder_html(&view("x"));
        assert!(!h.contains("class=\"toast\" onclick"));
    }

    #[test]
    fn should_escape_html_in_title_and_subtitle() {
        let mut v = view("<img src=x onerror=alert(1)>");
        v.subtitle = "<script>alert(2)</script>";
        let h = reminder_html(&v);
        assert!(!h.contains("<img src=x"));
        assert!(!h.contains("<script>alert(2)"));
        assert!(h.contains("&lt;img"));
    }
}