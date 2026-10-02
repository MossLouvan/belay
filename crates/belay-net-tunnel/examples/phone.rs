//! Mimic the phone: bind like belay_tunnel_start, dial like belay_tunnel_dial
//! (node id + first relay as hint), print the forwarder port, then keep
//! running so you can `curl -k https://127.0.0.1:<port>/health`.
//!
//!   BELAY_KEY=<64 hex> BELAY_RELAYS=http://host:3340 cargo run --example phone -- <host node id>
use belay_net_tunnel::{bind, relay_mode, Forwarder, ALPN};
use iroh::endpoint::presets;
use iroh::Endpoint;
use iroh::{EndpointAddr, EndpointId, RelayUrl, SecretKey};

#[tokio::main]
async fn main() {
    let host: EndpointId = std::env::args().nth(1).expect("host node id").parse().expect("node id");
    let key = std::env::var("BELAY_KEY").ok().map(|h| {
        let b: Vec<u8> = (0..32).map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap()).collect();
        SecretKey::from_bytes(&b.try_into().unwrap())
    });
    let key = key.unwrap_or_else(SecretKey::generate);
    let relays: Vec<RelayUrl> = std::env::var("BELAY_RELAYS").unwrap_or_default().split(',').filter_map(|s| s.trim().parse().ok()).collect();
    // BELAY_RELAY_ONLY=1: no IP transports, no mDNS, no DNS lookup: the host is
    // reachable only through the relay hint (a phone off the Wi-Fi).
    let ep = if std::env::var("BELAY_RELAY_ONLY").is_ok_and(|v| v == "1") {
        Endpoint::builder(presets::Minimal)
            .secret_key(key)
            .alpns(vec![ALPN.to_vec()])
            .relay_mode(relay_mode(&relays))
            .clear_ip_transports()
            .bind()
            .await
            .expect("bind")
    } else {
        bind(key, relay_mode(&relays)).await.expect("bind")
    };
    eprintln!("phone node id {}", ep.id());
    let mut addr = EndpointAddr::new(host);
    if let Some(r) = relays.first() {
        addr = addr.with_relay_url(r.clone());
    }
    let fwd = Forwarder::start(ep, addr).await.expect("forwarder");
    println!("port {}", fwd.local_port);
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        eprintln!("stats {:?}", fwd.stats().await);
    }
}
