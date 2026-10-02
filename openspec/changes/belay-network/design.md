## Contracts (agents build in parallel against these; change only via this file)

### Accounts API — `https://api.gobelay.com/v1` (Worker; JSON; errors `{error, code}`)
| Method | Path | Auth | Body → Result |
|---|---|---|---|
| POST | /auth/email/start | none | `{email}` → 204. Sends a 6-digit code (Resend), 10 min TTL, max 5 attempts, rate limit per IP+email |
| POST | /auth/email/verify | none | `{email, code}` → `{session, account}` |
| POST | /auth/nonce | none | `{}` → `{nonce, expiresAt}`. Server-issued, 5 min, single-use. The app sends sha256(nonce) to Apple and the raw nonce to /auth/apple |
| POST | /auth/apple | none | `{identityToken, nonce}` → `{session, account}`. JWT verified against Apple JWKS; aud = our bundle id; nonce must come from /auth/nonce (consumed atomically) |
| POST | /auth/google | none | `{idToken}` → `{session, account}`. JWKS-verified; aud = our client ids; each token is accepted once (sha256 kept until exp) |
| POST | /auth/logout | session | `{}` → 204. Deletes this session |
| GET | /me | session | → `{account}` |
| DELETE | /me | session | → 204. Deletes the account, devices and sessions (App Store 5.1.1(v)) |
| POST | /devices | session | `{kind:'phone', name, nodeId}` → `{device}` (registers this phone's tunnel identity) |
| GET | /devices | session | → `{devices:[{id, kind, name, platform, nodeId, lastSeenAt}]}` |
| DELETE | /devices/:id | session | → 204 |
| POST | /claims | none | host: `{nodeId, name, platform, ts, sig}` → `{claimCode, hostSecret, expiresAt}`. Code: 8 chars, base32, 10 min. `ts` = unix seconds (±300 s); `sig` = base64url Ed25519 signature by the node's secret key over the UTF-8 string `belay-claim:v1:${nodeId}:${ts}`. Bad signature → 401 |
| POST | /claims/:code/accept | session | phone → `{device}` (links the host to the account). 404 for unknown, expired OR already-taken codes; 409 `device_exists` if the account already has a host with that nodeId and a live credential (DELETE /devices/:id first). Limited 10/10 min per account |
| GET | /claims/:code | `X-Host-Secret` | host polls → `{status:'pending'|'claimed'|'expired', claimedBy?, hostCredential?}`. `claimedBy` = masked email of the linking account (`us***@example.com`) |
| POST | /hosts/heartbeat | host credential | `{}` → `{allowedNodeIds:[...phone nodeIds on the account], relayUrls:[...]}` |
| POST | /hosts/link | session | computer signed in to the account links itself, no QR: `{nodeId, name, platform, ts, sig}` (same proof of possession as POST /claims) → `{device, hostCredential, linkedBy}`. `hostCredential` is returned ONCE (only its hash is stored); `linkedBy` = masked email. 409 `device_exists` if the account already has a host with that nodeId and a live credential; a half-linked row (claim accepted, never polled) is replaced. Limited 60/min per IP and 10/10 min per account |

- Session and host credentials: 32 random bytes base64url, stored SHA-256 hashed in D1, shown once. Sessions last 90 days with sliding expiry and an absolute maximum of 365 days from creation.
- `nodeId` encoding everywhere in this API: the 32-byte Ed25519 public key as exactly 64 lowercase hex chars (iroh's `NodeId` `Display`). Base32 is not accepted; clients must use the hex form.
- Auth headers (clarification, 2026-10-02): `session` and `host credential` rows both use `Authorization: Bearer <token>`; `GET /claims/:code` uses `X-Host-Secret`. `POST /devices` also accepts an optional `platform` (defaults to `unknown`) and upserts by `nodeId`. The host credential is returned by the FIRST `GET /claims/:code` after acceptance only; later polls return `{status:'claimed'}` without it. Account JSON is `{id, email|null, createdAt}`.
- Claim QR payload: `belay://claim?c=<code>&n=<nodeId>`. The phone checks that the nodeId it later dials equals the claimed one.
- Reviewer: env `REVIEW_EMAIL` + `REVIEW_CODE` (secret) accepts a fixed code for that one address.
- Secrets only via `wrangler secret`; none in the repo. Rate limiting on every unauthenticated route.

### Tunnel
- Each device has a persistent tunnel keypair. The host keeps it at `~/.belay/net-key` (0600). The phone keeps it in the iOS Keychain or Android Keystore, passed into FFI.
- Host sidecar `belay-net` (Rust binary started by the host): an iroh endpoint with ALPN `belay/1`. It accepts a connection ONLY if the remote nodeId is in `allowedNodeIds` from the last heartbeat (refreshed every 60 s, and cached on disk for offline restarts). Each bi-stream is piped to the host's HTTPS port.
- Allow-list cache: replayed on restart only while a host credential exists and the cache is < 72 h old; older → the tunnel admits nobody until the heartbeat answers (fail closed; a host offline from the accounts service for 3 days loses tunnel access until it is back online, but a revoked phone can never ride a stale cache for longer than that). A 401 heartbeat empties the cache and the live list at once.
- Sidecar → host listener framing: every piped TCP stream starts with one line `belay-tunnel/1 <nodeId>\n` (64 lowercase hex), then the TLS ClientHello. The listener tags the socket `remoteAddress = 'tunnel:<nodeId>'`, so each phone is its own client for pair-replay, pair-guard and notifications; a stream without a valid header is dropped silently.
- **SECURITY:** tunneled traffic must NOT get loopback privileges on the host. Today plain HTTP and some trust are granted to loopback. The sidecar connects through a dedicated listener (a unix socket or a separate bound port) that the host marks `remote`, so it gets the same rules as LAN. The existing device-token auth and pinned TLS still apply inside the tunnel (defence in depth: an account compromise alone does not grant control).
- Phone FFI (in `crates/belay-client`, the same xcframework): `belay_tunnel_start(secretKey, relayUrls) -> handle`, `belay_tunnel_dial(handle, nodeId) -> localPort` (127.0.0.1 listener forwarding to the tunnel), `belay_tunnel_stats`, `belay_tunnel_close`. The app connects to `https://127.0.0.1:<localPort>`; the pin applies to that address too (same host fingerprint).
- Connection race in app/src/devices/race.ts: LAN candidates + `tunnel:<nodeId>`. Prefer LAN when it answers.
- Relays: `relayUrls` come from heartbeat/config. Production = self-hosted `iroh-relay` (deploy notes in infra/relay). An empty list means no relay, on both sides — never n0's public relays; the host keeps its last relay list across a 401. Development may opt into n0's public relays with `BELAY_NET_DEV_PUBLIC_RELAYS=1` on the sidecar. The phone has no heartbeat: it reads `EXPO_PUBLIC_RELAY_URLS` (comma-separated https URLs) at build time, defaulting to `https://relay.gobelay.com` (app/src/account/tunnel-key.ts).
- Phone-side pairing (clarification, 2026-10-02; superseded by Account trust below for account-linked computers): linking by claim QR or sign-in only proves which node to dial. A linked computer is still paired once THROUGH the tunnel and the device token still comes from the host. The saved computer keeps `nodeId`, never the ephemeral 127.0.0.1 port. The tunnel candidate is dialled only for a computer whose stored `nodeId` came from the account (`GET /devices`), and `verifyHost` runs on the loopback answer like any other. The fingerprint the host presents on the loopback port is pinned on first contact; inside an iroh connection authenticated to that nodeId this is not a blind TOFU, because only the holder of the node key can answer.

### Account trust (host routes; 2026-10-02)
No SMS and no codes for a computer linked to the account. The 6-digit `/pair` (with pair-guard, pair-replay and their bindings unchanged) stays only as the fallback for computers that are NOT account-linked (LAN, Tailscale, typed address).

| Method | Path | Who | Result |
|---|---|---|---|
| POST | /pair/account | tunnel peer `tunnel:<nodeId>` whose nodeId is on the current heartbeat allow-list; body `{deviceName}` | 200 `{token, name, deviceId, secret, fingerprint, via:'account'}` (same shape as /pair) when the host is account-linked AND has zero paired devices; else 202 `{pendingId, expiresInSec}`; 403 for LAN, loopback, a non-allow-listed node or an unlinked host; 429 + `Retry-After` past the rate limit |
| GET | /pair/account/:pendingId | the same nodeId that asked | 200 `{status:'pending'}`; 200 `{status:'approved', token, …}` exactly ONCE (the entry is deleted as the token is minted); 403 `{status:'denied'}` once; 404 `{status:'expired'}` for unknown, expired, already-collected or someone else's request |
| DELETE | /pair/account/:pendingId | the same nodeId | 204 — the phone's Cancel |
| POST | /devices/approve | device token (any already-paired phone) | `{pendingId, allow}` → 200 `{ok}`; 401 without a valid token; 400 bad body; 404 expired/answered |

- Pending request: `{id: 16 random bytes hex, nodeId, name (clamped, 32 printable chars), expires: 5 min}`. Approval re-arms a fresh 5 min to collect the token. Denied, cancelled and expired requests are cleared. A phone that asks again while its request is pending gets the same `pendingId` (not counted).
- Rate limits (counted only for admitted callers, so outsiders cannot burn the owner's budget): 3 requests per account (this host) per 10 min, and 2 per nodeId per 10 min.
- Approval surfaces: Belay.app (host IPC `pair-pending` → Allow/Deny in the host window and the window comes forward, plus a native notification; Allow/Deny returns as `pair-decide`), and every paired phone (the `/ws/attention` frame carries `pairRequests: [{id, name, expiresAt}]` → an "Allow <phone>?" card in the needs-you band on every tab and on the Computers list; the tap is `POST /devices/approve`). Belay.app also lists paired phones with Remove (IPC `devices` / `device-remove`). The attention frame never carries another phone's nodeId.
- Audit: every refusal, first-phone trust, pending, approve, deny, cancel and token issue is a line in `pair-audit.log` (0600) beside the host state file and in the host log.
- Phone: with a linked computer reachable over the tunnel (after linking, after sign-in, or Pair), the app calls `/pair/account` (when `/health` says `accountTrust: true`) and either saves the computer at once or shows "Waiting for approval on your computer or another phone…" with Cancel. A 403/404 falls back to the code screen.

### Threat model (account trust)
- The host auto-trusts a phone ONLY when it has zero paired devices AND is account-linked (holds a host credential). That first-phone window runs from link time until the first phone pairs. Linking itself requires presence at the computer (scanning the claim QR it shows, or signing in on it), so the window is opened by the owner. Removing every phone on the computer reopens it, which is again an action taken at the computer.
- An account compromise alone (stolen session, phished email code): the attacker can register a phone nodeId (`POST /devices`), so it rides the next heartbeat onto the allow-list. Against a computer that already has a phone, that yields at most a pending request the owner sees on Belay.app and on their phones, limited to 3 per 10 min, expiring in 5 min, never a token. Against a computer inside its first-phone window it yields the first-phone slot; the owner sees an unknown phone in Belay.app's paired list and can Remove it. Shrinking that window further would need presence again (a code), which the owner explicitly traded away.
- Network attackers: LAN, loopback and the public internet cannot reach /pair/account (403); only the tunnel listener tags `tunnel:<nodeId>`, the sidecar admits only allow-listed nodes, and the route re-checks the allow-list. Tunnel traffic keeps no loopback privileges.
- Approvals: an unauthenticated `POST /devices/approve` is 401. The token for an approved request is minted once and only for the node that asked; polling someone else's id is indistinguishable from an expired one. Belay.app's Allow/Deny comes over the parent IPC port, which only the app that spawned the host holds.
- Revocation is unchanged: removing a phone (Belay.app, `/devices/revoke`) drops its token and live sockets; removing it from the account drops it from the allow-list within a heartbeat.

### Out of scope here
Android tunnel FFI (follows the iOS FFI once proven), the installer app (separate change), and billing.

- Computer sign-in (2026-10-02): the computer may link itself with `POST /hosts/link` instead of a claim QR. Belay.app signs in (email code; Apple/Google via the system browser when configured), hands the session to the host over the app→host IPC exactly once, the host signs the nodeId proof with the sidecar and calls `/hosts/link`, persists `hostCredential` at 0600 (same file as the claim path) before any other call, and the session is discarded: it is never written to disk and the computer keeps no user session. The claim QR stays as the alternative. A linked computer appears in `GET /devices` for every phone on the account; phone-side pairing is account trust (above): the first phone connects without a code.
