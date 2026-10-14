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

## Overrides to SPEC (these take priority over docs/SPEC.md)

### 1. Item states — two only
Replaces SPEC §5 (state machine) and §7 (queues).

- Every item is in exactly one state: `needs_reply` or `no_reply_needed`.
- `no_reply_needed` items store a `reason`:
  - `replied`: an internal reply was detected after the last external message
  - `not_needed`: classifier or user decided no reply is needed (e.g. "Thanks", "Noted")
  - `filtered`: spam, promotional, bulk, automated, or non-client mail with no prior contact
  - `ignored`: user clicked Ignore
- Extra fields on items (not states):
  - `low_confidence` (bool): classifier confidence < 0.6
  - `unmatched_client` (bool): sender not linked to any client
  - `muted` (bool): user chose "Mute thread"
  - `overdue` (bool): computed from SLA

Transitions:
| Event | Result |
|---|---|
| New external message, classified needs reply | `needs_reply` (from any state, unless `muted = true`) |
| New external message, classified no reply needed | `no_reply_needed`, reason `not_needed` |
| Internal reply detected (any org mailbox, at least one external participant as recipient) | `no_reply_needed`, reason `replied` |
| User clicks "No reply needed" | `no_reply_needed`, reason `not_needed`; log feedback for classifier |
| User clicks Ignore | `no_reply_needed`, reason `ignored`; sub-options: this message / mute thread / always ignore sender / always ignore domain |
| User clicks "Needs reply" on any no_reply_needed item | `needs_reply`; log feedback for classifier |
| Classifier unsure (confidence < 0.6) | `needs_reply` with `low_confidence = true` |

Removed entirely: snooze, handled_elsewhere, sending, fyi, awaiting_client states and their queues. Sending a reply from the dashboard sets the item to `no_reply_needed` / `replied` only after sync confirms the sent message.

UI:
- Two tabs: **Needs reply** and **No reply needed**.
- Filters on both tabs: client, owner, age bucket, reason, low confidence, unmatched client, overdue.
- Needs reply sort: overdue first, then oldest first.
- Unmatched items have a "Link to client" action (creates a client_domains or client_contacts mapping, then re-runs matching on all open items from that sender/domain) and a "Not a client" action (sets `no_reply_needed`, reason `ignored`, optional always-ignore rule).

### 2. Mail filtering order
Replaces SPEC §4 steps 3–5. For every new external message, stop at the first match:

1. **Client mail**: sender domain in `client_domains`, or sender email in `client_contacts` (subdomains match parent domain; free email domains like gmail.com/outlook.com/yahoo.com match only via `client_contacts`).
   - Skip Gmail label filters (client mail can land in Promotions/Updates).
   - Still drop auto-replies, out-of-office and bounces by header → `no_reply_needed`, reason `filtered`.
   - Otherwise run the needs-reply classifier.
2. **Spam / promotional / automated**: any of
   - Gmail label `SPAM`, `CATEGORY_PROMOTIONS`, `CATEGORY_SOCIAL`, `CATEGORY_UPDATES`, `CATEGORY_FORUMS`
   - Header `List-Unsubscribe`, `Precedence: bulk|list`, `Auto-Submitted` (not `no`), `X-Autoreply`
   - Sender local part matches noreply, no-reply, donotreply, notifications, notification, mailer-daemon, postmaster, bounce
   - Calendar invite or response (`text/calendar` part)
   - Sender or domain on the always-ignore list
   → `no_reply_needed`, reason `filtered`. No LLM call.
3. **Non-client mail from a real person**:
   - If any org mailbox has previously sent at least one email to the sender's domain (or to the sender's exact address for free email domains) → run the needs-reply classifier; if it needs a reply → `needs_reply` with `unmatched_client = true`.
   - Otherwise → `no_reply_needed`, reason `filtered`. No LLM call.
   - Maintain a `contacted_domains` table (domain, first_sent_at, last_sent_at) built from org Sent mail during backfill and kept updated by sync, so this check is a DB lookup.

### 3. Needs-reply classifier
- Runs only on step 1 messages and step 3 messages that passed the prior-contact check.
- Input: subject, cleaned body of the latest external message (quoted text and signatures removed), and cleaned body of the latest internal message in the conversation.
- Cheap rule before the LLM: body under 200 characters, matches a thanks/acknowledgment pattern, no `?`, and none of "can you", "could you", "please", "need", "when", "send", "share", "confirm", "update" → no reply needed, confidence 0.9, no LLM call.
- LLM: small/cheap model. Output strict JSON only:
  `{"needs_reply": true|false, "confidence": 0.0-1.0, "summary": "one line"}`
- Prompt must ask: does the client's latest message ask a question, make a request, raise a problem, or otherwise expect a response from us, taking our last message into account?
- Cache by `rfc_message_id`. Classify once per message, not per mailbox copy.
- Store every user override ("Needs reply" / "No reply needed" clicks) in `classifier_feedback`.

### 4. Data model changes
- `items`: replace `state` enum with `needs_reply | no_reply_needed`; add `reason`, `low_confidence`, `unmatched_client`, `muted`; drop `snoozed_until`, `intent`, `awaiting_client`, `priority`.
- Add table `contacted_domains(domain PK, first_sent_at, last_sent_at, is_free_email_domain)` and `contacted_addresses(email PK, first_sent_at, last_sent_at)` for free email domains.
- Add tests with fixtures for each filtering branch: client in Promotions (kept), newsletter (filtered), cold outreach from never-contacted domain (filtered), new person from previously contacted domain (unmatched, needs_reply), client "Thanks!" (not_needed), client question after our reply (needs_reply), client reply on muted thread (stays no_reply_needed).