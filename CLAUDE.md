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


## Override: Slack ingestion (build now)

### Access
- Auth: Slack **user token** in env `SLACK_USER_TOKEN` (xoxp). No bot token, no Socket Mode, ignore any xapp token.
- Scopes available: channels:read, channels:history, groups:read, groups:history, users:read, users:read.email, reactions:read, team:read, chat:write.
- The token currently belongs to a test user; later it is swapped for a shared account that is in every client channel. Nothing in code may depend on which user owns the token. Read the owner via `auth.test` at startup.
- Build `src/slack/` with a real client (Slack Web API over fetch, honour 429 Retry-After, cursor pagination) and a fake client with fixtures, same pattern as `src/gmail/`. Tests use the fake only. If `SLACK_USER_TOKEN` is empty, Slack sync is disabled and the Slack tab shows "Not connected".
- Use the existing seam in `src/sources/types.ts`; items keep `source = 'slack'`.

### Channels and client mapping
- Sync job lists channels the token owner is a member of (`users.conversations`, public + private).
- Store `slack_channels(id, name, is_private, is_shared, client_id, mapping_source[auto|manual], watched bool, last_synced_ts)`.
- Map channel → client, first match wins:
  1. Manual mapping set in Settings.
  2. Email domains of external members (users with a `team_id` different from our team, or email not on an org domain) matched against `client_domains` / `client_contacts`. If members map to exactly one client, use it; if several, leave unmapped.
  3. Otherwise unmapped.
- Only channels with a client mapping are watched by default. Settings → "Clients & domains" gets a Slack channels section: list channels, set or change client, toggle watched.
- Internal user = same `team_id` as ours (from `team.info` / `auth.test`) or email on an org domain. Everyone else is external. Cache users in `slack_users(id, team_id, email, name, is_internal, is_bot)`; refresh daily. Bot and app messages and channel join/leave/topic messages are ignored.

### Sync
- Poll every 2 minutes per watched channel with `conversations.history(oldest = last_synced_ts)` plus `conversations.replies` for threads with new activity. Initial backfill: last `BACKFILL_DAYS` days.
- Store messages in the existing `messages` table (or a `slack_messages` table if cleaner; log the choice) with: channel_id, ts, thread_ts, user_id, is_internal, text, reactions, edited, deleted.
- Handle edits (update text) and deletions (mark deleted; a deleted client message closes its item with reason `filtered`).

### Reply detection — same two states as email (needs_reply | no_reply_needed)
Unit of work = one channel. Items are per pending client message group, not per channel.

Deterministic rules (no LLM):
1. Thread reply: an internal message with `thread_ts` equal to a client message's ts (or in the same thread after it) → that client message is replied.
2. Internal ✅ (`white_check_mark`, `heavy_check_mark`) reaction on a client message → replied.
3. A client message group = consecutive client messages from the same user with no internal message in between, each within 10 minutes of the previous. One item per group.
4. Exactly one pending client group in the channel and an internal top-level message after it (not @mentioning only colleagues) → replied.
5. An internal top-level message that @mentions only internal users is internal chatter and replies to nothing.

