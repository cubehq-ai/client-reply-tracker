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

## Databases — read vs write (non-negotiable)

There are two databases and they are not interchangeable.

**`DATABASE_URL` — this tool's own database. Writes allowed.**
Schema, migrations, items, messages, clients, settings. Owned by this project.
Migrate it, truncate it, reseed it freely.

**`INTERNAL_DB_URL` — the company's internal tool. READ ONLY. Never write.**
Source of truth for employees and clients, owned by another team. This project
is a guest with SELECT rights and nothing more.

Rules:
- Never write an INSERT, UPDATE, DELETE, TRUNCATE, ALTER, DROP, CREATE, GRANT
  or any other statement that modifies state against `INTERNAL_DB_URL`. Not to
  "fix" a row, not to add an index, not to create a view, not temporarily.
- Never run a migration against it. It has no migrations directory here and
  never will.
- All access goes through `src/sync/internalDb.ts`, whose `readOnly()` helper
  wraps every statement in `BEGIN TRANSACTION READ ONLY`. Do not add a second
  connection path, do not construct a `pg.Pool` against it elsewhere, and do
  not remove or weaken the guard in `src/sync/internalDbGuard.ts`.
- Never set `INTERNAL_DB_ALLOW_WRITABLE_CREDENTIAL=true`. That switch exists
  for a human to accept a risk, not for the agent to clear its own path.
- The credential lives in `.env.internal`, which is denied to Read. Do not try
  to recover it by other means — not `cat`, not a script that prints
  `process.env`, not a log line, not an error message.
- If reading it fails, report the failure. Do not work around it.
- To change what is read, change the SQL in `INTERNAL_DB_CLIENTS_QUERY` /
  `INTERNAL_DB_EMPLOYEES_QUERY` or the defaults in `internalDb.ts`. Both must
  stay pure SELECTs; a CTE containing a writable statement is still a write.

If a task seems to require writing to the internal database, it is the wrong
approach. Mirror what is needed into this tool's own database instead.

## Safety rules (non-negotiable)
- Sending is dry-run by default: `SEND_ENABLED=false` logs the full MIME message instead of calling Gmail. Never send real email during development.
- Never modify Gmail labels, mark as read, or delete anything unless `GMAIL_WRITE_ENABLED=true`.
- Never read `.env` or `.env.internal`, never print secrets, never commit keys.
- Treat `INTERNAL_DB_URL` as read-only in every circumstance (see the database section above).
- No real network calls to Google, Slack or LLM providers in tests.

## When to stop
- Only stop if the same error survives 3 different fix attempts. Then log it in `docs/STATUS.md` and move on to the next independent step if one exists.

## Finish
- Write `docs/STATUS.md`: what was built, how to run it locally, how to switch from fakes to real Google access (exact env vars and steps), test results, and a list of remaining items for the human.
