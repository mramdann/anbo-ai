use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize)]
pub struct Caller {
    pub brand: &'static str,
    pub label: &'static str,
    #[serde(skip)]
    owner: Option<String>,
    #[serde(skip)]
    pub(super) pty_id: Option<u32>,
}

/// Two calls are the same caller when they come from the same agent, not merely
/// from the same connection.
///
/// `owner` is the transport session id, and a CLI may rotate it mid-task --
/// measured on Claude Code, which changed it twice inside two minutes. Comparing
/// it made each rotation look like a brand new agent: a fresh control id was
/// minted, the id the agent was told to hold went stale, and its own
/// browser_end_session answered ended:false because the session was no longer
/// recognised as its own. A pty is the agent's terminal, which outlives any one
/// connection, so when both sides have one it settles identity by itself.
impl PartialEq for Caller {
    fn eq(&self, other: &Self) -> bool {
        if self.brand != other.brand {
            return false;
        }
        match (self.pty_id, other.pty_id) {
            (Some(mine), Some(theirs)) => mine == theirs,
            _ => self.owner == other.owner && self.pty_id == other.pty_id,
        }
    }
}
impl Eq for Caller {}

impl Default for Caller {
    fn default() -> Self {
        Self {
            brand: "remote",
            label: "Remote agent",
            owner: None,
            pty_id: None,
        }
    }
}

impl Caller {
    pub fn internal() -> Self {
        Self {
            brand: "anbo",
            label: "Anbo",
            owner: Some("internal".into()),
            pty_id: None,
        }
    }

    pub fn from_client_info(info: &Value) -> Self {
        let name = info.get("name").and_then(Value::as_str).unwrap_or("");
        if name.len() > 128 {
            return Self::default();
        }
        let name = name.trim().to_ascii_lowercase();
        let words: Vec<_> = name.split(|c: char| !c.is_ascii_alphanumeric()).collect();
        let has = |word: &str| words.contains(&word);
        let (brand, label) = if has("claude") || has("claudecode") {
            ("claude", "Claude")
        } else if has("codex") || has("codexcli") {
            ("codex", "Codex")
        } else if has("antigravity") || has("agy") {
            ("antigravity", "Antigravity")
        } else if has("opencode") {
            ("opencode", "OpenCode")
        } else if has("kimi") {
            ("kimi", "Kimi")
        } else if has("pi") {
            ("pi", "Pi")
        } else if has("grok") {
            ("grok", "Grok")
        } else {
            return Self::default();
        };
        Self {
            brand,
            label,
            owner: None,
            pty_id: None,
        }
    }

    pub fn from_pipe_info(info: &Value) -> Self {
        let mut caller = Self::from_client_info(info);
        if let Some(id) = info
            .get("instance")
            .and_then(Value::as_str)
            .filter(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            caller.owner = Some(format!("pipe:{id}"));
        }
        caller
    }

    pub(super) fn with_pty(mut self, pty_id: Option<u32>) -> Self {
        self.pty_id = pty_id;
        self
    }
}

const MAX_SESSIONS: usize = 128;
const SESSION_TTL: Duration = Duration::from_secs(24 * 60 * 60);
static SESSIONS: Mutex<Option<Sessions>> = Mutex::new(None);

#[derive(Default)]
struct Sessions(HashMap<String, (Caller, Instant)>);

impl Sessions {
    fn prune(&mut self, now: Instant) {
        self.0
            .retain(|_, (_, touched)| now.saturating_duration_since(*touched) < SESSION_TTL);
    }

    fn insert(&mut self, id: String, mut caller: Caller, now: Instant) -> Result<(), String> {
        self.prune(now);
        if self.0.len() >= MAX_SESSIONS {
            return Err("too many MCP sessions; close an unused client".into());
        }
        caller.owner = Some(format!("http:{id}"));
        self.0.insert(id, (caller, now));
        Ok(())
    }

    fn caller(&mut self, id: &str, now: Instant) -> Option<Caller> {
        if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        self.prune(now);
        let (caller, touched) = self.0.get_mut(id)?;
        *touched = now;
        Some(caller.clone())
    }
}

pub fn create_session(info: &Value, pty_id: Option<u32>) -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    let id = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut guard = SESSIONS
        .lock()
        .map_err(|_| "session registry unavailable")?;
    guard.get_or_insert_with(Sessions::default).insert(
        id.clone(),
        Caller::from_client_info(info).with_pty(pty_id),
        Instant::now(),
    )?;
    Ok(id)
}

pub fn session_caller(id: &str) -> Option<Caller> {
    let mut guard = SESSIONS.lock().ok()?;
    guard.as_mut()?.caller(id, Instant::now())
}

pub fn remove_session(id: &str) -> Option<Caller> {
    SESSIONS
        .lock()
        .ok()?
        .as_mut()?
        .0
        .remove(id)
        .map(|(caller, _)| caller)
}

