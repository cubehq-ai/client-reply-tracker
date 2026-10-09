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

## 3. Switching from the fakes to real Google access

Nothing in the pipeline changes; only configuration does.

**Step 1 — Google Cloud.** In the project that owns the service account, enable
the **Gmail API** and the **Admin SDK API**.

**Step 2 — domain-wide delegation.** In the Google Workspace Admin console →
Security → Access and data control → API controls → Domain-wide delegation, add
the service account's **client ID** (the numeric `client_id` in the key file)
with exactly these scopes:

```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/gmail.compose
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/admin.directory.user.readonly
```

`gmail.modify` is only needed if you want tracker labels written back into
Gmail; drop it otherwise and leave `GMAIL_WRITE_ENABLED=false`.

**Step 3 — environment.**

```bash
GOOGLE_SERVICE_ACCOUNT_FILE=/absolute/path/to/key.json
GOOGLE_ADMIN_SUBJECT=a-super-admin@yourdomain.com   # for Directory API calls
GOOGLE_BACKEND=real
ORG_DOMAINS=yourdomain.com
GROUP_ADDRESSES=support@yourdomain.com,hello@yourdomain.com
```

**Step 4 — go in read-only first.** Leave `SEND_ENABLED=false` and
`GMAIL_WRITE_ENABLED=false`. Run `npx tsx src/cli.ts discover` then
`npx tsx src/cli.ts sync` and check the queues. Nothing can be sent or modified
in this mode: a send logs the full MIME to the server instead.

**Step 5 — before the first real sync, set the exclusion list.** Admin →
Exclusions, or `EXCLUDED_MAILBOXES` / `EXCLUDED_LABELS`. HR, legal and
founders' mailboxes should go in before any backfill reads them, not after.

**Step 6 — enable sending** by setting `SEND_ENABLED=true` and restarting.

**Pub/Sub (optional, for sub-minute latency).** Create a topic, grant
`gmail-api-push@system.gserviceaccount.com` the Publisher role on it, point a
push subscription at `https://your-host/pubsub/push?token=<secret>`, then set
`PUBSUB_TOPIC` and `PUBSUB_VERIFICATION_TOKEN`. Without this the system runs on
the 10-minute poller, which is fully functional.

**Classifier.** Set `ANTHROPIC_API_KEY` to use the Haiku-class classifier and
AI drafts. Without it everything still works on heuristics plus the locally
trained model.

**Client data.** Set `CLIENT_DB_URL` to sync clients and domains from the
dashboard database; otherwise the fixture client list is used.

---

## 4. Test results

```
Test Files  9 passed (9)
     Tests  86 passed (86)
  Duration  ~6s
```

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
- the composer produces correctly threaded, correctly escaped MIME.

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

## 7. What is left for a human

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
