# ReplyQueue — build status

Dashboard of every client email across the org still waiting on a reply from us.
Built from `docs/SPEC.md`. Gmail only (v1), with the data model kept
channel-agnostic so Slack can reuse it.

---

## 1. What is built

All four phases of SPEC §15 are implemented and covered by tests, with the
exception noted in §7.

**Phase 1 — read-only MVP**
- Domain-wide-delegation Gmail + Directory clients, each with a fake twin.
- Mailbox discovery with an allowlist, exclusions, and reassignment of a
  suspended user's open items to their manager.
- Backfill (30 days) and incremental `history.list` sync, with automatic full
  resync when Gmail reports the saved `historyId` has aged out.
- The processing pipeline: normalize → dedupe → filter → client match →
  classify → ownership → state machine.
- Global conversation IDs built from `Message-ID`/`In-Reply-To`/`References`,
  so one thread is one row no matter how many mailboxes hold a copy.
- Reply detection across mailboxes, including the rule that an internal-only
  forward is not a reply.
- Queues, Ignore, and an admin page for domains, client sync and block rules.

**Phase 2 — actions**
- Reply composer: multipart MIME, correct `In-Reply-To`/`References`, quoted
  history, send-as-shared-inbox permission, save as a real Gmail draft.
- Collision check and a 10-minute soft lock on the composer.
- Snooze, mute, always-ignore (sender/domain), handled elsewhere, reassign,
  link-to-client with retroactive rematching.
- Needs-reply classifier with the FYI queue, and an audit log of every action.

**Phase 3 — real-time and alerts**
- Pub/Sub push endpoint, watch registration and daily renewal.
- Nightly reconciliation that recomputes every open item from stored messages.
- Business-hours SLA with per-client-tier override, the Overdue queue, daily
  owner and manager digests, and immediate alerts for high priority/complaints.
- AI draft replies (never auto-sent).

**Phase 4**
- Awaiting Client follow-up sweep and the metrics dashboard.
- A locally trained Naive Bayes classifier that learns from what the team
  actually did and answers before the LLM when confident, cutting paid calls.
- The channel-agnostic ingestion seam for Slack (interface only — see §7).

---

## 2. Running it locally

```bash
npm install
cp .env.example .env          # then set DATABASE_URL
npm run migrate               # create the schema
npx tsx src/cli.ts bootstrap  # seed config, discover mailboxes, sync, ingest
npm run build:web             # build the dashboard
npm run api                   # http://localhost:8787
npm run worker                # scheduled jobs, in a second terminal
```

Sign-in accounts are created with:

```bash
npx tsx scripts/create-user.ts you@yourdomain.com 'a-password' admin 'Your Name'
```

Useful CLI commands: `sync`, `reconcile`, `discover`, `sync-clients`,
`digests`, `alerts`, `sweeps`, `train-classifier`, `classifier-status`,
`purge-bodies`, `status`.

**Out of the box this runs entirely on fixtures.** No Google, Anthropic or
Slack call is made. The sidebar shows `Gmail: fake`, `Send: dry run` so the
mode is never ambiguous.

---

## 3. Google Workspace access

**This is live.** Domain-wide delegation is authorised and all 19 mailboxes sync.

Service account: `client-reply-tracker@spend-monitor-511010.iam.gserviceaccount.com`
Client ID: `116736478389350149311`

Authorised scopes (Admin console → Security → Access and data control → API
controls → Domain-wide delegation):

```
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/admin.directory.user.readonly
```

Requested scopes must match this list **exactly**. Domain-wide delegation
rejects the entire token request if any single requested scope is not
authorised — it does not grant what it can and skip the rest. They are set by
`GOOGLE_GMAIL_SCOPES` / `GOOGLE_DIRECTORY_SCOPES`, defaulting to
`gmail.modify` + `gmail.send`, which is all this tool needs: `gmail.modify`
already covers reading and draft creation, so `gmail.readonly` and
`gmail.compose` are redundant.

Verify at any time:

```bash
npx tsx src/cli.ts check-google
```

It makes real Directory and Gmail calls, reports Google's own error, and
prints the client ID and scope list an admin needs.

