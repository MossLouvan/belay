# Transport security and why the app allows cleartext

Short version: Belay talks plain HTTP to a host you own, over a network you
control. The iOS and Android defaults assume you are calling a public web API,
and would silently block that. This document records the exception, why it is
there, and what would let us remove it.

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

## Is cleartext actually acceptable here?

Over **Tailscale, yes.** WireGuard already provides encryption and mutual
authentication end to end. HTTPS inside that tunnel would be encrypting an
encrypted channel.

Over **plain LAN, it is a real weakness** and is documented as such: anyone
passively on the same Wi-Fi can capture the bearer token and gain complete
control of the machine — screen, keystrokes, shell. That is why the README says
to use Tailscale rather than treating LAN as the destination.

## Why not just add TLS?

Self-signed certificates are the obvious idea and they do not work here:

- React Native's `fetch` cannot pin a self-signed certificate without ejecting
  from Expo Go, so the app would lose its zero-setup development path.
- A publicly-trusted certificate needs a domain name and a challenge the host
  can answer, which a machine on a home LAN behind CGNAT generally cannot.

So the choice is between a VPN that provides transport security (Tailscale) and
app-layer encryption implemented ourselves. The architecture review picked the
first, which is also why cleartext-over-tailnet is a deliberate position and not
an oversight.

If Belay ever moves to a relay-based transport where the network is untrusted,
this becomes app-layer end-to-end encryption instead, and this exception should
be revisited at that point.
