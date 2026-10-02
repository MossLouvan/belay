//! The Belay tunnel: an iroh endpoint speaking ALPN `belay/1`, whose QUIC
//! bi-streams are piped byte-for-byte to a TCP port.
//!
//! Two halves, one crate:
//! * the host runs [`serve`]: accept connections from phones on the account's
//!   allow-list and pipe each stream to the host's HTTPS port;
//! * the phone runs [`Forwarder`]: a 127.0.0.1 TCP listener whose every
//!   accepted connection becomes one bi-stream to the host.
//!
//! Everything inside the tunnel is still the host's own TLS: the phone pins the
//! host certificate against 127.0.0.1:localPort exactly as it does on the LAN.
//! iroh encrypts hop-by-hop on top (QUIC/TLS keyed on the endpoint ids), and
//! the host's device-token auth applies unchanged. An account compromise
//! alone therefore reaches the host's front door and nothing behind it.

use std::collections::HashSet;
use std::io;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use iroh::endpoint::{presets, Connection, RecvStream, SendStream};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, SecretKey};
use tokio::net::{TcpListener, TcpStream};

pub use iroh;

/// The application protocol every Belay tunnel endpoint negotiates.
pub const ALPN: &[u8] = b"belay/1";

/// QUIC application close code sent to a peer that is not on the allow-list.
pub const CLOSE_NOT_ALLOWED: u32 = 0x4003;

/// The node ids a host accepts connections from. Everything else is closed
/// before a single stream is accepted, so no byte of theirs reaches the host.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AllowList {
    ids: HashSet<EndpointId>,
}

impl AllowList {
    /// Build from node ids as the accounts service spells them (z-base-32 /
    /// hex, whatever `EndpointId: FromStr` accepts). Returns the list and
    /// the entries it could not parse; the caller decides whether a bad entry
    /// is a log line or a refusal. An unparseable id never silently widens
    /// or narrows the list — it is simply reported.
    pub fn parse<'a>(ids: impl IntoIterator<Item = &'a str>) -> (AllowList, Vec<String>) {
        let mut ok = HashSet::new();
        let mut bad = Vec::new();
        for raw in ids {
            match raw.trim().parse::<EndpointId>() {
                Ok(id) => {
                    ok.insert(id);
                }
                Err(_) => bad.push(raw.to_string()),
            }
        }
        (AllowList { ids: ok }, bad)
    }

    pub fn from_ids(ids: impl IntoIterator<Item = EndpointId>) -> AllowList {
        AllowList { ids: ids.into_iter().collect() }
    }

    pub fn allows(&self, id: &EndpointId) -> bool {
        self.ids.contains(id)
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }
}

/// A shared, replaceable allow-list: the heartbeat loop swaps it, the accept
/// loop reads it.
pub type SharedAllowList = Arc<RwLock<AllowList>>;

/// Bind a tunnel endpoint with the given identity.
///
/// `relays` empty means n0's public relays (development only; see
/// infra/relay/README.md for production).
pub async fn bind(secret: SecretKey, relays: &[RelayUrl]) -> Result<Endpoint, iroh::endpoint::BindError> {
    let relay_mode = if relays.is_empty() {
        RelayMode::Default
    } else {
        RelayMode::custom(relays.iter().cloned())
    };
    Endpoint::builder(presets::N0)
        .secret_key(secret)
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(relay_mode)
        .bind()
        .await
}

/// Copy both directions between a QUIC bi-stream and a TCP socket until
/// either side finishes. Errors on close are the normal end of a connection
/// and are swallowed; the caller already knows the stream is over.
pub async fn pipe(mut send: SendStream, mut recv: RecvStream, mut tcp: TcpStream) -> io::Result<()> {
    let (mut tcp_rd, mut tcp_wr) = tcp.split();
    let up = async {
        let r = tokio::io::copy(&mut tcp_rd, &mut send).await;
        let _ = send.finish();
        r
    };
    let down = async {
        let r = tokio::io::copy(&mut recv, &mut tcp_wr).await;
        let _ = tokio::io::AsyncWriteExt::shutdown(&mut tcp_wr).await;
        r
    };
    let (a, b) = tokio::join!(up, down);
    a.and(b).map(|_| ())
}

/// The decision for one incoming connection, separated from I/O so it can be
/// unit-tested: accept when the remote is on the list, else close with
/// [`CLOSE_NOT_ALLOWED`].
pub fn admit(allow: &AllowList, remote: &EndpointId) -> bool {
    allow.allows(remote)
}

