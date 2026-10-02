// Error envelope `{error, code}` and input validation helpers.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const bad = (message: string, code = 'bad_request'): HttpError => new HttpError(400, code, message);
export const unauthorized = (message = 'unauthorized'): HttpError => new HttpError(401, 'unauthorized', message);
export const notFound = (message = 'not found'): HttpError => new HttpError(404, 'not_found', message);

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const noContent = (): Response => new Response(null, { status: 204 });

export const errorResponse = (err: HttpError): Response =>
  json({ error: err.message, code: err.code }, err.status);

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw bad('body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw bad('body must be a JSON object');
  return body as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, field: string, maxLen: number, pattern?: RegExp): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) throw bad(`${field} is required`);
  if (value.length > maxLen) throw bad(`${field} is too long`);
  if (pattern && !pattern.test(value)) throw bad(`${field} is invalid`);
  return value;
}

export function optionalString(body: Record<string, unknown>, field: string, maxLen: number, fallback: string): string {
  if (body[field] === undefined) return fallback;
  return requireString(body, field, maxLen);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function requireEmail(body: Record<string, unknown>): string {
  return requireString(body, 'email', 254, EMAIL_RE).trim().toLowerCase();
}

// iroh NodeId: the 32-byte Ed25519 public key as 64 lowercase hex chars.
export const NODE_ID_RE = /^[0-9a-f]{64}$/;

export function requireInteger(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw bad(`${field} must be an integer`);
  return value;
}

// Cloudflare sets cf-connecting-ip on every request; nothing else is trusted.
export const clientIp = (req: Request): string => req.headers.get('cf-connecting-ip') ?? 'unknown';

export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

export function bearer(req: Request): string | null {
  const header = req.headers.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}
