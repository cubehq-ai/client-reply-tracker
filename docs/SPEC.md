# Unresponded Inbox Dashboard — Gmail v1 Spec

## 1. Goal

One dashboard showing every client email across the org that is still waiting on a reply from us, grouped by client, with the ability to reply, ignore, snooze, or reassign directly from the dashboard.

v1 = Gmail only. Slack comes later; keep the data model channel-agnostic (`source = gmail | slack`).

---

## 2. Definitions (get these right first)

- **Org domains**: our own domains (e.g. `cubehq.ai` + any others). Config table, not hardcoded.
- **Internal sender**: from address on an org domain.
- **External sender**: anyone else.
- **Conversation**: one email thread. Gmail `threadId` is **per mailbox**, so the same thread has different IDs in different users' mailboxes. Use RFC headers (`Message-ID`, `In-Reply-To`, `References`) to build a **global conversation ID** that dedupes across mailboxes.
- **Unresponded**: the latest *meaningful* message in the conversation is from an external sender, and no internal sender (from any org mailbox) has sent a message in that conversation after it.
- **Item**: one dashboard row = one conversation that needs attention. Not one row per message, not one row per mailbox.

---

## 3. Architecture overview

```
Directory API ──> list of mailboxes to watch
        │
Gmail watch() + Pub/Sub ──> push "mailbox X changed, historyId N"
        │
Sync worker ──> history.list since last historyId ──> fetch new messages (metadata + body snippet)
        │
Pipeline: normalize → dedupe → filter (rules) → client match → classify → state machine update
        │
DB (items, messages, clients, rules, audit)
        │
Dashboard UI + reply composer ──> Gmail send (as the user) ──> picked up again by sync → marks replied
```

### 3.1 Mailbox discovery
- Daily job: Directory API → list active users. Store in `mailboxes`.
- Admin setting: include all users, or an allowlist (e.g. only client-facing team + shared inboxes like `support@`).
- Suspended or deleted users: stop watching; reassign their open items to their manager or an "unowned" queue.

### 3.2 Ingestion
- **Initial backfill**: per mailbox, fetch the last N days (default 30, configurable) using `messages.list` with query `-in:chats -in:spam -in:trash`.
- **Real-time**: `users.watch()` per mailbox pointing at a Pub/Sub topic.
  - Grant `gmail-api-push@system.gserviceaccount.com` the Publisher role on the topic.
  - Watches expire after 7 days → renew daily via cron.
- **On notification**: `history.list(startHistoryId=last_saved)` → get added messages and label changes → fetch each with `format=metadata` plus a body snippet. Fetch the full body only when needed for classification or the UI.
- **If historyId is too old** (404): fall back to a full resync of the last N days for that mailbox.
- **Fallback poller**: every 10 minutes, run `history.list` for every mailbox, in case push notifications are missed.
- **Nightly reconciliation**: recompute the state of every open item from source, to fix drift.
- **Quotas**: Gmail API has per-user quota units. Use batch requests and exponential backoff on 429.

### 3.3 Fetch only what's needed
Store: headers (From, To, Cc, Subject, Date, Message-ID, In-Reply-To, References, List-Unsubscribe, Precedence, Auto-Submitted), Gmail labels, snippet, and plain-text body (truncated, e.g. first 4k chars) for classification. Do not store attachments; store attachment metadata only.

---

## 4. Processing pipeline (per new message)

### Step 1 — Normalize & dedupe
- Parse headers, extract sender email + domain, recipients, and a cleaned body (strip quoted replies and signatures for classification).
- Compute the global conversation ID from the References/In-Reply-To chain (fallback: normalized subject + participant set + time window).
- If the message already exists (same Message-ID seen in another mailbox): attach this mailbox as an additional recipient and do not create a duplicate.

### Step 2 — Is it internal?
- If the sender is internal: this is a potential **reply event** (see section 6). Do not create an item.
- If all participants are internal: ignore entirely (internal threads are out of scope for v1).

### Step 3 — Rule-based filtering (free, runs on everything)
Mark as `auto_ignored` with a reason if any of these match:
- Gmail labels: `CATEGORY_PROMOTIONS`, `CATEGORY_SOCIAL`, `CATEGORY_UPDATES`, `CATEGORY_FORUMS`, `SPAM`
- Headers: `List-Unsubscribe` present, `Precedence: bulk|list`, `Auto-Submitted: auto-*`
- Sender patterns: `noreply@`, `no-reply@`, `notifications@`, `mailer-daemon@`, `postmaster@`
- Out-of-office or auto-replies (`Auto-Submitted`, `X-Autoreply`, subject patterns like "Out of office", "Automatic reply")
- Calendar invites/responses (`text/calendar` part, "Accepted:", "Declined:")
- Bounces
- Sender or domain on the org-level **block list** (built from user "Always ignore" actions)

