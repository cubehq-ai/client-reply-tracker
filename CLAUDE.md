# ReplyQueue — Unresponded Client Inbox (Gmail v1)

Full spec: `docs/SPEC.md` (the unresponded-inbox-gmail-spec.md file). Read it fully before writing code.

## How to work (autonomous mode)
- Work end to end without asking for confirmation. Never ask yes/no questions, never ask which option to pick, never ask for access or keys.
- When something is unclear, choose the option most consistent with `docs/SPEC.md`, continue, and record it in one line in `docs/DECISIONS.md` (date — decision — reason).
- Answer the open questions in SPEC §16 yourself using these defaults, and log them in DECISIONS.md:
  1. Mailboxes: allowlist from env var `WATCHED_MAILBOXES` (comma-separated); if empty, all active users.
  2. Members see only items they own/watch or for clients assigned to them; managers see team; admins see all.
  3. SLA default 24 business hours, Mon–Fri, timezone Asia/Kolkata; per-tier override supported but empty.
  4. "Thanks"-type FYI messages do not reopen a replied item.
  5. Only admins can send as shared inboxes.
  6. Backfill window 30 days (env `BACKFILL_DAYS`).
  7. Body text retention 90 days (env `BODY_RETENTION_DAYS`).
  8. Exclusion list from env `EXCLUDED_MAILBOXES` and `EXCLUDED_LABELS`, empty by default.
- Pick the tech stack yourself (prefer TypeScript, Next.js, Postgres, Prisma, a job queue such as BullMQ or pg-boss) and log it. Do not ask.
- Follow the build phases in SPEC §15 in order. Finish each phase fully before the next.
- After each step: run tests, lint and type check, fix failures, then `git add -A` and `git commit -m "<phase>: <summary>"`. Never push.

## Missing access / keys
- You do not have the Google service account key, Workspace admin access, Pub/Sub, LLM API keys, or the client dashboard DB. Do not ask for them and do not stop.
- Add every required variable to `.env.example` with a comment explaining it.
- Build an abstraction for each external dependency (Gmail client, Directory client, Pub/Sub, LLM classifier, client DB sync) with a real implementation plus a fake/fixture implementation. Use the fakes for all tests and local runs.
- Create realistic fixture data: several clients and domains, client threads, internal replies from a different mailbox, promotional mail, auto-replies, bounces, a personal-Gmail client, a "Thanks!" FYI, and a reopened thread.
- Use `docker compose` for local Postgres/Redis. If Docker is unavailable, fall back to SQLite and log it.

## Safety rules (non-negotiable)
- Sending is dry-run by default: `SEND_ENABLED=false` logs the full MIME message instead of calling Gmail. Never send real email during development.
- Never modify Gmail labels, mark as read, or delete anything unless `GMAIL_WRITE_ENABLED=true`.
- Never read `.env` files, never print secrets, never commit keys.
- No real network calls to Google, Slack or LLM providers in tests.

## When to stop
- Only stop if the same error survives 3 different fix attempts. Then log it in `docs/STATUS.md` and move on to the next independent step if one exists.

## Finish
- Write `docs/STATUS.md`: what was built, how to run it locally, how to switch from fakes to real Google access (exact env vars and steps), test results, and a list of remaining items for the human.
