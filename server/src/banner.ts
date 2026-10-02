// The console output the host prints on boot. Split out of index.ts so the
// platform-specific guidance (macOS permission prompts, Windows firewall) can
// grow without turning the entry point into a wall of console.log.

import qrcode from 'qrcode-terminal';

import { localAddresses, isTailscaleAddress, isCgnatAddress, schemeFor } from './addresses.js';
import { displayFingerprint } from './tls-cert.js';
import { emitPairingCode, PairingHostInfo } from './pairing-display.js';
import { postToApp, qrModules } from './host-ipc.js';

export interface BannerInfo {
  readonly hostName: string;
  readonly port: number;
  readonly nativeReady: boolean;
  readonly pairingCode: { code: string; expiresInSec: number } | null;
  readonly deviceCount: number;
  /** Stable machine id, so a scan can save this computer under the right key. */
  readonly hostId: string;
  readonly label: string;
  readonly platform: string;
  /** Certificate fingerprint (tls-cert.ts): printed so a typed pairing can be checked by eye. */
  readonly fingerprint?: string;
}

// The concrete terminal sinks: a real QR renderer and console.log. `small:
// true` uses half-block characters so the code fits an 80-column terminal; the
// default renders roughly twice as tall and wraps.
// Under Belay.app the same link also goes to the app, which draws it in a
// window (host-ipc.ts); the terminal copy still prints for the log file.
const terminalSinks = {
  qr: (link: string) => {
    qrcode.generate(link, { small: true });
    postToApp({ type: 'pairing', link, modules: qrModules(link) });
  },
  line: (text: string) => console.log(text),
};

/**
 * Reprint the QR and the code together after a rotation.
 *
 * The rotation loop mints a fresh code every few minutes while nothing is
 * paired. It must reprint the QR too — printing only a text line leaves the
 * boot QR scrolled above still encoding the now-dead code, which scans as "that
 * code didn't work" while the code is plainly on screen and burns the client's
 * failure budget toward a lockout. Going through the shared emitter guarantees
 * the QR and the digits name the same code.
 */
export function reprintPairingCode(
  info: PairingHostInfo,
  code: string,
  expiresInSec: number,
): void {
  console.log('');
  console.log('  Advanced: new pairing code — scan this in the Belay app (Connect by address):');
  console.log('');
  emitPairingCode(info, code, expiresInSec, terminalSinks);
  console.log('');
}

/** Platform-appropriate label for the machine the agent is running on. */
export function hostKindLabel(plat: NodeJS.Platform = process.platform): string {
  if (plat === 'darwin') return 'Mac';
  if (plat === 'win32') return 'PC';
  return 'computer';
}

/** How to build the native screen/input helper on this platform. */
export function buildNativeHint(plat: NodeJS.Platform = process.platform): string {
  if (plat === 'darwin') return 'run: npm run build:native  (needs Xcode command line tools)';
  if (plat === 'win32') return 'run: npm run build:native';
  return 'screen capture and input are not supported on this platform';
}

// The #1 macOS setup failure: the TCC permission attaches to the process that
// *launched* node, so it is Terminal/iTerm that has to be approved.
const MACOS_PERMISSION_LINES: readonly string[] = [
  '  macOS permissions (required for the Screen tab):',
  '    1. System Settings → Privacy & Security → Screen & System Audio Recording',
  '    2. System Settings → Privacy & Security → Accessibility',
  '',
  '    Grant both to the app that launched this process (Terminal, iTerm, VS Code…),',
  '    not to "node" — macOS attaches the permission to the parent app. Quit and',
  '    reopen that app after granting, then restart the host.',
];

export function printBanner(info: BannerInfo): void {
  const found = localAddresses();
  const urlOf = (a: { address: string; interfaceName: string }) =>
    `${schemeFor(isTailscaleAddress(a.address, a.interfaceName) ? 'tailscale' : 'lan')}://${a.address}:${info.port}`;
  const lines: string[] = [
    '',
    `  Belay host agent running on your ${hostKindLabel()}`,
    '  ─────────────────────────',
    `  Host name : ${info.hostName}`,
    `  Port      : ${info.port}`,
    `  Native    : ${info.nativeReady ? 'ready (screen + input)' : `NOT BUILT — ${buildNativeHint()}`}`,
    ...(info.fingerprint ? [`  Cert      : ${displayFingerprint(info.fingerprint)}`] : []),
    '',
    '  Advanced: connect by address (same network or VPN):',
    ...found.map((a) => `    ${urlOf(a)}`),
  ];

  const onTailscale = found.some((a) => isTailscaleAddress(a.address, a.interfaceName));
  // A CGNAT address on a *physical* interface is the ISP's, not Tailscale's.
  // Saying so matters: it looks identical to a tailnet address but means the
  // opposite — no public address, nothing to port-forward, harder to reach.
  const ispCgnat = found.filter((a) => isCgnatAddress(a.address) && !isTailscaleAddress(a.address, a.interfaceName));

  if (onTailscale) {
    lines.push('    (the 100.x address is on a VPN interface — reachable wherever that VPN reaches)');
  } else {
    if (ispCgnat.length > 0) {
      lines.push(
        `    Note: ${ispCgnat[0].address} is in the 100.64.0.0/10 range but sits on`,
        `    ${ispCgnat[0].interfaceName}, a physical interface — so it is your ISP's`,
        '    carrier-grade NAT, not a VPN address. It looks similar and means the',
        '    opposite: there is no public address and nothing to port-forward.',
        '',
      );
    }
    lines.push('    These addresses only work on this network, and they change.');
    lines.push('    To reach this computer from anywhere, link it to your Belay account:');
    lines.push('    open the Belay app on your phone, sign in, and scan the link QR.');
  }
  lines.push('');

  if (process.platform === 'darwin') {
    lines.push(...MACOS_PERMISSION_LINES, '');
  }

  if (info.deviceCount === 0 && info.pairingCode) {
    lines.push('  Advanced: pair by address and code (scan in the Belay app, Connect by address):', '');
    for (const line of lines) console.log(line);
    lines.length = 0;

    // The QR and the manual code line come from the one shared emitter, so this
    // boot display and the later rotation display can never disagree.
    emitPairingCode(info, info.pairingCode.code, info.pairingCode.expiresInSec, terminalSinks);
  } else {
    lines.push(`  Paired devices: ${info.deviceCount}. Use the app to connect.`);
  }
  lines.push('');

  for (const line of lines) console.log(line);
}
