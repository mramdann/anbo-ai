//! A PTY's output on its way to the UI. Every byte has a stream offset, and
//! the recent part stays after it is sent: a Tauri channel that loses one
//! message parks every later one for good, so a lost message is sent again on
//! a new channel instead of leaving the terminal blind while its shell runs on.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// The most output kept that the UI has not been handed. Past it the oldest
/// goes, and the UI marks the gap.
pub(super) const MAX_UNSENT: u64 = 4 * 1024 * 1024;
/// How long output handed to the UI stays for a resend. The UI checks for a
/// stalled stream every 2 s, but its IPC stayed jammed for 25 s after Dev's
/// UI-thread queue was full.
const KEEP_SENT_FOR: Duration = Duration::from_secs(30);
const KEEP_SENT_MAX: u64 = 1024 * 1024;

const DATA_MESSAGE: u8 = 0;
const EXIT_MESSAGE: u8 = 1;

struct Chunk {
    offset: u64,
    bytes: Vec<u8>,
    sent_at: Option<Instant>,
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
    /// Bytes dropped unsent since the last `take_dropped`.
    dropped: u64,
}

impl OutputLog {
    pub(super) fn push(&mut self, bytes: &[u8], now: Instant) {
        if bytes.is_empty() {
            return;
        }
        self.chunks.push_back(Chunk {
            offset: self.end,
            bytes: bytes.to_vec(),
            sent_at: None,
        });
        self.end += bytes.len() as u64;
        self.trim(now);
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

    /// The channel took everything before `upto`.
    pub(super) fn mark_sent(&mut self, upto: u64, now: Instant) {
        self.sent = upto.clamp(self.sent, self.end);
        for chunk in &mut self.chunks {
            if chunk.end() > self.sent {
                break;
            }
            chunk.sent_at.get_or_insert(now);
        }
        self.trim(now);
    }

    /// A new channel whose side has everything before `received`: send again
    /// from there, or from the oldest byte kept when that went.
    pub(super) fn resend_from(&mut self, received: u64) {
        self.sent = received.clamp(self.start, self.end);
    }

    pub(super) fn take_dropped(&mut self) -> u64 {
        std::mem::take(&mut self.dropped)
    }

    /// Lets go of sent output past its time, for a terminal that went quiet.
    pub(super) fn expire(&mut self, now: Instant) {
        self.trim(now);
    }

    fn trim(&mut self, now: Instant) {
        while let Some(front) = self.chunks.front() {
            let sent_long_ago = front.end() <= self.sent
                && front
                    .sent_at
                    .is_some_and(|at| now.duration_since(at) >= KEEP_SENT_FOR);
            let too_much_sent =
                front.end() <= self.sent && self.sent.saturating_sub(self.start) > KEEP_SENT_MAX;
            let too_much_unsent = self.end - self.sent.max(self.start) > MAX_UNSENT;
            if !(sent_long_ago || too_much_sent || too_much_unsent) {
                break;
            }
            let front = self.chunks.pop_front().expect("front chunk exists");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn log_with(parts: &[&[u8]], now: Instant) -> OutputLog {
        let mut log = OutputLog::default();
        for part in parts {
            log.push(part, now);
        }
        log
    }

    #[test]
    fn hands_out_each_byte_once_with_its_offset() {
        let now = Instant::now();
        let mut log = log_with(&[b"abc", b"de"], now);
        assert_eq!(log.unsent(), Some((0, b"abcde".to_vec())));
        log.mark_sent(5, now);
        assert_eq!(log.unsent(), None);
        log.push(b"fg", now);
        assert_eq!(log.unsent(), Some((5, b"fg".to_vec())));
    }

    #[test]
    fn sends_again_from_what_the_new_channel_has() {
        // Measured (round 61): one failed send left the UI's channel waiting
        // for that message forever while the shell ran the command.
        let now = Instant::now();
        let mut log = log_with(&[b"echo ", b"done\r\n"], now);
        log.mark_sent(11, now);
        log.resend_from(5);
        assert_eq!(log.unsent(), Some((5, b"done\r\n".to_vec())));
        log.resend_from(2);
        assert_eq!(log.unsent(), Some((2, b"ho done\r\n".to_vec())));
    }

    #[test]
    fn keeps_sent_output_for_a_while_only() {
        let start = Instant::now();
        let mut log = log_with(&[b"old"], start);
        log.mark_sent(3, start);
        let later = start + KEEP_SENT_FOR + Duration::from_millis(1);
        log.push(b"new", later);
        log.resend_from(0);
        assert_eq!(log.unsent(), Some((3, b"new".to_vec())));
        assert_eq!(log.take_dropped(), 0);
    }

    #[test]
    fn a_quiet_terminal_lets_go_of_sent_output() {
        let start = Instant::now();
        let mut log = log_with(&[b"last screen"], start);
        log.mark_sent(11, start);
        log.expire(start + KEEP_SENT_FOR - Duration::from_millis(1));
        log.resend_from(0);
        assert_eq!(log.unsent(), Some((0, b"last screen".to_vec())));
        log.mark_sent(11, start);
        log.expire(start + KEEP_SENT_FOR);
        log.resend_from(0);
        assert_eq!(log.unsent(), None);
    }

    #[test]
    fn caps_sent_output_kept_for_a_resend() {
        let now = Instant::now();
        let block = vec![b'x'; 256 * 1024];
        let mut log = OutputLog::default();
        for _ in 0..8 {
            log.push(&block, now);
            log.mark_sent(log.end(), now);
        }
        log.resend_from(0);
        let (from, bytes) = log.unsent().expect("kept output");
        assert!(bytes.len() as u64 <= KEEP_SENT_MAX + block.len() as u64);
        assert_eq!(from + bytes.len() as u64, log.end());
        assert_eq!(log.take_dropped(), 0);
    }

    #[test]
    fn drops_the_oldest_unsent_output_past_the_cap_and_counts_it() {
        let now = Instant::now();
        let block = vec![b'y'; 1024 * 1024];
        let mut log = OutputLog::default();
        for _ in 0..6 {
            log.push(&block, now);
        }
        let (from, bytes) = log.unsent().expect("unsent output");
        assert!(from > 0, "the gap starts the next message");
        assert!(bytes.len() as u64 <= MAX_UNSENT);
        assert_eq!(log.take_dropped(), from);
        assert_eq!(log.take_dropped(), 0);
    }

    #[test]
    fn a_resend_cannot_go_before_the_oldest_byte_kept() {
        let now = Instant::now();
        let block = vec![b'z'; 1024 * 1024];
        let mut log = OutputLog::default();
        for _ in 0..6 {
            log.push(&block, now);
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
}