**Known gap:** the Directory API returns 403. It is only used to auto-discover
mailboxes, and the watch list comes from the roster and Settings instead, so
nothing depends on it. To fix: enable the Admin SDK on project
`spend-monitor-511010` and set `GOOGLE_ADMIN_SUBJECT` to a real super admin.

**Least privilege option:** `gmail.modify` also permits changing labels and
trashing mail. This tool never does (`GMAIL_WRITE_ENABLED=false`), but you can
swap it for `gmail.readonly` + `gmail.compose` in the Admin console and set
`GOOGLE_GMAIL_SCOPES` to match.

### Sending

`SEND_ENABLED=false` by default: a send builds the full MIME and logs it
instead of calling Gmail. Set it to `true` when you want replies to leave.

---

## 3b. The internal dashboard (MongoDB)

Clients, teams and employees are read from the agency dashboard's MongoDB
(`agency_dashboard`), **read only**. See §8 for how that is enforced.

What is derived from it:

| This tool | Comes from |
|---|---|
| Clients | `clients.name`, `clients.id` |
| Services | `clients.service_type` (an array, joined for display) |
| Client domains | `seo.gsc.site_url` (verified Search Console property), `seo.ga4.name`, `seo.gmc.name`, `website_access_id`, and the external addresses in `notification_emails` |
| Client contacts | external addresses in `notification_emails` |
| Churned | `clients.is_churned` → archived |
| Teams | `team_members.role` |

A domain is only claimed when exactly one client uses it. Ten domains are
shared between clients (`1933group.com` covers three restaurants), so claiming
them would file one client's mail under another; those are reported instead and
their individual addresses still match exactly.

Commands: `inspect-internal-mongo`, `preview-internal-clients`, `sync-clients`,
`sync-churned`, `sync-teams`.

---

## 4. Test results

```
Test Files  37 passed (37)
     Tests  382 passed (382)
```

Plus browser QA: `QA_EMAIL=... QA_PASSWORD=... node scripts/qa.mjs` drives the
real app and asserts layout invariants (no horizontal overflow, consistent
control heights, composer closed by default, no console errors), and a Slack
section that asserts the channel list is a channel list, that no raw Slack
markup or stray `_emphasis_` reaches the screen in either the previews or the
conversation, that messages carry avatars and days are separated, and that
marking one message answered sticks.

Run with `npm test`. Tests use a **local** Postgres (`TEST_DATABASE_URL`,
defaulting to `postgres://localhost:5432/client_reply_tracker`) and never touch
the configured production database. No test makes a network call to Google,
Anthropic or Slack.

Coverage is behavioural rather than line-based — the suite asserts the
decisions the spec actually cares about:
- every fixture thread lands in the state SPEC §5 requires;
- a group mail delivered to three mailboxes becomes one item with three copies
  and exactly one classifier call;
- a reply sent from a different mailbox marks the item replied;
- an internal-only forward and a draft do not;
- "Thanks!" goes to FYI and does not reopen, while a real follow-up does and
  increments the reopen count;
- a muted thread stays ignored, an unmuted one reopens;
- free email domains can never be mapped to a client;
- business-hours SLA skips weekends and overnight;
- the composer produces correctly threaded, correctly escaped MIME;
- a Slack channel with an external member is watched whether or not its client
  can be named, and one with only our own people is not;
- the client's own people tagging each other is not work, a broadcast or an
  unresolved mention still is, and "@team for vis" is not;
- a channel whose every message is a bot's gets no item at all;
- retention deletes answered Slack messages past the window but never a
  pending one, anything after it, a thread holding one, or the recent tail —
  and unwatching a channel drops all of it and rearms the backfill;
- the nightly mail reconcile leaves Slack items to Slack's own rules;
- Slack mrkdwn renders as emphasis, links, code, quotes and mention chips,
  with our own people distinguishable from the client's.

---

## 5. Notable decisions and deviations

Full log in `docs/DECISIONS.md`. The ones that change the shape of the system:

- **`messages` was split into `messages` + `message_copies`.** SPEC §10 puts
  `mailbox_id` and `gmail_message_id` on `messages`, which forces a duplicate
  row per mailbox and breaks the one-item-per-conversation rule. One row per
  RFC `Message-ID`, N per-mailbox copies.
