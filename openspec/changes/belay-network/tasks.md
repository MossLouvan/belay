## Spike (agent T, first day)
- [ ] iroh on iOS: build for aarch64-apple-ios, direct + relay dial between this Mac and a phone/simulator; measure RTT direct vs relay; go/no-go
## Accounts (agent A)
- [ ] infra/accounts Worker + D1 schema + migrations
- [ ] email code (Resend), Apple, Google verification
- [ ] devices, claims, heartbeat, delete account, reviewer allow-list, rate limits
- [ ] tests (vitest/miniflare or node:test against handlers)
## Tunnel (agent T)
- [ ] crate + host sidecar with allow-list + remote-marked listener (host never grants loopback trust to tunnel traffic)
- [ ] phone FFI + localPort forwarder; xcframework build script updated
- [ ] infra/relay deploy notes for iroh-relay
## App (agent U)
- [ ] sign-in screens (Apple, Google, email code), session in SecureStore
- [ ] computers from GET /devices; QR claim scan → accept
- [ ] Delete Account in Settings; sign out
- [ ] tunnel candidate in the race (behind the FFI; mocked until T lands)
## Host (agent T or H2)
- [ ] claim QR on first run (terminal + existing pairing popup), heartbeat loop, store hostCredential (0600)
