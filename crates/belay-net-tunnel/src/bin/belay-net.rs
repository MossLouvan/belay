//! `belay-net`: the host's tunnel sidecar. Spawned and supervised by the host
//! (server/src/tunnel.ts), which owns the account credential and the
//! heartbeat; this process owns only the tunnel keypair and the sockets.
//!
//! Environment:
//!   BELAY_NET_TARGET  where accepted streams are piped (the host's tunnel
//!                     listener, 127.0.0.1:port). Required.
//!   BELAY_NET_KEY     keypair file, created 0600 if missing. Default
//!                     $HOME/.belay/net-key.
//!   BELAY_NET_RELAYS  comma-separated relay URLs; empty = n0 public (dev).
//!
//! stdout, first line: `ready <nodeId>` (nodeId is iroh's Display form: 64 hex)
//! stdin, per line:    `allow <nodeId> <nodeId> ...`  replaces the allow-list
//!                     (an `allow` with no ids admits nobody);
//!                     `sign <message>` answers `sig <base64url Ed25519 signature>`
//!                     on stdout, so the host can prove it owns the node id at
//!                     claim time without ever seeing the secret key. Only
//!                     messages starting with `belay-claim:v1:` are signed: the
//!                     key must never become a general-purpose oracle.
//! Any other line is ignored with a note on stderr. EOF on stdin exits.

use std::io::{BufRead, Write};
use std::path::PathBuf;

use belay_net_tunnel::{bind, AllowList, Host};
use iroh::{RelayUrl, SecretKey};

fn key_path() -> PathBuf {
    if let Some(p) = std::env::var_os("BELAY_NET_KEY") {
        return PathBuf::from(p);
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".belay").join("net-key")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<[u8; 32]> {
    let s = s.trim();
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

/// Load the keypair, or create one at 0600. A corrupt file is an error, not a
/// silent new identity: a new identity would quietly orphan the account link.
fn load_or_create_key(path: &PathBuf) -> std::io::Result<SecretKey> {
    use std::io::{Error, ErrorKind};
    match std::fs::read_to_string(path) {
        Ok(text) => unhex(&text)
            .map(|b| SecretKey::from_bytes(&b))
            .ok_or_else(|| Error::new(ErrorKind::InvalidData, format!("{} is not a 64-hex key", path.display()))),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            if let Some(dir) = path.parent() {
                let mut db = std::fs::DirBuilder::new();
                db.recursive(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    db.mode(0o700);
                }
                db.create(dir)?;
            }
            let key = SecretKey::generate();
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(path)?;
            writeln!(f, "{}", hex(&key.to_bytes()))?;
            Ok(key)
        }
        Err(e) => Err(e),
    }
}

fn parse_relays(raw: &str) -> Vec<RelayUrl> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|s| match s.parse::<RelayUrl>() {
            Ok(u) => Some(u),
            Err(e) => {
                eprintln!("[belay-net] ignoring relay url {s:?}: {e}");
                None
            }
        })
        .collect()
}

