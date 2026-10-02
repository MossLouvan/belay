// The lid-closed controller against a scripted shell: every command it would
// run is recorded, nothing touches the real machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLidController, type LidDeps } from '../src/lid-host.js';
import { BATTERY_WARNING, LID_GRACE_MS } from '../src/lid-mode.js';

const PMSET_ON = ['sudo', '-n', '/usr/bin/pmset', '-a', 'disablesleep', '1'].join(' ');
const PMSET_OFF = ['sudo', '-n', '/usr/bin/pmset', '-a', 'disablesleep', '0'].join(' ');
const PROBE = 'sudo -n -l /usr/bin/pmset -a disablesleep 1';

interface Script {
  /** Keyed by the joined argv; a string resolves, an Error rejects, a function decides. */
  readonly [command: string]: string | Error | ((args: readonly string[]) => string);
}

function harness(platform: NodeJS.Platform, script: Script, opts: { enabled?: boolean; saved?: { ac: number; dc: number } | null } = {}) {
  const ran: string[] = [];
  const warnings: string[] = [];
  let enabled = opts.enabled ?? false;
  let saved = opts.saved ?? null;
  let clock = 1_000_000;
  let battery: { percent: number; onBattery: boolean } | null = null;
  const deps: LidDeps = {
    platform,
    user: 'moss',
    exec: async (file, args) => {
      const line = [file, ...args].join(' ');
      ran.push(line);
      const key = Object.keys(script).find((k) => (k.startsWith('osascript') ? line.startsWith('osascript') : line === k));
      const hit = key === undefined ? undefined : script[key];
      if (hit === undefined) throw new Error(`unscripted: ${line}`);
      if (hit instanceof Error) throw hit;
      return typeof hit === 'function' ? hit(args) : hit;
    },
    now: () => clock,
    getEnabled: () => enabled,
    setEnabled: (on) => { enabled = on; },
    getSavedLidAction: () => saved,
    setSavedLidAction: (v) => { saved = v; },
    readBattery: async () => battery,
    onWarn: (m) => warnings.push(m),
    log: () => {},
  };
  const lid = createLidController(deps);
  return {
    lid, ran, warnings,
    enabled: () => enabled,
    saved: () => saved,
    advance: (ms: number) => { clock += ms; },
    setBattery: (b: typeof battery) => { battery = b; },
  };
}

const MAC_OK: Script = { [PROBE]: '', [PMSET_ON]: '', [PMSET_OFF]: '', 'ioreg -r -k AppleClamshellState -d 4': '"AppleClamshellState" = No' };

test('mac: host start forces sleep back on (crash safety)', async () => {
  const h = harness('darwin', MAC_OK);
  await h.lid.start();
  assert.deepEqual(h.ran, [PMSET_OFF]);
});

