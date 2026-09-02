# Scalability: the cloud rendezvous tier

How Belay goes from "phone and host on the same LAN/tailnet" to "any paired
phone reaches its host from anywhere" without trusting the cloud with anything
that matters, and without touching the tiers that already work. This implements
the consensus architecture's rendezvous slice (`docs/WEBRTC-SLICE.md` §"Why
LAN-only first", `docs/PERFORMANCE-PLAN.md` M7); the code is
`infra/rendezvous/` + `server/src/webrtc/envelope.ts`.

**Status honesty, up front:** the pure logic in this slice is implemented and
unit-tested (see the table below). The deployment topology, PoP strategy and
cost model are DESIGN — this repo cannot deploy or load-test cloud
infrastructure, so every claim in those sections is marked **UNVERIFIED** until
the verification runbook at the bottom has been executed against real
infrastructure. Nothing here claims "it scales"; it claims "this design has no
per-user central state, and the logic that must be right is tested".

---

## 1. Connection ladder (unchanged tiers stay primary)

1. **LAN direct** — mDNS discovery, JPEG/WS or WebRTC-LAN. Ships today.
2. **Tailscale** — WireGuard tunnel, same protocols. Ships today; the
   recommended remote path.
3. **Cloud rendezvous, direct P2P** *(this slice)* — the rendezvous introduces
   the peers, ICE + STUN find a direct UDP path, media flows peer-to-peer.
   Marginal cloud cost per session: a few KB of signaling.
4. **Cloud rendezvous, TURN relay** *(this slice)* — no direct path (symmetric
   NAT both sides, UDP-blocked network): media relays through coturn, still
   DTLS-SRTP end-to-end encrypted. This is the only tier where bandwidth costs
   money, which is why the credential is capped and short-lived.

Tiers 3–4 are gated on `BELAY_WEBRTC=1` **and** `BELAY_CLOUD_SIGNALING=1`
(`server/src/webrtc/flag.ts` — cloud off whenever WebRTC is off). Default off;
JPEG-over-WS on LAN/Tailscale remains the shipping product.

## 2. Trust model: the cloud is an untrusted introducer

The design goal, verbatim from the consensus: *the cloud connects peers but can
never decrypt or mint access.* Concretely:

- **Identity without accounts.** Pairing already gives both ends a shared
  256-bit device token that never leaves them. `envelope.ts` derives, via HKDF
  with separated info strings:
  - `mailboxId` — a public routing name. The rendezvous needs it to match
    peers; possessing it grants nothing (one-way derived, key-independent).
  - `signalKey` — an HMAC key the cloud never sees.
- **Sealed signaling.** Every offer/answer/ICE/bye crossing the rendezvous
  carries a seal: `HMAC-SHA256(signalKey, canonical(message) + ts + nonce)`
  with length-prefixed field encoding, a ±2 min skew window, and bounded
  nonce-replay rejection. The rendezvous relays it as opaque bytes
  (`infra/rendezvous/src/signal.ts` caps it and never reads it). A hostile
  rendezvous can drop or misroute — denial of service — but cannot forge a
  message either peer accepts. Device-key-proof admission is end-to-end, not
  cloud-side, so a compromised cloud still cannot admit anyone.
- **Media the cloud cannot read.** The sealed SDP carries the DTLS certificate
  fingerprint; DTLS-SRTP then proves the media peer holds that certificate.
  TURN relays ciphertext. A rendezvous MITM on media would need a forged seal,
  which needs the pairing token.
- **TURN credentials mint relay minutes, not access.** The TURN REST scheme
  (draft-uberti-behave-turn-rest-00; `turn-credentials.ts`): short TTL (5 min
  default), scoped per mailbox + session, bandwidth-capped by coturn policy
  (`max-bps` / quotas — `TURN_RELAY_POLICY` and `infra/turn/turnserver.conf`
  are locked together by a unit test). A stolen TURN credential lets someone
  relay their own packets for a few minutes within a bandwidth cap — it grants
  no access to any host and decrypts nothing.
- **What the cloud does learn (honesty):** pairing metadata — that mailbox X
  is online, when sessions happen, and the peers' IP addresses. That is the
  irreducible cost of an introducer. Users who refuse it keep tiers 1–2, which
  remain fully supported.

## 3. Statelessness: why this scales horizontally

A rendezvous instance holds **zero durable state**:

