//! A PTY's output on its way to the UI. Every byte has a stream offset, and
//! what the UI has not said it holds stays: a Tauri channel that loses one
//! message parks every later one for good, so output that did not arrive is
//! sent again on a new channel instead of leaving the terminal blind while its
//! shell runs on.

use std::collections::VecDeque;

use base64::Engine as _;
use tauri::ipc::Response;

/// The most output kept that the UI has not said it holds, handed to a channel
/// or not. Past it the oldest goes, and the UI marks a gap where it turns out
/// not to hold that.
///
/// Until round 113 output handed to a channel stayed 30 s and at most 1 MB,
/// on the thought that a UI missing a message asks again within seconds. A UI
/// that could not take its output for longer than that (several agents
/// writing without a pause) asked for output that was gone: Rust had nothing
/// to send again, the UI asked every four seconds in vain, and the terminal
/// showed "[anbo: N bytes of output were lost]" as soon as its program wrote
/// again. Handed to a channel is not arrived, so only the UI's own word lets
/// output go.
pub(super) const MAX_KEPT: u64 = 4 * 1024 * 1024;

const DATA_MESSAGE: u8 = 0;
const EXIT_MESSAGE: u8 = 1;

struct Chunk {
    offset: u64,
    bytes: Vec<u8>,
}

impl Chunk {
    fn end(&self) -> u64 {
        self.offset + self.bytes.len() as u64
    }
}

#[derive(Default)]
pub(super) struct OutputLog {
    chunks: VecDeque<Chunk>,
    /// Offset of the oldest byte kept.
    start: u64,
    /// Offset after the newest byte.
    end: u64,
    /// The current channel was handed everything before this offset.
    sent: u64,
    /// The UI has said it holds everything before this offset.
    taken: u64,
    /// Bytes dropped unsent since the last `take_dropped`.
    dropped: u64,
}

impl OutputLog {
    pub(super) fn push(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.chunks.push_back(Chunk {
            offset: self.end,
            bytes: bytes.to_vec(),
        });
        self.end += bytes.len() as u64;
        self.trim();
    }

    pub(super) fn end(&self) -> u64 {
        self.end
    }

    pub(super) fn sent(&self) -> u64 {
        self.sent
    }

    pub(super) fn has_unsent(&self) -> bool {
        self.end > self.sent.max(self.start)
    }

    /// Everything not yet handed to the channel: the stream offset of its
    /// first byte and the bytes. Past a gap it starts after the gap.
    pub(super) fn unsent(&self) -> Option<(u64, Vec<u8>)> {
        let from = self.sent.max(self.start);
        if from >= self.end {
            return None;
        }
        let mut bytes = Vec::with_capacity((self.end - from) as usize);
        for chunk in &self.chunks {
            if chunk.end() <= from {
                continue;
            }
            let skip = from.saturating_sub(chunk.offset) as usize;
            bytes.extend_from_slice(&chunk.bytes[skip..]);
        }
        Some((from, bytes))
    }

    /// The channel took everything before `upto`. That is not yet the UI
    /// holding it, so nothing goes.
    pub(super) fn mark_sent(&mut self, upto: u64) {
        self.sent = upto.clamp(self.sent, self.end);
    }

    /// The UI says it holds everything before `received`: that much can go.
    pub(super) fn taken_upto(&mut self, received: u64) {
        self.taken = received.clamp(self.taken, self.end);
        self.trim();
    }

    /// A new channel whose side has everything before `received`: send again
    /// from there, or from the oldest byte kept when that went.
    pub(super) fn resend_from(&mut self, received: u64) {
        self.taken_upto(received);
        self.sent = received.clamp(self.start, self.end);
    }

    pub(super) fn take_dropped(&mut self) -> u64 {
        std::mem::take(&mut self.dropped)
    }

    fn trim(&mut self) {
        while let Some(front) = self.chunks.front() {
            let taken = front.end() <= self.taken;
            let too_much = self.end - self.start > MAX_KEPT;
            if !(taken || too_much) {
                break;
            }
            let front = self.chunks.pop_front().expect("front chunk exists");
            // Only output no channel was handed counts as dropped here; the
            // UI finds by itself what it was handed and does not hold.
            self.dropped += front.end().saturating_sub(self.sent.max(front.offset));
            self.start = self.chunks.front().map_or(self.end, |next| next.offset);
        }
    }
}

/// One output message: a kind byte, the stream offset of the first byte
/// (little endian), then the bytes.
pub(super) fn data_message(offset: u64, bytes: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(9 + bytes.len());
    message.push(DATA_MESSAGE);
    message.extend_from_slice(&offset.to_le_bytes());
    message.extend_from_slice(bytes);
    message
}