**Exception**: if the sender's domain matches a client, skip the label-based rules. Clients sometimes land in Updates or Promotions. Header rules (bulk, auto-reply) still apply.

### Step 4 — Client matching
1. Exact match on sender domain → `client_domains` table (synced from the dashboard DB).
2. Exact match on sender email → `client_contacts` override table (for clients using Gmail, Outlook, etc.).
3. Subdomain match (`mail.acme.com` → `acme.com`).
4. If there's no match on the sender, try other external participants on the thread (e.g. the client CC'd).
5. Still no match → `client_id = null` → goes to the **Unmatched** queue (not hidden). From there users can:
   - "Link to client" → creates a contact or domain mapping, applies retroactively to open items
   - "Not a client" → optional block rule

Free email domains (`gmail.com`, `outlook.com`, `yahoo.com`, etc.) must never be added as client domains. Only email-level mappings are allowed for them.

### Step 5 — Needs-reply classification (only for messages that survived steps 3–4)
Goal: separate "needs a reply" from "FYI / no action" (e.g. "Thanks!", "Got it", invoices, reports).
- **Tier A — heuristics**: very short message with a thank-you/ack pattern and no question mark → `fyi` with low confidence.
- **Tier B — small LLM call** (Haiku-class) on the cleaned body + subject + last internal message. Returns JSON:
  `{needs_reply: bool, confidence: 0-1, intent: question|request|complaint|approval|fyi|other, priority: high|normal|low, summary: "one line"}`
- Volume is already small after rules + client filter, so a per-message LLM call is affordable here. Embeddings + a trained classifier can replace it later, using user actions (replied vs ignored) as training labels.
- Confidence below threshold (e.g. 0.6) → still show in **Needs Reply** with a "low confidence" tag. Never hide client mail based on the model alone.

### Step 6 — Ownership
- Owner = internal recipient in **To** (first match). If none is in To, use **Cc**.
- If there are multiple internal recipients, all are watchers and one is the owner.
- If the client has an assigned account manager in the dashboard DB, use them as owner when the email went to a shared inbox (`support@`, `hello@`).
- Owner can be reassigned manually (logged).

### Step 7 — Update state machine (section 5)

---

## 5. Item state machine

### States
| State | Meaning |
|---|---|
| `needs_reply` | External message waiting on us |
| `sending` | Reply submitted from dashboard, not yet confirmed via sync |
| `replied` | An internal reply exists after the last external message |
| `ignored` | User chose not to reply |
| `snoozed` | Hidden until a set time |
| `fyi` | Classifier says no reply needed (visible in FYI queue) |
| `auto_ignored` | Filtered by rules (not shown by default; auditable) |
| `handled_elsewhere` | User marked it handled outside email (call, Slack, meeting) |

### Transitions
| From | Event | To |
|---|---|---|
| — | New external client message, classified needs_reply | `needs_reply` |
| — | New external message, classified fyi | `fyi` |
| `needs_reply` | Internal reply detected in conversation (any org mailbox) | `replied` |
| `needs_reply` | User clicks Reply in dashboard and sends | `sending` → `replied` once the sent message appears in sync |
| `sending` | Send fails / not seen in sync within 5 min | `needs_reply` + error shown |
| `needs_reply` | User clicks Ignore | `ignored` (reason required: not needed / spam / not a client / other) |
| `needs_reply` | User clicks Snooze | `snoozed` (until time) |
| `needs_reply` | User clicks "Handled elsewhere" | `handled_elsewhere` |
| `snoozed` | Snooze time reached | `needs_reply` |
| `snoozed` | New external message in conversation | `needs_reply` (early wake) |
| `replied` | New external message in conversation | `needs_reply` (reopened, reopen count +1) |
| `ignored` | New external message in conversation | `needs_reply`, unless the thread is **muted** |
| `handled_elsewhere` | New external message | `needs_reply` |
| `fyi` | User clicks "Actually needs reply" | `needs_reply` (feedback logged for classifier) |
| `fyi` / `auto_ignored` | User restores | `needs_reply` |
| any | Thread deleted in all mailboxes | archived (soft delete) |

### Ignore options (sub-choices on the Ignore button)
- **Ignore this message**: reopens if the client writes again.
- **Mute this thread**: stays ignored even if new messages arrive.
- **Always ignore this sender**: creates a block rule for the email.
- **Always ignore this domain**: creates a block rule for the domain (requires admin confirmation if the domain is a client).
- Every ignore is undoable for 30 days from the Ignored queue.

---

## 6. Detecting replies (how and when)