LLM window (only when rules 1–5 don't settle it, i.e. 2+ pending client groups and a top-level internal message after them):
- Debounce: run once the channel has had no new messages for 15 minutes.
- Send the messages since the last fully resolved point (max 30) with ids, author name, internal/external, timestamps, thread markers.
- Ask the model to return strict JSON: `{"unanswered_client_message_ids": [...], "answered_client_message_ids": [...]}`. One internal message may answer several client messages.
- Without `ANTHROPIC_API_KEY`: mark every client group that has an internal top-level message after it as replied with `low_confidence = true`, and log it.

Needs-reply classification:
- Every pending client group goes through the same classifier as email (scored rule, thread context, embeddings, LLM). Acknowledgements ("thanks", "👍", "noted") → no_reply_needed, reason not_needed, and also mark earlier pending groups from the same client in that channel as replied.
- A client message that is only an emoji or a reaction-style word → no_reply_needed.
- Unsure → needs_reply with low_confidence.

Transitions: new client message in a channel with a closed item for that group → new item (do not reopen old groups unless it is a thread reply to them, in which case reopen that item).

### Reply from dashboard
- Composer for Slack items posts with `chat.postMessage` as a thread reply (`thread_ts` = the client message ts) so it is always detectable.
- Dry-run by default: `SLACK_SEND_ENABLED=false` logs the payload instead of posting. Never post during development or tests.
- Show in the UI that the reply posts as the token owner (name from `auth.test`).

### UI
- Enable the Slack tab. Same two tabs (Needs reply / No reply needed), same filters, plus channel filter.
- Row shows channel name, client, author, message text (first 2 lines), age, and a link to the message (`chat.getPermalink`).
- Item view shows the surrounding channel messages (10 before, all after) and the thread if any.

### Tests (fake client, fixtures)
- Thread reply closes item.
- ✅ reaction closes item.
- Burst of 3 client messages + 1 internal message → one item, replied.
- Two pending groups + one internal message → LLM window path (fake model) returns both answered.
- Internal message @mentioning only a colleague does not close the client item.
- Client "thanks 👍" → no_reply_needed and earlier pending groups closed.
- Unmapped channel is not watched; manual mapping makes it watched and backfills.
- Token missing → Slack disabled, no network calls.

### Finish
- Update docs/STATUS.md with: how Slack is configured, how to swap to the shared account's token (replace `SLACK_USER_TOKEN`, restart, run channel sync), and any channels left unmapped.


## Override: Slack items are per channel, not per message
Replaces the item model, reply detection, transitions and UI in "Override: Slack ingestion".
Access, channels/client mapping, sync and dry-run sending stay as written.

### Item model
- One item per watched Slack channel (`items.slack_channel_id`, unique). Same two states: `needs_reply` | `no_reply_needed`.
- Item fields: `pending_count`, `oldest_pending_at`, `oldest_pending_ts`, `last_client_message_at`, `last_internal_message_at`, `preview` (text of the oldest pending client message, 200 chars).
- Each stored Slack client message has `pending` (bool). The channel item is `needs_reply` when any client message in it is pending; otherwise `no_reply_needed` with reason `replied` (or `not_needed` if the last client messages were acknowledgements only).

### Deciding which client messages are pending
Recompute per channel whenever new messages arrive. A client message stops being pending when any of these is true:
1. An internal message exists in its thread after it.
2. An internal ✅ reaction (`white_check_mark`, `heavy_check_mark`) is on it.
3. It is top-level and an internal top-level message exists after it in the channel that is not addressed only to colleagues (@mentions only internal users).
4. It is classified as acknowledgement / no reply needed by the existing classifier.
5. A later message from the same client user is an acknowledgement ("thanks", "👍", "great") → all earlier messages from that user become not pending.

LLM check (only if `ANTHROPIC_API_KEY` is set): after the channel has been quiet for 15 minutes, if rule 3 closed 2 or more client messages using one internal message, send the window (max 30 messages, with ids, author, internal/external, thread markers) and ask for strict JSON `{"unanswered_client_message_ids": [...]}`. Re-mark those as pending. Without a key, keep rule 3's result and set `low_confidence = true` on the item.

### Actions (per channel)
- Reply: posts as a thread reply to the oldest pending client message by default; user can pick another pending message or post top-level. Dry-run unless `SLACK_SEND_ENABLED=true`.
- "Mark all answered": sets every pending message in the channel to not pending (audit-logged).
- Mark one message answered from the conversation view.
- Ignore channel: stops watching it (sets `watched = false`, item hidden), undoable in Settings.

### UI (Slack tab)
- List = channels, not messages. Columns: channel, client, preview of oldest pending message, waiting time (since oldest pending), pending count, last activity.
- Sort: `needs_reply` first by oldest pending ascending; then `no_reply_needed` by last activity descending. Same two tabs as email; filters: client, team, waiting time, low confidence.
- Opening a channel shows the last 50 messages (threads expandable), pending client messages highlighted, each with a "Mark answered" action, and the reply composer at the bottom.

### Tests
- Channel with one unanswered client question → needs_reply, pending_count 1.
- Thread reply / ✅ / internal top-level reply → channel moves to no_reply_needed.
- Pending question in a thread while the main channel is answered → channel still needs_reply.
- Client "thanks 👍" after our reply → no_reply_needed, reason not_needed.
- Internal message @mentioning only a colleague → channel stays needs_reply.
- Mark all answered → no_reply_needed, audit row written.