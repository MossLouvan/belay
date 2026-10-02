// Lid-closed mode: the pure arm/release policy and the parsers for the three
// shell probes it reads (ioreg clamshell, powercfg LIDACTION, Win32_Battery).
// Fixtures are real output captured on this Mac; the Windows ones are
// transcribed from powercfg / ConvertTo-Json documentation samples.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BATTERY_CUTOFF_PERCENT,
  LID_GRACE_MS,
  lidStatus,
  parseClamshell,
  parsePowercfgLidAction,
  parseWin32Battery,
  sudoersRule,
  toLidBattery,
} from '../src/lid-mode.js';

const AC = { percent: 90, onBattery: false };
const BATT = { percent: 90, onBattery: true };

test('off while the switch is off, whatever else is true', () => {
  assert.equal(lidStatus({ enabled: false, streams: 2, lastStreamEndedAt: null, now: 0, battery: BATT }), 'off');
});

test('ready while on but nobody is streaming', () => {
  assert.equal(lidStatus({ enabled: true, streams: 0, lastStreamEndedAt: null, now: 0, battery: null }), 'ready');
});

test('awake while on and at least one stream is live', () => {
  assert.equal(lidStatus({ enabled: true, streams: 1, lastStreamEndedAt: null, now: 0, battery: null }), 'awake');
  assert.equal(lidStatus({ enabled: true, streams: 1, lastStreamEndedAt: null, now: 0, battery: AC }), 'awake');
});

test('stays awake for the 30 minute grace after the last stream ends, then releases', () => {
  const ended = 1_000_000;
  const within = { enabled: true, streams: 0, lastStreamEndedAt: ended, now: ended + LID_GRACE_MS - 1, battery: null };
  const after = { ...within, now: ended + LID_GRACE_MS };
  assert.equal(lidStatus(within), 'awake');
  assert.equal(lidStatus(after), 'ready');
});

test('battery cutoff releases only on battery power', () => {
  const low = { percent: BATTERY_CUTOFF_PERCENT, onBattery: true };
  assert.equal(lidStatus({ enabled: true, streams: 1, lastStreamEndedAt: null, now: 0, battery: low }), 'battery-low');
  assert.equal(
    lidStatus({ enabled: true, streams: 1, lastStreamEndedAt: null, now: 0, battery: { percent: 5, onBattery: false } }),
    'awake',
  );
  assert.equal(
    lidStatus({ enabled: true, streams: 1, lastStreamEndedAt: null, now: 0, battery: { percent: 21, onBattery: true } }),
    'awake',
  );
  // Nobody streaming: a low battery is not a stop, it is just not armed.
  assert.equal(lidStatus({ enabled: true, streams: 0, lastStreamEndedAt: null, now: 0, battery: low }), 'ready');
});

test('parseClamshell reads the AppleClamshellState line', () => {
  const open = [
    '+-o AppleClamshell  <class IOPMrootDomain>',
    '  |   "AppleClamshellCausesSleep" = No',
    '  |   "AppleClamshellState" = No',
  ].join('\n');
  assert.equal(parseClamshell(open), false);
  assert.equal(parseClamshell(open.replace('"AppleClamshellState" = No', '"AppleClamshellState" = Yes')), true);
  assert.equal(parseClamshell(''), null);
  assert.equal(parseClamshell('"AppleClamshellCausesSleep" = Yes'), null);
});

test('toLidBattery maps pmset output to the policy shape', () => {
  assert.deepEqual(toLidBattery({ percent: 92, charging: false, source: 'Battery Power' }), { percent: 92, onBattery: true });
  assert.deepEqual(toLidBattery({ percent: 92, charging: true, source: 'AC Power' }), { percent: 92, onBattery: false });
  assert.equal(toLidBattery(null), null);
});

const POWERCFG = [
  'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)',
  '  Subgroup GUID: 4f971e89-eebd-4455-a8de-9e59040e7347  (Power buttons and lid)',
  '    GUID Alias: SUB_BUTTONS',
  '    Power Setting GUID: 5ca83367-6e45-459f-a27b-476b1d01c936  (Lid close action)',
  '      GUID Alias: LIDACTION',
  '      Possible Setting Index: 000',
  '      Possible Setting Friendly Name: Do nothing',
  '      Possible Setting Index: 001',
  '      Possible Setting Friendly Name: Sleep',
  '    Current AC Power Setting Index: 0x00000001',
  '    Current DC Power Setting Index: 0x00000002',
  '',
].join('\r\n');

test('parsePowercfgLidAction reads the AC and DC indexes', () => {
  assert.deepEqual(parsePowercfgLidAction(POWERCFG), { ac: 1, dc: 2 });
  assert.equal(parsePowercfgLidAction('Power Scheme GUID: x'), null);
  assert.equal(parsePowercfgLidAction(''), null);
});

test('parseWin32Battery accepts one battery or an array, and maps BatteryStatus', () => {
  assert.deepEqual(parseWin32Battery('{"EstimatedChargeRemaining": 45, "BatteryStatus": 1}'), { percent: 45, onBattery: true });
  assert.deepEqual(
    parseWin32Battery('[{"EstimatedChargeRemaining": 80, "BatteryStatus": 2},{"EstimatedChargeRemaining": 70, "BatteryStatus": 2}]'),
    { percent: 80, onBattery: false },
  );
  assert.equal(parseWin32Battery(''), null);
  assert.equal(parseWin32Battery('null'), null);
  assert.equal(parseWin32Battery('{"BatteryStatus": 1}'), null);
  assert.equal(parseWin32Battery('{"EstimatedChargeRemaining": 999, "BatteryStatus": 1}')?.percent, 100);
});

test('sudoersRule allows exactly the two pmset commands and refuses odd usernames', () => {
  assert.equal(
    sudoersRule('moss'),
    'moss ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1\n',
  );
  for (const bad of ['', 'ALL', 'a b', 'x,y', 'root\nALL', '%admin', '#x', 'a:b', '-x']) {
    assert.equal(sudoersRule(bad), null, JSON.stringify(bad));
  }
});
