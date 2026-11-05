# Talkmart audit implementation

Implemented against the 27 findings in the review dated 25 October 2026. Existing local changes were retained and completed. No production database, credential, cloud bucket, deployment or GitHub branch rule was changed during implementation.

## Finding coverage

| Finding | Integrated behavior |
| --- | --- |
| TM-001, TM-002 | Redacting logger throughout the server; no environment or OTP dumps; credential scan in CI. |
| TM-003 | Cryptographic OTP generation; purpose/account HMAC with independent required pepper; constant-time comparison; atomic attempt budget and consumption. Legacy plain hashes are rejected. |
| TM-004 | Strict access/reset types, issuer, audience, HS256, expiration and session version. Legacy JWT fallback removed. |
| TM-005 | One access-session validator reads authoritative account state on every request. Blocking and password changes revoke old sessions. |
| TM-006 | Reset nonce hash and expiry live on the account; password update, nonce consumption and session increment share one atomic write, including parallel requests. |
| TM-007 | Independent IP and account limits, shared Redis counters with shared MongoDB fallback; upload reservation before Multer, active-job, daily-byte and storage quotas; Retry-After. |
| TM-008 | Public feed DTO excludes contact fields. Contact and WhatsApp require login. Blocked/deleting owners are excluded from public results. |
| TM-009, TM-010 | Video documents form a durable MongoDB queue. Separate worker, atomic leases, heartbeat, bounded attempts, retry delay and failed-job retry endpoint. No Redis destructive pop or inline worker fallback. |
| TM-011, TM-012 | Ready/media/approval/owner publication invariant; decision versions and admin precedence; lease fencing; atomic media/AI commit; publication reconciliation after crash. |
| TM-013, TM-014 | Temporary file ownership through validation, errors and disconnect; old-temp reaper; FFprobe container, codec, duration, stream count and dimensions; bounded decoder processes. |
| TM-015 | File streams and multipart R2 upload, bounded parts and timeout, bounded output and FFmpeg time/threads. Container resource limits supplied. |
| TM-016 | Strict independent response schema, review on malformed/ambiguous/error output, at most two requests within a time budget, circuit breaker. No unbounded full-video fallback. Configurable manual-review categories. |
| TM-017 | Deleting state fences worker writes; registered attempt object keys, retryable storage cleanup, interaction cascade and hourly paged orphan reconciliation. Ambiguous DB commits cannot delete referenced media. |
| TM-018 | Account deleting state revokes access immediately; worker retries provider video/media/OTP/interaction cleanup; blocked references removed; associated reports/audits anonymized. |
| TM-019 | Unique interactions and MongoDB transactions; idempotent desired like/save state; counters recomputed within transaction and reconciled in bounded background batches. |
| TM-020 | Signed random anonymous session cookie, 24-hour transactional view deduplication, watched-time threshold and engagement limiter. Redis failure cannot disable deduplication. |
| TM-021 | Scalar query validation, ID/enum/search/price bounds, maximum 50 items, bounded offsets, cursor pagination for main lists and query timeouts. |
| TM-022 | Verified provider upload middleware and admin verification/revocation endpoint. |
| TM-023, TM-024 | Versioned public content cache, exact invalidation, DB fallback and bounded SCAN instead of KEYS. Visibility-sensitive feeds read the current database state. |
| TM-025 | Report lifecycle, assignment, reason and embedded audit history; durable embedded notification outbox, leases, backoff and manual retry. SMTP failure does not lose the report. |
| TM-026 | Admin user pagination/cursor, role/verification filters and selected fields; email/phone lists are not returned. |
| TM-027 | Real unit/media/integration tests, source checks, build check, dependency audit, Gitleaks workflow, uniform error envelope and request ID. OpenAPI copies synchronized. |

## Runtime and infrastructure

Use Node.js 22.15 or later and MongoDB with replica-set/transaction support. API and worker must point to the same database. Production should use majority write concern and journaling; restrict database access to these services. Redis is an accelerator, not the durable video queue. When Redis is down, cache reads fall back to the DB and rate limits use shared MongoDB buckets.

