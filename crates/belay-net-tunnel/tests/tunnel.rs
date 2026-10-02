//! End to end on loopback: host `Host::serve` piping to a TCP echo that
//! strips the stream header the way the host's tunnel listener does, phone
//! `Forwarder` dialing it, a stranger getting nothing, and a revoked phone
//! losing its live connection.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use belay_net_tunnel::{bind, stream_header, AllowList, Forwarder, Host, ALPN, STREAM_HEADER_PREFIX};
use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode, SecretKey, TransportAddr};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

/// A TCP echo that, like server/src/tunnel-listener.ts, requires the header
/// line first and records whose it was. A stream without it gets nothing.
async fn echo_server() -> (std::net::SocketAddr, Arc<Mutex<Vec<String>>>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen2 = seen.clone();
    tokio::spawn(async move {
        while let Ok((s, _)) = l.accept().await {
            let seen = seen2.clone();
            tokio::spawn(async move {
                let mut r = BufReader::new(s);
                let mut line = String::new();
                if r.read_line(&mut line).await.is_err() || !line.starts_with(STREAM_HEADER_PREFIX) {
                    return;
                }
                seen.lock().unwrap().push(line.trim_end().to_string());
                // Bytes read past the header belong to the stream; a BufReader
                // drops them on into_inner, so echo them first.
                let rest = r.buffer().to_vec();
                let mut s = r.into_inner();
                if s.write_all(&rest).await.is_err() {
                    return;
                }
                let (mut rd, mut wr) = s.split();
                let _ = tokio::io::copy(&mut rd, &mut wr).await;
            });
        }
    });
    (addr, seen)
}

fn ip_only(ep: &Endpoint) -> EndpointAddr {
    let a = ep.addr();
    EndpointAddr::from_parts(a.id, a.ip_addrs().map(|ip| TransportAddr::Ip(*ip)))
}

async fn phone(key: SecretKey) -> Endpoint {
    Endpoint::builder(presets::N0DisableRelay)
        .secret_key(key)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap()
}

async fn round_trip(port: u16, msg: &[u8]) -> Vec<u8> {
    let mut tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    tcp.write_all(msg).await.unwrap();
    let mut buf = vec![0u8; msg.len()];
    tokio::time::timeout(Duration::from_secs(10), tcp.read_exact(&mut buf)).await.unwrap().unwrap();
    buf
}

async fn setup(phone_id: EndpointId) -> (Arc<Host>, Endpoint, EndpointAddr, Arc<Mutex<Vec<String>>>) {
    let (target, seen) = echo_server().await;
    let host = Host::new(AllowList::from_ids([phone_id]));
    let ep = bind(SecretKey::generate(), RelayMode::Disabled).await.unwrap();
    let addr = ip_only(&ep);
    tokio::spawn(host.clone().serve(ep.clone(), target));
    (host, ep, addr, seen)
}

#[tokio::test]
async fn allowed_phone_round_trips_bytes_through_the_tunnel() {
    let phone_key = SecretKey::generate();
    let (_host, ep, addr, seen) = setup(phone_key.public()).await;

    let fwd = Forwarder::start(phone(phone_key.clone()).await, addr).await.unwrap();
    assert_eq!(round_trip(fwd.local_port, b"hello through the tunnel").await, b"hello through the tunnel");

    let stats = fwd.stats().await;
    assert!(stats.connected);
    assert!(stats.direct, "loopback dial should be a direct path: {stats:?}");
    assert!(stats.rtt_ms < 100.0, "{stats:?}");

    // A second TCP connection reuses the QUIC connection, and every stream
    // carried the phone's node id as its header line.
    assert_eq!(round_trip(fwd.local_port, b"again").await, b"again");
    let want = stream_header(&phone_key.public());
    assert_eq!(*seen.lock().unwrap(), vec![want.trim_end().to_string(); 2]);
    fwd.close().await;
    ep.close().await;
}

#[tokio::test]
async fn stranger_gets_no_bytes_from_the_host() {
    let (_host, ep, addr, seen) = setup(SecretKey::generate().public()).await;

    let fwd = Forwarder::start(phone(SecretKey::generate()).await, addr).await.unwrap();
    let mut tcp = TcpStream::connect(("127.0.0.1", fwd.local_port)).await.unwrap();
    let _ = tcp.write_all(b"hello?").await;
    let mut buf = Vec::new();
    let n = tokio::time::timeout(Duration::from_secs(10), tcp.read_to_end(&mut buf)).await;
    assert!(matches!(n, Ok(Ok(0))) || n.is_err() && buf.is_empty(), "stranger must get nothing back, got {buf:?}");
    assert!(buf.is_empty());
    assert!(seen.lock().unwrap().is_empty(), "no stream ever reached the host");
    fwd.close().await;
    ep.close().await;
}

#[tokio::test]
async fn revoking_a_phone_closes_its_live_connection() {
    let phone_key = SecretKey::generate();
    let (host, ep, addr, _seen) = setup(phone_key.public()).await;
    let fwd = Forwarder::start(phone(phone_key).await, addr).await.unwrap();
    assert_eq!(round_trip(fwd.local_port, b"before").await, b"before");
    assert!(fwd.stats().await.connected);

    host.set_allow(AllowList::default());

    // The live QUIC connection is closed by the host, so a new stream on it
    // (which the Forwarder would reuse) carries nothing back...
    let mut tcp = TcpStream::connect(("127.0.0.1", fwd.local_port)).await.unwrap();
    let _ = tcp.write_all(b"after").await;
    let mut buf = Vec::new();
    let n = tokio::time::timeout(Duration::from_secs(10), tcp.read_to_end(&mut buf)).await;
    assert!(buf.is_empty(), "revoked phone got {buf:?} ({n:?})");
    // ...and the Forwarder sees its connection gone (it may have redialed and
    // been refused again; either way, nothing is connected).
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!fwd.stats().await.connected, "connection must be closed after revocation");
    fwd.close().await;
    ep.close().await;
}
