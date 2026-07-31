// The console output the host prints on boot. Split out of index.ts so the
// platform-specific guidance (macOS permission prompts, Windows firewall) can
// grow without turning the entry point into a wall of console.log.

import { networkInterfaces } from 'node:os';

const TAILSCALE_PREFIX = '100.';

export interface BannerInfo {
  readonly hostName: string;
  readonly port: number;
  readonly nativeReady: boolean;
  readonly pairingCode: { code: string; expiresInSec: number } | null;
  readonly deviceCount: number;
}

/** Non-internal IPv4 addresses this host can be reached on. */
export function localIPs(): string[] {
  const ifaces = networkInterfaces();
  return Object.values(ifaces)
    .flatMap((list) => list ?? [])
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
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
  const ips = localIPs();
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

  if (ips.some((ip) => ip.startsWith(TAILSCALE_PREFIX))) {
    lines.push('    (a 100.x address is your Tailscale IP — use it from anywhere)');
  }
  lines.push('');

  if (process.platform === 'darwin') {
    lines.push(...MACOS_PERMISSION_LINES, '');
  }

  if (info.deviceCount === 0 && info.pairingCode) {
    lines.push(
      `  Pairing code: ${info.pairingCode.code}   (expires in ${info.pairingCode.expiresInSec}s)`,
      '  Enter this in the Tether app on your phone.',
    );
  } else {
    lines.push(`  Paired devices: ${info.deviceCount}. Use the app to connect.`);
  }
  lines.push('');

  for (const line of lines) console.log(line);
}
