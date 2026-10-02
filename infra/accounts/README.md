# Belay accounts service

Cloudflare Worker + D1 behind `https://api.gobelay.com/v1`. Sign in with Apple,
Google or a 6-digit email code (Resend); device registry; QR claim flow for
computers; account deletion. The API contract lives in
`openspec/changes/belay-network/design.md`.

```
npm install
npm test          # node:test over a node:sqlite D1 shim (needs Node >= 22.5)
npm run typecheck
npm run dev       # wrangler dev, local D1 (run migrate:local first)
```

## Layout

| Path | What |
|---|---|
| `src/index.ts` | router, error envelope, hourly cleanup cron |
| `src/routes/*.ts` | one file per route group (email, oidc, me, devices, claims, hosts) |
| `src/auth.ts` | sessions (90 d sliding), host credentials, account lookup/linking |
| `src/jwt.ts` | Apple/Google ID-token verification via WebCrypto + cached JWKS |
| `src/rate-limit.ts` | fixed-window counter in D1 (per IP, per email) |
| `migrations/` | D1 schema |

## Auth headers

- Session routes (incl. `POST /auth/logout`): `Authorization: Bearer <session>`
- `POST /hosts/heartbeat`: `Authorization: Bearer <hostCredential>`
- `GET /claims/:code`: `X-Host-Secret: <hostSecret>`

## Deploy (owner, one-time)

Nothing in this repo creates cloud resources. All ids and secrets are placeholders.

1. **Login**: `npx wrangler login`
2. **Database**: `npx wrangler d1 create belay-accounts` and paste the printed
   `database_id` into `wrangler.toml`.
3. **Migrate**: `npm run migrate` (`wrangler d1 migrations apply belay-accounts --remote`).
4. **Vars** in `wrangler.toml`: `GOOGLE_AUDIENCES` = comma-separated Google
   OAuth client ids (iOS + Android + any web client), `RELAY_URLS` = your iroh
   relay URLs. `APPLE_AUDIENCE` is the bundle id `com.mosslouvan.belay`.
5. **Secrets** (each prompts for the value, nothing lands in git):
   ```
   npx wrangler secret put RESEND_API_KEY   # from resend.com -> API Keys
   npx wrangler secret put REVIEW_EMAIL     # App Store reviewer address
   npx wrangler secret put REVIEW_CODE      # exactly 6 digits
   ```
   After App Review, remove the backdoor: `npx wrangler secret delete REVIEW_EMAIL`
   and `npx wrangler secret delete REVIEW_CODE` (either missing disables it).
6. **Resend domain**: in Resend -> Domains add `gobelay.com`, add the DKIM /
   SPF / MX records it prints to the gobelay.com DNS zone (Cloudflare), wait for
   "Verified". `EMAIL_FROM` must use that domain.
7. **Custom domain**: `wrangler.toml` already declares `api.gobelay.com` as a
   custom domain; `wrangler deploy` creates the DNS record and certificate as
   long as `gobelay.com` is a zone in the same Cloudflare account.
8. **Deploy**: `npm run deploy`. Smoke test:
   `curl -X POST https://api.gobelay.com/v1/auth/email/start -H 'content-type: application/json' -d '{"email":"you@example.com"}'` -> 204 and an email.

Re-deploys are just `npm run deploy`; new migrations go in `migrations/000N_*.sql`
followed by `npm run migrate`.

## Notes

- Credentials (session, host secret, host credential) are 32 random bytes
  base64url, shown once and stored only as SHA-256 hex.
- The host credential is minted on the host's first poll after the phone
  accepts the claim, so plaintext never waits in D1.
- Deleting an account relies on `ON DELETE CASCADE` (D1 enforces foreign keys).
- `POST /claims` needs proof of possession: the host signs
  `belay-claim:v1:<nodeId>:<ts>` with its Ed25519 node key. nodeIds are 64
  lowercase hex chars (iroh `NodeId` display form).
- Accepting a claim for a nodeId the account already has linked (with a live
  credential) is a 409; the phone must `DELETE /devices/:id` first.
- Apple nonces are server-issued (`POST /auth/nonce`, 5 min, single-use);
  Google ID tokens are accepted once (hash kept until `exp`).
- Rate limits: 60/min per IP on unauthenticated routes, 5 code sends per email
  and 10 verifies per email+IP per 10 min, 10 claim accepts per account per
  10 min. The counter is a fixed window in D1. A code younger than 2 min is
  kept rather than overwritten by a new start request.
- Sessions: 90 d sliding, 365 d absolute; `POST /auth/logout` revokes one.
