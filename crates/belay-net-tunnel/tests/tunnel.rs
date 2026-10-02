//! End to end on loopback: host `serve` piping to a TCP echo, phone
//! `Forwarder` dialing it, and a stranger getting nothing.

use std::sync::{Arc, RwLock};
use std::time::Duration;

use belay_net_tunnel::{bind, AllowList, Forwarder, ALPN};
use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, SecretKey, TransportAddr};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn echo_server() -> std::net::SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    addr
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

#[tokio::test]
async fn allowed_phone_round_trips_bytes_through_the_tunnel() {
    let target = echo_server().await;
    let phone_key = SecretKey::generate();
    let allow = Arc::new(RwLock::new(AllowList::from_ids([phone_key.public()])));
    let host = bind(SecretKey::generate(), &[]).await.unwrap();
    let host_addr = ip_only(&host);
    tokio::spawn(belay_net_tunnel::serve(host.clone(), allow, target));

    let fwd = Forwarder::start(phone(phone_key).await, host_addr).await.unwrap();
    let mut tcp = TcpStream::connect(("127.0.0.1", fwd.local_port)).await.unwrap();
    tcp.write_all(b"hello through the tunnel").await.unwrap();
    let mut buf = [0u8; 24];
    tokio::time::timeout(Duration::from_secs(10), tcp.read_exact(&mut buf)).await.unwrap().unwrap();
    assert_eq!(&buf, b"hello through the tunnel");

    let stats = fwd.stats().await;
    assert!(stats.connected);
    assert!(stats.direct, "loopback dial should be a direct path: {stats:?}");
    assert!(stats.rtt_ms < 100.0, "{stats:?}");

    // A second TCP connection reuses the QUIC connection.
    let mut tcp2 = TcpStream::connect(("127.0.0.1", fwd.local_port)).await.unwrap();
    tcp2.write_all(b"again").await.unwrap();
    let mut b2 = [0u8; 5];
    tokio::time::timeout(Duration::from_secs(10), tcp2.read_exact(&mut b2)).await.unwrap().unwrap();
    assert_eq!(&b2, b"again");
    fwd.close().await;
    host.close().await;
}

#[tokio::test]
async fn stranger_gets_no_bytes_from_the_host() {
    let target = echo_server().await;
    let allow = Arc::new(RwLock::new(AllowList::from_ids([SecretKey::generate().public()])));
    let host = bind(SecretKey::generate(), &[]).await.unwrap();
    let host_addr = ip_only(&host);
    tokio::spawn(belay_net_tunnel::serve(host.clone(), allow, target));

    let fwd = Forwarder::start(phone(SecretKey::generate()).await, host_addr).await.unwrap();
    let mut tcp = TcpStream::connect(("127.0.0.1", fwd.local_port)).await.unwrap();
    let _ = tcp.write_all(b"hello?").await;
    let mut buf = Vec::new();
    let n = tokio::time::timeout(Duration::from_secs(10), tcp.read_to_end(&mut buf)).await;
    assert!(matches!(n, Ok(Ok(0))) || n.is_err() && buf.is_empty(), "stranger must get nothing back, got {buf:?}");
    assert!(buf.is_empty());
    fwd.close().await;
    host.close().await;
}
