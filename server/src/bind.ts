// Which interfaces the host listens on: BELAY_BIND.
//
// The default is every interface, because the phone must reach the host on
// Wi-Fi to pair and the LAN address is the one it races first. Someone who
// only ever connects over Tailscale can shrink that to the tailnet address
// plus loopback, so nothing on the coffee-shop Wi-Fi can even see the port.
//
//   all            every interface (default)
//   tailnet        the Tailscale address(es) + 127.0.0.1
//   <addr>[,addr]  exactly these addresses

import { isTailscaleAddress, localAddresses, type LocalAddress } from './addresses.js';
import { productEnv } from './env.js';

export const LOOPBACK = '127.0.0.1';

export interface Bind {
  /** What was asked for, for the banner. */
  readonly setting: string;
  /** Addresses to listen on; empty means "every interface". */
  readonly hosts: readonly string[];
  /** Why the result differs from the setting, if it does. */
  readonly warning?: string;
}

/**
 * Turn the setting into the list of addresses to bind. Pure, so the
 * `tailnet` case can be tested against a fake interface list.
 */
export function resolveBind(
  setting: string | undefined,
  found: readonly LocalAddress[] = localAddresses(),
): Bind {
  const raw = (setting || 'all').trim();
  const lower = raw.toLowerCase();
  if (lower === 'all' || lower === '' || lower === '0.0.0.0' || lower === '::') {
    return { setting: 'all', hosts: [] };
  }
  if (lower === 'tailnet') {
    const tailnet = found
      .filter((a) => isTailscaleAddress(a.address, a.interfaceName))
      .map((a) => a.address);
    if (tailnet.length === 0) {
      // Falling open to every interface would be the opposite of what was
      // asked; loopback-only is the safe direction, and the warning says why
      // the phone cannot reach it.
      return {
        setting: 'tailnet',
        hosts: [LOOPBACK],
        warning: 'no Tailscale interface found — listening on 127.0.0.1 only until one appears (restart after Tailscale connects)',
      };
    }
    return { setting: 'tailnet', hosts: [LOOPBACK, ...tailnet] };
  }
  const hosts = raw.split(',').map((h) => h.trim()).filter(Boolean);
  return { setting: raw, hosts: [...new Set(hosts)] };
}

/** The bind from the environment (BELAY_BIND, or the legacy TETHER_BIND). */
export function configuredBind(): Bind {
  return resolveBind(productEnv('BIND'));
}

/** One line for the startup banner. */
export function bindBannerLine(bind: Bind): string {
  const where = bind.hosts.length === 0 ? 'all interfaces' : bind.hosts.join(', ');
  const label = bind.setting === 'all' ? where : `${bind.setting} (${where})`;
  return bind.warning ? `${label} — ${bind.warning}` : label;
}
