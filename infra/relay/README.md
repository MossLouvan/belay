# Self-hosting the Belay relay (iroh-relay)

The tunnel (`crates/belay-net-tunnel`) hole-punches a direct QUIC path whenever it can; the
relay carries the handshake and the traffic that cannot. n0's public relays are for development
only. Production = one `iroh-relay` on a small Hetzner box. ~€5/month, one binary, Let's Encrypt
does the TLS by itself.

## 1. Box + DNS
- Hetzner CX22 (or smaller), Ubuntu 24.04, IPv4 + IPv6.
- DNS `A`/`AAAA`: `relay.gobelay.com` → the box.
- Hetzner firewall (or ufw): allow `22/tcp`, `80/tcp`, `443/tcp`, `7842/udp`.
  `80` is only the ACME challenge + captive-portal page; `443` carries the relay WebSocket;
  `7842/udp` is QUIC address discovery (the relay tells endpoints their public address, which is
  what makes hole-punching work).

## 2. Install
```sh
# as root
apt-get update && apt-get install -y curl build-essential pkg-config libssl-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"
cargo install iroh-relay --version 1.3.0 --locked --features server
useradd --system --home /var/lib/iroh-relay --create-home iroh-relay
install -m 0755 "$HOME/.cargo/bin/iroh-relay" /usr/local/bin/iroh-relay
```
(Pin the version to the `iroh` version in `crates/belay-net-tunnel/Cargo.toml`; the relay
protocol is versioned with it.)

## 3. Config `/etc/iroh-relay.toml`
```toml
# Relay traffic between endpoints (the whole point).
enable_relay = true
# Captive portal + ACME on :80; everything real runs under [tls].
http_bind_addr = "[::]:80"
# QUIC address discovery on 7842/udp; needs tls.
enable_quic_addr_discovery = true

[tls]
hostname = "relay.gobelay.com"
cert_mode = "LetsEncrypt"
cert_dir = "/var/lib/iroh-relay/certs"
https_bind_addr = "[::]:443"
quic_bind_addr = "[::]:7842"

# Only our devices may relay. Start with `everyone`; tighten to an HTTP check
# against the accounts service (X-Iroh-Endpoint-Id → 200 "true") once the
# accounts API exposes a "known node id" lookup.
access = "everyone"

[limits]
# New connections per second (+ burst), so a scanner cannot soak the box.
accept_conn_limit = 100
accept_conn_burst = 200
# Per-client receive cap: 10 MB/s is well above H.264 at "max"; a stranger
# cannot turn the relay into their own CDN.
[limits.client.rx]
bytes_per_second = 10_000_000
max_burst_bytes = 20_000_000
```
Let's Encrypt needs the box reachable on 80 and 443 under that hostname; the first start
fetches the certificate and later starts renew it. `iroh-relay --config-path /etc/iroh-relay.toml`
prints the config it will refuse (unknown keys are errors, so a typo cannot silently disable
TLS).

Binding :80/:443 as a non-root user: `setcap cap_net_bind_service=+ep /usr/local/bin/iroh-relay`.

## 4. systemd `/etc/systemd/system/iroh-relay.service`
```ini
[Unit]
Description=Belay relay (iroh-relay)
After=network-online.target
Wants=network-online.target

[Service]
User=iroh-relay
ExecStart=/usr/local/bin/iroh-relay --config-path /etc/iroh-relay.toml
Restart=always
RestartSec=2
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/iroh-relay
Environment=RUST_LOG=info

[Install]
WantedBy=multi-user.target
```
```sh
systemctl daemon-reload && systemctl enable --now iroh-relay
journalctl -u iroh-relay -f
```

## 5. Point Belay at it
- Accounts service: return `relayUrls: ["https://relay.gobelay.com"]` from `/hosts/heartbeat`
  (the host passes it to `belay-net` as `BELAY_NET_RELAYS`; a changed list restarts the sidecar;
  a 401 keeps the last list rather than clearing it).
- No relay list (empty or unset `BELAY_NET_RELAYS`) means **no relay** — direct paths only.
  Belay never falls back to n0's public relays. For local development only, set
  `BELAY_NET_DEV_PUBLIC_RELAYS=1` on the sidecar to use them.
- Phone: pass the same list to `startTunnel(secretHex, relayUrls)`.
- Check: `curl -sI https://relay.gobelay.com/` answers; metrics on `:9090/metrics` (bind it to
  localhost or firewall it — it is on by default).
- Local smoke test from this repo with the box in place:
  `BELAY_RELAY=https://relay.gobelay.com cargo run --release --example spike`
  (in `crates/belay-net-tunnel`) prints relay-path RTT.

## When to add a second relay
Relays are picked by latency at bind time; one in the EU and one in the US halves the
relayed RTT for users on the other side. Same recipe, second hostname, both in `relayUrls`.