test('mac: enabling with no sudoers rule installs it once through the admin prompt', async () => {
  let probes = 0;
  const h = harness('darwin', {
    ...MAC_OK,
    [PROBE]: () => { probes += 1; if (probes === 1) throw new Error('sudo: a password is required'); return ''; },
    osascript: '',
  });
  const reply = await h.lid.setEnabled(true);
  assert.equal(reply.ok, true);
  assert.equal(h.enabled(), true);
  const install = h.ran.find((l) => l.startsWith('osascript'));
  assert.ok(install, 'osascript ran');
  assert.match(install, /with administrator privileges/);
  // TOCTOU: the user temp file is copied to a root-owned staging path first;
  // visudo validates THAT copy, and only it is renamed into place.
  const copy = install.indexOf('/usr/bin/install -o root -g wheel -m 0440 " & quoted form of item 1 of argv & " /etc/sudoers.d/.belay-lid.tmp');
  const check = install.indexOf('/usr/sbin/visudo -cf /etc/sudoers.d/.belay-lid.tmp');
  const move = install.indexOf('/bin/mv -f /etc/sudoers.d/.belay-lid.tmp /etc/sudoers.d/belay-lid');
  assert.ok(copy >= 0 && check > copy && move > check, install);
  assert.doesNotMatch(install, /visudo -cf " & quoted form/, 'must never validate the user-owned path');
  assert.match(install, /\|\| \(\/bin\/rm -f \/etc\/sudoers\.d\/\.belay-lid\.tmp; exit 1\)/, 'failed check removes the staging copy');
});

test('mac: a cancelled admin prompt leaves the switch off and says why', async () => {
  const h = harness('darwin', {
    ...MAC_OK,
    [PROBE]: new Error('sudo: a password is required'),
    osascript: new Error('execution error: User canceled. (-128)'),
  });
  const reply = await h.lid.setEnabled(true);
  assert.equal(reply.ok, false);
  if (reply.ok) return;
  assert.match(reply.error, /cancel/i);
  assert.equal(h.enabled(), false);
  assert.ok(!h.ran.includes(PMSET_ON));
});

test('mac: arms on the first stream, holds through the grace period, then releases', async () => {
  const h = harness('darwin', MAC_OK);
  assert.equal((await h.lid.setEnabled(true)).ok, true);
  assert.equal(h.lid.status().status, 'ready');
  h.lid.streamStarted();
  await h.lid.settle();
  assert.ok(h.ran.includes(PMSET_ON));
  assert.equal(h.lid.status().status, 'awake');
  h.lid.streamEnded();
  await h.lid.settle();
  assert.equal(h.lid.status().status, 'awake');
  assert.ok(!h.ran.includes(PMSET_OFF));
  h.advance(LID_GRACE_MS);
  await h.lid.tick();
  assert.equal(h.lid.status().status, 'ready');
  assert.ok(h.ran.includes(PMSET_OFF));
});

test('mac: the lid state is polled only while armed, and subscribers hear changes', async () => {
  let clamshell = '"AppleClamshellState" = No';
  const h = harness('darwin', { ...MAC_OK, 'ioreg -r -k AppleClamshellState -d 4': () => clamshell });
  const seen: boolean[] = [];
  h.lid.subscribe((closed) => seen.push(closed));
  await h.lid.setEnabled(true);
  await h.lid.tick();
  assert.ok(!h.ran.some((l) => l.startsWith('ioreg')), 'not armed: no ioreg');
  h.lid.streamStarted();
  await h.lid.settle();
  clamshell = '"AppleClamshellState" = Yes';
  await h.lid.tick();
  assert.deepEqual(seen, [true]);
  assert.equal(h.lid.status().lidClosed, true);
  await h.lid.tick();
  assert.deepEqual(seen, [true], 'no repeat while unchanged');
  clamshell = '"AppleClamshellState" = No';
  await h.lid.tick();
  assert.deepEqual(seen, [true, false]);
});

test('mac: battery cutoff releases, warns the phone once, and re-arms when plugged in', async () => {
  const h = harness('darwin', MAC_OK);
  await h.lid.setEnabled(true);
  h.lid.streamStarted();
  await h.lid.settle();
  h.setBattery({ percent: 20, onBattery: true });
  await h.lid.tick();
  assert.equal(h.lid.status().status, 'battery-low');
  assert.deepEqual(h.warnings, [BATTERY_WARNING]);
  assert.equal(h.ran.filter((l) => l === PMSET_OFF).length, 1);
  await h.lid.tick();
  assert.equal(h.warnings.length, 1, 'warned once');
  h.setBattery({ percent: 20, onBattery: false });
  await h.lid.tick();
  assert.equal(h.lid.status().status, 'awake');
  assert.equal(h.ran.filter((l) => l === PMSET_ON).length, 2);
});

test('mac: switching off while armed releases; stop() releases too', async () => {
  const h = harness('darwin', MAC_OK);
  await h.lid.setEnabled(true);
  h.lid.streamStarted();
  await h.lid.settle();
  await h.lid.setEnabled(false);
  assert.equal(h.ran.at(-1), PMSET_OFF);
  assert.equal(h.enabled(), false);
  await h.lid.stop();
  assert.equal(h.ran.at(-1), PMSET_OFF);
});

const POWERCFG_Q = 'powercfg /q SCHEME_CURRENT SUB_BUTTONS LIDACTION';
const WIN_OK: Script = {
  [POWERCFG_Q]: 'Current AC Power Setting Index: 0x00000001\r\nCurrent DC Power Setting Index: 0x00000002\r\n',
  'powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0': '',
  'powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0': '',
  'powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1': '',
  'powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 2': '',
  'powercfg /setactive SCHEME_CURRENT': '',
};

test('windows: arming saves LIDACTION then sets do-nothing; release restores and clears', async () => {
  const h = harness('win32', WIN_OK);
  await h.lid.start();
  assert.deepEqual(h.ran, [], 'nothing saved: nothing to restore');
  await h.lid.setEnabled(true);
  h.lid.streamStarted();
  await h.lid.settle();
  assert.deepEqual(h.ran, [
    POWERCFG_Q,
    'powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0',
    'powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0',
    'powercfg /setactive SCHEME_CURRENT',
  ]);
  assert.deepEqual(h.saved(), { ac: 1, dc: 2 });
  // Windows has no lid probe: the virtual display stays up for the whole armed stream.
  assert.equal(h.lid.status().lidClosed, true);
  await h.lid.setEnabled(false);
  assert.deepEqual(h.ran.slice(4), [
    'powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1',
    'powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 2',
    'powercfg /setactive SCHEME_CURRENT',
  ]);
  assert.equal(h.saved(), null);
  assert.equal(h.lid.status().lidClosed, false);
});

test('windows: a saved action from a crashed run is restored on start', async () => {
  const h = harness('win32', WIN_OK, { saved: { ac: 1, dc: 2 } });
  await h.lid.start();
  assert.deepEqual(h.ran, [
    'powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1',
    'powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 2',
    'powercfg /setactive SCHEME_CURRENT',
  ]);
  assert.equal(h.saved(), null);
});

test('unsupported platform: status says so and enabling is refused', async () => {
  const h = harness('linux', {});
  assert.equal(h.lid.status().supported, false);
  const reply = await h.lid.setEnabled(true);
  assert.equal(reply.ok, false);
  assert.equal(h.enabled(), false);
});