/// The stream's last message: the shell's exit code.
pub(super) fn exit_message(code: i32) -> Vec<u8> {
    let mut message = Vec::with_capacity(5);
    message.push(EXIT_MESSAGE);
    message.extend_from_slice(&code.to_le_bytes());
    message
}

/// The longest message that still travels as text. Tauri puts a JSON body
/// under 8,192 bytes inside the script that hands it to the page; base64
/// writes four characters for three bytes, and the two quotes count.
const TEXT_MESSAGE_MAX: usize = 6_141;

/// A message as the channel sends it.
///
/// Tauri hands a raw body of 1,024 bytes or more to the page by a request of
/// its own: the page fetches it through the IPC protocol, which is a trip
/// through the browser's network stack and back into this process for every
/// message. That is the right way for a megabyte of output and a dear one for
/// the kilobyte or two an agent's CLI repaints many times a second: across
/// that line, at twenty messages a second, Anbo's own work rose from 6% to 13%
/// of a core (round 112). A message that fits goes as base64 text instead,
/// which Tauri evaluates in place; a larger one stays raw.
pub(super) fn response(message: Vec<u8>) -> Response {
    match text_message(&message) {
        Some(text) => Response::new(text),
        None => Response::new(message),
    }
}

/// `message` as a JSON string of base64, when it is short enough.
fn text_message(message: &[u8]) -> Option<String> {
    if message.len() > TEXT_MESSAGE_MAX {
        return None;
    }
    let mut text = String::with_capacity(message.len().div_ceil(3) * 4 + 2);
    text.push('"');
    base64::engine::general_purpose::STANDARD.encode_string(message, &mut text);
    text.push('"');
    Some(text)
}