- **`items.client_id` was added.** SPEC §10 indexes `items(client_id, state)`
  but omits the column.
- **Fastify + Vite instead of Next.js**, because the system is two processes
  (API and a long-running worker) and Next helps with neither half.
- **Raw SQL migrations instead of Prisma**, to keep the §10 schema legible.
- **`node-cron` instead of BullMQ/pg-boss** — no Redis here, and the job set is
  a handful of periodic sweeps. The swap-in point is `src/worker/index.ts`.
- **Backfill ingests oldest-first.** Newest-first never observes the
  replied → reopened transition and undercounts reopens.
- **"Has the client written since the user acted?" compares against the
  external message the user dismissed** (`acted_on_external_at`), not a
  wall-clock `state_since`. The two timestamps come from different clocks, and
  the naive comparison dropped same-millisecond arrivals.

---

## 6. Open questions, answered

Per CLAUDE.md, with no further input required:

| # | Question | Answer |
|---|---|---|
| 1 | All mailboxes or allowlist? | `WATCHED_MAILBOXES`; empty means all active users |
| 2 | Can members see colleagues' threads? | No — owner/watcher/assigned-client only; managers see reports; admins see all |
| 3 | SLA defaults | 24 business hours, Mon–Fri, Asia/Kolkata, per-tier override supported |
| 4 | Do "Thanks" messages reopen? | No — they go to FYI |
| 5 | Who may send as shared inboxes? | Admins, or a user with `can_send_as_shared` |
| 6 | Backfill window | 30 days (`BACKFILL_DAYS`) |
| 7 | Body retention | 90 days (`BODY_RETENTION_DAYS`), metadata kept |
| 8 | Exclusions | `EXCLUDED_MAILBOXES` / `EXCLUDED_LABELS`, empty by default |

---

## 7. How mail is triaged

### Two states

Every item is `needs_reply` or `no_reply_needed`. A closed item always records
why: `replied`, `not_needed`, `filtered` or `ignored`. Everything else —
overdue, unmatched client, low confidence, muted — is a flag on the item, not
a state, so nothing is in two places at once and the counts never double up.

Removed in this revision: snooze, handled-elsewhere, sending, fyi and
awaiting-client. A reply sent from the dashboard closes the item only when
sync confirms the sent message, so there is no interim state to get stuck in.

### Filtering order

Every new external message takes the first branch that matches:

1. **Client mail** — sender domain in `client_domains`, address in
   `client_contacts`, a subdomain of a client domain, or a matching rule.
   Gmail's category labels are deliberately ignored here, because client mail
   lands in Promotions and Updates often enough to matter. Auto-replies,
   out-of-office and bounces are still dropped by header. Otherwise the
   classifier runs.
2. **Spam, promotional, automated** — Gmail SPAM/CATEGORY_* labels,
   `List-Unsubscribe`, `Precedence: bulk|list`, `Auto-Submitted`,
   `X-Autoreply`, a noreply-style sender, a calendar part, or an always-ignore
   rule. Closed as `filtered`, with no model call.
3. **A real person who is not a client** — if any org mailbox has written to
   that domain before (or to that exact address, for free providers), the
   classifier runs and the item is flagged `unmatched_client`. If we have
   never written to them, it is cold outreach: closed as `filtered`, no model
   call.

Prior contact is a lookup against `contacted_domains` / `contacted_addresses`,
built from our own Sent mail during backfill and kept current by sync. This is
what separates a real correspondent we simply have not linked yet from a cold
pitch, and it is why the Unmatched queue went from 255 items to 24.

Rebuild it at any time with `npx tsx src/cli.ts backfill-contacts`.

### Classifier

Runs only on branches 1 and 3. A free pre-check closes a message that is under
200 characters, reads as an acknowledgement, asks no question and contains none
of "can you / could you / please / need / when / send / share / confirm /
update". Everything else goes to the model, which answers only
`{needs_reply, confidence, summary}`. Cached by `rfc_message_id`, so a message
in five mailboxes is paid for once. Below `NEEDS_REPLY_CONFIDENCE_THRESHOLD`
the item still appears in Needs reply, flagged `low_confidence` — client mail
is never hidden on the model's word alone. Every user override is recorded in
`classifier_feedback`.

