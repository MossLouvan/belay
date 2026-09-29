# belay-host

The host side of [Belay](https://github.com/MossLouvan/belay): lets the Belay
iOS app see and control this Mac or Windows PC, supervise a coding agent
running on it, and reach its files and terminal.

```bash
npx belay-host
```

First run compiles the native screen/input helper (macOS: Xcode command line
tools; Windows: `csc.exe`), then prints a pairing code and the addresses the
phone can reach. State and the TLS certificate live in
`~/Library/Application Support/Belay`, `%APPDATA%\Belay` or `~/.config/belay`.

Options are environment variables (`BELAY_PORT`, `BELAY_BIND`,
`BELAY_STATE_FILE`, ...) — see
[docs/SETUP.md](https://github.com/MossLouvan/belay/blob/main/docs/SETUP.md).
