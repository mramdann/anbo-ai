//! Reads the JSON that pages and Anbo's page scripts hand back.
//!
//! A page's own text can hold a lone UTF-16 surrogate: a script that cut an
//! emoji in half, for one. JSON.stringify writes it as an escape such as
//! `\ud83d`, which is valid JSON text but no valid string, and serde_json
//! refuses the whole answer: a snapshot of such a page failed outright and its
//! frame's console logs came back empty. `from_str` reads the answer again with
//! each lone surrogate escape swapped for U+FFFD, the way the rest of Anbo
//! turns the browser's UTF-16 into text.

use serde::de::DeserializeOwned;
use std::borrow::Cow;

/// `serde_json::from_str`, then once more without lone surrogate escapes.
pub(crate) fn from_str<T: DeserializeOwned>(text: &str) -> serde_json::Result<T> {
    match serde_json::from_str(text) {
        Err(error) => match well_formed(text) {
            Cow::Owned(fixed) => serde_json::from_str(&fixed),
            Cow::Borrowed(_) => Err(error),
        },
        parsed => parsed,
    }
}

/// `from_str` for a frame of bytes, such as a message from the Chrome/Edge
/// extension, where one unreadable message would end the whole connection.
pub(crate) fn from_slice<T: DeserializeOwned>(bytes: &[u8]) -> serde_json::Result<T> {
    match serde_json::from_slice(bytes) {
        Err(error) => match std::str::from_utf8(bytes).map(well_formed) {
            Ok(Cow::Owned(fixed)) => serde_json::from_str(&fixed),
            _ => Err(error),
        },
        parsed => parsed,
    }
}

/// `text` with every `\u` escape of a lone surrogate replaced by `\ufffd`.
/// Escapes are ASCII, so a byte scan never splits a character.
fn well_formed(text: &str) -> Cow<'_, str> {
    let bytes = text.as_bytes();
    let unit_at = |at: usize| -> Option<u16> {
        let digits = bytes.get(at..at + 6)?;
        if digits[0] != b'\\' || digits[1] != b'u' {
            return None;
        }
        u16::from_str_radix(std::str::from_utf8(&digits[2..]).ok()?, 16).ok()
    };
    let mut fixed: Option<String> = None;
    let (mut at, mut copied) = (0, 0);
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        let Some(unit) = unit_at(at) else {
            // Any other escape: step over the escaped character too, so `\\u`
            // stays a backslash followed by text.
            at += 2;
            continue;
        };
        let lone = match unit {
            0xD800..=0xDBFF => {
                !unit_at(at + 6).is_some_and(|next| (0xDC00..=0xDFFF).contains(&next))
            }
            0xDC00..=0xDFFF => true,
            _ => false,
        };
        if lone {
            let out = fixed.get_or_insert_with(|| String::with_capacity(text.len()));
            out.push_str(&text[copied..at]);
            out.push_str("\\ufffd");
            copied = at + 6;
            at += 6;
        } else if (0xD800..=0xDBFF).contains(&unit) {
            at += 12;
        } else {
            at += 6;
        }
    }
    match fixed {
        Some(mut out) => {
            out.push_str(&text[copied..]);
            Cow::Owned(out)
        }
        None => Cow::Borrowed(text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn lone_surrogates_read_as_replacement_characters() {
        // Measured: a page whose title and console text held a lone surrogate
        // failed every snapshot and lost every console log of its frame.
        let value: Value = from_str(r#"{"title":"Edge \ud83d end","low":"\ude00"}"#).unwrap();
        assert_eq!(value["title"], "Edge \u{FFFD} end");
        assert_eq!(value["low"], "\u{FFFD}");
        let tail: Value = from_str(r#"["cut \ud83d"]"#).unwrap();
        assert_eq!(tail[0], "cut \u{FFFD}");
    }

    #[test]
    fn pairs_escaped_backslashes_and_plain_text_stay_as_they_are() {
        let value: Value =
            from_str(r#"{"emoji":"\ud83d\ude00","code":"\\ud83d","text":"ünï"}"#).unwrap();
        assert_eq!(value["emoji"], "\u{1F600}");
        assert_eq!(value["code"], "\\ud83d");
        assert_eq!(value["text"], "ünï");
        assert!(matches!(
            well_formed(r#"{"a":"\\ud83d","b":"\ud83d\ude00"}"#),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn a_page_answer_that_is_json_inside_a_string_reads_at_both_levels() {
        let outer = serde_json::to_string(r#"{"msg":"half \ud83d"}"#).unwrap();
        let inner: String = from_str(&outer).unwrap();
        let value: Value = from_str(&inner).unwrap();
        assert_eq!(value["msg"], "half \u{FFFD}");
    }

    #[test]
    fn a_bridge_message_with_a_lone_surrogate_still_reads() {
        let frame = br#"{"type":"event","text":"log \udc00 end"}"#;
        let value: Value = from_slice(frame).unwrap();
        assert_eq!(value["text"], "log \u{FFFD} end");
        assert!(from_slice::<Value>(b"{\"type\":").is_err());
        assert!(from_slice::<Value>(&[0xff, 0xfe]).is_err());
    }

    #[test]
    fn other_errors_are_still_errors() {
        assert!(from_str::<Value>(r#"{"a":"#).is_err());
        assert!(from_str::<Value>(r#"{"a":"\ud83d""#).is_err());
    }
}