### Matching rules

Settings → Matching rules is the general escape hatch: test one field (sender
address, sender domain, subject, body, recipient, raw header) with regex /
contains / equals / ends-with, then assign a client, filter it out, force it
through the filters, or set a priority. Rules run before the built-in filters
and before client matching, in `priority` order, and `allow` always beats
`ignore`. A rule is previewed against real stored mail before saving, and
**Apply to existing mail** re-runs the rules over the backlog.

---

## 8. What is left for a human

**Needs your access or decision**

1. **Domain-wide delegation has to be authorised by a Workspace super admin.**
   This is the one hard blocker on going live; everything else is configuration.
   Until it is done the system runs on fixtures.
2. **Set the exclusion list before the first real backfill.** Once a mailbox is
   read, it has been read.
3. **Decide whether tracker labels are written back into Gmail**
   (`GMAIL_WRITE_ENABLED`). Without it, someone working inside Gmail cannot see
   that an item was ignored or snoozed in the dashboard.
4. **Point `CLIENT_DB_URL` at the real dashboard database.** The fixture client
   list is a placeholder.
5. **Choose a digest transport.** `src/sync/digest.ts` defines a `Notifier`
   interface with a logging implementation; wire it to email or Slack.

**Not implemented, deliberately**

6. **Slack ingestion** (SPEC §15 phase 4) is an interface only —
   `src/sources/types.ts` documents the mapping. Implementing it against a real
   workspace was out of scope for a Gmail v1.
7. **Forwarded-client-email detection** (SPEC §12) is explicitly v2 in the spec
   and is not implemented.
8. **Attachments** are metadata-only, per SPEC §9 ("v1 none or simple upload").
9. **Google SSO** is wired to the login page and the `/api/auth/google` route
   builds a correct authorisation URL, but the callback exchange is not
   implemented — add `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` and the callback handler
   when you want it. Password login is complete and works now.

**Worth knowing**

10. **Backfill buffers a mailbox's messages in memory** to sort them
    oldest-first. Fine for 30 days of one mailbox; if you raise
    `BACKFILL_DAYS` a long way, make it chunked.
11. **The Naive Bayes classifier needs ~40 labelled items before it activates**,
    and only answers above 0.85 confidence (0.93 to call something FYI). Run
    `train-classifier` periodically once the team has been using the queues.

---

## 9. Internal database safety

Two databases, deliberately asymmetric:

| | `DATABASE_URL` | `INTERNAL_DB_URL` |
|---|---|---|
| What | This tool's own database | The company's internal tool |
| Owner | This project | Another team |
| Access | Read **and** write | **Read only, always** |
| Migrations | Yes | Never |

Four independent layers keep the second one read-only. Only the first is a
true guarantee; the rest are there to catch a mistake before it reaches it.

**1. The Postgres grant (the actual guarantee).** Create a login that can only
select:

```sql
CREATE ROLE replyqueue_reader LOGIN PASSWORD 'a-strong-password';
ALTER ROLE replyqueue_reader SET default_transaction_read_only = on;

GRANT CONNECT ON DATABASE your_internal_db TO replyqueue_reader;
GRANT USAGE ON SCHEMA public TO replyqueue_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO replyqueue_reader;

-- Tables created later are covered too.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO replyqueue_reader;

-- Make sure nothing was inherited from PUBLIC.
REVOKE CREATE ON SCHEMA public FROM replyqueue_reader;
```

Do not hand this tool a superuser or the application's own login. A superuser
ignores every grant, and the runtime check below will refuse to run against one.

**2. A runtime check that the grant is real.** Before the first query,
`assertInternalDbReadOnly()` verifies the role is not a superuser and holds no
INSERT/UPDATE/DELETE/TRUNCATE on any table. If it can write, the tool throws
rather than proceeding. Verify yours with:

```bash
npx tsx src/cli.ts check-internal-db-readonly
```

It also refuses if `INTERNAL_DB_URL` and `DATABASE_URL` resolve to the same
host, port and database — otherwise every write we believe is local would land
in the internal tool.

