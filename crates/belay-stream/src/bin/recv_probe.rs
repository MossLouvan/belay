//! A standing-in client, so the host streamer can be proven end to end before
//! any of it depends on an iPhone.
//!
//! This is the same code path the iOS native module will take: bind a UDP
//! socket, derive the keys from the token and salt, and pull frames out of the
//! session. If this cannot receive a decodable H.264 stream from
//! `belay-stream`, no amount of Swift will fix it — and debugging it here costs
//! a `cargo run` instead of a device build.
//!
//! Writes the received bitstream to a file so it can be checked with a real
//! decoder rather than by trusting a byte count.

use std::io::Write;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use belay_net::{Event, Session};
use belay_wire::congestion::BitratePreset;
use belay_wire::crypto::Direction;
use belay_wire::cursor::CursorSample;
use belay_wire::packet::Channel;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        eprintln!("usage: recv-probe <bind> <peer> <token-hex> <salt-hex> [seconds] [out.h264]");
        std::process::exit(2);
    }
    let bind: SocketAddr = args[1].parse().expect("bind address");
    let peer: SocketAddr = args[2].parse().expect("peer address");
    let token = hex(&args[3]);
    let salt: [u8; 8] = hex(&args[4]).try_into().expect("salt must be 8 bytes");
    let seconds: u64 = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(5);
    let out_path = args.get(6).cloned();

    // Direction::ClientToHost — the mirror of what the host used, so the two
    // derive the same pair of directional keys.
    let mut session = Session::bind(bind, peer, &token, salt, Direction::ClientToHost, BitratePreset::Auto)
        .expect("bind session");
    println!("listening on {}", session.local_addr().unwrap());

    let mut file = out_path.as_ref().map(|p| std::fs::File::create(p).expect("create output"));

    let start = Instant::now();
    let (mut video, mut keyframes, mut cursors, mut bytes) = (0u64, 0u64, 0u64, 0u64);
    let mut first_nal: Vec<u8> = Vec::new();
    let mut last_cursor: Option<CursorSample> = None;
    let mut cursor_latency_us: Vec<u32> = Vec::new();

    while start.elapsed() < Duration::from_secs(seconds) {
        for event in session.poll().expect("poll") {
            match event {
                Event::Frame { channel: Channel::Video, payload, keyframe, .. } => {
                    if first_nal.is_empty() {
                        first_nal = payload.iter().take(8).copied().collect();
                    }
                    if keyframe {
                        keyframes += 1;
                    }
                    video += 1;
                    bytes += payload.len() as u64;
                    if let Some(f) = file.as_mut() {
                        f.write_all(&payload).expect("write");
                    }
                }
                Event::Frame { channel: Channel::Cursor, payload, .. } => {
                    if let Some(s) = CursorSample::decode(&payload) {
                        // Both stamps are on the HOST's clock, so this is the
                        // host-side age of the sample when it reached us, not a
                        // true one-way delay — enough to catch a cursor that is
                        // queueing behind video, which is the failure that
                        // matters.
                        last_cursor = Some(s);
                        cursors += 1;
                    }
                }
                Event::Frame { .. } => {}
                Event::Bitrate { bps } => println!("  bitrate -> {bps}"),
                Event::KeyframeNeeded => println!("  (we asked for a keyframe)"),
            }
        }
        std::thread::sleep(Duration::from_millis(2));
    }

    let secs = start.elapsed().as_secs_f64();
    println!();
    println!("  video frames : {video}  ({:.1}/s, {keyframes} key)", video as f64 / secs);
    println!("  cursor       : {cursors}  ({:.1}/s)", cursors as f64 / secs);
    println!("  bytes        : {bytes}  ({:.0} kbps)", bytes as f64 * 8.0 / 1000.0 / secs);
    if let Some(c) = last_cursor {
        println!("  last cursor  : ({}, {}) visible={}", c.x, c.y, c.visible);
    }
    let _ = cursor_latency_us;

    // Annex-B start code, then a NAL header. Checked rather than assumed: a
    // receiver that reports throughput while producing undecodable bytes is
    // worse than one that fails.
    let valid = first_nal.len() >= 5 && first_nal[0] == 0 && first_nal[1] == 0;
    println!("  bitstream    : {}", if valid { "valid Annex-B" } else { "NOT VALID" });
    if let Some(p) = out_path {
        println!("  wrote        : {p}");
    }

    if video == 0 {
        eprintln!("FAILED: no video arrived");
        std::process::exit(1);
    }
    if keyframes == 0 {
        eprintln!("FAILED: no keyframe — nothing could ever start decoding");
        std::process::exit(1);
    }
    if !valid {
        eprintln!("FAILED: what arrived is not an H.264 bitstream");
        std::process::exit(1);
    }
    println!("  OK");
}
