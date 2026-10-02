//! The Belay tunnel: an iroh endpoint speaking ALPN `belay/1`, whose QUIC
//! bi-streams are piped byte-for-byte to a TCP port.
//!
//! Two halves, one crate:
//! * the host runs [`Host::serve`]: accept connections from phones on the
//!   account's allow-list and pipe each stream to the host's tunnel listener;
//! * the phone runs [`Forwarder`]: a 127.0.0.1 TCP listener whose every
//!   accepted connection becomes one bi-stream to the host.
//!
//! Everything inside the tunnel is still the host's own TLS: the phone pins the
//! host certificate against 127.0.0.1:localPort exactly as it does on the LAN.
//! iroh encrypts hop-by-hop on top (QUIC/TLS keyed on the endpoint ids), and
//! the host's device-token auth applies unchanged. An account compromise
//! alone therefore reaches the host's front door and nothing behind it.

use std::collections::{HashMap, HashSet};
use std::io;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use iroh::endpoint::{presets, Connection, RecvStream, SendStream};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, SecretKey};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

pub use iroh;

/// The application protocol every Belay tunnel endpoint negotiates.
pub const ALPN: &[u8] = b"belay/1";

/// QUIC application close code sent to a peer that is not on the allow-list.
pub const CLOSE_NOT_ALLOWED: u32 = 0x4003;

/// First line of every TCP stream the host side pipes: who is on the other
/// end of the tunnel, so the host can tag the socket `tunnel:<nodeId>` and
/// keep per-phone pairing/replay/notification state.
///
/// The listener is a loopback port any local process could connect to, so
/// the line also carries a per-launch secret the host handed this sidecar
/// (env `BELAY_NET_STREAM_SECRET`, never argv). Without it a local process
/// could claim to be any allow-listed phone. The old `belay-tunnel/1` line,
/// which had no secret, is rejected by the host.
pub const STREAM_HEADER_PREFIX: &str = "belay-tunnel/2 ";

/// The host's per-launch stream secret: 32 bytes as 64 lowercase hex.
#[derive(Clone, PartialEq, Eq)]
pub struct StreamSecret(String);

impl StreamSecret {
    pub fn parse(hex: &str) -> Option<StreamSecret> {
        let ok = hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        ok.then(|| StreamSecret(hex.to_string()))
    }
}

impl std::fmt::Debug for StreamSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StreamSecret(..)")
    }
}

pub fn stream_header(secret: &StreamSecret, id: &EndpointId) -> String {
    format!("{STREAM_HEADER_PREFIX}{} {id}\n", secret.0)
}

/// Concurrent bi-streams one connection may have open: a phone opens one per
/// HTTP connection; sixty-four is far above what a client keeps alive and
/// bounds what a compromised phone can fan out.
pub const MAX_STREAMS_PER_CONNECTION: usize = 64;
/// Concurrent tunnel connections the host accepts overall.
pub const MAX_CONNECTIONS: usize = 256;

/// The node ids a host accepts connections from. Everything else is closed
/// before a single stream is accepted, so no byte of theirs reaches the host.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AllowList {
    ids: HashSet<EndpointId>,
}

