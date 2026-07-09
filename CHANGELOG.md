# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by Keep a Changelog.

## [3.1.0] - 2026-07-09

Security and correctness hardening release following a full three-round audit. Backward-compatible for existing installs (which already have a password); only fresh setups and password resets now require a one-time setup token.

### Security
- **First-run takeover (TOFU) closed**: `/api/setup` now requires a one-time `setup_token` that is printed to the server log at startup while no password exists, preventing an unauthenticated attacker from claiming the panel during the pre-setup window. A corrupt `password.json` is treated fail-closed (as "password set") instead of silently re-opening setup.
- **Logout DoS closed**: `/api/logout` only bumps the session epoch (global revocation) when the request carries a valid session + CSRF token; unauthenticated requests can no longer force a global logout.
- **Login rate-limit bypass fixed**: the failure counter is incremented synchronously before password verification, closing the concurrency window that let parallel requests slip past the lockout gate. The limiter is keyed on `req.ip` (not the forgeable `X-Real-IP`), clears when the lockout expires, and is bounded (lazy eviction + hard cap).
- Password hashing/verification moved to **async bcrypt** so bursts of login attempts no longer block the event loop.
- `bird_path` validation now also requires the basename to be `bird`, preventing an authenticated user from pointing it at `/bin/sh` or other host binaries.
- Added security response headers (CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`) and disabled `X-Powered-By`.
- The SSE stream re-verifies the session on each keepalive (closing on logout/expiry) and enforces a connection cap.
- Malformed cookies and session tokens now return 400/401 instead of leaking a 500 stack trace; a global error handler returns generic messages.

### Fixed
- **Silent mis-push on empty first fetch**: a new account whose first fetch returns an empty list no longer records an empty baseline, which previously made the next fetch push the entire timeline.
- **Fetch errors no longer masquerade as success**: a non-zero exit / timeout from bird is treated as a failure instead of "no new tweets".
- JSON is extracted from **stdout only**, so bracket characters in bird's stderr diagnostics can no longer corrupt parsing and drop a successful fetch.
- Tweet IDs prefer the string `id_str`/`rest_id` fields (avoiding 64-bit float rounding collisions that dropped tweets); object-typed IDs are skipped.
- Telegram 429 responses honor `retry_after`; permanent (4xx) errors are no longer retried.
- Duplicate IDs within a single fetch (e.g. a pinned tweet appearing twice) are de-duplicated so they are not pushed twice.
- Offset-less tweet timestamps are interpreted as UTC instead of the server's local timezone.
- Usernames are de-duplicated case-insensitively; reserved names such as `__proto__` no longer corrupt the dedup table (null-prototype maps).
- The "checking…" badge no longer sticks on error paths (reset in `finally`).

### Changed
- Password reset now requires stop → delete `password.json` → restart, then reading the new one-time setup token from the logs.
- Account checks run with bounded concurrency (max 4) so one slow/dead account no longer stalls the others; pause now takes effect immediately, mid-tick.
- Config saves return a `warnings` list for silently-ignored invalid values; a `MAX_ACCOUNTS` cap (100) is enforced and duplicate accounts are merged.
- Per-account dedup is flushed once per check instead of per tweet, reducing write amplification.

### Robustness
- Atomic writes now `fsync` the file and the directory, so the "safe against power loss" guarantee actually holds; corrupt data files are surfaced (logged and preserved) rather than silently reset to defaults.
- `uncaughtException` / `unhandledRejection` now log and `exit(1)` so systemd restarts cleanly instead of the process limping on in an undefined state; the worker loop reschedules in `finally`, and stdout write failures can no longer stall it.
- Added a `lastTickAt` heartbeat and a `healthy` flag on `/api/status` to detect a silently dead worker.

## [3.0.0] - 2026-07-08

Initial public release. A single Node process serves the web panel and runs the monitoring worker in-process.

### Added
- Web management panel (static `public/`, no build step) to configure monitored accounts, Twitter/X credentials, the Telegram bot, and the bird CLI path — with pause/resume, live status + logs, and test buttons.
- In-process monitoring worker: a 5-second tick that checks each account when its `check_interval` is due, fetches tweets via the bird CLI, deduplicates against a persisted `sent_ids` table, and forwards new tweets to Telegram.
- Telegram delivery with up to 3 attempts (2 s apart); each successful push is flushed to `sent_ids.json` immediately, so a crash won't cause a re-send.
- Real-time SSE stream (`/api/stream`) for status and logs; logs are an in-memory ring buffer (500 lines) that is also written to stdout for journald.
- Message formatting: 🐦 新推文 / 🔁 转推 label, publish time converted to `Asia/Shanghai`, X link, and content; messages over 4000 characters are truncated.
- Per-account deduplication: the first run records existing tweet IDs without pushing; at most 200 IDs are retained per account; removing an account cleans up its dedup table and status.
- Forgot-password reset by deleting `data/password.json`.

### Security
- First-run password (>= 8 characters) hashed with bcrypt (cost 12); legacy `$2y$` hashes are normalized to `$2b$`; wrong-password responses use a fixed 1-second delay.
- Login rate limiting keyed on the Nginx-injected `X-Real-IP`: 5 consecutive failures lock for 5 minutes, 10 for 30 minutes, and 20 for 60 minutes.
- Stateless HMAC-SHA256-signed session cookies (7-day lifetime) with an `epoch`, so logout or a password change invalidates all issued sessions immediately.
- CSRF double-submit tokens verified with constant-time comparison on every state-mutating endpoint.
- Credentials are redacted from logs; `trust proxy` is restricted to loopback; the `data/` directory is `0700` and its files `0600`, lives outside the site root, and is never served statically.

### Robustness
- All configuration and runtime state is written atomically (temp file + `rename`) at mode `0600`, preventing corruption on crash or power loss.

Runtime dependencies: `express` and `bcryptjs`. Requires Node.js >= 20 and the bird CLI (`@steipete/bird`).
