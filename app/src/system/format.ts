// Formatting helpers for the System screen. Kept pure so the numbers a person
// reads are easy to reason about and easy to change in one place.

import { BatteryInfo, SystemStats } from '../api';
import { Palette } from '../theme';

const UNITS: readonly string[] = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const STEP = 1024;

/** Byte count in the largest unit that keeps the number readable. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  let value = n;
  let unit = 0;
  while (value >= STEP && unit < UNITS.length - 1) {
    value /= STEP;
    unit += 1;
  }
  const decimals = unit >= 3 && value < 100 ? 1 : 0;
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Uptime as the two largest meaningful units, e.g. "6d 4h" or "12m 30s". */
export function fmtUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const whole = Math.floor(sec);
  if (whole < MINUTE) return `${whole}s`;
  const days = Math.floor(whole / DAY);
  const hours = Math.floor((whole % DAY) / HOUR);
  const minutes = Math.floor((whole % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${whole % MINUTE}s`;
}

/**
 * A human-readable OS name.
 *
 * Newer hosts send `osName` ("macOS 26.3.1", "Windows 11"). Older ones and the
 * Windows agent do not, and the raw fallback is `platform` + `release` — on a
 * Mac that reads "darwin 25.3.0". Ugly, but it is the *kernel* version, and
 * mapping it to a marketing version is not possible client-side, so we show it
 * verbatim rather than inventing a wrong-but-pretty answer.
 */
export function osLabel(stats: SystemStats): string {
  const named = stats.osName?.trim();
  if (named) return named;
  return `${stats.platform} ${stats.release}`.trim();
}

export type Severity = 'good' | 'warn' | 'bad';

/** Usage thresholds, shared by every meter so the colours mean one thing. */
export function usageSeverity(percent: number): Severity {
  if (percent > 90) return 'bad';
  if (percent > 75) return 'warn';
  return 'good';
}

/** Charge thresholds. Inverted relative to usage: low is the bad end. */
export function chargeSeverity(battery: BatteryInfo): Severity {
  if (battery.charging) return 'good';
  if (battery.percent <= 15) return 'bad';
  if (battery.percent <= 35) return 'warn';
  return 'good';
}

/** The power source as reported by the host, tidied for display. */
export function batterySource(battery: BatteryInfo): string {
  const source = battery.source?.trim();
  return source ? source : battery.charging ? 'AC power' : 'Battery';
}

/** "just now" / "8s ago" / "3m ago", for the last-successful-poll line. */
export function fmtAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 2) return 'just now';
  if (sec < MINUTE) return `${sec}s ago`;
  const minutes = Math.floor(sec / MINUTE);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
