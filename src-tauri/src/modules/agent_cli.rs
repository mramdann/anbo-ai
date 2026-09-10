//! Which agent CLIs this machine can actually run.
//!
//! Anbo offers the same bench of agents everywhere, but a machine only has the
//! ones its owner installed. Resolving each start command's program against
//! PATH lets the launcher say so up front, instead of handing the user a tab
//! that dies on "command not found".

use std::collections::HashMap;

use crate::modules::path_env::resolve_binary;

/// The program a start command runs, picked out the way a shell would.
///
/// A quoted first word keeps its spaces, which is how a path under Program
/// Files is written. Leading `NAME=value` assignments are environment, not
/// program, so they are stepped over rather than probed for.
pub fn launch_program(command: &str) -> Option<String> {
    let mut rest = command.trim_start();
    loop {
        if rest.is_empty() {
            return None;
        }
        if let Some(unquoted) = rest.strip_prefix('"') {
            let end = unquoted.find('"')?;
            let program = &unquoted[..end];
            return (!program.is_empty()).then(|| program.to_string());
        }
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let token = &rest[..end];
        // Only a bare NAME=value is an assignment. A path holding an equals
        // sign is still the program, so a name with a separator in it stays put.
        match token.find('=') {
            Some(equals) if equals > 0 && !token[..equals].contains(['/', '\\']) => {
                rest = rest[end..].trim_start();
            }
            _ => return Some(token.to_string()),
        }
    }
}

/// Answers keyed by the command as it was given, so the caller never has to
/// hold its own idea of where a command's program ends.
#[tauri::command]
pub fn agent_cli_status(commands: Vec<String>) -> HashMap<String, bool> {
    let mut probed: HashMap<String, bool> = HashMap::new();
    let mut status = HashMap::with_capacity(commands.len());
    for command in commands {
        let installed = match launch_program(&command) {
            // Several launchers share one program often enough -- a wrapper
            // around Claude is still `claude` -- to be worth remembering.
            Some(program) => *probed
                .entry(program)
                .or_insert_with_key(|program| resolve_binary(program).is_some()),
            None => false,
        };
        status.insert(command, installed);
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_program_out_of_a_command_with_flags() {
        assert_eq!(launch_program("claude").as_deref(), Some("claude"));
        assert_eq!(
            launch_program("codex --yolo --model o3").as_deref(),
            Some("codex")
        );
        assert_eq!(launch_program("   agy  ").as_deref(), Some("agy"));
    }

    #[test]
    fn keeps_a_quoted_path_whole() {
        // The shape a Windows install under Program Files takes. Splitting on
        // the first space would probe a directory that does not exist.
        assert_eq!(
            launch_program(r#""C:\Program Files\anbo\claude.exe" --resume"#).as_deref(),
            Some(r"C:\Program Files\anbo\claude.exe")
        );
    }

    #[test]
    fn steps_over_a_leading_environment_assignment() {
        assert_eq!(
            launch_program("OPENCODE_CONFIG=/tmp/anbo.json opencode").as_deref(),
            Some("opencode")
        );
        // A path is not an assignment, however many equals signs it holds.
        assert_eq!(
            launch_program("./bin/run=agent --now").as_deref(),
            Some("./bin/run=agent")
        );
    }

    #[test]
    fn has_no_program_to_probe_when_there_is_nothing_to_run() {
        assert_eq!(launch_program(""), None);
        assert_eq!(launch_program("   "), None);
        // An unterminated quote is a command the user is still typing.
        assert_eq!(launch_program("\"claude"), None);
        assert_eq!(launch_program("\"\" --flag"), None);
    }

    #[test]
    fn a_command_naming_nothing_installed_reports_false() {
        let status = agent_cli_status(vec![
            "anbo-no-such-agent-cli --go".to_string(),
            String::new(),
        ]);
        assert_eq!(status["anbo-no-such-agent-cli --go"], false);
        assert_eq!(status[""], false);
    }
}