### How
- Any **internal-sender message** in the same global conversation with `Date` later than the latest external message → conversation is replied.
- Works regardless of where the reply was sent from (Gmail web, phone, Outlook client, dashboard), because everything ends up in the sender's Sent folder, which we sync.
- Works across mailboxes. If a client emails A and B replies (with the client on the thread), B's sent message carries the same References chain, so it matches the same conversation.
- Internal-only forwards (e.g. A forwards to B with no client recipient) **do not count** as a reply. A reply only counts if at least one external participant of the conversation is a recipient.
- Drafts do not count.

### When
1. **Real-time**: Pub/Sub push on the sender's mailbox (Sent label added) → usually within seconds.
2. **Every 10 min**: fallback history poll.
3. **Nightly**: full reconciliation of all open items.
4. **On dashboard open of an item**: quick re-check of that thread before showing the composer, so two people don't reply to the same mail.

### What happens after an item is replied
- State → `replied`, store `replied_at`, `replied_by`, `response_time` (external message time → reply time).
- Removed from the Needs Reply queue and shown in the **Replied (last 7 days)** queue.
- Optional **Awaiting client** tracking: if our reply contained a question or request (LLM flag or user toggle "I'm waiting on them"), track it. If there's no client response after X days, surface it in an **Awaiting Client / Follow-up** queue. v1: optional toggle only.
- If the client replies again → reopened to `needs_reply` with history preserved.
- Metrics updated (response time per client, per owner).

---

## 7. Queues / views

| Queue | Contents | Default sort |
|---|---|---|
| **Needs Reply** | `needs_reply` items with a client match | Priority, then oldest first |
| **Overdue** | Needs Reply items past SLA | Oldest first |
| **Unmatched** | `needs_reply` from external senders with no client match | Newest first |
| **Low Confidence** | Classifier unsure (also shown in Needs Reply with a tag) | Newest first |
| **FYI** | `fyi` items | Newest first |
| **Snoozed** | `snoozed` with wake time | Wake time |
| **Replied** | Replied in last 7 days | Most recently replied |
| **Awaiting Client** (optional) | We replied and are waiting | Oldest first |
| **Ignored** | Ignored + muted, last 30 days, with undo | Newest first |
| **Filtered** | `auto_ignored`, with reason, for audit | Newest first |

### Filters on every queue
Client, owner, mailbox, age bucket (<4h, 4–24h, 1–3d, >3d), priority, intent.

### Views
- **My items** (owner = me), **My team**, **All** (admin).
- **By client**: client list with open count, oldest age, and SLA breach count; drill into the client's items.

---

## 8. SLA & alerts
- SLA hours configurable per client tier (from dashboard DB if a tier exists; otherwise a global default, e.g. 24 business hours).
- Business hours + timezone per org (exclude weekends optionally).
- Alerts:
  - Daily digest email/Slack to each owner: their open + overdue items.
  - Daily digest to managers: overdue by client.
  - Optional immediate alert for `priority = high` or a complaint intent.

---

## 9. Reply from dashboard

