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
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::modules::workspace::{authorize_existing_path, WorkspaceEnv, WorkspaceRegistry};

const CODEX_SESSION_META_MAX_BYTES: u64 = 256 * 1024;
const CODEX_SESSION_SCAN_LIMIT: usize = 20_000;
const SESSION_LOG_TAIL_MAX_BYTES: u64 = 2 * 1024 * 1024;
const ANTIGRAVITY_DB_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// Dir projects claude (port claudeProjectsDir). Override via env utk test.
/// Default: ~/.claude/projects.
pub fn claude_projects_dir() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("ANBO_CLAUDE_PROJECTS") {
        return std::path::PathBuf::from(p);
    }
    // Legacy name from before the anbo rebrand — keep honoring it so existing
    // setups/test harnesses aren't silently dropped, but nudge toward the new.
    if let Ok(p) = std::env::var("ANBOAI_CLAUDE_PROJECTS") {
        log::warn!("ANBOAI_CLAUDE_PROJECTS is deprecated; rename it to ANBO_CLAUDE_PROJECTS");
        return std::path::PathBuf::from(p);
    }
    dirs::home_dir()
        .map(|h| h.join(".claude").join("projects"))
        .unwrap_or_else(|| std::path::PathBuf::from(".claude/projects"))
}

fn codex_sessions_dir() -> PathBuf {
    if let Ok(path) = std::env::var("ANBO_CODEX_SESSIONS") {
        return PathBuf::from(path);
    }
    if let Ok(home) = std::env::var("CODEX_HOME") {
        return PathBuf::from(home).join("sessions");
    }
    dirs::home_dir()
        .map(|home| home.join(".codex").join("sessions"))
        .unwrap_or_else(|| PathBuf::from(".codex/sessions"))
}

fn opencode_log_path() -> PathBuf {
    std::env::var_os("ANBO_OPENCODE_LOG")
        .map(PathBuf::from)
        .or_else(|| {
            dirs::home_dir().map(|home| {
                home.join(".local")
                    .join("share")
                    .join("opencode")
                    .join("log")
                    .join("opencode.log")
            })
        })
        .unwrap_or_else(|| PathBuf::from(".local/share/opencode/log/opencode.log"))
}

fn antigravity_conversations_dir() -> PathBuf {
    std::env::var_os("ANBO_ANTIGRAVITY_CONVERSATIONS")
        .map(PathBuf::from)
        .or_else(|| {
            dirs::home_dir().map(|home| {
                home.join(".gemini")
                    .join("antigravity-cli")
                    .join("conversations")
            })
        })
        .unwrap_or_else(|| PathBuf::from(".gemini/antigravity-cli/conversations"))
}

fn pi_sessions_dir() -> PathBuf {
    std::env::var_os("ANBO_PI_SESSIONS")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".pi").join("agent").join("sessions")))
        .unwrap_or_else(|| PathBuf::from(".pi/agent/sessions"))
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

fn normalized_cwd(path: &str) -> String {
    let resolved = std::fs::canonicalize(path)
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .into_owned();
    let value = strip_verbatim_prefix(&resolved)
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn session_created_ms(path: &Path) -> Option<u64> {
    let metadata = path.metadata().ok()?;
    metadata
        .created()
        .ok()
        .or_else(|| metadata.modified().ok())?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn codex_session_meta(path: &Path) -> Option<(String, String)> {
    let file = std::fs::File::open(path).ok()?;
    let mut input = String::new();
    file.take(CODEX_SESSION_META_MAX_BYTES)
        .read_to_string(&mut input)
        .ok()?;
    let first_line = input.lines().next()?;
    let value: serde_json::Value = serde_json::from_str(first_line).ok()?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = value.get("payload")?;
    let id = payload.get("id")?.as_str()?;
    let cwd = payload.get("cwd")?.as_str()?;
    is_uuid(id).then(|| (id.to_string(), cwd.to_string()))
}

fn codex_session_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    let mut inspected = 0usize;

    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            inspected += 1;
            if inspected > CODEX_SESSION_SCAN_LIMIT {
                return files;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file()
                && entry.path().extension().is_some_and(|ext| ext == "jsonl")
            {
                files.push(entry.path());
            }
        }
    }
    files
}