pub fn clear_sessions() {
    if let Ok(mut guard) = SESSIONS.lock() {
        *guard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn one_agent_terminal_stays_one_caller_across_a_reconnect() {
        // Measured on Claude Code: it rotated its MCP session twice inside a two
        // minute task. Comparing the transport id made each rotation a new
        // agent, so a fresh control id was minted, the id the agent had been
        // told to hold went stale, and its own browser_end_session answered
        // ended:false. The terminal is what the agent actually is.
        let first = Caller::from_client_info(&json!({"name": "claude"})).with_pty(Some(7));
        let mut reconnected = first.clone();
        reconnected.owner = Some("http:".to_string() + &"b".repeat(64));
        assert_eq!(first, reconnected, "same terminal, later connection");

        // A second terminal of the same CLI is still a different agent.
        let sibling = Caller::from_client_info(&json!({"name": "claude"})).with_pty(Some(8));
        assert_ne!(first, sibling);

        // With no terminal to go on, the connection is all there is, so two
        // separate clients stay separate.
        let piped = Caller::from_pipe_info(&json!({"name":"codex","instance":"a".repeat(64)}));
        let other = Caller::from_pipe_info(&json!({"name":"codex","instance":"b".repeat(64)}));
        assert_ne!(piped, other);
        assert_eq!(piped, piped.clone());
    }

    #[test]
    fn the_open_request_names_the_caller_in_the_shape_the_ui_reads() {
        // browser_open cannot be tracked -- the tab has no id while the call
        // runs -- so the UI takes the tab's identity straight off this payload.
        // If the field names drift, nothing errors: the tab strip quietly falls
        // back to the generic robot until a tracked action arrives, which is the
        // bug this shape exists to prevent.
        let caller = Caller::from_client_info(&json!({"name": "opencode"}));
        let payload = serde_json::to_value(&caller).unwrap();
        assert_eq!(payload["brand"], "opencode");
        assert_eq!(payload["label"], "OpenCode");
        // A caller the registry cannot place still has to serialize, or the open
        // request would carry nothing at all.
        let unknown = serde_json::to_value(Caller::default()).unwrap();
        assert_eq!(unknown["brand"], "remote");
        assert_eq!(unknown["label"], "Remote agent");
    }

    #[test]
    fn private_connection_ids_are_stable_but_never_serialized() {
        let info = json!({"name":"codex", "instance":"a".repeat(64)});
        let caller = Caller::from_pipe_info(&info).with_pty(Some(123));
        assert_eq!(caller, Caller::from_pipe_info(&info).with_pty(Some(123)));
        assert_ne!(caller, Caller::from_client_info(&info));
        assert_eq!(
            serde_json::to_value(&caller).unwrap(),
            json!({"brand":"codex", "label":"Codex"})
        );
        assert_eq!(
            Caller::from_pipe_info(&json!({"name":"codex","instance":"invalid"})),
            Caller::from_client_info(&info)
        );
    }

    #[test]
    fn client_brand_is_bounded_and_never_echoes_arbitrary_metadata() {
        for (name, brand) in [
            ("claude-code", "claude"),
            ("codex_cli_rs", "codex"),
            ("OpenCode", "opencode"),
            ("antigravity", "antigravity"),
            ("pi", "pi"),
        ] {
            assert_eq!(
                Caller::from_client_info(&json!({"name": name})).brand,
                brand
            );
        }
        for name in ["notcodex", "secret-value", "<img src=x>", &"a".repeat(129)] {
            assert_eq!(
                Caller::from_client_info(&json!({"name": name})),
                Caller::default()
            );
        }
        assert_eq!(Caller::from_client_info(&Value::Null), Caller::default());
    }

    #[test]
    fn simultaneous_clients_keep_separate_identity_and_can_disconnect() {
        let mut sessions = Sessions::default();
        let now = Instant::now();
        let first = "a".repeat(64);
        let second = "b".repeat(64);
        sessions
            .insert(
                first.clone(),
                Caller::from_client_info(&json!({"name":"claude-code"})),
                now,
            )
            .unwrap();
        sessions
            .insert(
                second.clone(),
                Caller::from_client_info(&json!({"name":"codex_cli_rs"})),
                now,
            )
            .unwrap();
        assert_eq!(sessions.caller(&first, now).unwrap().brand, "claude");
        assert_eq!(sessions.caller(&second, now).unwrap().brand, "codex");
        sessions.0.remove(&first);
        assert!(sessions.caller(&first, now).is_none());
        assert_eq!(sessions.caller(&second, now).unwrap().brand, "codex");
        assert!(sessions.caller("invalid", now).is_none());
    }

    #[test]
    fn sessions_are_bounded_and_expire_only_after_inactivity() {
        let mut sessions = Sessions::default();
        let now = Instant::now();
        for id in 0..MAX_SESSIONS {
            sessions
                .insert(format!("{id:064x}"), Caller::default(), now)
                .unwrap();
        }
        assert!(sessions
            .insert("e".repeat(64), Caller::default(), now)
            .is_err());
        let live = "0".repeat(64);
        assert!(sessions.caller(&live, now + SESSION_TTL / 2).is_some());
        sessions
            .insert("e".repeat(64), Caller::default(), now + SESSION_TTL)
            .unwrap();
        assert_eq!(sessions.0.len(), 2);
        assert!(sessions.caller(&live, now + SESSION_TTL * 2).is_none());
    }
}