/// The bytes of a message as the page reads them, whichever way it went.
#[cfg(test)]
pub(super) fn message_bytes(body: tauri::ipc::InvokeResponseBody) -> Vec<u8> {
    match body {
        tauri::ipc::InvokeResponseBody::Raw(bytes) => bytes,
        tauri::ipc::InvokeResponseBody::Json(text) => {
            let text: String = serde_json::from_str(&text).expect("a JSON string");
            base64::engine::general_purpose::STANDARD
                .decode(text)
                .expect("base64")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log_with(parts: &[&[u8]]) -> OutputLog {
        let mut log = OutputLog::default();
        for part in parts {
            log.push(part);
        }
        log
    }

    #[test]
    fn hands_out_each_byte_once_with_its_offset() {
        let mut log = log_with(&[b"abc", b"de"]);
        assert_eq!(log.unsent(), Some((0, b"abcde".to_vec())));
        log.mark_sent(5);
        assert_eq!(log.unsent(), None);
        log.push(b"fg");
        assert_eq!(log.unsent(), Some((5, b"fg".to_vec())));
    }

    #[test]
    fn sends_again_from_what_the_new_channel_has() {
        // Measured (round 61): one failed send left the UI's channel waiting
        // for that message forever while the shell ran the command.
        let mut log = log_with(&[b"echo ", b"done\r\n"]);
        log.mark_sent(11);
        log.resend_from(2);
        assert_eq!(log.unsent(), Some((2, b"ho done\r\n".to_vec())));
        log.mark_sent(11);
        log.resend_from(5);
        assert_eq!(log.unsent(), Some((5, b"done\r\n".to_vec())));
    }

    #[test]
    fn keeps_what_a_channel_took_until_the_ui_holds_it() {
        // Measured (round 113): a UI that could not take a terminal's output
        // for 40 s asked for it again every four seconds. After 30 s the
        // output was gone from here, nothing was sent again, and the terminal
        // showed "[anbo: 26272 bytes of output were lost]" when its program
        // wrote again. However long the UI takes, what it asks for is there.
        let mut log = log_with(&[b"a long answer"]);
        log.mark_sent(13);
        for _ in 0..12 {
            log.resend_from(0);
            assert_eq!(log.unsent(), Some((0, b"a long answer".to_vec())));
            log.mark_sent(13);
        }
        log.push(b", and more");
        log.resend_from(0);
        assert_eq!(log.unsent(), Some((0, b"a long answer, and more".to_vec())));
        assert_eq!(log.take_dropped(), 0);
    }

    #[test]
    fn lets_go_of_what_the_ui_says_it_holds() {
        let mut log = log_with(&[b"last ", b"screen"]);
        log.mark_sent(11);
        log.taken_upto(5);
        log.resend_from(5);
        assert_eq!(log.unsent(), Some((5, b"screen".to_vec())));
        log.mark_sent(11);
        log.taken_upto(11);
        assert_eq!(log.chunks.len(), 0, "a quiet terminal keeps nothing");
        log.resend_from(11);
        assert_eq!(log.unsent(), None);
        // The UI's word only moves forward: an older one changes nothing.
        log.push(b"next");
        log.mark_sent(15);
        log.taken_upto(13);
        log.taken_upto(11);
        assert_eq!(log.taken, 13);
        assert_eq!(log.chunks.len(), 1, "a chunk stays until all of it is held");
    }

    #[test]
    fn keeps_at_most_the_cap_for_a_ui_that_does_not_answer() {
        let block = vec![b'x'; 1024 * 1024];
        let mut log = OutputLog::default();
        for _ in 0..7 {
            log.push(&block);
            log.mark_sent(log.end());
        }
        log.resend_from(0);
        let (from, bytes) = log.unsent().expect("kept output");
        assert_eq!(bytes.len() as u64, MAX_KEPT);
        assert_eq!(from + bytes.len() as u64, log.end());
        // What a channel took is not counted as dropped: the UI finds by
        // itself what it does not hold.
        assert_eq!(log.take_dropped(), 0);
    }

    #[test]
    fn drops_the_oldest_unsent_output_past_the_cap_and_counts_it() {
        let block = vec![b'y'; 1024 * 1024];
        let mut log = OutputLog::default();
        for _ in 0..6 {
            log.push(&block);
        }
        let (from, bytes) = log.unsent().expect("unsent output");
        assert!(from > 0, "the gap starts the next message");
        assert!(bytes.len() as u64 <= MAX_KEPT);
        assert_eq!(log.take_dropped(), from);
        assert_eq!(log.take_dropped(), 0);
    }

    #[test]
    fn a_resend_cannot_go_before_the_oldest_byte_kept() {
        let block = vec![b'z'; 1024 * 1024];
        let mut log = OutputLog::default();
        for _ in 0..6 {
            log.push(&block);
        }
        log.resend_from(0);
        let (from, _) = log.unsent().expect("unsent output");
        assert_eq!(from, 2 * 1024 * 1024);
    }

    #[test]
    fn encodes_messages_with_a_kind_and_offset() {
        assert_eq!(
            data_message(0x0102, b"hi"),
            vec![0, 0x02, 0x01, 0, 0, 0, 0, 0, 0, b'h', b'i']
        );
        assert_eq!(exit_message(-1), vec![1, 0xff, 0xff, 0xff, 0xff]);
    }

    fn body_of(message: Vec<u8>) -> tauri::ipc::InvokeResponseBody {
        use tauri::ipc::IpcResponse;
        response(message).body().expect("a body")
    }

    #[test]
    fn a_message_that_fits_travels_as_text_and_reads_the_same() {
        // Bytes no text encoding would keep: an escape, a NUL, half a UTF-8
        // character, 0xff.
        let message = data_message(9, &[0x1b, b'[', 0, 0xe2, 0x94, 0xff, b'\n']);
        let body = body_of(message.clone());
        let tauri::ipc::InvokeResponseBody::Json(text) = &body else {
            panic!("a short message goes as text");
        };
        assert!(text.starts_with('"') && text.ends_with('"'));
        assert!(
            text[1..text.len() - 1]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')),
            "nothing a script would have to escape"
        );
        assert_eq!(message_bytes(body), message);
        assert_eq!(
            message_bytes(body_of(exit_message(3))),
            vec![1, 3, 0, 0, 0],
            "the exit code too"
        );
    }

    #[test]
    fn text_stops_where_tauri_would_fetch_it() {
        // Tauri's own limit for a JSON body it evaluates in place
        // (MAX_JSON_DIRECT_EXECUTE_THRESHOLD in its ipc/channel.rs): past it
        // the text would be fetched like a raw body, only larger.
        const TAURI_JSON_DIRECT_LIMIT: usize = 8192;
        let longest = vec![0xa5; TEXT_MESSAGE_MAX];
        let text = text_message(&longest).expect("the longest text message");
        assert!(text.len() < TAURI_JSON_DIRECT_LIMIT);
        assert!(text_message(&vec![0xa5; TEXT_MESSAGE_MAX + 1]).is_none());
        let one_more = vec![0xa5; TEXT_MESSAGE_MAX + 1];
        assert!(
            one_more.len().div_ceil(3) * 4 + 2 >= TAURI_JSON_DIRECT_LIMIT,
            "the limit is as high as it can be"
        );
        assert!(matches!(
            body_of(one_more),
            tauri::ipc::InvokeResponseBody::Raw(bytes) if bytes.len() == TEXT_MESSAGE_MAX + 1
        ));
    }
}
