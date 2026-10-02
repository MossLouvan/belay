## Contracts (agents build in parallel against these; change only via this file)

### Accounts API — `https://api.gobelay.com/v1` (Worker; JSON; errors `{error, code}`)
| Method | Path | Auth | Body → Result |
|---|---|---|---|
| POST | /auth/email/start | none | `{email}` → 204. Sends a 6-digit code (Resend), 10 min TTL, max 5 attempts, rate limit per IP+email |
| POST | /auth/email/verify | none | `{email, code}` → `{session, account}` |
| POST | /auth/apple | none | `{identityToken, nonce}` → `{session, account}`. JWT verified against Apple JWKS; aud = our bundle id |
| POST | /auth/google | none | `{idToken}` → `{session, account}`. JWKS-verified; aud = our client ids |
| GET | /me | session | → `{account}` |
| DELETE | /me | session | → 204. Deletes the account, devices and sessions (App Store 5.1.1(v)) |
| POST | /devices | session | `{kind:'phone', name, nodeId}` → `{device}` (registers this phone's tunnel identity) |
| GET | /devices | session | → `{devices:[{id, kind, name, platform, nodeId, lastSeenAt}]}` |
| DELETE | /devices/:id | session | → 204 |
| POST | /claims | none | host: `{nodeId, name, platform}` → `{claimCode, hostSecret, expiresAt}`. Code: 8 chars, base32, 10 min |
| POST | /claims/:code/accept | session | phone → `{device}` (links the host to the account) |
| GET | /claims/:code | `X-Host-Secret` | host polls → `{status:'pending'|'claimed'|'expired', hostCredential?}` |
| POST | /hosts/heartbeat | host credential | `{}` → `{allowedNodeIds:[...phone nodeIds on the account], relayUrls:[...]}` |

- Session and host credentials: 32 random bytes base64url, stored SHA-256 hashed in D1, shown once. Sessions last 90 days with sliding expiry.
- Claim QR payload: `belay://claim?c=<code>&n=<nodeId>`. The phone checks that the nodeId it later dials equals the claimed one.
- Reviewer: env `REVIEW_EMAIL` + `REVIEW_CODE` (secret) accepts a fixed code for that one address.
- Secrets only via `wrangler secret`; none in the repo. Rate limiting on every unauthenticated route.

### Tunnel
- Each device has a persistent tunnel keypair. The host keeps it at `~/.belay/net-key` (0600). The phone keeps it in the iOS Keychain or Android Keystore, passed into FFI.
- Host sidecar `belay-net` (Rust binary started by the host): an iroh endpoint with ALPN `belay/1`. It accepts a connection ONLY if the remote nodeId is in `allowedNodeIds` from the last heartbeat (refreshed every 60 s, and cached on disk for offline restarts). Each bi-stream is piped to the host's HTTPS port.
- **SECURITY:** tunneled traffic must NOT get loopback privileges on the host. Today plain HTTP and some trust are granted to loopback. The sidecar connects through a dedicated listener (a unix socket or a separate bound port) that the host marks `remote`, so it gets the same rules as LAN. The existing device-token auth and pinned TLS still apply inside the tunnel (defence in depth: an account compromise alone does not grant control).
- Phone FFI (in `crates/belay-client`, the same xcframework): `belay_tunnel_start(secretKey, relayUrls) -> handle`, `belay_tunnel_dial(handle, nodeId) -> localPort` (127.0.0.1 listener forwarding to the tunnel), `belay_tunnel_stats`, `belay_tunnel_close`. The app connects to `https://127.0.0.1:<localPort>`; the pin applies to that address too (same host fingerprint).
- Connection race in app/src/devices/race.ts: LAN candidates + `tunnel:<nodeId>`. Prefer LAN when it answers.
- Relays: `relayUrls` come from heartbeat/config. Production = self-hosted `iroh-relay` (deploy notes in infra/relay). Development may use n0 public relays.

### Out of scope here
Android tunnel FFI (follows the iOS FFI once proven), the installer app (separate change), and billing.