Copy the empty variables from `.env.example` into the deployment secret manager. Generate independent random values of at least 32 characters for `JWT_SECRET` and `OTP_PEPPER`; optional `JWT_ACCESS_SECRET` and `JWT_RESET_SECRET` allow separate signing keys. Set `TRUST_PROXY` only to the actual trusted proxy IPs/subnets. The default trusts no forwarding headers.

Create `R2_STAGING_BUCKET` as a **separate private bucket**, with no r2.dev/custom public domain. Configure an original-file retention/lifecycle policy long enough for failed-job recovery and a rule to abort incomplete multipart uploads. `R2_BUCKET` and `R2_PUBLIC_URL` remain the published-media bucket/domain. Application startup rejects a missing or identical staging bucket name, but bucket privacy and lifecycle rules must be set in Cloudflare. Credentials need only the required bucket/object permissions.

Run the API with `npm start` and a continuously running worker with `npm run worker`. The API never starts a worker. Start with concurrency 1; raise it only after measuring memory, CPU and disk under realistic input. `compose.yaml` supplies separate processes, non-root containers, bounded temporary storage, CPU/memory/PID limits and no new privileges. It was not deployed or built on this host. Configure load balancer/body upload limits and timeouts consistently with the 250 MB application limit.

For an existing PM2 deployment, `ecosystem.config.cjs` defines `talkmart-api` and `talkmart-worker`, both reading the release folder's `.env`. After the migration and coordinated mobile rollout, start/reload them with `pm2 startOrReload ecosystem.config.cjs --update-env`, then `pm2 save`. Keep `.env` and PM2's saved environment restricted to the service administrator. The worker refuses to start while legacy video rows still require migration. Migration backfills legacy thumbnail object keys, including URLs on an earlier media domain, and the orphan scanner retains URL-only references.

Missing Gemini configuration yields manual review. The default model and environment example use `gemini-3.5-flash-lite`, verified on the staging account with a real portrait 4K service video. Override it with a model actually available to the account in `GEMINI_MODEL`; verify a real structured multimodal request as well as model discovery, because discovery can include models that reject generation for a particular account. Keyframes do not assess audio or every instant; use `MANUAL_REVIEW_CATEGORIES` for categories requiring human review. The 20-second budget bounds the AI attempt path; it is not a promise that upload, compression and publication finish within 20 seconds.

Keyframe extraction shares a 13.5-second budget, reserving time for the model request. Clips up to 30 seconds use one decoder pass to sample four time windows, avoiding repeated decoding of the same 4K GOP. Longer clips retain sparse seeks with a five-second per-seek cap so a multi-minute upload does not require full decoding. Input decoding uses two threads and frame encoding/filtering uses one. Expired budgets or incomplete samples require manual review and remove temporary frames. Real portrait 4K, short/long sampling coverage and deadline/cleanup checks cover these paths.

## Client/API changes

- Old access/reset JWTs and old plain OTP hashes are invalid; clients must sign in or request a new OTP.
- Errors are `{success:false,data:null,error:{code,message},meta:{requestId}}`. Read `error.code`; the top-level message remains for compatibility. Successful responses retain their original fields and add `data` and `meta`.
- Upload remains HTTP 201 with a queued video, and completes asynchronously. Send a stable `Idempotency-Key` of 8-100 letters/digits/underscore/hyphen to replay a successful upload without creating another video. Poll the provider's paginated video list for readiness. Admin approval cannot bypass missing media/readiness.
- Provider verification: `PATCH /api/admin/users/:id/verify-provider` with `{verified:true,reason}`. Verification changes revoke old sessions; sign in again. Existing unverified providers require explicit admin review.
- `POST /api/videos/:id/like` sets liked=true by default, and accepts `{liked:false}`. Save uses `{saved:false}`. These requests are idempotent. `DELETE` on the same paths removes the interaction. Clients that previously relied on toggle behavior must send their intended boolean state.
- `POST /api/videos/:id/view` requires `{watchedMs:2000}` or greater. Guest clients must retain the signed `tm_view` cookie. No raw IP is stored as a view identifier.
- Contact and WhatsApp require access authentication. Public feed responses omit phone and address.
- Lists accept page/limit; the maximum is 50 and large offsets are rejected. Admin users/videos/reports, provider videos and newest explore results support `cursor` using the preceding `nextCursor`, without page or a different sort order.
- Account/video deletion is accepted immediately and hidden at once; storage and dependent-record removal is completed by the worker with retries. Repeat requests are safe while deletion is pending.
- Reports: `GET /api/admin/reports?status=new&overdue=true`; `PATCH /api/admin/reports/:id` with status/note/assignedTo. Resolved/rejected decisions require a reason. Failed notification delivery can be retried at `POST /api/admin/reports/:id/retry-notification`.
- Failed videos with a retained original can be retried at `POST /api/admin/videos/:id/retry`. Admin rejection retains a nonpublic video record for review; deletion is a separate explicit operation.

