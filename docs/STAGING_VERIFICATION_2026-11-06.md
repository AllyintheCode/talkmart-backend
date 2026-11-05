# Talkmart staging verification — 6 November 2026

## Scope

Real-server checks used `/var/www/backend-test`, MongoDB `talkmart_staging`, the separate `talkmart-test-media` / `talkmart-test-staging` R2 buckets and `/test-api/` on `api.talkmart.az`. The staging checkout was at `15626e88a5f8a2ba61c5c8ec0662fd68ff82e579`; `GEMINI_MODEL=gemini-3.5-flash-lite` was configured and both staging PM2 processes restarted. Subsequent repository changes set the same model as the default, add client documentation, make migration previews metadata-read-only, update the redirect dependency and use the current origin for Swagger requests.

## Verified on the VPS

- Provider login and authenticated profile returned HTTP 200.
- Real portrait 4K media, approximately 32 MB and 20 seconds, was accepted as a durable queued upload. Compression and media storage completed. A recheck using the final sampling strategy/model completed in approximately 12.4 seconds and approved the cleaning video with confidence 95; the video became active.
- Four samples from the retained 4K media were extracted in one decoder pass within approximately 10.5 seconds on the VPS.
- Public feed and public video lookup returned the active fixture without contact fields. The MP4 returned HTTP 206 for a byte range, the WebP decoded successfully, and the user confirmed normal browser playback.
- User login, repeated desired-state like/save requests, liked/saved lists and restoration of original interaction state passed. A regular user received HTTP 403 from upload and admin routes.
- Admin login, pagination and current worker heartbeat passed. Rejection removed the video from public lookup/feed; activation while rejected returned HTTP 409. Approval restored publication. Explicit hiding survived a subsequent worker maintenance cycle, followed by successful explicit activation.
- A disposable verified provider and tiny real R2 fixtures were seeded for cleanup checks. Guest contact access was rejected; authenticated contact access succeeded. Guest view threshold, signed cookie reuse and repeat-view deduplication passed.
- Provider video deletion immediately hid the fixture. The worker removed its database record, like/save/view records, video object and thumbnail.
- Disposable account deletion immediately rejected the old token with HTTP 401. The worker removed the account, remaining private original, profile image and remaining video records. The original public staging fixture remained active.

Cleanup fixtures were prepared directly in the isolated database/storage to target deletion behavior. They do not constitute an additional registration or fresh upload test. The final-model success was a recheck of retained processed media; a fresh upload from the Flutter application remains part of client acceptance.

## Release verification

- Source checks, 12 unit/media tests and 23 integration tests passed locally. The added migration-preview regression covers empty and existing databases, custom indexes, unchanged legacy records and rollback previews. Production migration has not been applied.
- The locked `follow-redirects` dependency was updated to 1.16.2 for [GHSA-mrwp-f3q8-3g9p](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p); a fresh dependency audit reported zero vulnerabilities.
- Both OpenAPI copies use relative `/api` on the current origin. The staging runner retains its explicit `/test-api/api` override.
- The release manifest records the final Git revision, package checksum and secret-scan result.

## Remaining release conditions

- Flutter instructions have been sent; application acceptance is pending. Test fresh uploads, status polling, session/error handling, cookie persistence, contact actions and OTP/password-reset flows from the client.
- Verify current production configuration and inspect migration preview totals. Required production model/proxy settings must match the tested configuration. Take fresh code/environment/database backups at the actual cutover; the earlier October backup is not a substitute.
- Run production migration/app startup only during the coordinated cutover. Retain the BSON-preserving migration snapshot and deployment rollback material.
- SMTP connection verification is distinct from message delivery; actual OTP receipt and sender deliverability require a controlled client/email test. No production load test or branch-protection/CI change is claimed here.
