// Security alert emails: a new sign-in, a new phone, a newly linked computer,
// and a phone asking a computer for approval. The owner notices quickly.
//
// Rules (design.md, "Security emails"):
//  * Only to the account's stored address (an Apple private relay address
//    works); accounts without one, or that turned alerts off, get nothing.
//  * Rate limited (rate-limit.ts LIMITS.alert*), counted only when we would send.
//  * Location comes from request.cf for this one email and is never stored.
//  * The "Not you?" link is a static help page. No link in an email performs
//    an action: anything destructive happens signed in, in the app.
//  * Never throws: a failed send is logged and the user's action goes on.

import type { AccountRow } from './auth.js';
import type { Env } from './env.js';
import { LIMITS, withinLimit, type Limit } from './rate-limit.js';
import { postResend } from './resend.js';

export const SECURITY_URL = 'https://gobelay.com/security';

interface DeviceInfo {
  readonly name: string;
  readonly platform: string;
}

export type SecurityEvent =
  | { readonly kind: 'sign-in'; readonly method: 'email' | 'apple' | 'google' }
  | { readonly kind: 'phone-added'; readonly device: DeviceInfo }
  | { readonly kind: 'computer-linked'; readonly device: DeviceInfo }
  | { readonly kind: 'alerts-off' }
  | { readonly kind: 'phone-request'; readonly host: DeviceInfo & { readonly id: string }; readonly phoneName: string; readonly matchCode: string };

type Recipient = Pick<AccountRow, 'id' | 'email' | 'security_emails'>;

const METHODS = { email: 'an email code', apple: 'Apple', google: 'Google' } as const;
const PLATFORMS: Readonly<Record<string, string>> = {
  ios: 'iOS', android: 'Android', macos: 'macOS', darwin: 'macOS', windows: 'Windows', win32: 'Windows', linux: 'Linux',
};
const HOST_NOUNS: Readonly<Record<string, string>> = { macos: 'Mac', darwin: 'Mac', windows: 'PC', win32: 'PC' };
// Sign-in requests carry no device name; the User-Agent is a fair guess.
const UA_DEVICES: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Android/, 'Android device'], [/Macintosh|Mac OS X/, 'Mac'],
  [/Windows/, 'Windows PC'], [/Darwin|CFNetwork/, 'Apple device'],
];

/** User-chosen names: no control characters (no forged lines), clamped. */
const clean = (raw: string, max = 60): string => raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || 'Unnamed';
const platformLabel = (p: string): string => PLATFORMS[p.toLowerCase()] ?? clean(p, 20);
const describe = (d: DeviceInfo): string => `${clean(d.name)} (${platformLabel(d.platform)})`;
const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function location(req: Request): string | null {
  const cf = (req as Request & { cf?: { city?: unknown; country?: unknown } }).cf;
  const parts = [cf?.city, cf?.country].filter((p): p is string => typeof p === 'string' && p.length > 0).map((p) => clean(p, 40));
  return parts.length ? `${parts.join(', ')} (approximate)` : null;
}

function uaDevice(req: Request): string | null {
  const ua = req.headers.get('user-agent') ?? '';
  return UA_DEVICES.find(([re]) => re.test(ua))?.[1] ?? null;
}

interface Content {
  readonly subject: string;
  readonly lead: string;
  readonly details: ReadonlyArray<readonly [string, string]>;
}