- **Presence = leases** (`lease.ts`): a host announces `{mailboxId, seq,
  ttl≤120s}` and re-announces at half-life. Reachability is a pure function of
  (recent announces, now). Kill any instance; within one TTL the picture
  rebuilds on whichever instance the host reconnects to. Replay of a captured
  announce against a live lease is seq-rejected; expiry always comes from the
  server clock.
- **Sessions = mailboxes** (`mailbox.ts`): a bounded in-memory meeting point
  for one host + one client, buffering signaling across the attach-order race,
  `bye`-terminal, idle-reaped. Worst-case loss on instance death: an
  in-progress *handshake* (seconds), never a media session — media is P2P/TURN
  and does not touch the rendezvous.
- **TURN credentials** are self-verifying HMACs; coturn checks them offline
  against the shared secret. No credential database anywhere.
- **Rate limiting** (`rate-limit.ts`) is per-instance token buckets, fail-closed
  at table capacity. A distributed attacker gets `instances × capacity`; the
  quota that costs real money (TURN) is additionally enforced by coturn itself.

The one coordination requirement: a host and its client must reach the *same*
instance for the mailbox to connect them (leases likewise). Route
`hash(mailboxId) → instance` at the load balancer (consistent hashing on the
WS path, e.g. Envoy/nginx `hash $arg_mailbox consistent`). On instance loss the
ring reassigns and both sides reconnect-and-reattach — the protocol was built
so that reattach is cheap and safe (no silent side takeover, buffered flush).
No Redis, no cross-instance bus, no sticky-session cookies. **UNVERIFIED:**
the consistent-hash LB config itself is deploy-time work not in this repo.

## 4. Adopt vs build

