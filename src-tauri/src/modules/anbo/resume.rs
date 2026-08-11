//! Resume strategy — IP inti anbo (port dari server/src/resume-strategy.ts +
//! opencode-discover.ts, lihat juga desktop-rust/src/resume.rs).
//!
//! Tiap tab agen me-resume percakapannya SENDIRI setelah restart. CLI yang bisa
//! resume-by-id (claude, opencode) dipetakan ke strategi `discover`: kita capture
//! session-id ASLI yang dibuat CLI post-hoc, lalu pin → restart resume by-id.
//! Gagal capture → fallback `--continue` (never-worse).
//!
//! Spike ini mengandung discoverer claude (lengkap & teruji). opencode (log parse)
//! + integrasi ke pty/session.rs spawn menyusul.

use std::collections::HashSet;

/// Dir projects claude (port claudeProjectsDir). Override via env utk test.
/// Default: ~/.claude/projects.
pub fn claude_projects_dir() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("ANBO_CLAUDE_PROJECTS") {
        return std::path::PathBuf::from(p);
    }
    // Legacy name from before the anbo rebrand — keep honoring it so existing
    // setups/test harnesses aren't silently dropped, but nudge toward the new.
    if let Ok(p) = std::env::var("ANBOAI_CLAUDE_PROJECTS") {
        log::warn!(
            "ANBOAI_CLAUDE_PROJECTS is deprecated; rename it to ANBO_CLAUDE_PROJECTS"
        );
        return std::path::PathBuf::from(p);
    }
    dirs::home_dir()
        .map(|h| h.join(".claude").join("projects"))
        .unwrap_or_else(|| std::path::PathBuf::from(".claude/projects"))
}