function content(event: SecurityEvent, req: Request): Content {
  switch (event.kind) {
    case 'sign-in': {
      const device = uaDevice(req);
      return {
        subject: 'New sign-in to your Belay account',
        lead: `Someone just signed in to your Belay account with ${METHODS[event.method]}.`,
        details: device ? [['Device', device]] : [],
      };
    }
    case 'phone-added':
      return {
        subject: 'A new phone was added to your Belay account',
        lead: 'A new phone was added to your Belay account. It can now ask to control your computers.',
        details: [['Phone', describe(event.device)]],
      };
    case 'computer-linked':
      return {
        subject: 'A computer was linked to your Belay account',
        lead: 'A computer was linked to your Belay account. Phones on the account can now ask to control it.',
        details: [['Computer', describe(event.device)]],
      };
    case 'alerts-off':
      return {
        subject: 'Security emails were turned off for your Belay account',
        lead: 'Security emails were just turned off for your Belay account. This is the last one you will get until they are turned back on in the Belay app.',
        details: [],
      };
    case 'phone-request': {
      const noun = HOST_NOUNS[event.host.platform.toLowerCase()] ?? 'computer';
      return {
        subject: `A new phone asked to control your ${noun}`,
        lead: `A new phone asked to control your ${noun}. It is waiting for approval in Belay.`,
        details: [['Phone', clean(event.phoneName)], ['Computer', describe(event.host)], ['Match code', event.matchCode]],
      };
    }
  }
}

const NOT_YOU = 'Not you? Remove it: open Belay, remove any phone or computer you do not recognise, then tap Sign out everywhere.';
const FOOTER = 'You get these emails because security alerts are on for your Belay account. You can turn them off in the Belay app, under Account.';

export function renderSecurityEmail(event: SecurityEvent, req: Request, now: number): { subject: string; text: string; html: string } {
  const c = content(event, req);
  const when = `${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  // A phone-request comes from the computer, so its location says nothing about the phone.
  const where = event.kind === 'phone-request' ? null : location(req);
  const details: ReadonlyArray<readonly [string, string]> = [['When', when], ...c.details, ...(where ? [['Location', where] as const] : [])];

  const text = [
    c.lead,
    '',
    ...details.map(([k, v]) => `${k}: ${v}`),
    '',
    NOT_YOU,
    `How: ${SECURITY_URL}`,
    '',
    FOOTER,
    '',
    'Belay',
  ].join('\n');

  const rows = details
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#667">${escapeHtml(k)}</td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`)
    .join('');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1b1f24">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:24px">
<p style="margin:0 0 16px;font-weight:700;font-size:18px">Belay</p>
<p style="margin:0 0 16px;font-size:15px;line-height:1.5">${escapeHtml(c.lead)}</p>
<table style="font-size:14px;line-height:1.5;margin:0 0 20px">${rows}</table>
<p style="margin:0 0 8px;font-size:15px;font-weight:600">Not you?</p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.5">Open Belay, remove any phone or computer you do not recognise, then tap Sign out everywhere.</p>
<p style="margin:0 0 24px"><a href="${SECURITY_URL}" style="display:inline-block;background:#1b1f24;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">How to secure your account</a></p>
<p style="margin:0;font-size:12px;color:#667;line-height:1.5">${escapeHtml(FOOTER)}</p>
</div></body></html>`;

  return { subject: c.subject, text, html };
}

function limitFor(event: SecurityEvent, accountId: string): readonly [key: string, limit: Limit] {
  switch (event.kind) {
    case 'sign-in': return [`alert-signin:${accountId}`, LIMITS.alertSignIn];
    case 'phone-request': return [`alert-host:${event.host.id}`, LIMITS.alertHostEvent];
    default: return [`alert-device:${accountId}`, LIMITS.alertDevice];
  }
}

/** Emails `account` about `event` when it has an address, alerts are on and the limit allows. Never throws. */
export async function sendSecurityEmail(env: Env, req: Request, account: Recipient, event: SecurityEvent, now = Date.now()): Promise<void> {
  if (!account.email || account.security_emails === 0) return;
  try {
    const [key, limit] = limitFor(event, account.id);
    if (!(await withinLimit(env.DB, key, limit, now))) return;
    if (!env.RESEND_API_KEY) {
      console.error('security email skipped: RESEND_API_KEY is not set', event.kind);
      return;
    }
    const res = await postResend(env, { to: account.email, ...renderSecurityEmail(event, req, now) });
    if (!res.ok) console.error('security email failed', event.kind, account.id, res.status, await res.text().catch(() => ''));
  } catch (err) {
    console.error('security email failed', event.kind, account.id, err);
  }
}
