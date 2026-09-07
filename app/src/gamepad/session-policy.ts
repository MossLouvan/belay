import type { GamepadMessage } from './messages';

export type InputMode = 'auto' | 'phone';
export const usesPhysicalController = (mode: InputMode, connected: boolean): boolean => mode === 'auto' && connected;

export function hostStatus(message: Extract<GamepadMessage, { type: 'hello' }>): string {
  if (!message.available) return message.reason?.trim() || 'Gaming input is unavailable on this computer';
  return message.backend === 'vigem' ? 'Connected · Xbox game input' : 'Connected · Keyboard and mouse controls';
}

/** A server refusal must survive its following close and subsequent retries. */
export function reconnectStatus(reason: string | null, closeReason?: string): string {
  const detail = reason?.trim() || closeReason?.trim();
  return detail ? `${detail} · Retrying connection` : 'Reconnecting to the computer…';
}
