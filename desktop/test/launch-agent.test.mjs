import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { LAUNCH_AGENT_LABEL, launchAgentInstalled, launchAgentPlist, stopLaunchAgent } from '../src/launch-agent.js';

const fakeHome = (withPlist) => {
  const home = mkdtempSync(join(tmpdir(), 'belay-home-'));
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  if (withPlist) writeFileSync(launchAgentPlist(home), '<plist/>');
  return home;
};

test('launchAgentInstalled is the plist on disk', { skip: process.platform !== 'darwin' }, () => {
  assert.equal(launchAgentInstalled(fakeHome(false)), false);
  assert.equal(launchAgentInstalled(fakeHome(true)), true);
});

test('stopLaunchAgent boots the agent out of the gui domain and parks the plist', async () => {
  const home = fakeHome(true);
  const calls = [];
  const run = async (cmd, args) => { calls.push([cmd, ...args]); };
  const result = await stopLaunchAgent({ home, uid: 501, run });
  assert.deepEqual(calls, [['launchctl', 'bootout', `gui/501/${LAUNCH_AGENT_LABEL}`]]);
  assert.equal(result.moved, true);
  assert.equal(existsSync(launchAgentPlist(home)), false);
  assert.equal(existsSync(`${launchAgentPlist(home)}.disabled`), true);
});

test('an agent that is not loaded still gets its plist parked; other launchctl errors surface', async () => {
  const home = fakeHome(true);
  const notLoaded = async () => { throw new Error('Boot-out failed: 3: No such process'); };
  assert.equal((await stopLaunchAgent({ home, uid: 501, run: notLoaded })).moved, true);

  const denied = async () => { throw new Error('Boot-out failed: 1: Operation not permitted'); };
  await assert.rejects(stopLaunchAgent({ home: fakeHome(true), uid: 501, run: denied }), /not permitted/);
  await assert.rejects(stopLaunchAgent({ home }), /runner/);
});
