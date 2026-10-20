const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const OSC_INTRO: u8 = b']';
const ST_FINAL: u8 = b'\\';

const OSC_MAX: usize = 2048;

const DEFAULT_AGENTS: &[&str] = &[
    "claude",
    "codex",
    "antigravity",
    "pi",
    "opencode",
    "kimi",
    "grok",
];

fn valid_session_id(agent: &str, session_id: &str) -> bool {
    // Kimi wraps a plain uuid in a `session_` prefix and takes the whole string
    // back on --session, so the prefix is part of the id, not decoration.
    let session_id = match agent {
        "kimi" => match session_id.strip_prefix("session_") {
            Some(tail) => tail,
            None => return false,
        },
        _ => session_id,
    };
    if agent == "opencode" {
        return session_id.strip_prefix("ses_").is_some_and(|tail| {
            !tail.is_empty() && tail.chars().all(|c| c.is_ascii_alphanumeric())
        });
    }
    if session_id.len() != 36 {
        return false;
    }
    session_id
        .bytes()
        .enumerate()
        .all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => matches!(byte, b'1'..=b'8'),
            19 => matches!(byte.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_hexdigit(),
        })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Ground,
    Esc,
    Osc,
    OscEsc,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Transition {
    Started {
        agent: String,
        session_id: Option<String>,
    },
    Attention,
    Exited,
}

#[derive(Clone, serde::Serialize)]
pub struct AgentSignal {
    pub id: u32,
    pub kind: &'static str,
    pub agent: Option<String>,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

impl Transition {
    pub fn into_signal(self, id: u32) -> AgentSignal {
        match self {
            Transition::Started { agent, session_id } => AgentSignal {
                id,
                kind: "started",
                agent: Some(agent),
                session_id,
            },
            Transition::Attention => AgentSignal {
                id,
                kind: "attention",
                agent: None,
                session_id: None,
            },
            Transition::Exited => AgentSignal {
                id,
                kind: "exited",
                agent: None,
                session_id: None,
            },
        }
    }
}

/// Words that run the command after them in the same terminal.
const LAUNCHERS: &[&str] = &[
    "&", ".", "bunx", "call", "cmd", "command", "doas", "env", "exec", "nohup", "npx", "pnpx",
    "sudo", "time", "uvx", "wsl",
];
/// Package managers that run a package through one of these sub-commands.
const PACKAGE_RUNNERS: &[(&str, &[&str])] = &[
    ("bun", &["x"]),
    ("npm", &["exec", "x"]),
    ("pnpm", &["dlx", "exec"]),
    ("yarn", &["dlx", "exec"]),
];

/// The words of each statement of a command line. Quotes group a word and
/// are dropped; `;`, `|`, `&&`, `||` and line breaks end a statement.
fn statements(cmd: &str) -> Vec<Vec<String>> {
    let mut statements = Vec::new();
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    let mut chars = cmd.chars().peekable();
    let end_word = |words: &mut Vec<String>, word: &mut String, in_word: &mut bool| {
        if std::mem::take(in_word) {
            words.push(std::mem::take(word));
        }
    };
    while let Some(c) = chars.next() {
        if let Some(open) = quote {
            if c == open {
                quote = None;
            } else {
                word.push(c);
            }
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                in_word = true;
            }
            ';' | '|' | '\n' | '&' if c != '&' || chars.peek() == Some(&'&') => {
                if matches!(c, '|' | '&') && chars.peek() == Some(&c) {
                    chars.next();
                }
                end_word(&mut words, &mut word, &mut in_word);
                if !words.is_empty() {
                    statements.push(std::mem::take(&mut words));
                }
            }
            c if c.is_whitespace() => end_word(&mut words, &mut word, &mut in_word),
            _ => {
                word.push(c);
                in_word = true;
            }
        }
    }
    end_word(&mut words, &mut word, &mut in_word);
    if !words.is_empty() {
        statements.push(words);
    }
    statements
}

