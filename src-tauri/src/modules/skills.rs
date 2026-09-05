//! Workspace skills: instructions an agent can look up before acting.
//!
//! A skill is a folder under `.anbo/skills/<name>/` holding a `SKILL.md`. The
//! file leads with frontmatter naming the skill and saying when it applies, so
//! an agent can scan a whole workspace's skills cheaply and only read the one
//! it needs. Supporting files sit beside it.
//!
//! Anbo ships its own skills too, compiled in, so every workspace can explain
//! Anbo to an agent without anyone writing that down first. A workspace skill
//! of the same name replaces the built-in rather than competing with it.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

const SKILLS_DIR: &str = "skills";
const SKILL_FILE: &str = "SKILL.md";

/// Enough for a long procedure, far short of a pasted transcript.
const MAX_SKILL_BYTES: u64 = 64 * 1024;
/// A listing is read into an agent's context, so it has to stay scannable.
const MAX_SKILLS: usize = 200;
const MAX_DESCRIPTION_CHARS: usize = 400;

/// Skills Anbo carries itself, available in every workspace.
const BUILT_IN: &[(&str, &str)] = &[("anbo", include_str!("skills/anbo.md"))];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    /// Where it came from, so a reader knows whether it can be edited.
    pub source: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub name: String,
    pub description: String,
    pub source: &'static str,
    pub body: String,
    /// Absent for a built-in, which has no file to open.
    pub path: Option<String>,
}

/// A skill name is a single path segment, checked rather than sanitised.
///
/// Accepting only this shape makes directory traversal impossible by
/// construction: there is no input that both passes and escapes.
pub fn is_valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
}

fn skills_root(workspace: &Path) -> PathBuf {
    workspace.join(".anbo").join(SKILLS_DIR)
}

/// Pull `name` and `description` out of the leading frontmatter block.
///
/// Deliberately not a YAML parser: a skill file that needs one has outgrown
/// what a listing can usefully summarise.
pub fn parse_frontmatter(source: &str) -> (Option<String>, Option<String>) {
    let trimmed = source.trim_start_matches('\u{feff}');
    let Some(rest) = trimmed.strip_prefix("---") else {
        return (None, None);
    };
    let rest = rest.trim_start_matches(['\r', '\n']);
    let Some(end) = rest.find("\n---") else {
        return (None, None);
    };
    let mut name = None;
    let mut description = None;
    for line in rest[..end].lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches(['"', '\'']).to_string();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "name" => name = Some(value),
            "description" => description = Some(value),
            _ => {}
        }
    }
    (name, description)
}

fn summarise(name: &str, source_text: &str, origin: &'static str) -> SkillSummary {
    let (_, description) = parse_frontmatter(source_text);
    let mut description = description.unwrap_or_default();
    if description.chars().count() > MAX_DESCRIPTION_CHARS {
        description = description.chars().take(MAX_DESCRIPTION_CHARS).collect();
    }
    SkillSummary {
        name: name.to_string(),
        description,
        source: origin,
    }
}