**3. Every statement runs in `BEGIN TRANSACTION READ ONLY`.** Postgres itself
rejects a write inside that transaction, so even a mistaken query cannot
modify anything. All access is funnelled through `readOnly()` in
`src/sync/internalDb.ts`; there is no second connection path.

**4. Agent-level rules.** `CLAUDE.md` forbids writing to `INTERNAL_DB_URL` in
any form, and `.claude/settings.json` denies the direct database clients
(`psql`, `pg_dump`, `mysql`, `mongosh`, …) that would bypass the guarded path.
The credential lives in `.env.internal`, which is denied to the Read tool, so
the agent can run the app against the database without ever seeing the string.

The escape hatch `INTERNAL_DB_ALLOW_WRITABLE_CREDENTIAL=true` exists so a human
can knowingly proceed with a writable login during setup. Setting it is denied
to the agent, and it only downgrades layer 2 — layer 3 still blocks writes.


## Slack ingestion (updated 2026-11-02)

### How it is configured
`SLACK_USER_TOKEN` in `.env` — a **user** token (`xoxp-`), not a bot token.
Empty disables Slack completely: no sync, no network calls, and the Slack tab
reads "not connected".

| Variable | Default | What it does |
|---|---|---|
| `SLACK_USER_TOKEN` | *(empty)* | The token. Empty = Slack off. |
| `SLACK_SEND_ENABLED` | `false` | Replies are logged, not posted, until this is `true`. |
| `SLACK_DEBOUNCE_MINUTES` | `15` | Quiet period before ambiguous groups go to the model. |
| `SLACK_RETENTION_DAYS` | `BACKFILL_DAYS` (30) | How long an **answered** message is kept. |
| `SLACK_KEEP_MESSAGES` | `100` | Messages kept per channel whatever their age. |

Scopes in use: `channels:read`, `channels:history`, `groups:read`,
`groups:history`, `users:read`, `users:read.email`, `reactions:read`,
`team:read`.

### What the token owner changes — nothing
Discovery reads **every non-archived public channel in the workspace**, joined
or not, plus the private channels the owner is in. A user token with
`channels:history` can read a public channel without joining it, which is how
the client channels are reachable: not one of them had been joined.

The earlier version listed `users.conversations` — the owner's own channels —
and so covered 4 of 48. Swapping the token now changes who replies would post
as, and nothing else.

1. Replace `SLACK_USER_TOKEN` in `.env`.
2. Restart the API and worker.
3. Settings → **Slack channels** to check the list. Nothing needs mapping for
   ingestion to work.

### Which channels are watched, and whose they are
These are two separate decisions, and the Settings table keeps them apart.

**Watched** — does a client talk to us here? Answered by whether any external
human is a member. `#general`, `#random` and the nine `sentry-alerts-*`
channels have none; `#reviews-california` has twenty-nine. 25 of 48 channels
qualify.

**Client** — which client? Best effort, strongest evidence first: an external
member's address in `client_domains`/`client_contacts`; then that address's
email domain matching a client's name (`madeforfreedom.com` → "Made for
freedom"); then the channel name (`#just-enough-wines-x-cube`). Any step that
implicates two clients gives up rather than guessing.

Watching used to be gated on the client mapping, which hid 46 of 48 channels,
because the dashboard has no domain rows for most accounts that live in Slack.
An unmapped channel now shows its items as `unmatched`.

### What counts as waiting on us
Deterministic rules, in order; the first that fires closes the message.

1. An internal reply in its thread, after it.
2. A ✅ from one of us.
3. The client's own people talking to each other — every `@mention` in the
   message resolves to someone on their side. This is the mirror of the rule
   for our chatter, and it matters: most of `#reviews-*` is Kasa staff tagging
   Kasa staff, which read as 14 items of work in one channel.
4. Posted for visibility — "@team for vis", "fyi", "cc @someone" and nothing
   else. No question mark, no sentence of its own.
5. An acknowledgement ("thanks", "👍"), or a later one from the same person.
6. A top-level internal message after it that is not addressed only to
   colleagues.
7. Whatever survives goes to the **needs-reply classifier**, the same one the
   mail side uses, cached per message. Only a confident "no" closes anything;
   unsure leaves it waiting and marks the channel low confidence — which is
   every message while `ANTHROPIC_API_KEY` is unset.

