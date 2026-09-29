# Transport security

Short version: on the LAN the host speaks HTTPS with a self-signed certificate
whose fingerprint the clients pin at pairing; plain HTTP survives only for
loopback and Tailscale, which are private already. The app still carries the
ATS exception described below because of that plain-HTTP-over-Tailscale path.

## What ships now

- **Host certificate.** `server/src/tls-cert.ts` mints an EC P-256 key and a
  ten-year self-signed certificate on first run, beside the state file, both
  0600. One port serves TLS and plain HTTP (`server/src/transport.ts` sniffs
  the first byte), so nothing about ports or pair links changed.
- **Plaintext policy.** A plain request is accepted only from loopback or a
  100.64.0.0/10 address. Anything else gets `426 {"code":"plaintext-refused"}`
  with a message that says to update the app and pair again. The same rule
  covers WebSocket upgrades.
- **Pinning.** The certificate's SHA-256 rides in the pairing QR (`f=`), in
  the `/pair` reply and in `/health`, and is printed as the `Cert` banner line.
  The phone pins it natively (`app/modules/belay-stream/ios/BelayPinModule.swift`:
  a server-trust challenge handler added to React's `RCTHTTPRequestHandler`
  for fetch/Image/XHR, SocketRocket's `SR_SSLPinnedCertificates` for
  WebSocket, and react-native-webview's `customCertificatesForHost` for the
  PDF viewer). The desktop pins through Electron's
  `session.setCertificateVerifyProc` (`desktop/src/pins.js`). A pinned host
  presenting any other certificate is refused; unpinned hosts get the
  system's normal verdict.
- **Typed addresses.** A scanned QR carries the fingerprint. A typed https
  address does not, so both clients read the certificate the host presents,
  pin it, and show the fingerprint for the user to compare with the banner —
  trust on first use, verified by eye, then pinned for good.
- **Host identity proof.** The host id in `/health` is public, so matching it
  proves nothing. Pairing also issues a per-device secret
  (`server/src/device-proof.ts`); before the token is sent to any address the
  client POSTs a random nonce to `/challenge` and verifies
  `HMAC-SHA256(secret, "belay-host-proof:v1:" + nonce)`. A host that reports
  no id, a different id, or the wrong proof is refused. This is what makes
  plain-HTTP-over-Tailscale safe against an address that has been reused.
- **BWP media (H.264 over UDP).** Already ChaCha20-Poly1305 per packet, keyed
  from a per-session key that travels only over the (now encrypted) screen
  WebSocket. Nothing changed there.

## Migration

Devices paired before this shipped have no fingerprint and no secret. Over
Tailscale they keep working; on the LAN the host refuses their plaintext and
the app shows "Pair again to secure this connection" with a scan button.
The certificate is persistent, so re-pairing is a one-time step per device;
deleting `belay-tls-*.pem` mints a new certificate and un-pins every device.

## Why the ATS exception is still there

## The problem

iOS App Transport Security blocks cleartext `http://` by default. Apple provides
`NSAllowsLocalNetworking`, which exempts:

- `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918 private ranges)
- `.local` (Bonjour)
- link-local addresses

That exemption does **not** cover `100.64.0.0/10` — the carrier-grade NAT range
that Tailscale assigns. Which is precisely the range this app tells users to
use for reaching a machine from anywhere.

Two further traps made this worth writing down rather than just fixing:

1. **`NSLocalNetworkUsageDescription` is not the same thing.** It governs the
   local-network *permission prompt* introduced in iOS 14. It has no effect on
   ATS. The app had that key and no ATS key at all, which reads like the
   question was considered and settled when it was not.

2. **It is invisible in development.** Expo Go and EAS development builds ship
   with arbitrary loads already permitted, so everything works on a phone
   during development. The block only appears in a `preview` or `production`
   build — the first time you install the real app and take it out of the
   house. The failure looks like "the host is unreachable", not "the OS
   refused", so it costs a debugging session before anyone suspects ATS.

Android has the mirror problem: cleartext is blocked by default since Android 9,
and `usesCleartextTraffic` was not set.

## What we set, and why it is this rather than something narrower

```jsonc
"NSAppTransportSecurity": {
  "NSAllowsArbitraryLoads": true     // every host the user pairs with, incl. 100.64.0.0/10
}
```

**`NSAllowsLocalNetworking` must not be set alongside it.** On iOS 10 and later,
listing any of the narrower keys — `NSAllowsLocalNetworking`,
`NSAllowsArbitraryLoadsInWebContent`, `NSAllowsArbitraryLoadsForMedia` — makes
the OS *ignore* `NSAllowsArbitraryLoads` and honour only the narrow one. Setting
both did not add local networking to arbitrary loads; it silently replaced them.

That is not a theoretical concern: it shipped. LAN addresses worked, so the app
looked fine at home, while every request to a `100.x` address failed with

```
The resource could not be loaded because the app transport security
policy requires the use of secure connections.
```

Tailscale hands out CGNAT addresses from `100.64.0.0/10`, which ATS does not
count as local networking — so the one configuration the standalone build exists
to provide was the one being blocked. Safari on the same phone reached the same
address, because ATS does not apply to it, which makes this look like an app bug
rather than a policy block until you read the error text.

`NSExceptionDomains` — the narrow, preferred mechanism — keys on **domain
names**. Belay connects to bare IP addresses that the user's own machines
report at runtime, and those addresses change. There is no fixed domain to
list, so a domain exception cannot express the rule we actually want, which is
"any host the user has explicitly paired with".

`NSAllowsArbitraryLoads` is the honest way to state that. Apple accepts this for
apps that connect to user-specified hosts; if this ever goes to the App Store,
that is the justification to give at review. It stands alone precisely because
adding the narrower key would switch it off.

## Is cleartext acceptable over Tailscale?

Yes. WireGuard already provides encryption and mutual authentication end to
end, and the host-identity proof above closes the one gap a reused address
could open. HTTPS inside that tunnel would be encrypting an encrypted channel,
and requiring it would break every phone paired before the certificate
existed. That is the whole reason `NSAllowsArbitraryLoads` stays: ATS has no
way to say "cleartext only to 100.64.0.0/10", and `NSExceptionDomains` keys
on names, not address ranges.

The self-signed certificate is pinned natively rather than through `fetch`,
which is why it works in a standalone build but **not in Expo Go**: Expo Go
does not contain the module, so there the app keeps every pin in JS, cannot
enforce it, and the system refuses the self-signed certificate. Use a dev
client or TestFlight build to test the LAN path; Tailscale works in Expo Go.

If Belay ever moves to a relay-based transport where the network is untrusted,
this becomes app-layer end-to-end encryption instead.

## Export compliance (App Store)

`ITSAppUsesNonExemptEncryption` is `true`: the app ships ChaCha20-Poly1305
(crates/belay-wire, via the xcframework) plus pinned TLS, so it no longer
qualifies for the "only uses OS encryption" exemption. It uses standard
published algorithms only, which self-classifies as mass-market 5D992.c — no
CCATS/ERN needed, just the annual BIS self-classification report.
