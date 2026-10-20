-- Slack ingestion (CLAUDE.md override: Slack ingestion).
--
-- Messages live in their own table rather than in `messages`. That table is
-- shaped around RFC mail: rfc_message_id is NOT NULL UNIQUE and from_email /
-- from_domain are NOT NULL citext. A Slack message has none of those, and a
-- Slack user need not have an email at all, so sharing the table would mean
-- inventing identifiers for every row. Items and conversations ARE shared, so
-- everything downstream -- states, filters, actions, ownership, the UI -- is
-- the same machinery for both sources.

CREATE TABLE IF NOT EXISTS slack_channels (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  is_private      boolean NOT NULL DEFAULT false,
  is_shared       boolean NOT NULL DEFAULT false,
  is_archived     boolean NOT NULL DEFAULT false,
  client_id       bigint REFERENCES clients(id) ON DELETE SET NULL,
  -- 'auto' mappings are recomputed by sync; 'manual' ones are never overwritten,
  -- the same precedence the Gmail side uses for team assignment.
  mapping_source  text NOT NULL DEFAULT 'auto' CHECK (mapping_source IN ('auto','manual')),
  watched         boolean NOT NULL DEFAULT false,
  last_synced_ts  text,
  backfilled_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS slack_channels_client_idx ON slack_channels(client_id);
CREATE INDEX IF NOT EXISTS slack_channels_watched_idx ON slack_channels(watched) WHERE watched;

CREATE TABLE IF NOT EXISTS slack_users (
  id          text PRIMARY KEY,
  team_id     text NOT NULL DEFAULT '',
  email       citext,
  name        text NOT NULL DEFAULT '',
  -- Same workspace as the token owner, or an address on an org domain.
  is_internal boolean NOT NULL DEFAULT false,
  is_bot      boolean NOT NULL DEFAULT false,
  deleted     boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS slack_users_email_idx ON slack_users(email);

CREATE TABLE IF NOT EXISTS slack_messages (
  id           bigserial PRIMARY KEY,
  channel_id   text NOT NULL REFERENCES slack_channels(id) ON DELETE CASCADE,
  -- Slack's per-channel id, which is also its timestamp.
  ts           text NOT NULL,
  thread_ts    text,
  user_id      text,
  is_internal  boolean NOT NULL DEFAULT false,
  text         text NOT NULL DEFAULT '',
  reactions    jsonb NOT NULL DEFAULT '{}'::jsonb,
  edited       boolean NOT NULL DEFAULT false,
  deleted      boolean NOT NULL DEFAULT false,
  -- The client-message group this belongs to, when it opened or extended one.
  conversation_id bigint REFERENCES conversations(id) ON DELETE SET NULL,
  posted_at    timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, ts)
);
CREATE INDEX IF NOT EXISTS slack_messages_channel_idx ON slack_messages(channel_id, ts);
CREATE INDEX IF NOT EXISTS slack_messages_thread_idx ON slack_messages(channel_id, thread_ts);
CREATE INDEX IF NOT EXISTS slack_messages_conversation_idx ON slack_messages(conversation_id);

-- Which Slack message opened an item's group, so the composer can reply in the
-- right thread and the UI can link to the right permalink.
ALTER TABLE items ADD COLUMN IF NOT EXISTS slack_channel_id text REFERENCES slack_channels(id) ON DELETE CASCADE;
ALTER TABLE items ADD COLUMN IF NOT EXISTS slack_group_ts text;
CREATE INDEX IF NOT EXISTS items_slack_idx ON items(slack_channel_id, slack_group_ts);

-- Channel activity drives the debounce for the LLM window: it runs only once a
-- channel has been quiet, so a burst is judged whole rather than per message.
ALTER TABLE slack_channels ADD COLUMN IF NOT EXISTS last_message_at timestamptz;
ALTER TABLE slack_channels ADD COLUMN IF NOT EXISTS resolved_through_ts text;