A channel with no client message at all gets no item. Fourteen of the first
twenty-five watched channels are bot review feeds, and each had produced a row
reading "no reply needed — replied" about a conversation that never happened.

### Retention — what is deleted and when
`slack-retention`, nightly at 04:40. Slack is not mail: a channel is one
endless conversation that arrives in order and is mostly answered within
minutes, so an answered message past the window is deleted outright rather
than emptied of its body the way a mail is.

Never deleted:
- anything still pending;
- anything **at or after** the oldest pending message in its channel, so
  reconciliation recomputes the same answer from what is left;
- any thread holding a pending message;
- the newest `SLACK_KEEP_MESSAGES` per channel, and anything inside
  `SLACK_RETENTION_DAYS`.

A channel that stops being watched loses all of its messages, and its
`last_synced_ts`/`backfilled_at` are cleared so re-watching backfills afresh
rather than resuming from a watermark whose messages are gone. Unwatching from
Settings purges immediately rather than waiting for 04:40.

Bot and app messages, joins and topic changes are never stored at all, which
is what keeps `#connector-statuses` — 16,360 messages in thirty days — out of
the database even if somebody watches it.

Taken together the store is bounded rather than growing: roughly
`watched channels × SLACK_KEEP_MESSAGES`, plus whatever is still waiting,
plus the last 30 days. At 25 watched channels that is a few thousand rows.
It is 252 today.

### Schedule
| Job | Cadence |
|---|---|
| `slack-sync` — history per watched channel | every 2 min |
| `slack-window` — the ambiguous groups | every 5 min, only after a channel is quiet |
| `slack-channels` — channel list, membership, auto mapping | hourly at :17 |
| `slack-users` — user directory | daily 05:00 |
| `slack-retention` — delete answered messages past the window | daily 04:40 |

### The workspace as of 2026-11-02
Token owner **sasi** in **Cube HQ**. 48 channels, 25 watched, 252 messages
stored, 13 items — 9 needing a reply across 35 waiting messages.

| Channel | Client | Matched on |
|---|---|---|
| `#made-for-freedom-x-cube` | Made for freedom | an external member's address |
| `#planteddetroit-cube` | Planted Detroit | an external member's address |
| `#cl-blackbrookcase-alia` | BlackBrook | the channel name |
| the other 22 watched channels | *unmatched* | — |

### Left for a human
- **Most watched channels have no client.** Kasa (17 `#reviews-*` channels
  plus `#team-kasa-x-cube`, every external member `@kasa.com`), Balance
  Grille, Adagio Teas, Moon Audio, Tribetokes and Cartlift are not in the
  dashboard at all. `behno` and `Just Enough Wines` are there but archived, so
  they are deliberately skipped. Either add them in the dashboard with their
  domains, or map the channels by hand in Settings → **Slack channels**; the
  items work either way, they just read `unmatched`.