/// Host side: accept tunnel connections forever, piping every bi-stream from an
/// allowed peer to `target` (the host's own HTTPS listener for tunnel traffic).
pub async fn serve(endpoint: Endpoint, allow: SharedAllowList, target: SocketAddr) {
    while let Some(incoming) = endpoint.accept().await {
        let allow = allow.clone();
        tokio::spawn(async move {
            let conn = match incoming.accept() {
                Ok(accepting) => match accepting.await {
                    Ok(c) => c,
                    Err(_) => return,
                },
                Err(_) => return,
            };
            let remote = conn.remote_id();
            let ok = allow.read().map(|l| admit(&l, &remote)).unwrap_or(false);
            if !ok {
                conn.close(CLOSE_NOT_ALLOWED.into(), b"not allowed");
                return;
            }
            while let Ok((send, recv)) = conn.accept_bi().await {
                tokio::spawn(async move {
                    if let Ok(tcp) = TcpStream::connect(target).await {
                        let _ = pipe(send, recv, tcp).await;
                    }
                });
            }
        });
    }
}

/// What a phone can show about its tunnel connection.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Stats {
    pub connected: bool,
    /// Smoothed RTT on the selected path, in milliseconds.
    pub rtt_ms: f64,
    /// True when the selected path is a direct UDP path, false when relayed.
    pub direct: bool,
}

pub fn stats_of(conn: &Connection) -> Stats {
    let paths = conn.paths();
    let selected = paths.iter().find(|p| p.is_selected()).or_else(|| paths.iter().next());
    match selected {
        Some(p) => Stats { connected: true, rtt_ms: p.rtt().as_secs_f64() * 1000.0, direct: p.is_ip() },
        None => Stats { connected: true, rtt_ms: 0.0, direct: false },
    }
}

/// Phone side: a 127.0.0.1 TCP listener that turns each accepted connection
/// into one bi-stream to `remote`. One QUIC connection is shared and redialed
/// on demand when it drops.
pub struct Forwarder {
    pub local_port: u16,
    conn: Arc<tokio::sync::Mutex<Option<Connection>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Forwarder {
    pub async fn start(endpoint: Endpoint, remote: EndpointAddr) -> io::Result<Forwarder> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let local_port = listener.local_addr()?.port();
        let conn: Arc<tokio::sync::Mutex<Option<Connection>>> = Arc::default();
        let shared = conn.clone();
        let task = tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let endpoint = endpoint.clone();
                let remote = remote.clone();
                let shared = shared.clone();
                tokio::spawn(async move {
                    let Some(conn) = connected(&endpoint, remote, &shared).await else { return };
                    if let Ok((send, recv)) = conn.open_bi().await {
                        let _ = pipe(send, recv, tcp).await;
                    }
                });
            }
        });
        Ok(Forwarder { local_port, conn, task })
    }

    pub async fn stats(&self) -> Stats {
        match self.conn.lock().await.as_ref() {
            Some(c) if c.close_reason().is_none() => stats_of(c),
            _ => Stats::default(),
        }
    }

    /// Smoothed RTT of the live connection, or None when not connected.
    pub async fn rtt(&self) -> Option<Duration> {
        let s = self.stats().await;
        s.connected.then(|| Duration::from_secs_f64(s.rtt_ms / 1000.0))
    }

    pub async fn close(self) {
        self.task.abort();
        if let Some(c) = self.conn.lock().await.take() {
            c.close(0u32.into(), b"closed");
        }
    }
}

/// The live connection, dialing a new one when there is none or the old one
/// has closed. The lock is held across the dial so concurrent TCP accepts
/// share a single handshake instead of racing to open several.
async fn connected(
    endpoint: &Endpoint,
    remote: EndpointAddr,
    slot: &tokio::sync::Mutex<Option<Connection>>,
) -> Option<Connection> {
    let mut guard = slot.lock().await;
    if let Some(c) = guard.as_ref() {
        if c.close_reason().is_none() {
            return Some(c.clone());
        }
    }
    let c = endpoint.connect(remote, ALPN).await.ok()?;
    *guard = Some(c.clone());
    Some(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> EndpointId {
        SecretKey::generate().public()
    }

    #[test]
    fn allow_list_admits_only_listed_ids() {
        let a = id();
        let b = id();
        let list = AllowList::from_ids([a]);
        assert!(admit(&list, &a));
        assert!(!admit(&list, &b));
        assert!(!admit(&AllowList::default(), &a), "an empty list admits nobody");
    }

    #[test]
    fn allow_list_parse_reports_bad_entries_without_dropping_good_ones() {
        let a = id();
        let (list, bad) = AllowList::parse([a.to_string().as_str(), " not-a-node-id ", ""]);
        assert_eq!(list.len(), 1);
        assert!(list.allows(&a));
        assert_eq!(bad, vec![" not-a-node-id ".to_string(), "".to_string()]);
    }

    #[test]
    fn allow_list_parse_trims_whitespace() {
        let a = id();
        let padded = format!("  {a}\n");
        let (list, bad) = AllowList::parse([padded.as_str()]);
        assert!(bad.is_empty());
        assert!(list.allows(&a));
    }
}
