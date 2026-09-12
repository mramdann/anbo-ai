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
//!
//! A skill that declares `sections: on-demand` in its frontmatter is read in
//! two steps: the text before its first `## ` heading plus an index of the
//! sections, then one section at a time by name. Measured on the built-in
//! skill, every agent read all 20k characters of it at the start of every
//! task and used a tenth; the essentials are what they need up front.

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
const MAX_SECTION_SUMMARY_CHARS: usize = 160;

/// Skills Anbo carries itself, available in every workspace.
const BUILT_IN: &[(&str, &str)] = &[("anbo", include_str!("skills/anbo.md"))];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    /// Where it came from, so a reader knows whether it can be edited.
    pub source: &'static str,
    /// Section names of a skill that is read on demand, so a caller can go
    /// straight to the one it needs.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sections: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub name: String,
    pub description: String,
    pub source: &'static str,
    pub body: String,
    /// Absent for a built-in, which has no file to open.
    pub path: Option<String>,
    /// The section this body is, when one was asked for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    /// Every section this skill offers on demand.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sections: Vec<String>,
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

/// The leading frontmatter block, without its fences, when there is one.
fn frontmatter(source: &str) -> Option<&str> {
    let trimmed = source.trim_start_matches('\u{feff}');
    let rest = trimmed.strip_prefix("---")?;
    let rest = rest.trim_start_matches(['\r', '\n']);
    let end = rest.find("\n---")?;
    Some(&rest[..end])
}

/// One `key: value` line of the frontmatter.
fn frontmatter_value(source: &str, wanted: &str) -> Option<String> {
    for line in frontmatter(source)?.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim() != wanted {
            continue;
        }
        let value = value.trim().trim_matches(['"', '\'']).to_string();
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

/// Pull `name` and `description` out of the leading frontmatter block.
///
/// Deliberately not a YAML parser: a skill file that needs one has outgrown
/// what a listing can usefully summarise.
pub fn parse_frontmatter(source: &str) -> (Option<String>, Option<String>) {
    (
        frontmatter_value(source, "name"),
        frontmatter_value(source, "description"),
    )
}

fn reads_on_demand(source: &str) -> bool {
    frontmatter_value(source, "sections").is_some_and(|value| value == "on-demand")
}

/// The body with its frontmatter fences removed.
fn without_frontmatter(source: &str) -> &str {
    let trimmed = source.trim_start_matches('\u{feff}');
    let Some(rest) = trimmed.strip_prefix("---") else {
        return trimmed;
    };
    let rest = rest.trim_start_matches(['\r', '\n']);
    match rest.find("\n---") {
        Some(end) => rest[end + 4..].trim_start_matches(['\r', '\n']),
        None => trimmed,
    }
}

fn section_title(line: &str) -> Option<&str> {
    line.strip_prefix("## ").map(str::trim).filter(|t| !t.is_empty())
}

/// Every `## ` heading, in document order.
fn section_titles(source: &str) -> Vec<String> {
    without_frontmatter(source)
        .lines()
        .filter_map(section_title)
        .map(str::to_owned)
        .collect()
}

/// One section by name (case-insensitive), heading included, up to the next.
fn section_text(source: &str, wanted: &str) -> Option<(String, String)> {
    let mut lines = without_frontmatter(source).lines();
    let title = loop {
        let line = lines.next()?;
        if let Some(title) = section_title(line) {
            if title.eq_ignore_ascii_case(wanted.trim()) {
                break title.to_owned();
            }
        }
    };
    let mut body = format!("## {title}\n");
    for line in lines {
        if section_title(line).is_some() {
            break;
        }
        body.push_str(line);
        body.push('\n');
    }
    Some((title, body.trim_end().to_owned()))
}

/// The first sentence of a section, for the index an on-demand read carries.
fn section_summary(source: &str, title: &str) -> String {
    let Some((_, text)) = section_text(source, title) else {
        return String::new();
    };
    let prose: String = text
        .lines()
        .skip(1)
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join(" ");
    let sentence = match prose.find(". ") {
        Some(end) => &prose[..=end],
        None => prose.as_str(),
    };
    sentence.chars().take(MAX_SECTION_SUMMARY_CHARS).collect()
}

/// What an on-demand skill returns when no section is named: everything
/// before the first section, then an index of what the sections hold.
fn essentials(name: &str, source: &str, titles: &[String]) -> String {
    let body = without_frontmatter(source);
    let head = match body.find("\n## ") {
        Some(end) => &body[..end],
        None => body,
    };
    let mut text = head.trim_end().to_owned();
    if !titles.is_empty() {
        text.push_str("\n\n## Sections\n\nRead one in full with skills_read {name: \"");
        text.push_str(name);
        text.push_str("\", section: <title>}:\n");
        for title in titles {
            text.push_str("- ");
            text.push_str(title);
            let summary = section_summary(source, title);
            if !summary.is_empty() {
                text.push_str(": ");
                text.push_str(&summary);
            }
            text.push('\n');
        }
    }
    text
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
        sections: if reads_on_demand(source_text) {
            section_titles(source_text)
        } else {
            Vec::new()
        },
    }
}

