//! Spike: two endpoints on one machine. Dials direct (relay disabled) and via
//! relay only (IP transports cleared), measuring handshake and stream RTT.
//!
//!   cargo run --release --example spike            # n0 public relays
//!   BELAY_RELAY=https://relay.example cargo run --release --example spike
use std::time::Instant;

use belay_net_tunnel::{bind, stats_of, AllowList, ALPN};
use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, RelayMode, SecretKey, TransportAddr};

async fn ping(ep: &Endpoint, addr: EndpointAddr, label: &str) {
    let t0 = Instant::now();
    let conn = ep.connect(addr, ALPN).await.expect("connect");
    let handshake = t0.elapsed();
    let mut rtts = Vec::new();
    for _ in 0..20 {
        let (mut s, mut r) = conn.open_bi().await.unwrap();
        let t = Instant::now();
        s.write_all(b"ping").await.unwrap();
        s.finish().unwrap();
        let mut buf = [0u8; 4];
        r.read_exact(&mut buf).await.unwrap();
        rtts.push(t.elapsed());
    }
    rtts.sort();
    let st = stats_of(&conn);
    println!(
        "{label}: handshake {:?}, stream rtt median {:?} min {:?}, quic rtt {:.1}ms, direct={}",
        handshake,
        rtts[rtts.len() / 2],
        rtts[0],
        st.rtt_ms,
        st.direct
    );
    conn.close(0u32.into(), b"done");
}

#[tokio::main]
async fn main() {
    let relays: Vec<iroh::RelayUrl> = std::env::var("BELAY_RELAY")
        .ok()
        .map(|u| vec![u.parse().unwrap()])
        .unwrap_or_default();
    let relay_mode = if relays.is_empty() { RelayMode::Default } else { RelayMode::custom(relays.clone()) };

    // Server: echo every bi-stream, allow-listing the client.
    let client_key = SecretKey::generate();
    let allow = AllowList::from_ids([client_key.public()]);
    let server = bind(SecretKey::generate(), relay_mode.clone()).await.expect("bind server");
    server.online().await;
    let server_addr = server.addr();
    println!("server {} addr {:?}", server.id(), server_addr);
    let srv = server.clone();
    tokio::spawn(async move {
        while let Some(inc) = srv.accept().await {
            let allow = allow.clone();
            tokio::spawn(async move {
                let conn = inc.accept().unwrap().await.unwrap();
                if !allow.allows(&conn.remote_id()) {
                    conn.close(1u32.into(), b"no");
                    return;
                }
                while let Ok((mut s, mut r)) = conn.accept_bi().await {
                    tokio::spawn(async move {
                        let b: Vec<u8>;
                        b = r.read_to_end(1 << 16).await.unwrap();
                        s.write_all(&b).await.unwrap();
                        let _ = s.finish();
                    });
                }
            });
        }
    });

    // 1. Direct: no relay at all, dial by IP addresses only.
    let direct = Endpoint::builder(presets::N0DisableRelay)
        .secret_key(client_key.clone())
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let ip_only = EndpointAddr::from_parts(server_addr.id, server_addr.ip_addrs().map(|a| TransportAddr::Ip(*a)));
    ping(&direct, ip_only, "direct").await;
    direct.close().await;

    // 2. Relay only: client has no IP transports, so every packet rides the relay.
    let relayed = Endpoint::builder(presets::N0)
        .secret_key(client_key.clone())
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(relay_mode)
        .clear_ip_transports()
        .bind()
        .await
        .unwrap();
    let relay_only = EndpointAddr::from_parts(server_addr.id, server_addr.relay_urls().cloned().map(TransportAddr::Relay));
    ping(&relayed, relay_only, "relay").await;
    relayed.close().await;

    // 3. Stranger: not on the allow-list.
    let stranger = Endpoint::builder(presets::N0DisableRelay).alpns(vec![ALPN.to_vec()]).bind().await.unwrap();
    let conn = stranger
        .connect(EndpointAddr::from_parts(server_addr.id, server_addr.ip_addrs().map(|a| TransportAddr::Ip(*a))), ALPN)
        .await
        .unwrap();
    let r = conn.accept_bi().await;
    println!("stranger: first stream -> {:?} (expected closed)", r.err().map(|e| e.to_string()));
    server.close().await;
}
