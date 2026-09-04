//! The Belay host streamer.
//!
//! Capture -> convert -> encode -> BWP, in one process the Node server spawns
//! per streaming session. This is what replaces the JPEG loop: instead of
//! `capture, JPEG-encode, base64, JSON, WebSocket` at ~12 fps and ~84 KB a
//! frame, it is `capture, convert in VRAM, H.264, UDP` at 60 fps and a few KB a
//! frame.
//!
//! A separate process rather than a native Node addon, for three reasons that
//! all cost more than they save if ignored:
//!
//! * A driver fault in Desktop Duplication or a hardware encoder takes down the
//!   process it lives in. In-process, that is the whole Belay server — the
//!   agent, the terminal, the file browser, the pairing state. Out of process,
//!   the stream dies and the server restarts it.
//! * The capture loop wants a real thread running flat out. Node's event loop
//!   does not have one to give without blocking everything else on it.
//! * It can be killed. A stuck encoder is a `kill`, not a hung server.
//!
//! Status and errors go to stdout as one JSON object per line, because the
//! parent is a program, not a person.

mod config;
mod stream;
#[cfg(windows)]
mod synthetic;

use std::io::{BufRead, Write};

use config::Config;

fn emit(line: &str) {
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{line}");
    // Explicit flush: the parent is waiting on these lines to know the session
    // is up, and a buffered "ready" that arrives after the client has given up
    // is the same as no "ready" at all.
    let _ = out.flush();
}

fn emit_event(kind: &str, body: &str) {
    emit(&format!("{{\"type\":\"{kind}\"{}{body}}}", if body.is_empty() { "" } else { "," }));
}

/// JSON string escaping for the few places a message can carry arbitrary text.
///
/// An error message containing a quote would otherwise produce a line the
/// parent cannot parse — turning a reportable failure into a mystery.
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn fail(msg: &str) -> ! {
    emit_event("error", &format!("\"error\":\"{}\"", json_escape(msg)));
    std::process::exit(1);
}

fn main() {
    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).is_err() || line.trim().is_empty() {
        fail("no configuration on stdin");
    }

    let config = match Config::parse(&line) {
        Ok(c) => c,
        Err(e) => fail(&format!("bad configuration: {e}")),
    };
    // The token was a credential on stdin and is now in memory only. Do not let
    // it reach a log line, a panic message, or a Debug print.
    line.clear();

    #[cfg(windows)]
    {
        if let Err(e) = stream::run(config, emit_event, json_escape) {
            fail(&e);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = config;
        fail("the host streamer is Windows-only");
    }
}
