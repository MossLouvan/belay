// The developer host's LaunchAgent (server/scripts/autostart-macos.sh installs
// com.belay.host). When it holds the port, Belay.app can take over — but only
// on the user's explicit click, and only by unloading it and moving its plist
// aside, so the old setup can be restored by hand. The launchctl runner is a
// parameter so the test never touches a real agent.

import { existsSync, renameSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

export const LAUNCH_AGENT_LABEL = 'com.belay.host';

export function launchAgentPlist(home = homedir()) {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

/** True when the npx/LaunchAgent host is installed for this user. */
export function launchAgentInstalled(home = homedir()) {
  return process.platform === 'darwin' && existsSync(launchAgentPlist(home));
}

/**
 * Unload the agent and park its plist as `<name>.plist.disabled`. `run` is
 * (cmd, args) => Promise; a bootout of an agent that is not loaded is not an
 * error, so the plist still gets moved.
 */
export async function stopLaunchAgent({ home = homedir(), uid = userInfo().uid, run, rename = renameSync } = {}) {
  if (typeof run !== 'function') throw new Error('stopLaunchAgent needs a launchctl runner');
  try {
    await run('launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
  } catch (e) {
    // "Boot-out failed: 3: No such process" — the agent is not loaded; fine.
    if (!/No such process|Could not find|not loaded/i.test(String(e?.message ?? e))) throw e;
  }
  const plist = launchAgentPlist(home);
  if (!existsSync(plist)) return { plist, moved: false };
  rename(plist, `${plist}.disabled`);
  return { plist, moved: true };
}
