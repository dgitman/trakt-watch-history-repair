# Trakt watch-history repair

Daily checks and repairs of incorrect watch-history dates for David, running entirely on Cloudflare Workers. No local scheduled jobs or running Mac are required.

This is the canonical source repository for the daily job, extracted from [trakt-list-sync](https://github.com/dgitman/trakt-list-sync) with its Git history intact. The hourly list sync and Emalie's account were removed on October 25, 2026; the Worker now handles David's account only.

The source repository was separated on October 15, 2026. The deployed Worker retains its existing name and Durable Object identity to preserve credentials and repair journals. Deploy future daily-job changes from this repository only.

## Daily history behavior

- Checks complete paginated history for Unix-epoch placeholders and watches before a movie release or episode first-air timestamp.
- Repairs eligible entries using release timestamps, including episode runtime. Preserves repeat watches using distinct minute offsets when needed.
- Adds and verifies a replacement before removing the exact original history ID. A persistent cloud journal reconciles interrupted work without blindly repeating writes.
- Verifies per-title watches, history counts, and ratings including rating timestamps. Unknown release dates, future releases, invalid timestamps, and ambiguous changes remain for review.
- Processes up to 100 findings per account each run. Remaining findings are reported and checked on subsequent runs.
- Emails completed repairs, new remaining findings, and failures. Identical unresolved findings are deduplicated.
- Paces API calls and backs off on explicit rate-limit rejections.

The daily trigger runs at **12:35 UTC** (08:35 Eastern during daylight saving time, 07:35 in winter). No local scheduler is required.

## Production deployment

The Worker is `trakt-list-sync` in the Personal Cloudflare account:

`https://trakt-list-sync.dgitman-personal.workers.dev`

Set `SYNC_URL` to that URL for administration. The daily history job runs at 12:35 UTC; the hourly list-sync trigger has been removed. Email is sent from `trakt-sync@gitman.net` to `david@because.ventures`.

The existing Worker was renamed in place on October 5, 2026. Its secrets, Durable Object namespace, stored grants, baseline, repair journals, and both cron triggers were preserved. Retain the `DavEmalieSync` class, stable `davemalie` object name, encryption key, and migration configuration for future deployments. These names identify existing state and are independent of the project name.

The September 20, 2026 deployment repaired its initial 46 date findings. That historical verification does not establish the current operational status; use the authenticated `status` and `history/report` operations to inspect recent runs.

## Development

Requires Node 24+ and npm. Provisioning also uses Python 3 and the 1Password CLI.

```sh
npm ci
npm test
npm run typecheck
npm run dry-run
```

The tests cover detection, pagination integrity, interrupted additions and deletions, repeat-watch preservation, concurrent changes, identity checks, rate-limit recovery, notification behavior, and secret-free token requests. Tests do not call live Trakt accounts.

## Deployment and secrets

```sh
npm run deploy
```

Authenticate Wrangler to the configured Cloudflare account first. The checked-in configuration points to the existing production Worker. Review its account, email destination, and schedules before deployment elsewhere.

Required cloud secrets: `ADMIN_KEY`, `ENCRYPTION_KEY`, and `TRAKT_CLIENT_ID`. No Trakt client secret is used: Trakt no longer issues one, and the device flow needs only the client ID. The encryption key must be a random 32-byte base64 value. Existing secrets and encrypted OAuth grants must be retained for production updates.

`scripts/provision-secrets.py` reads `ADMIN_KEY_REF`, `ENCRYPTION_KEY_REF`, and `TRAKT_CLIENT_ID_REF` from environment variables containing 1Password secret references. It streams values to Wrangler without saving or printing them. Never commit credentials, local operational configuration, OAuth token files, or personal history exports.

## Administration

Set `SYNC_URL` to the deployed Worker HTTPS URL and `ADMIN_KEY_REF` to its 1Password admin-key reference. All operations require the admin key. The client reads it directly through the 1Password CLI.

```sh
npm run admin -- status
npm run admin -- history/check
npm run admin -- history/report
```

`history/check` performs checks and repairs immediately. `history/report` returns the last complete findings, latest run status, and any pending repair journals. Completed repairs are also retained in Durable Object audit records.

Other operations: `auth/start`, `auth/poll`, and `notifications/test`.

After rotating the Trakt client ID, or if Trakt returns `invalid_grant` ("session not found"), reauthorize with `auth/start` and `auth/poll` using `{"side":"david"}`. The Worker validates the expected identity before accepting a grant. Use an independent cloud grant; do not reuse desktop MCP refresh tokens. Do not reauthorize an already working deployment just to update its code.

## Recovery

An interrupted repair retains its journal. The next run reconciles actual history before changing it again. If an addition is ambiguous, the job stops and alerts rather than risking a duplicate or deleting the original. Inspect `history/report` before intervention. Missing release metadata is reported, not guessed. Release-date repairs are fallback dates, not recovered viewing dates.

Never delete or reset the Durable Object to recover from an error; it holds the encrypted grant and repair journals.