/// Find the newest unclaimed Codex session created in `cwd` after `since_ts`.
/// Codex writes the canonical session UUID and cwd into the first `session_meta`
/// record of each rollout, so resume identity does not depend on terminal hooks.
pub fn find_codex_session(cwd: &str, since_ts: u64, claimed: &HashSet<String>) -> Option<String> {
    let expected_cwd = normalized_cwd(cwd);
    let mut best: Option<(String, u64)> = None;

    for path in codex_session_files(&codex_sessions_dir()) {
        let Some(created_ms) = session_created_ms(&path) else {
            continue;
        };
        if created_ms < since_ts {
            continue;
        }
        let Some((id, session_cwd)) = codex_session_meta(&path) else {
            continue;
        };
        if claimed.contains(&id) || normalized_cwd(&session_cwd) != expected_cwd {
            continue;
        }
        if best
            .as_ref()
            .is_none_or(|(best_id, best_ts)| (created_ms, &id) > (*best_ts, best_id))
        {
            best = Some((id, created_ms));
        }
    }

    best.map(|(id, _)| id).inspect(|id| {
        log::info!("[anbo] discovered Codex session {id} (cwd={cwd})");
    })
}

#[tauri::command]
pub fn anbo_find_codex_session(
    cwd: String,
    since_ts: u64,
    claimed: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Option<String>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if !matches!(workspace, WorkspaceEnv::Local) {
        return Ok(None);
    }
    let cwd = authorize_existing_path(&registry, &cwd, &workspace)?;
    let claimed = claimed.into_iter().collect();
    Ok(find_codex_session(
        &cwd.to_string_lossy(),
        since_ts,
        &claimed,
    ))
}

fn read_file_tail(path: &Path, max_bytes: u64) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes).ok()?;
    if start > 0 {
        if let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes.drain(..=newline);
        }
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn quoted_log_field(line: &str, key: &str) -> Option<String> {
    let start = line.find(key)? + key.len();
    let tail = line.get(start..)?;
    let end = tail.find('"')?;
    Some(tail[..end].replace("\\\\", "\\"))
}

fn plain_log_field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let start = line.find(key)? + key.len();
    line.get(start..)?.split_whitespace().next()
}

fn find_opencode_session(cwd: &str, since_ts: u64, claimed: &HashSet<String>) -> Option<String> {
    let expected = normalized_cwd(cwd);
    let log = read_file_tail(&opencode_log_path(), SESSION_LOG_TAIL_MAX_BYTES)?;
    let mut best: Option<(String, u64)> = None;
    for line in log.lines() {
        if !line.contains("message=created id=ses_") {
            continue;
        }
        let Some(id) = plain_log_field(line, " id=") else {
            continue;
        };
        if claimed.contains(id) {
            continue;
        }
        let Some(directory) = quoted_log_field(line, " directory=\"") else {
            continue;
        };
        if normalized_cwd(&directory) != expected {
            continue;
        }
        let Some(created) =
            plain_log_field(line, " time.created=").and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };
        if created < since_ts {
            continue;
        }
        if best.as_ref().is_none_or(|(_, ts)| created > *ts) {
            best = Some((id.to_string(), created));
        }
    }
    best.map(|(id, _)| id)
}