/// base64url without padding (RFC 4648 §5), the encoding the accounts
/// service expects for `sig`. Hand-rolled: twelve lines beat a dependency.
fn base64url(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..chunk.len() + 1 {
            out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// What the host wrote on stdin.
#[derive(Debug, PartialEq)]
enum Command<'a> {
    Allow(AllowList),
    Sign(&'a str),
    Unknown,
}

fn parse_line(line: &str) -> Command<'_> {
    let line = line.trim();
    if let Some(ids) = line.strip_prefix("allow").filter(|r| r.is_empty() || r.starts_with(' ')) {
        let (list, bad) = AllowList::parse(ids.split_whitespace());
        for b in bad {
            eprintln!("[belay-net] ignoring bad node id {b:?}");
        }
        return Command::Allow(list);
    }
    if let Some(msg) = line.strip_prefix("sign ") {
        return Command::Sign(msg.trim());
    }
    Command::Unknown
}

/// The only message shape the key signs.
const SIGNABLE_PREFIX: &str = "belay-claim:v1:";

/// Apply one stdin line. Returns the reply to print, if any.
fn apply_line(line: &str, host: &Host, key: &SecretKey) -> Option<String> {
    match parse_line(line) {
        Command::Allow(list) => {
            eprintln!("[belay-net] allow-list: {} node id(s)", list.len());
            host.set_allow(list);
            None
        }
        Command::Sign(msg) if msg.starts_with(SIGNABLE_PREFIX) => {
            Some(format!("sig {}", base64url(&key.sign(msg.as_bytes()).to_bytes())))
        }
        Command::Sign(_) => {
            eprintln!("[belay-net] refusing to sign a message that is not a claim");
            Some("sig-refused".to_string())
        }
        Command::Unknown => {
            eprintln!("[belay-net] ignoring line {line:?}");
            None
        }
    }
}

#[tokio::main]
async fn main() {
    let target: std::net::SocketAddr = match std::env::var("BELAY_NET_TARGET").ok().and_then(|t| t.parse().ok()) {
        Some(t) => t,
        None => {
            eprintln!("[belay-net] BELAY_NET_TARGET must be host:port");
            std::process::exit(2);
        }
    };
    let key = match load_or_create_key(&key_path()) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("[belay-net] key: {e}");
            std::process::exit(2);
        }
    };
    let relays = parse_relays(&std::env::var("BELAY_NET_RELAYS").unwrap_or_default());
    let endpoint = match bind(key, &relays).await {
        Ok(ep) => ep,
        Err(e) => {
            eprintln!("[belay-net] bind: {e}");
            std::process::exit(1);
        }
    };
    let host = Host::new(AllowList::default());

    println!("ready {}", endpoint.id());
    let _ = std::io::stdout().flush();

    let serve = tokio::spawn(host.clone().serve(endpoint.clone(), target));

    // stdin is blocking; a thread is the smallest thing that reads it.
    let signer = endpoint.secret_key().clone();
    let stdin_done = tokio::task::spawn_blocking(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if let Some(reply) = apply_line(&line, &host, &signer) {
                println!("{reply}");
                let _ = std::io::stdout().flush();
            }
        }
    });
    tokio::select! {
        _ = stdin_done => {}
        _ = serve => {}
    }
    endpoint.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_line_replaces_the_list() {
        let host = Host::new(AllowList::default());
        let key = SecretKey::generate();
        let id = key.public();
        assert_eq!(apply_line(&format!("allow {id}"), &host, &key), None);
        assert!(host.allows(&id));
        assert_eq!(apply_line("allow", &host, &key), None, "an empty allow line is valid");
        assert!(!host.allows(&id), "and admits nobody");
        assert_eq!(parse_line("allowance"), Command::Unknown);
        assert_eq!(apply_line("nonsense", &host, &key), None);
    }

    #[test]
    fn sign_line_answers_a_verifiable_base64url_signature() {
        let host = Host::new(AllowList::default());
        let key = SecretKey::generate();
        let msg = format!("belay-claim:v1:{}:1760000000", key.public());
        let reply = apply_line(&format!("sign {msg}"), &host, &key).unwrap();
        let b64 = reply.strip_prefix("sig ").unwrap();
        assert!(!b64.contains(['+', '/', '=']), "base64url, unpadded: {b64}");
        assert_eq!(b64.len(), 86, "64 signature bytes");
        let bytes = unbase64url(b64);
        let sig = iroh::Signature::from_bytes(&bytes.try_into().unwrap());
        key.public().verify(msg.as_bytes(), &sig).unwrap();
    }

    #[test]
    fn sign_refuses_anything_that_is_not_a_claim() {
        let host = Host::new(AllowList::default());
        let key = SecretKey::generate();
        for msg in ["hello", "belay-claim:v2:x", "xbelay-claim:v1:x"] {
            assert_eq!(apply_line(&format!("sign {msg}"), &host, &key).as_deref(), Some("sig-refused"), "{msg:?}");
        }
        assert_eq!(parse_line("sign "), Command::Unknown, "an empty message is not even a command");
    }

    #[test]
    fn key_dir_is_created_private() {
        let dir = std::env::temp_dir().join(format!("belay-net-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        load_or_create_key(&dir.join("net-key")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64url_matches_known_vectors() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn key_file_round_trips_and_is_private() {
        let dir = std::env::temp_dir().join(format!("belay-net-key-{}", std::process::id()));
        let path = dir.join("net-key");
        let a = load_or_create_key(&path).unwrap();
        let b = load_or_create_key(&path).unwrap();
        assert_eq!(a.public(), b.public());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::write(&path, "garbage").unwrap();
        assert!(load_or_create_key(&path).is_err(), "a corrupt key is an error, not a new identity");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn unbase64url(s: &str) -> Vec<u8> {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut bits = 0u32;
        let mut n = 0;
        let mut out = Vec::new();
        for c in s.bytes() {
            bits = (bits << 6) | T.iter().position(|t| *t == c).unwrap() as u32;
            n += 6;
            if n >= 8 {
                n -= 8;
                out.push((bits >> n) as u8);
                bits &= (1 << n) - 1;
            }
        }
        out
    }
}