/// Encode cwd claude → nama folder (port encodeClaudeCwd opencode-discover.ts:64).
/// claude mengganti SETIAP char non-alfanumerik jadi '-' (bukan cuma \ / : — juga
/// spasi, kurung, titik). "D:\a\OFFLINE SCADA" → "D--a-OFFLINE-SCADA".
/// Dulu hanya /[\\/:]/ → cwd berspasi meleset folder → transkrip tak ketemu.
pub fn encode_claude_cwd(cwd: &str) -> String {
    let resolved = std::fs::canonicalize(cwd)
        .map(|p| strip_verbatim_prefix(&p.to_string_lossy()))
        .unwrap_or_else(|_| cwd.to_string());
    resolved
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Strip the `\\?\` verbatim prefix that `std::fs::canonicalize` prepends on
/// Windows. Claude Code (Node `process.cwd()`) reports the path WITHOUT this
/// prefix, so leaving it would make the encoded projects folder name gain
/// leading dashes (`----C--...`) and never match the folder Claude creates.
/// Verbatim UNC (`\\?\UNC\server\share`) maps back to the Node form
/// (`\\server\share`). No-op on platforms that don't add the prefix.
fn strip_verbatim_prefix(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest)
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        p.to_string()
    }
}

/// UUID v4 format check: 8-4-4-4-12 hex.
fn is_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 5 {
        return false;
    }
    let lens = [8, 4, 4, 4, 12];
    parts
        .iter()
        .zip(lens.iter())
        .all(|(p, &l)| p.len() == l && p.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Cari UUID claude yg DIBUAT di `cwd` setelah `since_ts` (epoch ms) & belum di-claim
/// (port findClaudeSession opencode-discover.ts:72). Sumber: file `<uuid>.jsonl` di
/// folder project claude (birthtime = saat sesi dibuat). Return UUID TERBARU yang
/// cocok, atau None (→ pemanggil fallback `--continue`, never-worse).
pub fn find_claude_session(cwd: &str, since_ts: u64, claimed: &HashSet<String>) -> Option<String> {
    let dir = claude_projects_dir().join(encode_claude_cwd(cwd));
    let entries = std::fs::read_dir(&dir).ok()?;
    let mut best: Option<(String, u64)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".jsonl") {
            continue;
        }
        let id = &name[..name.len() - 6];
        if !is_uuid(id) {
            continue;
        }
        if claimed.contains(id) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        // birthtime = saat sesi dibuat (presisi utk filter since_ts); fallback mtime.
        let ts = meta
            .created()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .or_else(|| {
                meta.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
            });
        let ts = match ts {
            Some(t) => t,
            None => continue,
        };
        if ts < since_ts {
            continue;
        }
        if best.as_ref().is_none_or(|(_, b_ts)| ts > *b_ts) {
            best = Some((id.to_string(), ts));
        }
    }
    best.map(|(id, _)| id).inspect(|id| {
        log::info!("[anbo] discover claude → sesi {id} (cwd={cwd})");
    })
}

/// Command Tauri: discover session-id claude utk cwd setelah since_ts.
/// `claimed` = sesi yg sudah dipin tab lain (cegah bentrok multi-tab di cwd sama).
/// Return UUID terbaru yang cocok, atau null.
#[tauri::command]
pub fn anbo_find_claude_session(
    cwd: String,
    since_ts: u64,
    claimed: Vec<String>,
) -> Option<String> {
    let claimed: HashSet<String> = claimed.into_iter().collect();
    find_claude_session(&cwd, since_ts, &claimed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    #[test]
    fn uuid_validation() {
        assert!(is_uuid("a1b2c3d4-e5f6-7890-abcd-ef1234567890"));
        assert!(!is_uuid("not-a-uuid"));
        assert!(!is_uuid("a1b2c3d4-e5f6-7890")); // terlalu pendek
        assert!(!is_uuid("a1b2c3d4-e5f6-7890-abcd-ef1234567890-extra"));
    }

    // Versi encode tanpa canonicalize (canonicalize butuh path nyata di disk;
    // utk unit test string murni, bypass fs). Setiap char non-alfanumerik → '-'.
    fn encode_segments_only(cwd: &str) -> String {
        cwd.chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect()
    }

    #[test]
    fn encode_replaces_all_non_alphanumeric() {
        // Spasi, kurung, titik, slash, colon — SEMUA → '-'.
        assert_eq!(
            encode_segments_only("D:\\a\\OFFLINE SCADA"),
            "D--a-OFFLINE-SCADA"
        );
        assert_eq!(encode_segments_only("FLORES (FCC)"), "FLORES--FCC-");
    }

    #[test]
    fn strip_verbatim_prefix_matches_node_cwd() {
        // Windows canonicalize adds `\\?\`; Node process.cwd() (what Claude
        // derives the projects folder from) does not. After stripping, the
        // encoded name must NOT gain leading dashes.
        let enc = |p: &str| -> String {
            strip_verbatim_prefix(p)
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                .collect()
        };
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\Users\ramdan\my-app"),
            r"C:\Users\ramdan\my-app"
        );
        assert_eq!(
            enc(r"\\?\C:\Users\ramdan\my-app"),
            "C--Users-ramdan-my-app"
        );
        assert_eq!(
            enc(r"\\?\C:\Users\ramdan\my-app"),
            enc(r"C:\Users\ramdan\my-app"),
            "verbatim and non-verbatim must encode identically"
        );
        // Verbatim UNC → Node UNC form.
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\dir"),
            r"\\server\share\dir"
        );
        // No prefix (non-Windows / already Node form) → unchanged.
        assert_eq!(strip_verbatim_prefix(r"/home/ramdan/my-app"), r"/home/ramdan/my-app");
    }

    #[test]
    fn find_returns_newest_unclaimed_and_respects_filters() {
        // Isolasi: arahkan ANBO_CLAUDE_PROJECTS ke tmp dir.
        let tmp = std::env::temp_dir().join(format!("anbo-spike-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("ANBO_CLAUDE_PROJECTS", &tmp);

        // cwd NYATA (jadi canonicalize di encode_claude_cwd berhasil). Nama folder
        // project di-derive lewat fungsi encode yang SAMA → tak bisa mismatch.
        let cwd_dir = tmp.join("my proj");
        fs::create_dir_all(&cwd_dir).unwrap();
        let cwd = cwd_dir.to_string_lossy().into_owned();
        let proj = claude_projects_dir().join(encode_claude_cwd(&cwd));
        fs::create_dir_all(&proj).unwrap();

        let old_id = "11111111-1111-1111-1111-111111111111";
        let new_id = "22222222-2222-2222-2222-222222222222";
        // Buat berurutan dgn jeda → created(new) > created(old) deterministik
        // (tanpa set_created, yg tak ada di toolchain <1.79). Lalu satu non-uuid.
        write_jsonl(&proj.join(format!("{old_id}.jsonl")));
        thread::sleep(Duration::from_millis(20));
        write_jsonl(&proj.join(format!("{new_id}.jsonl")));
        write_jsonl(&proj.join("bukan-uuid.jsonl")); // diabaikan: bukan UUID

        // (A) since_ts=0 → yg TERBARU (new_id). Bukti: scan + encode folder + uuid.
        let found = find_claude_session(&cwd, 0, &HashSet::new());
        assert_eq!(found.as_deref(), Some(new_id), "harus ambil sesi TERBARU");

        // (B) claimed new_id → old masih ada & unclaimed → fallback ke old_id.
        let mut claimed = HashSet::new();
        claimed.insert(new_id.to_string());
        let found2 = find_claude_session(&cwd, 0, &claimed);
        assert_eq!(
            found2.as_deref(),
            Some(old_id),
            "claimed new → fallback old"
        );

        // (C) since_ts di masa depan → semua sesi (created≈now) < since → None.
        let future = now_ms() + 3_600_000;
        let found3 = find_claude_session(&cwd, future, &HashSet::new());
        assert!(
            found3.is_none(),
            "since_ts masa depan → tak ada yg eligible"
        );

        std::env::remove_var("ANBO_CLAUDE_PROJECTS");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// Tulis file jsonl dummy (isi tak relevan — discoverer cuma baca nama + mtime).
    fn write_jsonl(path: &std::path::Path) {
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(b"{}\n").unwrap();
    }
}
