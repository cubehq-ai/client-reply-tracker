-- Core schema for the Unresponded Inbox dashboard (Gmail v1).

-- Case-insensitive email columns. Available on Neon and Homebrew Postgres alike.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS org_domains (
  domain        text PRIMARY KEY,
  -- Google Groups / shared inboxes count as internal senders (spec 12).
  is_group      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Domains that may never be attached to a client as a whole (spec 4.4).
CREATE TABLE IF NOT EXISTS free_email_domains (
  domain text PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS users (
  id            bigserial PRIMARY KEY,
  email         citext UNIQUE NOT NULL,
  name          text,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('member','manager','admin')),
  manager_email citext,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  can_send_as_shared boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id               bigserial PRIMARY KEY,
  email            citext UNIQUE NOT NULL,
  user_id          bigint REFERENCES users(id) ON DELETE SET NULL,
  kind             text NOT NULL DEFAULT 'user' CHECK (kind IN ('user','shared')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','suspended','excluded')),
  watch_expiration timestamptz,
  last_history_id  text,
  last_synced_at   timestamptz,
  backfilled_at    timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mailboxes_status_idx ON mailboxes(status);

-- Mailboxes or labels that must never be read (spec 11).
CREATE TABLE IF NOT EXISTS exclusions (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('mailbox','label')),
  value      text NOT NULL,
  reason     text,
  created_by citext,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);

CREATE TABLE IF NOT EXISTS clients (
  id                      bigserial PRIMARY KEY,
  external_id             text UNIQUE,
  name                    text NOT NULL,
  tier                    text,
  account_manager_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  sla_hours               integer,
  archived                boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS client_domains (
  id         bigserial PRIMARY KEY,
  client_id  bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  domain     citext NOT NULL UNIQUE,
  source     text NOT NULL DEFAULT 'manual' CHECK (source IN ('sync','manual')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_domains_domain_idx ON client_domains(domain);

CREATE TABLE IF NOT EXISTS client_contacts (
  id         bigserial PRIMARY KEY,
  client_id  bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email      citext NOT NULL UNIQUE,
  source     text NOT NULL DEFAULT 'manual' CHECK (source IN ('sync','manual')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_contacts_email_idx ON client_contacts(email);

-- One row per global conversation, deduped across mailboxes (spec 2).
CREATE TABLE IF NOT EXISTS conversations (
  id                bigserial PRIMARY KEY,
  global_key        text NOT NULL UNIQUE,
  subject           text,
  client_id         bigint REFERENCES clients(id) ON DELETE SET NULL,
  participants_ext  text[] NOT NULL DEFAULT '{}',
  first_external_at timestamptz,
  last_external_at  timestamptz,
  last_internal_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_client_idx ON conversations(client_id);

-- Links an RFC Message-ID to its conversation so later messages can join the
-- same thread even when they land in a mailbox we had not seen before.
CREATE TABLE IF NOT EXISTS conversation_keys (
  rfc_message_id  text PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id               bigserial PRIMARY KEY,
  conversation_id  bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  rfc_message_id   text NOT NULL,
  from_email       citext NOT NULL,
  from_domain      citext NOT NULL,
  to_emails        text[] NOT NULL DEFAULT '{}',
  cc_emails        text[] NOT NULL DEFAULT '{}',
  subject          text,
  -- Gmail internalDate, never the spoofable Date header (spec 12).
  internal_date    timestamptz NOT NULL,
  direction        text NOT NULL CHECK (direction IN ('in','out')),
  snippet          text,
  body_text_trunc  text,
  body_purged_at   timestamptz,
  is_auto          boolean NOT NULL DEFAULT false,
  filter_reason    text,
  in_reply_to      text,
  references_ids   text[] NOT NULL DEFAULT '{}',
  is_draft         boolean NOT NULL DEFAULT false,
  is_bounce        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfc_message_id)
);
CREATE INDEX IF NOT EXISTS messages_rfc_idx ON messages(rfc_message_id);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, internal_date DESC);

-- The same RFC message seen in several mailboxes: one message row, N copies.
CREATE TABLE IF NOT EXISTS message_copies (
  id               bigserial PRIMARY KEY,
  message_id       bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mailbox_id       bigint NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  gmail_message_id text NOT NULL,
  gmail_thread_id  text NOT NULL,
  labels           text[] NOT NULL DEFAULT '{}',
  deleted          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, gmail_message_id)
);
CREATE INDEX IF NOT EXISTS message_copies_message_idx ON message_copies(message_id);
CREATE INDEX IF NOT EXISTS message_copies_thread_idx ON message_copies(mailbox_id, gmail_thread_id);

CREATE TABLE IF NOT EXISTS attachments (
  id         bigserial PRIMARY KEY,
  message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename   text,
  mime_type  text,
  size_bytes bigint
);

CREATE TABLE IF NOT EXISTS items (
  id                     bigserial PRIMARY KEY,
  conversation_id        bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE UNIQUE,
  source                 text NOT NULL DEFAULT 'gmail' CHECK (source IN ('gmail','slack')),
  state                  text NOT NULL CHECK (state IN (
                           'needs_reply','sending','replied','ignored','snoozed',
                           'fyi','auto_ignored','handled_elsewhere','archived')),
  client_id              bigint REFERENCES clients(id) ON DELETE SET NULL,
  owner_user_id          bigint REFERENCES users(id) ON DELETE SET NULL,
  watchers               text[] NOT NULL DEFAULT '{}',
  priority               text NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
  intent                 text,
  needs_reply_confidence real,
  summary                text,
  sla_due_at             timestamptz,
  snoozed_until          timestamptz,
  ignore_reason          text,
  muted                  boolean NOT NULL DEFAULT false,
  filter_reason          text,
  reopen_count           integer NOT NULL DEFAULT 0,
  last_external_at       timestamptz,
  replied_at             timestamptz,
  replied_by             citext,
  response_time_seconds  integer,
  awaiting_client        boolean NOT NULL DEFAULT false,
  awaiting_since         timestamptz,
  sending_since          timestamptz,
  last_error             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS items_state_owner_idx ON items(state, owner_user_id);
CREATE INDEX IF NOT EXISTS items_client_state_idx ON items(client_id, state);
CREATE INDEX IF NOT EXISTS items_sla_idx ON items(sla_due_at) WHERE state = 'needs_reply';
CREATE INDEX IF NOT EXISTS items_snoozed_idx ON items(snoozed_until) WHERE state = 'snoozed';

CREATE TABLE IF NOT EXISTS item_events (
  id         bigserial PRIMARY KEY,
  item_id    bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  from_state text,
  to_state   text NOT NULL,
  event      text NOT NULL,
  actor      citext,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS item_events_item_idx ON item_events(item_id, created_at DESC);

-- "A is replying" soft lock on the composer (spec 9).
CREATE TABLE IF NOT EXISTS item_locks (
  item_id    bigint PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  user_email citext NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id         bigserial PRIMARY KEY,
  type       text NOT NULL CHECK (type IN ('block_sender','block_domain','allow_sender')),
  value      citext NOT NULL,
  created_by citext,
  scope      text NOT NULL DEFAULT 'org' CHECK (scope IN ('org','user')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type, value, scope, created_by)
);
CREATE INDEX IF NOT EXISTS rules_value_idx ON rules(value);

CREATE TABLE IF NOT EXISTS classifier_feedback (
  id         bigserial PRIMARY KEY,
  item_id    bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  predicted  text NOT NULL,
  actual     text NOT NULL,
  confidence real,
  user_email citext,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Cached classifier verdicts keyed by message, so a message is never paid for
-- twice no matter how many mailboxes it landed in (spec 13).
CREATE TABLE IF NOT EXISTS classifications (
  rfc_message_id text PRIMARY KEY,
  needs_reply    boolean NOT NULL,
  confidence     real NOT NULL,
  intent         text,
  priority       text,
  summary        text,
  tier           text NOT NULL,
  model          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial PRIMARY KEY,
  user_email citext,
  action     text NOT NULL,
  item_id    bigint,
  payload    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_runs (
  id          bigserial PRIMARY KEY,
  job         text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean,
  detail      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS job_runs_job_idx ON job_runs(job, started_at DESC);