/// Every skill available in this workspace, built-ins included.
pub fn list_skills(workspace: &Path) -> Result<Vec<SkillSummary>, String> {
    let mut skills: Vec<SkillSummary> = Vec::new();
    let mut from_workspace: Vec<String> = Vec::new();

    let root = skills_root(workspace);
    if root.is_dir() {
        let entries = fs::read_dir(&root)
            .map_err(|error| format!("read {}: {error}", root.display()))?;
        for entry in entries.flatten() {
            if skills.len() >= MAX_SKILLS {
                break;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !is_valid_skill_name(&name) {
                continue;
            }
            let file = entry.path().join(SKILL_FILE);
            let Ok(metadata) = fs::metadata(&file) else {
                continue;
            };
            if !metadata.is_file() || metadata.len() > MAX_SKILL_BYTES {
                continue;
            }
            let Ok(text) = fs::read_to_string(&file) else {
                continue;
            };
            from_workspace.push(name.clone());
            skills.push(summarise(&name, &text, "workspace"));
        }
    }

    // A workspace skill of the same name replaces the built-in, so a project
    // can correct or extend what Anbo says about itself.
    for (name, text) in BUILT_IN {
        if from_workspace.iter().any(|taken| taken == name) {
            continue;
        }
        skills.push(summarise(name, text, "anbo"));
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

/// One skill in full, ready to follow.
pub fn read_skill(workspace: &Path, name: &str) -> Result<SkillDetail, String> {
    if !is_valid_skill_name(name) {
        return Err(format!(
            "skill names are lowercase letters, digits and single hyphens: {name}"
        ));
    }
    let file = skills_root(workspace).join(name).join(SKILL_FILE);
    if let Ok(metadata) = fs::metadata(&file) {
        if metadata.is_file() {
            if metadata.len() > MAX_SKILL_BYTES {
                return Err(format!(
                    "skill '{name}' is larger than the {MAX_SKILL_BYTES} byte limit"
                ));
            }
            let body = fs::read_to_string(&file)
                .map_err(|error| format!("read {}: {error}", file.display()))?;
            let (_, description) = parse_frontmatter(&body);
            return Ok(SkillDetail {
                name: name.to_string(),
                description: description.unwrap_or_default(),
                source: "workspace",
                body,
                path: Some(file.to_string_lossy().into_owned()),
            });
        }
    }

    if let Some((_, text)) = BUILT_IN.iter().find(|(id, _)| *id == name) {
        let (_, description) = parse_frontmatter(text);
        return Ok(SkillDetail {
            name: name.to_string(),
            description: description.unwrap_or_default(),
            source: "anbo",
            body: (*text).to_string(),
            path: None,
        });
    }

    Err(format!("no skill named '{name}' in this workspace"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_skill(root: &Path, name: &str, body: &str) {
        let dir = root.join(".anbo").join("skills").join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), body).unwrap();
    }

    #[test]
    fn a_skill_name_cannot_describe_a_path() {
        // The shape is the whole defence: nothing that passes can escape.
        assert!(is_valid_skill_name("buat-surat"));
        assert!(is_valid_skill_name("a1"));
        assert!(!is_valid_skill_name(".."));
        assert!(!is_valid_skill_name("a/b"));
        assert!(!is_valid_skill_name("a\\b"));
        assert!(!is_valid_skill_name("C:"));
        assert!(!is_valid_skill_name(""));
        assert!(!is_valid_skill_name("-lead"));
        assert!(!is_valid_skill_name("trail-"));
        assert!(!is_valid_skill_name("double--hyphen"));
        assert!(!is_valid_skill_name("Upper"));
    }

    #[test]
    fn frontmatter_yields_the_name_and_description() {
        let (name, description) = parse_frontmatter(
            "---\nname: buat-surat\ndescription: Alur surat keluar\n---\nlangkah satu\n",
        );
        assert_eq!(name.as_deref(), Some("buat-surat"));
        assert_eq!(description.as_deref(), Some("Alur surat keluar"));
    }

    #[test]
    fn a_file_without_frontmatter_is_read_rather_than_refused() {
        // A skill someone wrote as plain prose still lists, just without a
        // description, which is better than hiding it.
        let (name, description) = parse_frontmatter("just some notes\n");
        assert!(name.is_none() && description.is_none());
        let (_, unterminated) = parse_frontmatter("---\ndescription: never closed\n");
        assert!(unterminated.is_none());
    }

    #[test]
    fn anbo_explains_itself_in_a_workspace_with_no_skills() {
        let temp = tempfile::tempdir().unwrap();
        let skills = list_skills(temp.path()).unwrap();
        assert!(skills.iter().any(|s| s.name == "anbo" && s.source == "anbo"));
        assert!(skills.iter().all(|s| !s.description.is_empty()));
    }

    #[test]
    fn a_workspace_skill_replaces_the_built_in_of_the_same_name() {
        let temp = tempfile::tempdir().unwrap();
        write_skill(
            temp.path(),
            "anbo",
            "---\nname: anbo\ndescription: our own version\n---\nlocal rules\n",
        );
        let skills = list_skills(temp.path()).unwrap();
        let anbo: Vec<_> = skills.iter().filter(|s| s.name == "anbo").collect();
        assert_eq!(anbo.len(), 1, "the built-in should not appear twice");
        assert_eq!(anbo[0].source, "workspace");
        let detail = read_skill(temp.path(), "anbo").unwrap();
        assert_eq!(detail.source, "workspace");
        assert!(detail.body.contains("local rules"));
        assert!(detail.path.is_some());
    }

    #[test]
    fn reading_an_unknown_skill_says_so_rather_than_guessing() {
        let temp = tempfile::tempdir().unwrap();
        assert!(read_skill(temp.path(), "missing").is_err());
        assert!(read_skill(temp.path(), "..").is_err());
    }

    #[test]
    fn a_directory_without_a_skill_file_is_not_a_skill() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join(".anbo").join("skills").join("empty")).unwrap();
        let skills = list_skills(temp.path()).unwrap();
        assert!(!skills.iter().any(|s| s.name == "empty"));
    }
}
