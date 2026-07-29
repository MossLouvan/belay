// Persistent host state: the device token(s) a paired phone uses, plus config.
// Stored next to the server as tether-state.json (gitignored).

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE_FILE = join(process.cwd(), 'tether-state.json');

export interface Device {
  token: string;
  name: string;
  createdAt: number;
  lastSeen: number;
}

interface Persisted {
  devices: Device[];
  hostName: string;
}

let state: Persisted = { devices: [], hostName: '' };

export function loadState(): void {
  if (existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      if (!Array.isArray(state.devices)) state.devices = [];
    } catch {
      state = { devices: [], hostName: '' };
    }
  }
}

function save(): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

export function getHostName(): string {
  return state.hostName || '';
}

export function setHostName(name: string): void {
  state.hostName = name;
  save();
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

export function addDevice(name: string): Device {
  const device: Device = {
    token: newToken(),
    name: name || 'iPhone',
    createdAt: Date.now(),
    lastSeen: Date.now(),
  };
  state.devices.push(device);
  save();
  return device;
}

// Constant-time comparison so a token cannot be recovered by timing the check.
export function findDevice(token: string): Device | undefined {
  if (!token) return undefined;
  const candidate = Buffer.from(token);
  for (const d of state.devices) {
    const known = Buffer.from(d.token);
    if (known.length === candidate.length && timingSafeEqual(known, candidate)) {
      return d;
    }
  }
  return undefined;
}

export function touchDevice(device: Device): void {
  device.lastSeen = Date.now();
  // Persist lazily; losing a lastSeen update on crash is harmless.
}

export function listDevices(): Device[] {
  return state.devices.map((d) => ({ ...d, token: d.token.slice(0, 8) + '…' })) as Device[];
}

export function revokeDevice(tokenPrefix: string): boolean {
  const before = state.devices.length;
  state.devices = state.devices.filter((d) => !d.token.startsWith(tokenPrefix));
  const changed = state.devices.length !== before;
  if (changed) save();
  return changed;
}

export function revokeAll(): void {
  state.devices = [];
  save();
}