/// The program a statement runs, past launchers such as `npx`, `& ` or
/// `cmd /c` and `NAME=value` prefixes. None for a PowerShell expression or
/// assignment (`$env:NAME = ...`).
fn command_word(words: &[String]) -> Option<&str> {
    let mut index = 0;
    let skip_options = |index: &mut usize| {
        while words
            .get(*index)
            .is_some_and(|word| word.starts_with('-') || (word.len() == 2 && word.starts_with('/')))
        {
            *index += 1;
        }
    };
    while let Some(word) = words.get(index) {
        if word.starts_with('$') {
            return None;
        }
        if word
            .split_once('=')
            .is_some_and(|(name, _)| is_variable_name(name))
        {
            index += 1;
            continue;
        }
        let name = program_name(word);
        if LAUNCHERS.contains(&name.as_str()) {
            index += 1;
            skip_options(&mut index);
            continue;
        }
        if let Some((_, modes)) = PACKAGE_RUNNERS.iter().find(|(runner, _)| *runner == name) {
            if words
                .get(index + 1)
                .is_some_and(|mode| modes.contains(&mode.as_str()))
            {
                index += 2;
                skip_options(&mut index);
                continue;
            }
        }
        return Some(word.as_str());
    }
    None
}

fn is_variable_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// A program word as its command name: the file name, lower case, without a
/// Windows extension (`C:\Tools\Claude.exe` is `claude`).
fn program_name(word: &str) -> String {
    let base = word.rsplit(['/', '\\']).next().unwrap_or(word);
    let base = base
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    for extension in [".exe", ".cmd", ".bat", ".ps1", ".com"] {
        if let Some(stem) = base.strip_suffix(extension) {
            return stem.to_string();
        }
    }
    base
}

pub struct AgentDetector {
    agents: Vec<String>,
    state: State,
    osc: Vec<u8>,
    armed: bool,
}

impl AgentDetector {
    pub fn new() -> Self {
        Self::with_agents(DEFAULT_AGENTS.iter().map(|s| s.to_string()).collect())
    }

    pub fn with_agents(agents: Vec<String>) -> Self {
        Self {
            agents,
            state: State::Ground,
            osc: Vec::new(),
            armed: false,
        }
    }

    /// Feed a chunk of raw PTY output. Transitions come only from OSC sequences
    /// (`133` prompt boundaries, `9` and `777` notifications), never from raw output,
    /// so a TUI agent that repaints continuously never flaps working/waiting.
    pub fn process<F: FnMut(Transition)>(&mut self, input: &[u8], mut emit: F) {
        if self.state == State::Ground && !input.contains(&ESC) {
            return;
        }

        for &b in input {
            match self.state {
                State::Ground => {
                    if b == ESC {
                        self.state = State::Esc;
                    }
                }
                State::Esc => match b {
                    OSC_INTRO => {
                        self.state = State::Osc;
                        self.osc.clear();
                    }
                    ESC => {}
                    _ => self.state = State::Ground,
                },
                State::Osc => match b {
                    BEL => {
                        self.finish_osc(&mut emit);
                        self.state = State::Ground;
                    }
                    ESC => self.state = State::OscEsc,
                    _ => {
                        if self.osc.len() < OSC_MAX {
                            self.osc.push(b);
                        } else {
                            self.osc.clear();
                            self.state = State::Ground;
                        }
                    }
                },
                State::OscEsc => match b {
                    ST_FINAL => {
                        self.finish_osc(&mut emit);
                        self.state = State::Ground;
                    }
                    ESC => {}
                    _ => {
                        self.osc.clear();
                        self.state = State::Ground;
                    }
                },
            }
        }
    }

    /// Called when the underlying PTY closes. Reports the agent as exited so the
    /// UI doesn't leave a stale entry if the shell died mid-command.
    pub fn finish<F: FnMut(Transition)>(&mut self, mut emit: F) {
        if self.armed {
            self.armed = false;
            emit(Transition::Exited);
        }
    }

