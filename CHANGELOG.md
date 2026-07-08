# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by Keep a Changelog.

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
