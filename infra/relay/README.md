# Self-hosting the Belay relay (iroh-relay)

The tunnel (`crates/belay-net-tunnel`) hole-punches a direct QUIC path whenever it can; the
relay carries the handshake and the traffic that cannot. n0's public relays are for development
only. Production = `iroh-relay` boxes we own: one binary, one systemd unit, Let's Encrypt done
by the relay itself. Everything a box needs is in [`cloud-init.yaml`](cloud-init.yaml); the
`aws/` and `azure/` scripts just launch a VM with it.

Ports (from the iroh-relay 1.3 source, `iroh-relay/src/defaults.rs`): `80/tcp` ACME challenge +
captive-portal page, `443/tcp` relay WebSocket, `7842/udp` QUIC address discovery (the relay
tells endpoints their public address, which is what makes hole-punching work). There is no
STUN/3478. Metrics on `127.0.0.1:9090` only.

## Deploy on AWS Lightsail (3 regions, one command)
```sh
aws sts get-caller-identity              # logged in?
ACME_EMAIL=you@gobelay.com infra/relay/aws/deploy.sh
```
Creates `belay-relay-use1|euc1|apse1` (us-east-1, eu-central-1, ap-southeast-1) from
`cloud-init.yaml`, Ubuntu 24.04, bundle `small_3_0`, a static IP each, and opens exactly the
ports above. Re-running skips what exists (safe to run after a failure). It ends by printing
the DNS records:

- `A`/`AAAA` `relay-use1.gobelay.com`, `relay-euc1.gobelay.com`, `relay-apse1.gobelay.com`.
- `CNAME relay.gobelay.com -> relay-use1.gobelay.com`: the fallback the app ships when
  `EXPO_PUBLIC_RELAY_URLS` is unset (`app/src/account/tunnel-key.ts`). Point it at the region
  nearest most users. Do not round-robin one name across regions: peers must agree on a home
  relay and iroh does that per URL.

Cloudflare: DNS-only (grey cloud), never proxied. `infra/relay/aws/destroy.sh` tears it down.
Override `REGIONS`, `BUNDLE`, `DOMAIN` by env.

## Azure backup (one region)
```sh
az login
ACME_EMAIL=you@gobelay.com infra/relay/azure/deploy.sh      # westus2 -> relay-azw2.gobelay.com
```
Same cloud-init, `Standard_B2ats_v2`, resource group `belay-relay-azw2`. Add its URL to the
lists below only when you want it in rotation (overflow, or while AWS is down).

## Cost from credits
| | per month | $10k credit lasts |
|---|---|---|
| Lightsail `small_3_0` × 3 ($12 each, 2 vCPU/2 GB/60 GB/3 TB transfer; attached static IPs free) | $36 | ~23 years |
| Azure `B2ats_v2` ≈ $4 + egress $0.087/GB after the first 100 GB | ~$4–15 | years |

Transfer overage on Lightsail is $0.09/GB. A relayed screen session is roughly 1 MB/s at the top quality tier, so
3 TB ≈ 35 relay-days of continuous video per box per month; direct paths (the common case)
cost nothing. Note some APAC regions halve the included transfer; `aws lightsail get-bundles
--region ap-southeast-1` shows the real number. Verify bundle ids/prices with the same command
before changing `BUNDLE`.

## Point Belay at the relays
- Worker (`infra/accounts/wrangler.toml` `[vars]`):
  `RELAY_URLS = "https://relay-use1.gobelay.com,https://relay-euc1.gobelay.com,https://relay-apse1.gobelay.com"`
  then `wrangler deploy`. Hosts get it from `/hosts/heartbeat` as `relayUrls` (a changed list
  restarts the sidecar; a 401 keeps the last list).
- App: `EXPO_PUBLIC_RELAY_URLS` with the same comma-separated list in the EAS build profile
  (`app/eas.json` env) or `.env`. It is read at build time; unset means `https://relay.gobelay.com`.
- iroh pings every URL at bind time and homes on the lowest-latency one, so listing all three
  is what makes the phone in Sydney not relay through Virginia.
- No relay list means **no relay** (direct paths only); Belay never falls back to n0's public
  relays. Dev only: `BELAY_NET_DEV_PUBLIC_RELAYS=1` on the sidecar.

## Verify a relay
```sh
curl -sI https://relay-use1.gobelay.com/generate_204     # HTTP/2 204, valid LE cert
curl -s  https://relay-use1.gobelay.com/                 # captive-portal page = relay up
ssh ubuntu@relay-use1.gobelay.com 'journalctl -u iroh-relay -n 50; sudo ss -lunp | grep 7842'
BELAY_RELAY=https://relay-use1.gobelay.com cargo run --release --example spike   # in crates/belay-net-tunnel: relay-path RTT
```
Let's Encrypt completes a minute or two after the A record resolves (the relay retries on
its own; `journalctl` shows "certificate obtained"). Ubuntu `cloud-init status --long` shows
whether the box finished provisioning. The binary's SHA-256 is checked before install; a
mismatch leaves no `iroh-relay` on the box and the unit fails loudly.

## Config notes (`/etc/iroh-relay.toml`, written by cloud-init)
- `access = "everyone"` for now. Tighten to `access.http` (POST with the endpoint id → `200 true`)
  once the accounts API exposes a known-node-id lookup, or `access.shared_token` if the app
  and host can carry a token.
- Limits: 100 new conns/s (+200 burst); 10 MB/s receive per client, 20 MB burst (well above
  H.264 at "max"; nobody turns the relay into their own CDN).
- Unknown keys are errors, so a typo cannot silently disable TLS.
- Pin: `iroh-relay v1.3.0` matches `iroh = "1.3"` in `crates/belay-net-tunnel/Cargo.toml`.
  Bump version and both checksums in `cloud-init.yaml` together (`shasum -a 256` of the
  release tarball), redeploy by `destroy.sh && deploy.sh` or `ssh` + rerun
  `/usr/local/sbin/install-iroh-relay && systemctl restart iroh-relay`.

## Moving to Hetzner / OVH later (no app change)
The app and the Worker only know URLs. Create the box anywhere that accepts cloud-init
(Hetzner: `hcloud server create --user-data-from-file`, OVH: paste as "post-installation
script"), with `__HOSTNAME__`/`__ACME_EMAIL__` substituted the way the scripts do, open the
same four ports, then move the `relay-<x>.gobelay.com` A record (or add a new name to
`RELAY_URLS`/`EXPO_PUBLIC_RELAY_URLS`). Keep the old box up until the DNS TTL passes, then
`destroy.sh`. Relayed sessions reconnect by themselves; the host restarts its sidecar when
the heartbeat list changes.
