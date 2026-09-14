// build.rs — copy the bundled notification sounds next to the built binary.
//
// The daemon plays a named sound by looking for `sounds/<name>.wav` beside the
// executable (see play_sound in main.rs). Cargo builds the binary into
// target/<profile>/, so the sounds must be copied there or every named sound
// silently no-ops. Doing it in build.rs means it happens on every build, for
// everyone, with no manual step.
use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=sounds");

    // OUT_DIR is target/<profile>/build/<pkg>-<hash>/out — walk up to <profile>/.
    let out_dir = match env::var("OUT_DIR") {
        Ok(d) => PathBuf::from(d),
        Err(_) => return,
    };
    // out -> <pkg>-<hash> -> build -> <profile>
    let profile_dir = out_dir
        .ancestors()
        .nth(3)
        .map(PathBuf::from);
    let Some(profile_dir) = profile_dir else { return };

    let src = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_default()).join("sounds");
    if !src.is_dir() {
        return;
    }
    let dst = profile_dir.join("sounds");
    let _ = fs::create_dir_all(&dst);

    if let Ok(entries) = fs::read_dir(&src) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) == Some("wav") {
                if let Some(name) = p.file_name() {
                    let _ = fs::copy(&p, dst.join(name));
                }
            }
        }
    }
}