## Safe rollout and rollback

1. Back up MongoDB and retain existing media. Configure the new private staging bucket and secrets in a test environment. Announce required re-login and the like/save/view contract changes to mobile clients.
2. Stop the old video enqueue/worker implementation and drain active requests. There must be only one processing system. Keep the API and new worker stopped while migrating existing video state.
3. Run `npm run migrate:video-state` for a read-only count and proposed processing/moderation/publication status totals. Preview connections disable automatic collection and index creation, including rollback previews; indexes are created explicitly only by the apply branch. Review legacy records: local-only jobs with no source cannot be reconstructed and migrate to failed/review; valid retained staging jobs become queued; explicit admin decisions are preserved. No missing decision is inferred as approved.
4. Run `npm run migrate:video-state -- --apply`. Keep the generated BSON-preserving snapshot in restricted storage. The migration is versioned and idempotent, records conflicts and creates declared indexes. Do not commit its snapshot. Unchanged legacy account defaults are filled as part of the apply step.
5. Start the new worker, then API, and run the tests and staging smoke checks. Confirm provider verification, contact privacy, delete retries, and original-bucket privacy. The worker does not publish failed/review/pending videos.
6. For rollback, stop API and workers first. Run `npm run migrate:video-state -- --rollback <snapshot>` to inspect, then add `--apply` to restore matching records. Concurrently changed records are skipped and counted as conflicts. Restore the DB backup if broader rollback is required. Preserve security patches, session revocation and the private original bucket; do not reactivate the old in-memory queue on new jobs.

All rollback and migration commands are prepared for an operator; none was run against the configured production database.

## Operations and verification

`GET /api/admin/operations` returns queue/failed/stale-lease counts, deletion/report backlog, notification failures, per-worker heartbeat, bounded p50/p95/p99 latency samples and memory. Workers publish snapshots and redacted structured logs every maintenance cycle. Monitor missing/stale worker heartbeats, rising failure/cleanup/report backlogs, repeated 429s, and orphan-removal counts. Forward those logs/metrics to the deployment's monitoring system and configure alerts there.

The supplied tests use a temporary local replica set, real FFprobe/FFmpeg, and fake R2/SMTP; they do not send email or call paid AI. Local verification passed 12 unit/media tests and 23 integration tests, including portrait 4K frame extraction, short/long sampling coverage, shared-deadline cleanup, legacy thumbnail retention, migration dry-run/apply/rollback and unchanged collection/index metadata during previews on the isolated test DB. Dependency audit reported zero vulnerabilities; Gitleaks found no leaks in the source snapshot and the pre-release 70-commit Git history. Run:

```text
npm ci
npm run lint
npm test
npm run test:integration
npm run build
npm audit --audit-level=moderate
```

`lint` and `build` are JavaScript syntax and unsafe-pattern checks; this service has no compile/bundle step. CI runs the same checks and scans committed Git history using Gitleaks. Mark `quality` and `secrets` as required repository checks before allowing merge/deployment; the workflow file alone cannot change branch protection.

Before production, measure 250 MB uploads and concurrent compression against the actual RAM/CPU/disk budget, verify 50k-user pagination/explain plans and 100k-key Redis SCAN latency, confirm real R2 multipart cleanup and SMTP retry behavior, and measure AI/queue/FFmpeg/R2 p95 on the target hosting/network. No production load, external Gemini/R2/SMTP test, historical credential rotation, log-retention change, cloud configuration or remote CI run is claimed by the local automated results. Review report/audit retention and anonymization against the product's retention policy before deployment.
