# Using Belay safely

Belay hands your phone the keys to a computer. That is the whole point of it,
and it is also the whole risk. This page is the short version of what that
actually means, what to be careful with, and what not to do with it.

For *how* the security works — tokens, tickets, origin checks, the file
allow-list — see the Security section of the [README](../README.md). This page
is about using it.

---

## 1. What pairing really gives away

Pairing a phone does not give it "some access". It gives it, on that computer:

| | |
| :-- | :-- |
| Mouse and keyboard | Anything you could do sitting at it |
| A real shell | The Terminal tab is a full login shell, with no extra prompt |
| Your screen | Live, plus still thumbnails cached on the phone |
| Your files | Read-only, and outside credential folders (see below) |
| Your agent | Claude Code sessions running as you, in your projects |
| Your audio | Whatever the machine is playing |

Treat a paired device exactly as you would treat someone sitting in your chair
with your session unlocked. There is no lesser tier.

**The one number that matters is the pairing code.** Whoever types it gets a
device token, and that token is as good as being at the machine.

---

## 2. Rules for the pairing code

- **Never show it to anyone, in any form.** Not a screenshot, not a photo, not
  pasted into a chat, an issue, a support thread, or an AI assistant.
- **Do not pair while screen sharing, streaming, or recording.** The code is
  displayed on the host. A Zoom call, a Twitch stream, or a recorded demo will
  capture it, and it stays valid for five minutes afterwards.
- **Do not pre-generate a code and walk away.** Generate it when the phone is
  in your hand.
- It is single use and expires in five minutes. Wrong guesses lock the client
  out after five attempts, and twenty wrong guesses from anywhere burn the code
  entirely, so it cannot be brute forced. Those protections do not help if you
  hand the code over voluntarily.

**On your own Tailscale network there is no code at all.** The host asks the
Tailscale daemon who is connecting and pairs any device signed in to the same
Tailscale account. That is convenient and it is safe *because your tailnet is
the trust boundary*. It also means: anyone you add to your tailnet can pair
with your computer without asking. Think about that before you share a tailnet
with a friend, a group project, or a client. If you would rather insist on a
code anyway, set `BELAY_TAILNET_PAIR=0`.

---

## 3. Paired devices are devices, not people

- **Review the paired list now and then.** A phone you sold, wiped, returned or
  lost is still paired until you say otherwise.
- **Revoke immediately when a device leaves your hands.** Revoking closes that
  device's live screen and terminal sockets on the spot, not at the next
  reconnect.
- If you think a code or token leaked and you are not sure which device is
  which, clear them all: start the host with `--reset-pairing`. That drops
  every paired device but keeps the computer's identity, so your phone just
  pairs again rather than showing up as a new machine.

---

## 4. Agent sessions deserve their own paragraph

This is the newest and sharpest part of Belay, so be deliberate with it.

- **An agent session runs as you.** Same user, same permissions, same
  credentials on disk. It is not sandboxed.
- **Any paired device can attach to any session**, watch it, and type into it.
  That is the feature: your phone and your desk are two windows onto one
  session. It also means a paired device you did not intend to trust has the
  same reach.
- **Approval prompts are the seatbelt. Read them.** It is very easy to develop
  a reflex of tapping Allow. The prompt is the only moment where a destructive
  command is still preventable.
- **Prefer the narrowest grant.** When you do grant something standing, scope
  it to this command, this file, or read-only in this project, rather than
  blanket approval. Grants last the session, and you can see and remove them as
  chips on the session view.
- **Answering "don't ask again" is a real decision**, and anyone attached to
  that session can answer it, not just you.
- **Point agents at project folders, not your home directory.** The file
  browser already refuses `~/.ssh`, `~/.aws` and `~/.claude`, and the Belay
  install directory whose state file holds your device tokens. An agent with a
  shell has no such guardrail: it is as capable as you are.

---

## 5. Network

- **Transport is plain HTTP.** Use Belay over Tailscale, or over a network you
  genuinely control. On open Wi-Fi, anyone on the segment could read the token
  off the wire.
- **Do not port-forward the host to the internet**, and do not put it behind a
  public tunnel such as Tailscale Funnel. It is designed to live on a private
  network. Exposing it publicly turns a six digit code into the only thing
  between the internet and your shell.
- The host refuses browser requests whose `Host` header is not an IP literal,
  `localhost`, a `.local` name, or something you listed in `BELAY_HOSTS`. That
  defeats a malicious web page re-pointing its own domain at your machine.
  Adding a wildcard there to "make it work" removes that protection.

---

## 6. Remember that the screen is leaving the room

Streaming your desktop, and the thumbnails now shown on the Computers cards,
mean pictures of whatever is on that screen travel to your phone and are cached
there.

Before you stream, hand a session to someone, or record:

- Close password managers, secret files, `.env` files, and anything with keys in
  it.
- Remember the Screen tab can record. If anyone else is on the call or in the
  room, get their consent first.
- The clipboard is shared. Do not copy a credential on one side and forget.

---

## 7. Use it on computers you are entitled to use

Belay is remote control and remote administration software. Where you install
the host matters more than where you install the app.

- **Only install the host on machines you own, or are clearly authorised to
  administer.** Your own desktop, your own laptop, your own server.
- **Do not install it on a shared, work, school, or lab machine without
  permission.** On many managed machines, installing remote-control software is
  a policy violation regardless of intent, and can be treated as a serious one.
- **Do not use it to watch or control a person without their knowledge.** The
  host announces a pairing attempt and shows an indicator while a session is
  live, deliberately. Defeating those to observe someone is not a use this
  project supports.
- Consent is not implied by physical access. A family computer in a shared
  house is still shared.

If you are setting Belay up for someone else, pair it in front of them, show
them the paired device list, and show them how to revoke.

---

## 8. If you think something has gone wrong

1. **Revoke the devices.** From any paired device, or clear all of them with
   `--reset-pairing` on the host.
2. **Assume anything that machine could reach is exposed.** Rotate credentials
   that lived on it or were reachable from it: SSH keys, cloud tokens, anything
   in a shell history or a `.env`.
3. **Look at what the machine had open.** Agent transcripts live in
   `server/agent-logs/`, and session metadata in `belay-agent.json`, so you can
   see what ran.
4. **Then re-pair from scratch**, on a network you trust.

---

## The short version

Do not share the code. Do not expose the port. Review your paired devices. Read
the approval prompts instead of tapping past them. And only put the host on a
computer that is yours to put it on.