- **No `ANTHROPIC_API_KEY`.** The needs-reply classifier falls back to
  keywords and answers "unsure" for nearly everything, so every Slack item
  carries `low_confidence` and the Low confidence chip is hidden as it would
  select the whole list. This is the single biggest quality lever left: with a
  key, statements of fact from a client ("No, I don't believe I interacted
  with them") stop being counted as questions. The LLM window for ambiguous
  closures is also disabled without it.
- **Replies are a dry run.** `SLACK_SEND_ENABLED=false`. There is no composer
  in the Slack drawer by design — replies are written in Slack, where the
  threading, formatting and files are — so this only affects the API.
- **`chat:write` is not in the current token's scopes**, so posting would fail
  even with `SLACK_SEND_ENABLED=true`. Re-authorise with it if you want the
  dashboard to post.
- **`#team-kasa-x-cube` is watched by hand** (`watch_source = 'manual'` from
  before the auto rule existed). It would be watched automatically now anyway.

## Deploying to Railway (2026-10-20)

Two services from this one repo. Both need the same environment.

| Service | Start command | Replicas |
|---|---|---|
| `web` | `npm run migrate:prod && npm start` | any |
| `worker` | `npm run start:worker` | **1 — do not scale** |

`guarded()` stops a job overlapping *itself* inside one process. It cannot stop
two processes, so a second worker replica doubles every Gmail and Slack sync
and sends every digest twice. `railway.json` pins `numReplicas: 1`; keep it.

Migrations run in the web service only — both racing is worse than the worker
starting a few seconds before a new column exists.

The `Procfile` carries no comments. Railway reads any `name: command` line as a
process, and a comment containing a colon was picked up as a third service
called "# Migrations run in the ...". Keep it to the two process lines.

### Environment
**Railway variables are per service.** Setting `DATABASE_URL` on `web` does not
set it on `worker`: the worker will start, dial `127.0.0.1:5432` and
crash-loop. Either set the variables on both, or define them once at the
environment level and reference them from each service.

Everything in `.env.example`. The ones without which it will not work:
`DATABASE_URL`, `GOOGLE_BACKEND=real`, `GOOGLE_SERVICE_ACCOUNT_FILE` (or the
key's JSON mounted at that path), `SESSION_SECRET`, `ORG_DOMAINS`.
Optional: `SLACK_USER_TOKEN` (empty disables Slack entirely),
`ANTHROPIC_API_KEY`, `INTERNAL_MONGO_URL`, `DNS_FALLBACK_SERVERS`.

Keep `SEND_ENABLED=false` and `SLACK_SEND_ENABLED=false` until you want the
app to actually send and post.

### Scheduled jobs
All run in `Asia/Kolkata`, set explicitly, so a UTC container does not shift
them. `npm run jobs-qa` runs every one of them once, for real, and prints what
each did — use it after a deploy rather than waiting to see whether 04:00
worked.

| Job | Schedule | What it does |
|---|---|---|
| `sync` | every 10 min | Gmail history per watched mailbox — the primary ingest |
| `slack-sync` | every 2 min | Slack history per watched channel |
| `sweeps` | every 5 min | expired composer locks, overdue alerts |
| `slack-window` | every 5 min | the ambiguous Slack groups, once a channel is quiet |
| `hourly-status` | hourly at :05 | re-reads open threads, catching replies sent from mailboxes we do not watch |
| `sync-clients` | hourly | clients and domains from the dashboard |
| `slack-channels` | hourly at :17 | channel list, membership and auto client mapping |
| `discover` | 02:00 | mailbox discovery — skips unless `GOOGLE_ADMIN_SUBJECT` is set |
| `renew-watches` | 03:00 | no-op until `PUBSUB_TOPIC` is set |
| `reconcile` | 04:00 | full recompute of mail items, then every watched Slack channel; ~1 hour at 2,400 items against Neon — `npm run jobs-qa` skips the mail half unless `QA_JOBS_HEAVY=true` |
| `purge-bodies` | 04:30 | mail retention, `BODY_RETENTION_DAYS` |
| `slack-retention` | 04:40 | deletes answered Slack messages, `SLACK_RETENTION_DAYS` |
| `slack-users` | 05:00 | Slack directory |
| `digests` | 08:00 Mon–Fri | owner and manager digests |
| `sync-teams` | 18:00 | teams and membership from the dashboard |

### After the first deploy
1. Generate a domain on the **web** service only (Settings - Networking).
   The worker serves nothing and needs no domain.
2. Change the seeded password immediately — the app is now reachable from the
   internet and that password is the only thing in front of real client mail:
   ```
   npm run cli set-password -- dev@cubehq.ai 'a long passphrase'
   ```
   Run it against the production database (Railway shell, or locally with
   `DATABASE_URL` set to production). It ends every existing session too.
3. `npm run jobs-qa` to confirm all 16 scheduled jobs run in the new
   environment.

### Known gaps at deploy time
- **No Pub/Sub.** `PUBSUB_TOPIC` is unset, so mail arrives on the 10-minute
  poll rather than in seconds. `renew-watches` no-ops until it is set.
- **No `GOOGLE_ADMIN_SUBJECT`**, so `discover` skips. Mailboxes are managed in
  Settings, which is why skipping is safe.
- **No `ANTHROPIC_API_KEY`**, so the classifier is rules-only and the Slack
  window keeps rule 3's guess with `low_confidence` set.
- **`reconcile` takes ~8 minutes.** Fine at 04:00; worth watching as the
  backlog grows.
