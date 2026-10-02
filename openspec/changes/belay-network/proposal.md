## Why
Owner decision (2026-10-02): Belay must work "anywhere in the world" with no Tailscale and no second app. Users create a Belay account; their devices link to it; the phone reaches the computer directly when possible and through our relay otherwise. Research: scratchpad network/{arch,hosting,onboarding}.md (summarised in the plan doc "Belay: Path to Thousands of Users").

## What Changes
1. **Accounts service** (`infra/accounts`, Cloudflare Workers + D1): Sign in with Apple, Sign in with Google, and email code (Resend). Device registry, QR claim for computers, account deletion, and a reviewer allow-list.
2. **Tunnel** (`crates/belay-net-tunnel` + host sidecar + phone FFI): an end-to-end encrypted QUIC tunnel between phone and computer, with hole-punching and relay fallback. ALL existing features (screen, terminal, files, agent, system) run through it unchanged, because the tunnel forwards the host's existing HTTPS port. The first candidate is **iroh** (MIT/Apache, Rust, QUIC streams + datagrams, hole-punching, self-hostable relay). If a 1-day spike shows iroh is unworkable on iOS, fall back to ICE (libjuice) + quinn.
3. **App**: sign-in flow, computers listed from the account, QR claim scanning, Delete Account, and a tunnel connection candidate raced alongside LAN.
4. **Onboarding**: the host shows a claim QR. Tailscale becomes optional legacy (still works, never required).

## Why a tunnel, not video-only ICE
Belay is more than video: terminal, files, the agent API and system all ride HTTP/WS. A tunnel to the host's existing port carries every feature with zero protocol rewrites. Video already got 7.5× smaller (#104 H.264), so it fits in the tunnel. Datagrams remain available for later.

## Impact
New: infra/accounts, the crates tunnel crate, the server sidecar wiring, app auth screens. Changed: app connection racing, host pairing. Privacy policy and App Store labels must be updated (email, device names). Relay hosting: iroh-relay self-hosted (~€5/mo Hetzner at launch). n0's public relays are for development only.
