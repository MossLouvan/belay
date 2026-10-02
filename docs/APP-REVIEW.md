# App Review host

Apple's reviewers need a host they can pair with — possibly several times,
from several devices, over several days. A normal host cannot do that: its
pairing code is single-use, expires in five minutes, and stops being issued
once one device is paired.

The host already has a fixed, reusable, non-expiring code for the automated
end-to-end suite. Review uses that. Nothing else changes: TLS with the pinned
self-signed certificate, the HMAC host proof, hashed tokens, and the rate
limit and lockouts on `/pair` all stay on.

## Run the review host

On a **throwaway VM you will delete after review** — anyone with the code
can control it:

```bash
BELAY_TEST_CODE=REVIEW_CODE BELAY_ALLOW_TEST_CODE=1 BELAY_BIND=all npx belay-host
```

- `BELAY_TEST_CODE` is exactly six digits. Pick a fresh one for review.
- `BELAY_ALLOW_TEST_CODE=1` is the explicit opt-in; without it the code is
  ignored. The host prints a warning on boot while it is on.
- `BELAY_BIND=all` listens on every interface, so the VM's public IP works.
  Alternatively keep the default bind and put a Cloudflare tunnel in front.

The code keeps working after the first device pairs, so every reviewer
device can pair with the same `IP:port` and the same code. There is no
Tailscale in this setup: the reviewer types the address by hand, and the
host's self-signed certificate is pinned at pairing like any LAN pairing.

One caveat from the brute-force guard: 20 wrong guesses against the code
burn it until the host restarts. If a reviewer reports "invalid code",
restart the host.

### VM

- **macOS** (a Mac mini from a cloud provider, or a macOS VM). Windows also
  works; macOS matches the screenshots and the permissions story.
- It needs a **logged-in desktop session**, not just SSH: screen capture and
  input injection only exist inside a window server. Log in via VNC once,
  grant Screen Recording and Accessibility to the terminal you start the host
  from, and leave that session open.
- Open port 8787 (or `BELAY_PORT`) in the provider's firewall.
- Put something harmless on screen: a text editor and a browser is enough.
  The agent tab needs the `claude` CLI on the VM; if you install it, start a
  session on a scratch folder so the approval loop has something to show.
  There is no scripted demo agent in the host today.
- Delete the VM when review ends, and never reuse the code.

### Screen recording

Attach a 60–90 second recording to the review notes: entering `IP:port` and
the code, the host pairing, the Screen tab moving the VM's cursor, then one
agent approval round-trip (request appears on the phone, approve, the agent
continues). Reviewers pair far faster when they have seen it once.

## App Review Notes (paste-ready)

```
Belay is a remote-desktop and agent-supervision client for a computer the
user owns. There are no accounts, no sign-in and no purchases. The app
connects directly to a host program the user runs on their own Mac or PC;
no server of ours is involved.

TEST HOST
  Address:      REVIEW_HOST_IP:8787
  Pairing code: REVIEW_CODE
On first launch tap "Add computer", enter the address and the code. The
same code works for every reviewer device. A short screen recording of the
flow is attached.

NETWORK / ATS
The app sets NSAllowsArbitraryLoads because the only place plain HTTP is
used is the user's own Tailscale network (100.64.0.0/10 addresses and their
*.ts.net MagicDNS names), which Tailscale already encrypts with WireGuard;
those hosts have no public certificate. Every other connection, including the
LAN and this test host, uses TLS with the host's certificate pinned at
pairing, and the app refuses to send credentials to an unverified host.

ENCRYPTION (standard algorithms only, no proprietary crypto)
  TLS 1.2+ with a pinned self-signed certificate; HMAC-SHA256 host proof
  before any token is sent; ChaCha20-Poly1305 (RFC 8439) for the stream.
  Declared in App Store Connect as using non-exempt encryption with
  standard algorithms (mass market, 5D992.c); no proprietary crypto.

2.5.2  The app downloads and executes no code. Everything it shows is a
       screen image, terminal text and file listings from the user's own
       host.
4.2.7  The app is a remote-desktop mirror of a computer the user owns and
       has installed the host program on, in the same category as other
       remote-desktop clients. It does not mirror third-party content.
```