impl AllowList {
    /// Build from node ids as the accounts service spells them (whatever
    /// `EndpointId: FromStr` accepts). Returns the list and the entries it
    /// could not parse; the caller decides whether a bad entry is a log line
    /// or a refusal. An unparseable id never silently widens or narrows the
    /// list — it is simply reported.
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

/// The relay configuration for a list of relay URLs: exactly those relays,
/// or NO relay when the list is empty. An empty list never means n0's public
/// relays; a caller that wants those for development says `RelayMode::Default`
/// explicitly (the sidecar's BELAY_NET_DEV_PUBLIC_RELAYS=1).
pub fn relay_mode(relays: &[RelayUrl]) -> RelayMode {
    if relays.is_empty() {
        RelayMode::Disabled
    } else {
        RelayMode::custom(relays.iter().cloned())
    }
}

/// Bind a tunnel endpoint with the given identity and relays (see
/// [`relay_mode`]; infra/relay/README.md for production).
pub async fn bind(secret: SecretKey, relay_mode: RelayMode) -> Result<Endpoint, iroh::endpoint::BindError> {
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
        let _ = tcp_wr.shutdown().await;
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

/// The host side: the allow-list and every live connection, so a phone that
/// leaves the list loses its connection the moment the list is replaced, not
/// when it next reconnects.
pub struct Host {
    allow: RwLock<AllowList>,
    live: Mutex<HashMap<EndpointId, Vec<Connection>>>,
    conns: Arc<Semaphore>,
}

impl Host {
    pub fn new(allow: AllowList) -> Arc<Host> {
        Arc::new(Host {
            allow: RwLock::new(allow),
            live: Mutex::new(HashMap::new()),
            conns: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
        })
    }

    pub fn allows(&self, id: &EndpointId) -> bool {
        self.allow.read().map(|l| admit(&l, id)).unwrap_or(false)
    }

    pub fn allow_len(&self) -> usize {
        self.allow.read().map(|l| l.len()).unwrap_or(0)
    }

    /// Replace the allow-list and close every live connection from a node id
    /// no longer on it (immediate revocation).
    pub fn set_allow(&self, list: AllowList) {
        if let Ok(mut slot) = self.allow.write() {
            *slot = list;
        }
        let Ok(mut live) = self.live.lock() else { return };
        let revoked: Vec<EndpointId> = live.keys().filter(|id| !self.allows(id)).copied().collect();
        for id in revoked {
            for conn in live.remove(&id).unwrap_or_default() {
                conn.close(CLOSE_NOT_ALLOWED.into(), b"revoked");
            }
        }
    }

    fn track(&self, conn: &Connection) {
        if let Ok(mut live) = self.live.lock() {
            live.entry(conn.remote_id()).or_default().push(conn.clone());
        }
    }

    fn untrack(&self, conn: &Connection) {
        let Ok(mut live) = self.live.lock() else { return };
        let id = conn.remote_id();
        if let Some(list) = live.get_mut(&id) {
            list.retain(|c| c.stable_id() != conn.stable_id());
            if list.is_empty() {
                live.remove(&id);
            }
        }
    }

    /// Accept tunnel connections forever, piping every bi-stream from an
    /// allowed peer to `target` (the host's tunnel listener), each stream
    /// prefixed with [`stream_header`].
    pub async fn serve(self: Arc<Self>, endpoint: Endpoint, target: SocketAddr, secret: StreamSecret) {
        while let Some(incoming) = endpoint.accept().await {
            let Ok(permit) = self.conns.clone().acquire_owned().await else { return };
            let host = self.clone();
            let secret = secret.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let Ok(accepting) = incoming.accept() else { return };
                let Ok(conn) = accepting.await else { return };
                host.connection(conn, target, &secret).await;
            });
        }
    }

    async fn connection(&self, conn: Connection, target: SocketAddr, secret: &StreamSecret) {
        let remote = conn.remote_id();
        if !self.allows(&remote) {
            conn.close(CLOSE_NOT_ALLOWED.into(), b"not allowed");
            return;
        }
        self.track(&conn);
        let streams = Arc::new(Semaphore::new(MAX_STREAMS_PER_CONNECTION));
        let header = stream_header(secret, &remote);
        while let Ok((send, recv)) = conn.accept_bi().await {
            // Re-checked per stream: the list may have changed since the
            // handshake, and set_allow's close may still be in flight.
            if !self.allows(&remote) {
                conn.close(CLOSE_NOT_ALLOWED.into(), b"revoked");
                break;
            }
            let Ok(permit) = streams.clone().acquire_owned().await else { break };
            let header = header.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let Ok(mut tcp) = TcpStream::connect(target).await else { return };
                if tcp.write_all(header.as_bytes()).await.is_err() {
                    return;
                }
                let _ = pipe(send, recv, tcp).await;
            });
        }
        self.untrack(&conn);
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
        let streams = Arc::new(Semaphore::new(MAX_STREAMS_PER_CONNECTION));
        let task = tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let Ok(permit) = streams.clone().acquire_owned().await else { return };
                let endpoint = endpoint.clone();
                let remote = remote.clone();
                let shared = shared.clone();
                tokio::spawn(async move {
                    let _permit = permit;
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

    #[test]
    fn no_relays_means_no_relay_not_public_ones() {
        assert_eq!(relay_mode(&[]), RelayMode::Disabled);
        let r: RelayUrl = "https://relay.example".parse().unwrap();
        assert_eq!(relay_mode(&[r.clone()]), RelayMode::custom([r]));
    }

    #[test]
    fn stream_header_is_v2_secret_then_node_id_on_one_line() {
        let a = id();
        let secret = StreamSecret::parse(&"5a".repeat(32)).unwrap();
        let h = stream_header(&secret, &a);
        assert!(h.starts_with("belay-tunnel/2 "));
        assert!(h.ends_with('\n'));
        let rest: Vec<&str> = h["belay-tunnel/2 ".len()..h.len() - 1].split(' ').collect();
        assert_eq!(rest.len(), 2);
        assert_eq!(rest[0], "5a".repeat(32));
        assert_eq!(rest[1].len(), 64);
        assert!(rest[1].bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    }

    #[test]
    fn stream_secret_is_exactly_64_lowercase_hex() {
        assert!(StreamSecret::parse(&"0f".repeat(32)).is_some());
        for bad in ["", "abc", &"0F".repeat(32), &"0f".repeat(31), &"0f".repeat(33), &"zz".repeat(32)] {
            assert!(StreamSecret::parse(bad).is_none(), "{bad}");
        }
        assert_eq!(format!("{:?}", StreamSecret::parse(&"0f".repeat(32)).unwrap()), "StreamSecret(..)");
    }
}