/// Every skill available in this workspace, built-ins included.
pub fn list_skills(workspace: &Path) -> Result<Vec<SkillSummary>, String> {
    let mut skills: Vec<SkillSummary> = Vec::new();
    let mut from_workspace: Vec<String> = Vec::new();

    let root = skills_root(workspace);
    if root.is_dir() {
        let entries =
            fs::read_dir(&root).map_err(|error| format!("read {}: {error}", root.display()))?;
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

/// One skill, ready to follow: in full, or one named section of it, or for a
/// skill read on demand its essentials plus a section index.
pub fn read_skill(
    workspace: &Path,
    name: &str,
    section: Option<&str>,
) -> Result<SkillDetail, String> {
    if !is_valid_skill_name(name) {
        return Err(format!(
            "skill names are lowercase letters, digits and single hyphens: {name}"
        ));
    }
    let (text, source, path): (String, &'static str, Option<String>) = 'located: {
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
                break 'located (body, "workspace", Some(file.to_string_lossy().into_owned()));
            }
        }
        if let Some((_, text)) = BUILT_IN.iter().find(|(id, _)| *id == name) {
            break 'located ((*text).to_string(), "anbo", None);
        }
        return Err(format!("no skill named '{name}' in this workspace"));
    };
    let (_, description) = parse_frontmatter(&text);
    let titles = section_titles(&text);
    let (body, section) = match section.map(str::trim).filter(|s| !s.is_empty()) {
        Some(wanted) => {
            let Some((title, body)) = section_text(&text, wanted) else {
                return Err(if titles.is_empty() {
                    format!("skill '{name}' has no sections; read it without a section")
                } else {
                    format!(
                        "skill '{name}' has no section named '{wanted}'; its sections are: {}",
                        titles.join(", ")
                    )
                });
            };
            (body, Some(title))
        }
        None if reads_on_demand(&text) => (essentials(name, &text, &titles), None),
        None => (text.clone(), None),
    };
    Ok(SkillDetail {
        name: name.to_string(),
        description: description.unwrap_or_default(),
        source,
        body,
        path,
        section,
        sections: if reads_on_demand(&text) {
            titles
        } else {
            Vec::new()
        },
    })
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
        let anbo = skills
            .iter()
            .find(|s| s.name == "anbo" && s.source == "anbo")
            .expect("built-in skill");
        assert!(skills.iter().all(|s| !s.description.is_empty()));
        assert!(
            anbo.sections.iter().any(|s| s == "Browser details"),
            "{:?}",
            anbo.sections
        );
    }

    #[test]
    fn the_built_in_skill_opens_with_its_essentials_and_a_section_index() {
        // Every agent read the whole 20k-character skill at the start of
        // every task. The first read now carries what every task needs and a
        // map of the rest; a section costs a second call only when wanted.
        let temp = tempfile::tempdir().unwrap();
        let detail = read_skill(temp.path(), "anbo", None).unwrap();
        assert!(
            detail.body.len() < 6_000,
            "essentials are {} bytes",
            detail.body.len()
        );
        assert!(detail.body.contains("browser_open"));
        assert!(detail.body.contains("## Sections"));
        assert!(detail.body.contains("Browser details"));
        assert!(detail.body.contains("Terminals"));
        assert!(
            !detail.body.contains("terminal_wait"),
            "section bodies stay out of the essentials"
        );
        assert!(detail.section.is_none());
        assert!(detail.sections.contains(&"Terminals".to_string()));
    }

    #[test]
    fn a_section_is_read_in_full_by_name_regardless_of_case() {
        let temp = tempfile::tempdir().unwrap();
        let detail = read_skill(temp.path(), "anbo", Some("terminals")).unwrap();
        assert_eq!(detail.section.as_deref(), Some("Terminals"));
        assert!(detail.body.starts_with("## Terminals"));
        assert!(detail.body.contains("terminal_execute"));
        assert!(
            !detail.body.contains("agent_send"),
            "the next section is not included"
        );
    }

    #[test]
    fn an_unknown_section_names_the_real_ones() {
        let temp = tempfile::tempdir().unwrap();
        let error = read_skill(temp.path(), "anbo", Some("Printing")).unwrap_err();
        assert!(error.contains("Browser details"), "{error}");
        assert!(error.contains("Terminals"), "{error}");
    }

    #[test]
    fn a_workspace_skill_without_the_flag_is_still_read_whole() {
        // Sections are opt-in: a project's own procedure keeps reading the way
        // its author wrote it, headings and all.
        let temp = tempfile::tempdir().unwrap();
        write_skill(
            temp.path(),
            "deploy",
            "---\nname: deploy\ndescription: ship it\n---\nfirst\n\n## Rollback\n\nsecond\n",
        );
        let detail = read_skill(temp.path(), "deploy", None).unwrap();
        assert!(detail.body.contains("first") && detail.body.contains("second"));
        assert!(detail.sections.is_empty());
        let rollback = read_skill(temp.path(), "deploy", Some("Rollback")).unwrap();
        assert_eq!(rollback.body, "## Rollback\n\nsecond");
        let listed = list_skills(temp.path()).unwrap();
        assert!(listed.iter().find(|s| s.name == "deploy").unwrap().sections.is_empty());
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
        let detail = read_skill(temp.path(), "anbo", None).unwrap();
        assert_eq!(detail.source, "workspace");
        assert!(detail.body.contains("local rules"));
        assert!(detail.path.is_some());
    }

    #[test]
    fn reading_an_unknown_skill_says_so_rather_than_guessing() {
        let temp = tempfile::tempdir().unwrap();
        assert!(read_skill(temp.path(), "missing", None).is_err());
        assert!(read_skill(temp.path(), "..", None).is_err());
    }

    #[test]
    fn a_directory_without_a_skill_file_is_not_a_skill() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join(".anbo").join("skills").join("empty")).unwrap();
        let skills = list_skills(temp.path()).unwrap();
        assert!(!skills.iter().any(|s| s.name == "empty"));
    }
}
