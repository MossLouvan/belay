// The console output the host prints on boot. Split out of index.ts so the
// platform-specific guidance (macOS permission prompts, Windows firewall) can
// grow without turning the entry point into a wall of console.log.

import qrcode from 'qrcode-terminal';

import { localIPv4, isTailscaleAddress, buildAddresses } from './addresses.js';
import { buildPairLink } from './pair-link.js';

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
}

/**
 * Print the pairing QR.
 *
 * Scanning removes the two typing steps — the address and the six digits — that
 * are the clunkiest part of setup and the only part that requires being at the
 * computer. The code is still shown underneath, because a terminal that
 * mangles block characters, a remote SSH session, or simply a phone with no
 * working camera all need the manual path to keep working.
 */
function printPairingQr(info: BannerInfo, code: string): void {
  const addresses = buildAddresses(info.port);
  if (addresses.length === 0) return;

  const link = buildPairLink({
    hostId: info.hostId,
    label: info.label,
    platform: info.platform,
    code,
    addresses,
  });

  // `small: true` uses half-block characters so the code fits an 80-column
  // terminal; the default renders roughly twice as tall and wraps.
  qrcode.generate(link, { small: true });
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
  const ips = localIPv4();
  const lines: string[] = [
    '',
    `  Tether host agent running on your ${hostKindLabel()}`,
    '  ─────────────────────────',
    `  Host name : ${info.hostName}`,
    `  Port      : ${info.port}`,
    `  Native    : ${info.nativeReady ? 'ready (screen + input)' : `NOT BUILT — ${buildNativeHint()}`}`,
    '',
    '  Reachable at:',
    ...ips.map((ip) => `    http://${ip}:${info.port}`),
  ];

  if (ips.some(isTailscaleAddress)) {
    lines.push('    (a 100.x address is your Tailscale IP — reachable from anywhere)');
  } else {
    // Worth saying plainly: a LAN-only host is one DHCP lease away from being
    // unreachable, and there is no way for the phone to learn the new address
    // from outside the house.
    lines.push('    These are LAN addresses only — they will not work away from');
    lines.push('    this network, and they change. Install Tailscale on this machine');
    lines.push('    and your phone to reach it from anywhere.');
  }
  lines.push('');

  if (process.platform === 'darwin') {
    lines.push(...MACOS_PERMISSION_LINES, '');
  }

  if (info.deviceCount === 0 && info.pairingCode) {
    lines.push('  Scan this in the Tether app to connect:', '');
    for (const line of lines) console.log(line);
    lines.length = 0;

    printPairingQr(info, info.pairingCode.code);

    lines.push(
      '',
      `  ...or type it in manually — code: ${info.pairingCode.code}   (expires in ${info.pairingCode.expiresInSec}s)`,
    );
  } else {
    lines.push(`  Paired devices: ${info.deviceCount}. Use the app to connect.`);
  }
  lines.push('');

  for (const line of lines) console.log(line);
}
