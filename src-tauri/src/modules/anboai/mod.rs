//! Modul anboai — diferensiator anboai yang di-inject ke atas Anbo.
//!
//! Anbo sudah punya: terminal ANSI, editor, git, file tree, deteksi status agen
//! (OSC 777), auto-update. Modul ini menambah IP unik anboai:
//!   - `resume` — strategi resume sesi per-CLI (discover session-id claude/opencode)
//!   - (menyusul) telegram bridge, dispatcher multi-agen
//!
//! Modul diisolasi (file sendiri di bawah `modules/anboai/`) supaya diff upstream
//! Anbo minim — kita jarang menyentuh file core Anbo.

pub mod resume;