    fn finish_osc<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        let body = std::mem::take(&mut self.osc);
        let (ps, pt) = match body.iter().position(|&c| c == b';') {
            Some(i) => (&body[..i], &body[i + 1..]),
            None => (&body[..], &body[0..0]),
        };
        match ps {
            b"133" => self.handle_osc133(pt, emit),
            // OSC 9;4 is taskbar progress, not a notification.
            b"9" if !pt.starts_with(b"4;") && pt != b"4" => self.generic_attention(emit),
            b"777" => self.generic_attention(emit),
            _ => {}
        }
    }

    fn handle_osc133<F: FnMut(Transition)>(&mut self, pt: &[u8], emit: &mut F) {
        match pt.first() {
            Some(b'C') => {
                if self.armed {
                    return;
                }
                let cmd = pt.strip_prefix(b"C;").unwrap_or(b"");
                if let Some(agent) = self.match_agent(cmd) {
                    let session_id = Self::resume_session_id(&agent, cmd);
                    self.armed = true;
                    emit(Transition::Started { agent, session_id });
                }
            }
            Some(b'D') if self.armed => {
                self.armed = false;
                emit(Transition::Exited);
            }
            _ => {}
        }
    }

    fn generic_attention<F: FnMut(Transition)>(&mut self, emit: &mut F) {
        if self.armed {
            emit(Transition::Attention);
        }
    }

    /// The agent a command line starts: the program of one of its statements.
    /// A name anywhere else on the line is an argument; `Get-Process codex`
    /// had made a shell an agent tab, which left the terminal tools' list.
    fn match_agent(&self, cmd: &[u8]) -> Option<String> {
        let cmd = std::str::from_utf8(cmd).ok()?;
        statements(cmd)
            .iter()
            .filter_map(|words| command_word(words))
            .find_map(|program| {
                let name = program_name(program);
                self.agents
                    .iter()
                    .find(|a| {
                        let executable = if a.as_str() == "antigravity" {
                            "agy"
                        } else {
                            a.as_str()
                        };
                        name.strip_prefix(executable)
                            .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
                    })
                    .cloned()
            })
    }

    fn resume_session_id(agent: &str, cmd: &[u8]) -> Option<String> {
        let cmd = std::str::from_utf8(cmd).ok()?;
        let tokens: Vec<&str> = cmd
            .split_whitespace()
            .map(|token| token.trim_matches(['\'', '"', ';']))
            .collect();
        let selectors: &[&str] = match agent {
            "claude" => &["--resume", "--session-id"],
            "opencode" => &["--session", "-s"],
            "antigravity" => &["--conversation", "-c"],
            "kimi" => &["--session", "-S"],
            _ => &[],
        };

        for (index, token) in tokens.iter().enumerate() {
            if agent == "codex" && *token == "resume" {
                let candidate = *tokens.get(index + 1)?;
                return valid_session_id(agent, candidate).then(|| candidate.to_string());
            }
            for selector in selectors {
                if *token == *selector {
                    let candidate = *tokens.get(index + 1)?;
                    if valid_session_id(agent, candidate) {
                        return Some(candidate.to_string());
                    }
                }
                if let Some(candidate) = token.strip_prefix(&format!("{selector}=")) {
                    if valid_session_id(agent, candidate) {
                        return Some(candidate.to_string());
                    }
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(d: &mut AgentDetector, input: &[u8]) -> Vec<Transition> {
        let mut out = Vec::new();
        d.process(input, |t| out.push(t));
        out
    }

    fn osc(body: &str) -> Vec<u8> {
        let mut v = vec![ESC, OSC_INTRO];
        v.extend_from_slice(body.as_bytes());
        v.extend_from_slice(&[ESC, ST_FINAL]);
        v
    }

    fn started(agent: &str) -> Transition {
        Transition::Started {
            agent: agent.into(),
            session_id: None,
        }
    }

    fn started_session(agent: &str, session_id: &str) -> Transition {
        Transition::Started {
            agent: agent.into(),
            session_id: Some(session_id.into()),
        }
    }

    #[test]
    fn arms_on_agent_command() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("133;C;claude -p hello")),
            vec![started("claude")]
        );
    }

    #[test]
    fn captures_exact_session_from_manual_resume_commands() {
        let uuid = "01a02fbc-ed2d-72b3-9111-0e1395a678bb";
        let opencode = "ses_fd03c6167ffeYZs4Zyi98zkY9T";
        // Kimi's id carries its own prefix, and the whole string is what goes
        // back on --session, so the prefix has to survive the round trip.
        let kimi = format!("session_{uuid}");
        for (command, agent, session_id) in [
            (format!("claude --resume {uuid}"), "claude", uuid),
            (format!("codex --yolo resume {uuid}"), "codex", uuid),
            (
                format!("opencode --session {opencode}"),
                "opencode",
                opencode,
            ),
            (format!("agy --conversation={uuid}"), "antigravity", uuid),
            (format!("agy -c {uuid}"), "antigravity", uuid),
            (
                format!("kimi --auto --session {kimi}"),
                "kimi",
                kimi.as_str(),
            ),
            (format!("kimi -S {kimi}"), "kimi", kimi.as_str()),
        ] {
            let mut detector = AgentDetector::new();
            assert_eq!(
                run(&mut detector, &osc(&format!("133;C;{command}"))),
                vec![started_session(agent, session_id)],
            );
        }
    }

    #[test]
    fn ignores_invalid_session_selectors_on_agent_commands() {
        let mut detector = AgentDetector::new();
        assert_eq!(
            run(&mut detector, &osc("133;C;claude --resume newest")),
            vec![started("claude")],
        );
    }

    #[test]
    fn arms_on_pi_command() {
        let mut d = AgentDetector::new();
        assert_eq!(run(&mut d, &osc("133;C;pi")), vec![started("pi")]);
    }

    #[test]
    fn arms_antigravity_on_agy_command() {
        let mut detector = AgentDetector::new();
        assert_eq!(
            run(&mut detector, &osc("133;C;agy")),
            vec![started("antigravity")]
        );
    }

    #[test]
    fn arms_on_opencode_and_grok_commands() {
        for agent in ["opencode", "grok"] {
            let mut d = AgentDetector::new();
            assert_eq!(
                run(&mut d, &osc(&format!("133;C;{agent}"))),
                vec![started(agent)]
            );
        }
    }

    #[test]
    fn arms_on_pathed_and_wrapped_command() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("133;C;/usr/local/bin/codex exec")),
            vec![started("codex")]
        );
        let mut d2 = AgentDetector::new();
        assert_eq!(
            run(&mut d2, &osc("133;C;npx claude")),
            vec![started("claude")]
        );
    }

    #[test]
    fn arms_on_dash_suffixed_alias() {
        let mut d = AgentDetector::new();
        assert_eq!(
            run(&mut d, &osc("133;C;claude-enigma")),
            vec![started("claude")]
        );
    }

    #[test]
    fn does_not_arm_on_other_commands() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &osc("133;C;vim src/main.rs")).is_empty());
        assert!(run(&mut d, &osc("133;C;cat claude.txt")).is_empty());
        assert!(run(&mut d, &osc("133;C;claudexyz")).is_empty());
    }

    #[test]
    fn an_agent_name_given_to_another_program_is_an_argument() {
        // Measured: an agent looking for a leftover process with
        // `Get-Process codex` turned its 'git' terminal into a Codex tab, and
        // the terminal left terminal_list for good.
        for command in [
            "Get-Process codex",
            "Stop-Process -Name codex -Force",
            "where.exe claude",
            "echo pi",
            "git log --author claude",
            "Write-Output 'kimi'; Get-Date",
            "$env:AGENT = 'codex'",
            "npm install -g @openai/codex",
        ] {
            let mut d = AgentDetector::new();
            assert!(
                run(&mut d, &osc(&format!("133;C;{command}"))).is_empty(),
                "{command}"
            );
        }
    }

    #[test]
    fn arms_on_the_program_of_any_statement_past_launchers() {
        let uuid = "01a02fbc-ed2d-72b3-9111-0e1395a678bb";
        for (command, agent) in [
            (
                "$env:OPENCODE_CONFIG='C:\\w\\a;b.json'; opencode",
                "opencode",
            ),
            ("OPENCODE_CONFIG=/w/anbo-mcp.json opencode", "opencode"),
            ("cd app && codex --yolo", "codex"),
            ("cmd /c claude", "claude"),
            ("npx -y @anthropic-ai/claude-code", "claude"),
            ("pnpm dlx @openai/codex", "codex"),
            ("C:\\Tools\\Kimi.EXE --auto", "kimi"),
        ] {
            let mut d = AgentDetector::new();
            assert_eq!(
                run(&mut d, &osc(&format!("133;C;{command}"))),
                vec![started(agent)],
                "{command}"
            );
        }
        let mut d = AgentDetector::new();
        assert_eq!(
            run(
                &mut d,
                &osc(&format!(
                    "133;C;& 'C:\\Program Files\\Claude\\claude.exe' --resume {uuid}"
                ))
            ),
            vec![started_session("claude", uuid)]
        );
    }

    #[test]
    fn ignores_bell_and_plain_output() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert!(run(&mut d, &[BEL]).is_empty());
        assert!(run(&mut d, b"thinking...\x07more").is_empty());
    }

    #[test]
    fn a_leftover_hook_marker_is_only_a_notification() {
        // Older Anbo hooks and plugins wrote `notify;Anbo;...`; it no longer
        // arms anything or drives status.
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &osc("777;notify;Anbo;claude;working")).is_empty());
        assert!(run(
            &mut d,
            &osc("777;notify;Anbo;opencode;session;ses_02ed951faffexIxSGpdc5IFmZz")
        )
        .is_empty());
        run(&mut d, &osc("133;C;claude"));
        assert_eq!(
            run(&mut d, &osc("777;notify;Anbo;claude;finished")),
            vec![Transition::Attention]
        );
    }

    #[test]
    fn generic_osc777_and_osc9_attention_only_when_armed() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &osc("777;notify;Other;ready")).is_empty());
        run(&mut d, &osc("133;C;codex"));
        assert_eq!(
            run(&mut d, &osc("777;notify;Codex;ready")),
            vec![Transition::Attention]
        );
        assert_eq!(
            run(&mut d, &osc("9;needs you")),
            vec![Transition::Attention]
        );
        assert!(run(&mut d, &osc("9;4;1;50")).is_empty());
    }

    #[test]
    fn exits_on_133d() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        assert_eq!(run(&mut d, &osc("133;D;0")), vec![Transition::Exited]);
        assert!(run(&mut d, &osc("133;D;0")).is_empty());
    }

    #[test]
    fn bel_terminator_inside_osc_is_not_attention() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut seq = vec![ESC, OSC_INTRO];
        seq.extend_from_slice(b"0;set title");
        seq.push(BEL);
        assert!(run(&mut d, &seq).is_empty());
    }

    #[test]
    fn started_split_across_chunks() {
        let mut d = AgentDetector::new();
        assert!(run(&mut d, &[ESC, OSC_INTRO]).is_empty());
        assert!(run(&mut d, b"133;C;cla").is_empty());
        let mut out = run(&mut d, b"ude");
        out.extend(run(&mut d, &[ESC, ST_FINAL]));
        assert_eq!(out, vec![started("claude")]);
    }

    #[test]
    fn finish_reports_exited_when_armed() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut out = Vec::new();
        d.finish(|t| out.push(t));
        assert_eq!(out, vec![Transition::Exited]);
        let mut out2 = Vec::new();
        d.finish(|t| out2.push(t));
        assert!(out2.is_empty());
    }

    #[test]
    fn oversized_osc_does_not_panic() {
        let mut d = AgentDetector::new();
        run(&mut d, &osc("133;C;claude"));
        let mut seq = vec![ESC, OSC_INTRO];
        seq.extend(std::iter::repeat_n(b'x', OSC_MAX + 100));
        seq.extend_from_slice(&[ESC, ST_FINAL]);
        assert!(run(&mut d, &seq).is_empty());
        assert_eq!(
            run(&mut d, &osc("777;notify;Anbo;attention")),
            vec![Transition::Attention]
        );
    }
}
