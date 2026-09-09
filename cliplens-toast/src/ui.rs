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
    pub scale: f64,
}

/// A single toast card: accent rail + emoji + title/subtitle + agent badge.
/// Kind drives animation (calm wiggle / progress shimmer / celebrate confetti).
pub fn toast_html(v: &ToastView) -> String {
    let kind = v.resolved.kind.as_str();
    let accent = esc(&v.resolved.accent);
    let emoji = esc(&v.resolved.emoji);

    let sub = if v.subtitle.is_empty() {
        String::new()
    } else {
        format!("<div class=\"sub\">{}</div>", esc(v.subtitle))
    };

    let badge = if v.agent.trim().is_empty() {
        String::new()
    } else {
        format!("<div class=\"badge\">{}</div>", esc(v.agent))
    };

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

    // Clip uses a FatCow icon chosen by clip type (embedded); other kinds keep their emoji glyph.
    let icon_el = if kind == "clip" {
        format!(r#"<img class="emoji {a}" src="data:image/png;base64,{ic}"/>"#, a = emoji_anim, ic = icon_for(v.type_label))
    } else {
        format!(r#"<div class="emoji {a}">{e}</div>"#, a = emoji_anim, e = emoji)
    };

    // Optional clip-type chip (Slack / Mural / Image / Prompt / Normal / Vanilla ...).
    let chip = if v.type_label.trim().is_empty() {
        String::new()
    } else {
        format!(r#"<span class="chip">{}</span>"#, esc(v.type_label))
    };

    format!(
        r#"<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>
{base}
:root{{--scale:{scale};--accent:{accent};}}
.wrap{{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;}}
.toast{{position:relative;display:flex;align-items:center;gap:calc(18px*var(--scale));
  width:100%;height:100%;box-sizing:border-box;
  padding:0 calc(30px*var(--scale)) 0 calc(28px*var(--scale));
  background:rgba(74,54,40,0.90);border-radius:calc(22px*var(--scale));color:#F5EFE8;
  cursor:pointer;animation:pop 420ms cubic-bezier(0.22,1,0.36,1);}}
.toast:active{{transform:scale(0.98);}}
.rail{{position:absolute;left:0;top:14%;bottom:14%;width:4px;border-radius:4px;{rail_style}}}
.emoji{{font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif;
  font-size:calc(52px*var(--scale));line-height:1;
  filter:drop-shadow(0 0 calc(14px*var(--scale)) {accent}88);}}
img.emoji{{width:32px;height:32px;object-fit:contain;filter:none;image-rendering:-webkit-optimize-contrast;}}
.chip{{display:inline-block;font-size:calc(10px*var(--scale));font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#F5EFE8;background:rgba(255,255,255,0.16);padding:1px calc(7px*var(--scale));border-radius:calc(6px*var(--scale));margin-right:calc(7px*var(--scale));vertical-align:2px;}}
.emoji.wiggle{{animation:wiggle 2s ease-in-out infinite;}}
.emoji.pulse{{animation:pulse 1.3s ease-in-out infinite;}}
.emoji.bounce{{animation:bounce 900ms cubic-bezier(0.22,1.4,0.4,1);}}
.title{{font-size:calc(21px*var(--scale));font-weight:600;line-height:1.15;}}
.sub{{font-size:calc(14px*var(--scale));color:rgba(235,235,245,0.62);margin-top:calc(3px*var(--scale));}}
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
<div class="text"><div class="title">{chip}{title}</div>{sub}</div>
{badge}
{shimmer}
{confetti}
</div></div></body></html>"#,
        base = BASE_CSS,
        anim = ANIM_CSS,
        scale = v.scale,
        accent = accent,
        rail_style = rail_style,
        icon = icon_el,
        chip = chip,
        title = esc(v.title),
        sub = sub,
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

/// Pick the embedded FatCow icon for a clip's type label (case-insensitive).
/// Unknown falls back to the clipboard glyph.
fn icon_for(type_label: &str) -> &'static str {
    match type_label.trim().to_ascii_lowercase().as_str() {
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