fn bytes_contain(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn find_antigravity_session(cwd: &str, since_ts: u64, claimed: &HashSet<String>) -> Option<String> {
    let expected = normalized_cwd(cwd);
    let expected_bytes = expected.as_bytes();
    let mut best: Option<(String, u64)> = None;
    for entry in std::fs::read_dir(antigravity_conversations_dir())
        .ok()?
        .flatten()
    {
        let path = entry.path();
        if path.extension().is_none_or(|extension| extension != "db") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if !is_uuid(id) || claimed.contains(id) {
            continue;
        }
        let Some(created) = session_created_ms(&path) else {
            continue;
        };
        let Ok(metadata) = path.metadata() else {
            continue;
        };
        if created < since_ts || metadata.len() > ANTIGRAVITY_DB_MAX_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let normalized = String::from_utf8_lossy(&bytes)
            .replace('\\', "/")
            .to_ascii_lowercase();
        if !bytes_contain(normalized.as_bytes(), expected_bytes) {
            continue;
        }
        if best.as_ref().is_none_or(|(_, ts)| created > *ts) {
            best = Some((id.to_string(), created));
        }
    }
    best.map(|(id, _)| id)
}

fn pi_session_meta(path: &Path) -> Option<(String, String)> {
    let file = std::fs::File::open(path).ok()?;
    let mut input = String::new();
    file.take(64 * 1024).read_to_string(&mut input).ok()?;
    let value: serde_json::Value = serde_json::from_str(input.lines().next()?).ok()?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("session") {
        return None;
    }
    Some((
        value.get("id")?.as_str()?.to_string(),
        value.get("cwd")?.as_str()?.to_string(),
    ))
}

fn find_pi_session(cwd: &str, since_ts: u64, claimed: &HashSet<String>) -> Option<String> {
    let expected = normalized_cwd(cwd);
    let mut best: Option<(String, u64)> = None;
    for path in codex_session_files(&pi_sessions_dir()) {
        let Some(created) = session_created_ms(&path) else {
            continue;
        };
        if created < since_ts {
            continue;
        }
        let Some((id, directory)) = pi_session_meta(&path) else {
            continue;
        };
        if !is_uuid(&id) || claimed.contains(&id) || normalized_cwd(&directory) != expected {
            continue;
        }
        if best.as_ref().is_none_or(|(_, ts)| created > *ts) {
            best = Some((id, created));
        }
    }
    best.map(|(id, _)| id)
}

#[tauri::command]
pub fn anbo_find_agent_session(
    agent: String,
    cwd: String,
    since_ts: u64,
    claimed: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Option<String>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if !matches!(workspace, WorkspaceEnv::Local) {
        return Ok(None);
    }
    let cwd = authorize_existing_path(&registry, &cwd, &workspace)?;
    let cwd = cwd.to_string_lossy();
    let claimed: HashSet<String> = claimed.into_iter().collect();
    let session = match agent.as_str() {
        "claude" => find_claude_session(&cwd, since_ts, &claimed),
        "codex" => find_codex_session(&cwd, since_ts, &claimed),
        "antigravity" => find_antigravity_session(&cwd, since_ts, &claimed),
        "pi" => find_pi_session(&cwd, since_ts, &claimed),
        "opencode" => find_opencode_session(&cwd, since_ts, &claimed),
        _ => None,
    };
    Ok(session)
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
        assert_eq!(enc(r"\\?\C:\Users\ramdan\my-app"), "C--Users-ramdan-my-app");
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
        assert_eq!(
            strip_verbatim_prefix(r"/home/ramdan/my-app"),
            r"/home/ramdan/my-app"
        );
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

    #[test]
    fn codex_discovery_matches_cwd_time_and_unclaimed_session() {
        let tmp = std::env::temp_dir().join(format!("anbo-codex-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let sessions = tmp.join("sessions").join("2026").join("08").join("16");
        let cwd = tmp.join("project");
        let other_cwd = tmp.join("other-project");
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&other_cwd).unwrap();
        std::env::set_var("ANBO_CODEX_SESSIONS", tmp.join("sessions"));

        let old_id = "01a00862-cfd1-72e0-a7b4-a4a50f9e0e29";
        let new_id = "01a00863-1111-7222-a333-444444444444";
        let other_id = "01a00864-5555-7666-a777-888888888888";
        write_codex_rollout(
            &sessions.join(format!("rollout-old-{old_id}.jsonl")),
            old_id,
            &cwd,
        );
        thread::sleep(Duration::from_millis(20));
        write_codex_rollout(
            &sessions.join(format!("rollout-new-{new_id}.jsonl")),
            new_id,
            &cwd,
        );
        thread::sleep(Duration::from_millis(20));
        write_codex_rollout(
            &sessions.join(format!("rollout-other-{other_id}.jsonl")),
            other_id,
            &other_cwd,
        );

        assert_eq!(
            find_codex_session(&cwd.to_string_lossy(), 0, &HashSet::new()).as_deref(),
            Some(new_id)
        );

        let mut claimed = HashSet::new();
        claimed.insert(new_id.to_string());
        assert_eq!(
            find_codex_session(&cwd.to_string_lossy(), 0, &claimed).as_deref(),
            Some(old_id)
        );
        assert!(find_codex_session(
            &cwd.to_string_lossy(),
            now_ms() + 3_600_000,
            &HashSet::new(),
        )
        .is_none());

        std::env::remove_var("ANBO_CODEX_SESSIONS");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn hookless_discovery_reads_opencode_antigravity_and_pi_storage() {
        let tmp = std::env::temp_dir().join(format!("anbo-agent-stores-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let cwd = tmp.join("project");
        fs::create_dir_all(&cwd).unwrap();
        let cwd_text = cwd.to_string_lossy();

        let opencode_log = tmp.join("opencode.log");
        let opencode_id = "ses_hookless123";
        let escaped_cwd = cwd_text.replace('\\', "\\\\");
        fs::write(
            &opencode_log,
            format!(
                "timestamp=2026-08-20T00:00:00Z level=INFO message=created id={opencode_id} directory=\"{escaped_cwd}\" time.created=1787000000000\n"
            ),
        )
        .unwrap();
        std::env::set_var("ANBO_OPENCODE_LOG", &opencode_log);
        assert_eq!(
            find_opencode_session(&cwd_text, 0, &HashSet::new()).as_deref(),
            Some(opencode_id)
        );

        let antigravity_dir = tmp.join("antigravity");
        fs::create_dir_all(&antigravity_dir).unwrap();
        let antigravity_id = "11111111-2222-4333-8444-555555555555";
        fs::write(
            antigravity_dir.join(format!("{antigravity_id}.db")),
            format!(
                "binary-prefix\0file:///{}\0binary-suffix",
                cwd_text.replace('\\', "/")
            ),
        )
        .unwrap();
        std::env::set_var("ANBO_ANTIGRAVITY_CONVERSATIONS", &antigravity_dir);
        assert_eq!(
            find_antigravity_session(&cwd_text, 0, &HashSet::new()).as_deref(),
            Some(antigravity_id)
        );

        let pi_dir = tmp.join("pi").join("project");
        fs::create_dir_all(&pi_dir).unwrap();
        let pi_id = "019fc684-96b2-7717-ac08-3afca66e8a0b";
        let pi_session = serde_json::json!({
            "type": "session",
            "id": pi_id,
            "cwd": cwd_text.as_ref(),
        });
        fs::write(
            pi_dir.join(format!("session_{pi_id}.jsonl")),
            format!("{}\n", serde_json::to_string(&pi_session).unwrap()),
        )
        .unwrap();
        std::env::set_var("ANBO_PI_SESSIONS", tmp.join("pi"));
        assert_eq!(
            find_pi_session(&cwd_text, 0, &HashSet::new()).as_deref(),
            Some(pi_id)
        );

        std::env::remove_var("ANBO_OPENCODE_LOG");
        std::env::remove_var("ANBO_ANTIGRAVITY_CONVERSATIONS");
        std::env::remove_var("ANBO_PI_SESSIONS");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// Tulis file jsonl dummy (isi tak relevan — discoverer cuma baca nama + mtime).
    fn write_jsonl(path: &std::path::Path) {
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(b"{}\n").unwrap();
    }

    fn write_codex_rollout(path: &Path, id: &str, cwd: &Path) {
        let value = serde_json::json!({
            "type": "session_meta",
            "payload": {
                "id": id,
                "cwd": cwd,
            }
        });
        let mut file = std::fs::File::create(path).unwrap();
        writeln!(file, "{}", serde_json::to_string(&value).unwrap()).unwrap();
    }
}
