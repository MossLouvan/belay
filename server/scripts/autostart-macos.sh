#!/usr/bin/env bash
#
# Install (or remove) the Deskhandler host agent as a macOS LaunchAgent, so the
# machine is reachable from your phone whenever it is awake and logged in.
#
# Usage:
#   npm run autostart            install and start
#   npm run autostart -- status  show whether it is running
#   npm run autostart -- logs    tail the agent's output
#   npm run autostart -- remove  stop and uninstall
#
# Why a LaunchAgent and not a LaunchDaemon
# ----------------------------------------
# A daemon (`launchctl bootstrap system/`) runs as root outside any login
# session and has no connection to the window server, so it cannot capture the
# screen or inject input — those capabilities exist only inside a logged-in GUI
# session. This is macOS's equivalent of Windows' Session 0 isolation, and it is
# the security model rather than a limitation to work around.
#
# The consequence, stated plainly: the agent starts at *login*, not at boot. For
# a machine you want reachable after an unattended restart, enable automatic
# login (System Settings > Users & Groups > Automatic login) and stop the Mac
# sleeping. Without automatic login there is no session, so there is no screen
# to capture and nothing for launchd to start.

set -euo pipefail

LABEL="com.deskhandler.host"
# The pre-rename label. An install from before the rename registered under this
# name; if it is left loaded, install would end with two agents fighting over
# the same port at every login — so install and remove both clean it up.
LEGACY_LABEL="com.tether.host"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LEGACY_PLIST="$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"
DOMAIN="gui/$(id -u)"
OUT_LOG="$HOME/Library/Logs/deskhandler.out.log"
ERR_LOG="$HOME/Library/Logs/deskhandler.err.log"

SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"

action="${1:-install}"

is_loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

legacy_loaded() {
  launchctl print "$DOMAIN/$LEGACY_LABEL" >/dev/null 2>&1
}

case "$action" in
  status)
    if is_loaded; then
      echo "Deskhandler autostart: INSTALLED"
      launchctl print "$DOMAIN/$LABEL" | grep -E "^\s+(state|pid) " || true
      echo
      echo "Logs: $OUT_LOG"
    else
      echo "Deskhandler autostart: not installed"
    fi
    if legacy_loaded; then
      echo "note: the pre-rename agent ($LEGACY_LABEL) is still loaded; re-run install to replace it"
    fi
    exit 0
    ;;
  logs)
    echo "Tailing $OUT_LOG (Ctrl-C to stop)"
    exec tail -f "$OUT_LOG"
    ;;
  remove)
    if is_loaded; then
      launchctl bootout "$DOMAIN/$LABEL"
      echo "Stopped and unloaded $LABEL"
    fi
    if legacy_loaded; then
      launchctl bootout "$DOMAIN/$LEGACY_LABEL"
      echo "Stopped and unloaded $LEGACY_LABEL (pre-rename install)"
    fi
    rm -f "$PLIST" "$LEGACY_PLIST"
    echo "Removed $PLIST"
    echo "Your pairings are untouched — they live in the agent's state file."
    exit 0
    ;;
  install) ;;
  *)
    echo "usage: $0 [install|status|logs|remove]" >&2
    exit 2
    ;;
esac

# launchd does not read a shell profile, so every path has to be absolute and
# PATH has to be supplied explicitly. Resolving npm here rather than guessing
# between the Homebrew and Intel locations is the difference between this
# working and failing silently at login with a "command not found" nobody sees.
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: node is not on PATH; install Node before setting up autostart." >&2
  exit 1
fi
BIN_DIR="$(dirname "$NODE_BIN")"

# launchd is told to run node directly rather than `npm start`.
#
# With npm in between, launchd's child is npm and the server is a *grandchild*.
# Unloading the agent kills npm, node survives as an orphan still holding port
# 8787, and the next install then cannot bind — while reporting itself healthy.
# Verified: after one install/remove cycle a node process was left running with
# its parent gone. Running node directly makes the server launchd's own child,
# so it is torn down with the job.
TSX_CLI="$SERVER_DIR/node_modules/tsx/dist/cli.mjs"
if [[ ! -f "$TSX_CLI" ]]; then
  echo "error: $TSX_CLI is missing. Run 'npm install' in server/ first." >&2
  exit 1
fi

echo "==> Server directory : $SERVER_DIR"
echo "==> node             : $NODE_BIN"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# Replace any previous install so this script is safe to re-run after moving
# the repo or upgrading Node.
if is_loaded; then
  echo "==> Removing the existing agent first"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
fi
if legacy_loaded || [[ -f "$LEGACY_PLIST" ]]; then
  echo "==> Removing the pre-rename agent ($LEGACY_LABEL) first"
  launchctl bootout "$DOMAIN/$LEGACY_LABEL" 2>/dev/null || true
  rm -f "$LEGACY_PLIST"
fi

# Pin the state file to whichever one actually holds the pairings. A machine
# that paired before the rename has tether-state.json and nothing else; pointing
# the agent at a brand-new deskhandler-state.json would unpair every phone the
# moment autostart is (re)installed. Once the new file exists it wins.
STATE_FILE="$SERVER_DIR/deskhandler-state.json"
if [[ ! -f "$STATE_FILE" && -f "$SERVER_DIR/tether-state.json" ]]; then
  STATE_FILE="$SERVER_DIR/tether-state.json"
fi

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$TSX_CLI</string>
    <string>$SERVER_DIR/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$SERVER_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$BIN_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <!-- Pin the state file to the server directory so the agent finds the same
         pairings regardless of what launchd sets as the working directory. -->
    <key>DESKHANDLER_STATE_FILE</key><string>$STATE_FILE</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$OUT_LOG</string>
  <key>StandardErrorPath</key><string>$ERR_LOG</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST_EOF

echo "==> Wrote $PLIST"

launchctl bootstrap "$DOMAIN" "$PLIST"
echo "==> Loaded into $DOMAIN"

# Give it a moment to bind before reporting, so "installed" and "answering" are
# not conflated.
sleep 2
if is_loaded; then
  echo
  echo "Deskhandler will now start automatically when you log in."
  launchctl print "$DOMAIN/$LABEL" | grep -E "^\s+(state|pid) " || true
else
  echo "warning: the agent did not stay loaded; check $ERR_LOG" >&2
  exit 1
fi

cat <<'NOTES'

Two things to know
------------------
1. Screen Recording and Accessibility grants attach to the process launchd
   starts, not to Terminal. macOS cannot show a permission prompt for a
   background job, so the Screen tab may need `node` added by hand under
   System Settings > Privacy & Security > Screen & System Audio Recording, and
   again under Accessibility. Terminal, Files and System work regardless.

2. This starts at login, not at boot. For an unattended restart to leave the
   machine reachable, turn on automatic login and stop the Mac sleeping —
   see docs/SETUP.md.

   npm run autostart -- status    is it running
   npm run autostart -- logs      what it printed
   npm run autostart -- remove    undo all of this
NOTES
