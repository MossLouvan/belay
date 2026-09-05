# Dual Cursors: macOS Helper Rebuild Required

## The Issue

After updating to a version that includes the macOS idle probe (commit 2ad3258 or later), **macOS users must rebuild the native helper** for dual-cursor collaboration to work correctly.

## Why a Rebuild is Needed

The dual-cursor system's "local user always wins" rule requires idle detection:

- **Windows**: Uses `GetLastInputInfo` (already implemented)
- **macOS**: Uses `CGEventSourceSecondsSinceLastEventType` (added in commit 2ad3258)

The macOS idle probe code was added to `server/native/mac/main.swift`, but the **compiled binary** (`server/native/BelayHostMac`) needs to be rebuilt from that source.

Without rebuilding:
- The old helper doesn't know about the `idle` command
- The server's idle probe returns null (no evidence of local user)
- Remote input is never frozen when someone at the Mac tries to use it
- The "local user always wins" rule doesn't engage

## How to Rebuild

From the `server/` directory:

```bash
bash native/build-mac.sh
```

This will:
1. Compile all Swift sources in `native/mac/`
2. Produce a universal binary (arm64 + x86_64) at `native/BelayHostMac`
3. Ad-hoc sign it (grants sticky across runs, but not across rebuilds)

Then restart the server:

```bash
npm start
```

## Verifying It Works

After rebuilding, test the idle probe:

```bash
# In another terminal, while the server is running
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8787/...
```

Or check the server logs for idle probe activity when you type or move the mouse on the Mac while a remote user is connected.

You should see the remote input freeze for 3 seconds after local activity.

## Why This Matters

Without the idle probe, multiple people on the same Mac host can fight for control:

- ❌ A remote user can keep clicking while someone at the Mac tries to use it
- ❌ The person physically at the machine doesn't automatically win
- ❌ Input floor rule 1 ("local user always wins") is inactive

With the idle probe:

- ✅ Any local mouse move or keypress freezes remote input for 3 seconds
- ✅ The person at the machine reclaims control automatically
- ✅ Remote cursors keep moving (pointing is free), but clicks are refused

## What About Windows?

Windows hosts already have idle detection (`GetLastInputInfo`) in the C# helper. No rebuild needed there.

## References

- Commit 2ad3258: "Fix macOS idle probe and setup page UI issues"
- Commit ae1d132: "Fix: Implement macOS idle detection for multi-cursor input floor"
- `docs/COLLABORATION.md` - Full dual-cursor documentation
- `CURSOR_IMPLEMENTATION_VERIFICATION.md` - Complete implementation audit