| Piece | Decision | License | Why |
|---|---|---|---|
| TURN relay | **Adopt coturn** | BSD-3-Clause (compatible with Belay's MIT) | The battle-tested reference TURN server (RFC 5766/8656); implements the REST credential scheme natively; per-user/total quotas and bps caps built in. Building a TURN server is months of NAT edge cases with zero product differentiation. |
| TURN credential scheme | **Adopt the TURN REST API convention** (implement in TS) | spec convention (draft-uberti-behave-turn-rest-00) | ~60 lines of pure HMAC we fully unit-test, vs pulling a dependency for it. Verified byte-for-byte against an independent HMAC computation in tests. |
| Signaling rendezvous | **Build** (thin, ~600 LOC + tests) | ours (MIT) | Off-the-shelf signaling servers (PeerJS server, ion-sfu, LiveKit) assume rooms/accounts/SFU semantics and would still need the sealed-envelope model bolted on. Our rendezvous is deliberately dumber than all of them — that is the security property — and it reuses the already-validated signal shapes from `server/src/webrtc/relay.ts`. |
| E2E seal | **Build** (`envelope.ts`) | ours | It IS the product's trust boundary; must compose with Belay's existing pairing-token model. Standard primitives only (HKDF, HMAC-SHA256, node:crypto). |
| Prior art consulted | Sunshine/Moonlight (STUN-first + self-hosted TURN fallback), Tailscale DERP (relay-of-last-resort + per-node keys), Parsec (cloud rendezvous + relays) | — | Same ladder shape everywhere: direct when possible, capped relay as fallback. |

## 5. PoP strategy (DESIGN — UNVERIFIED)

- **Phase 0 (now):** zero PoPs. Ship tiers 1–2. The LAN WebRTC slice's `ice.ts`
  telemetry measures the direct-vs-relayed ratio on real users — the number
  every cost decision below hangs on (consensus position, WEBRTC-SLICE.md).
- **Phase 1:** one PoP (single region, both services on one box via
  `infra/docker-compose.yml`). Rendezvous CPU is negligible (JSON relay);
  coturn is the resource to watch. Validates the protocol end-to-end.
- **Phase 2:** rendezvous stays few-region (signaling RTT only bites during
  setup); TURN goes multi-PoP because *media* RTT rides the relay. Client picks
  the TURN PoP by lowest STUN RTT probe; the lease's `hints` field already
  carries `region:*` for host-side locality. Same `static-auth-secret` on every
  PoP = any rendezvous mints for any PoP (rotate by dual-secret overlap —
  coturn accepts a secrets list).
- **Anycast/GeoDNS** in front of both; TLS terminates at the edge (`wss://`
  for signaling, `turns:` on 443 for UDP-blocked networks).

## 6. Cost model (DESIGN — UNVERIFIED, from the consensus)

Assumptions to validate with Phase-0 telemetry: **80–92% of session-hours go
direct** (industry WebRTC experience; Tailscale-using households skew higher),
relay sessions average ~4 Mbit/s effective.

| Item | Basis | Est. monthly at 1,000 MAU | at 10,000 MAU |
|---|---|---|---|
| Rendezvous compute | 2 small VMs (HA), signaling is ~KB/session | ~$20 | ~$40 (still 2–4 VMs) |
| TURN compute | 1 mid VM per PoP, 2→4 PoPs | ~$40 | ~$160 |
| TURN egress | the dominant term: `MAU × hrs/mo × relay% × 1.8 GB/hr @ ~$0.09/GB` (at 10 hrs/mo, 12% relayed) | ~$190 | ~$1,900 |
| **Total** | | **~$250/mo** | **~$2,100/mo** |

Per-MAU cost is egress-dominated and linear — there is no per-user server
state to shard, which is the point of the lease/mailbox design. The levers if
relay% comes in high: `max-bps` cap (already 12 Mbit/s), relay-tier quality
degradation before direct-tier, and egress-cheap providers (Hetzner ~$1/TB
class vs big-cloud ~$90/TB — a 10× swing that dwarfs every other line).
**These numbers set the shape of the bet, not a budget; Phase 1 replaces them
with measurements.**

## 7. What is tested vs not

| TESTED-AND-DONE (headless, green) | Where |
|---|---|
| TURN REST credential mint/verify, byte-equal to independent HMAC; TTL clamp; tamper/expiry rejection; sha1+sha256 | `infra/rendezvous/test/turn-credentials.test.ts` |
| Policy parity: `turnserver.conf` caps == `TURN_RELAY_POLICY` (drift fails tests) | same |
| Lease model: server-clock expiry, seq replay rejection, restart reset, renewal, capacity, prune | `test/lease.test.ts` |
| Mailbox brokering: attach-order buffering (bounded frames+bytes), side exclusivity, stale-session, terminal bye, idle reap | `test/mailbox.test.ts` |
| Wire protocol + config fail-fast + rate limiter edges | `test/protocol.test.ts`, `test/rate-limit.test.ts` |
| E2E seal: HKDF identity separation, tamper/forge/replay/skew rejection, canonical-encoding boundary attack, bounded replay guard | `server/test/webrtc-envelope.test.ts` |
| Existing suites still green with the additive `seal` field | `server npm test` (508 tests) |

| DESIGN-ONLY / UNVERIFIED-DEPLOY | Becomes real when |
|---|---|
| `server.ts` WS binding, Dockerfile, compose topology | runbook below |
| Host-side rendezvous client (dialing out, announcing leases) | next slice — `cloudSignalingEnabled()` gates it, wiring documented here so it stays a wiring change |
| App-side rendezvous fallback in the connection race | next slice (frontend owned elsewhere) |
| Consistent-hash LB, multi-PoP, all cost/scale numbers | Phase 1–2 deploys + load test |

## 8. Verification runbook (the honest path to "it works")

1. **Single-box smoke:** `export BELAY_TURN_SECRET=$(openssl rand -hex 32)`,
   `docker compose up` in `infra/`. `curl :8790/healthz`. Two `wscat` clients:
   host announces + attaches, client looks up + attaches, paste a sealed offer
   through, confirm delivery + `turn-cred` frames that `turnutils_uclient -W`
   accepts against the coturn.
2. **Cross-NAT reality:** host on a home NAT, client on cellular. Wire the host
   rendezvous client (next slice), confirm ICE completes; force TURN by
   blocking UDP (`turns:` on 443) and confirm relayed media + `relayed` in
   `ice.ts` telemetry, p95 ≤ 120 ms (PERFORMANCE-PLAN M7 bar).
3. **Statelessness proof:** kill the rendezvous mid-session — media must
   survive; reconnect must re-broker within one lease TTL. Kill one of two
   instances behind a consistent-hash LB — both sides must land together again.
4. **Abuse:** flood announces/turn requests from one IP (rate-limit refusals,
   flat memory); replay captured announces and sealed frames (rejected);
   confirm coturn refuses expired credentials and enforces `max-bps`.
5. **Load:** 10k synthetic hosts announcing at TTL/2 + 1k handshakes/min on one
   instance; memory flat, p99 relay latency < 50 ms intra-PoP. Only after this
   may any scale number in §6 be quoted without the UNVERIFIED label.