### Composer
- Opens with the full thread (all messages, newest last, quoted text collapsed).
- Defaults to Reply-all to the last external message. To/Cc editable.
- Sends as the logged-in user (impersonated via DWD). A user can only send as themselves; admins can be allowed to send as shared inboxes (`support@`) via a permission flag.
- Optional "AI draft" button: LLM drafts a reply from the thread context; user edits before sending. Never auto-send.
- Attachments: v1 none or simple upload; v2 full.
- Save as Gmail draft option (creates a real draft in the user's mailbox, so they can finish in Gmail).

### Sending correctly (must stay in the same Gmail thread for everyone)
- Use `users.messages.send` with `threadId` = the thread ID **in the sender's own mailbox**. If the sender doesn't have this thread (they weren't a recipient), send without threadId but with headers.
- Set headers: `In-Reply-To: <last message Message-ID>`, `References: <full chain + last Message-ID>`, `Subject: Re: <original subject>` (no double "Re:").
- Build MIME with both plain-text and HTML parts; include quoted previous message.

### After send
- State → `sending` immediately (optimistic UI), then `replied` once sync sees the message in Sent.
- Log to `audit_log` (who sent, as whom, item id, message id).
- Collision check: before sending, re-check the thread. If someone else replied in the last few minutes, warn: "B already replied 3 min ago. Send anyway?"
- Soft lock: when a user opens the composer on an item, show "A is replying" to others for up to 10 minutes.

---

## 10. Data model (Postgres suggested)

```
mailboxes(id, email, user_id, status, watch_expiration, last_history_id, last_synced_at)
org_domains(domain)
clients(id, name, tier, account_manager_user_id, external_id)  -- synced from dashboard DB
client_domains(id, client_id, domain, source[sync|manual])
client_contacts(id, client_id, email, source)
conversations(id, global_key, subject, client_id, first_external_at, last_external_at, last_internal_at)
messages(id, conversation_id, mailbox_id, gmail_message_id, gmail_thread_id, rfc_message_id,
         from_email, from_domain, to[], cc[], date, direction[in|out], labels[], snippet,
         body_text_trunc, is_auto, filter_reason)
items(id, conversation_id, source[gmail], state, owner_user_id, watchers[], priority, intent,
      needs_reply_confidence, summary, sla_due_at, snoozed_until, ignore_reason, muted,
      reopen_count, replied_at, replied_by, awaiting_client, created_at, updated_at)
rules(id, type[block_sender|block_domain|allow_sender], value, created_by, scope[org|user])
classifier_feedback(id, item_id, predicted, actual, user_id, created_at)
audit_log(id, user_id, action, item_id, payload_json, created_at)
```

Indexes: `messages.rfc_message_id`, `items(state, owner_user_id)`, `items(client_id, state)`, `client_domains.domain`.

### Client sync
- Job every 15 min (or webhook) from the dashboard DB → upsert `clients` and `client_domains`.
- On new domain mapping → re-run matching on open Unmatched items.

---

## 11. Permissions & privacy
- Roles: **member** (sees own items + clients they're assigned to), **manager** (team), **admin** (all + settings + rules).
- Decide whether members can see other people's client emails. Default: only items where they are owner/watcher, or the client is assigned to them.
- Never expose the DWD key to the frontend; all Gmail calls are server-side.
- Store minimal body text; configurable retention (e.g. delete body text after 90 days, keep metadata).
- Audit every read of full email body by non-owners (optional), every send, and every ignore.
- Exclusion list: mailboxes or labels that must never be read (e.g. HR, legal, founders' personal folders). Check before fetching.

---

## 12. Edge cases checklist
- Client emails multiple people separately (not one thread) → separate items, same client. Fine.
- Client CCs a new person mid-thread → same conversation.
- Client replies "Thanks!" after our reply → classifier → `fyi`; does not reopen into Needs Reply (goes to FYI with a link to the conversation).
- Client sends from a personal Gmail → Unmatched until linked.
- One external message to `support@` (Google Group) → group delivers to members' mailboxes; dedupe via Message-ID.
- Google Groups / shared mailbox replies "on behalf of" → treat the group address as internal.
- Our reply bounces → keep `needs_reply` (detect bounce of our message).
- Very long threads → classify only the latest external message + latest internal message.
- Forwarded client email from an internal person ("FYI, can you handle this?") → v2: detect forwards and create an item for the forwarded-to person.
- User deletes the external message in Gmail → keep the item unless deleted in all mailboxes.
- Timezone/date header spoofing → use Gmail `internalDate`, not the `Date` header, for ordering.
- Non-English email → LLM handles it; rules use headers so they're language-independent.

---

## 13. Cost control
- Rules + client match filter out most mail before any paid call.
- LLM classify only: external, non-bulk, client-or-unmatched messages. One call per new external message, not per mailbox copy.
- Cache by `rfc_message_id`.
- Store classifier feedback (ignore = not needed, reply = needed) to train an embedding-based classifier later and reduce LLM calls.

---

## 14. Metrics to track
- Open items per client / owner; oldest open age.
- Median and p90 first-response time per client, per owner.
- SLA breach count.
- Reopen rate.
- Classifier precision: % of `fyi` later moved to needs_reply; % of needs_reply ignored.
- Filter audit: % of `auto_ignored` restored by users (if high, rules are too aggressive).

---

## 15. Build phases

**Phase 1 — Read-only MVP**
- DWD auth, mailbox discovery, backfill + polling (no Pub/Sub yet).
- Rules filter, client matching, reply detection.
- Queues: Needs Reply, Unmatched, Replied. Basic Ignore.
- Admin page for org domains, client domain sync, block rules.

**Phase 2 — Actions**
- Reply composer with correct threading, collision check, audit log.
- Snooze, mute, always-ignore rules, handled elsewhere, reassign.
- LLM needs-reply classifier + FYI queue.

**Phase 3 — Real-time & alerts**
- Pub/Sub push, watch renewal, nightly reconciliation.
- SLA, Overdue queue, daily digests.
- AI draft replies.

**Phase 4**
- Awaiting Client follow-up queue, metrics dashboard, embedding classifier.
- Slack ingestion using the same `items` model.

---

## 16. Open questions (decide before Phase 2)
1. All mailboxes or allowlist only?
2. Can members see colleagues' client threads?
3. SLA defaults per client tier?
4. Should "Thanks"-type FYI messages reopen a replied item or not (current spec: no)?
5. Who is allowed to send as shared inboxes?
6. Backfill window: 30 days enough?
7. Retention period for email body text?
8. Any mailboxes or labels that must be excluded entirely?
