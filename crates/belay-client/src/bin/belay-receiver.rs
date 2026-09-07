//! Desktop bridge: encrypted BWP stays in Rust; Electron only receives H.264.
//! Credentials arrive on stdin, never argv. Stdout is length-prefixed binary.
use std::io::{self, BufRead, Write};
use std::net::{SocketAddr, UdpSocket};
use std::time::Duration;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use belay_net::{Event, Session};
use belay_wire::{congestion::BitratePreset, crypto::Direction, packet::Channel};

fn hex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 || !s.is_ascii() { return Err("invalid key encoding".into()); }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i+2],16).map_err(|_| "invalid key encoding".into())).collect()
}
fn run() -> Result<(), String> {
    let stdin=io::stdin(); let mut lines=stdin.lock().lines();
    let family=lines.next().ok_or("missing address family")?.map_err(|e|e.to_string())?;
    let bind=if family=="6" { "[::]:0" } else { "0.0.0.0:0" };
    let reserved=UdpSocket::bind(bind).map_err(|e|e.to_string())?;
    let local=reserved.local_addr().map_err(|e|e.to_string())?;
    eprintln!("{{\"type\":\"reserved\",\"port\":{}}}",local.port());
    let mut read=|| lines.next().ok_or("incomplete configuration")?.map_err(|e|e.to_string());
    let peer:SocketAddr=read()?.parse().map_err(|_|"invalid peer")?;
    let key=hex(&read()?)?; if key.len()!=32 { return Err("invalid key length".into()); }
    let salt: [u8;8]=hex(&read()?)?.try_into().map_err(|_|"invalid salt length")?;
    let preset=BitratePreset::parse(&read()?).ok_or("invalid preset")?;
    drop(read); drop(lines);
    let request=Arc::new(AtomicBool::new(true));
    let input_request=request.clone();
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            if matches!(line.as_deref(), Ok("keyframe")) { input_request.store(true,Ordering::Relaxed); }
        }
        std::process::exit(0);
    });
    drop(reserved);
    let mut session=Session::bind(local,peer,&key,salt,Direction::ClientToHost,preset).map_err(|_|"cannot open receiver")?;
    let mut out=io::BufWriter::new(io::stdout());
    loop {
        if request.swap(false,Ordering::Relaxed) { let _=session.request_keyframe(); }
        for event in session.poll().map_err(|_|"receiver failed")? {
            if let Event::Frame {channel:Channel::Video,payload,keyframe,..}=event {
                if payload.is_empty() || payload.len()>8*1024*1024 { continue; }
                out.write_all(&[u8::from(keyframe)]).map_err(|e|e.to_string())?;
                out.write_all(&(payload.len() as u32).to_be_bytes()).map_err(|e|e.to_string())?;
                out.write_all(&payload).map_err(|e|e.to_string())?;
                out.flush().map_err(|e|e.to_string())?;
            }
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn main() { if let Err(_) = run() { eprintln!("{{\"type\":\"error\",\"error\":\"Receiver stopped\"}}"); std::process::exit(1); } }
