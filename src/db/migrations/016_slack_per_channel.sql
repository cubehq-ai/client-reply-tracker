-- Slack items are per channel, not per client-message group (CLAUDE.md
-- override: "Slack items are per channel, not per message").
--
-- A channel is the unit of work: "who is waiting on us in #acme-cube" is the
-- question, and one row per message group split one conversation across
-- several rows that each told half the story. Pendingness moves down to the
-- message, and the channel's item aggregates it.

ALTER TABLE slack_messages ADD COLUMN IF NOT EXISTS pending boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS slack_messages_pending_idx ON slack_messages(channel_id) WHERE pending;

ALTER TABLE items ADD COLUMN IF NOT EXISTS pending_count integer NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS oldest_pending_at timestamptz;
ALTER TABLE items ADD COLUMN IF NOT EXISTS oldest_pending_ts text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS last_client_message_at timestamptz;
ALTER TABLE items ADD COLUMN IF NOT EXISTS last_internal_message_at timestamptz;
ALTER TABLE items ADD COLUMN IF NOT EXISTS preview text;

-- The per-group items are derived data and are rebuilt by the next
-- reconciliation, so they are removed rather than migrated: there is no
-- sensible way to fold several group items into one channel item, and
-- keeping them would leave the unique index below unbuildable.
DELETE FROM items WHERE source = 'slack';
DELETE FROM conversations WHERE global_key LIKE 'slack:%';

ALTER TABLE items DROP COLUMN IF EXISTS slack_group_ts;
CREATE UNIQUE INDEX IF NOT EXISTS items_slack_channel_unique ON items(slack_channel_id) WHERE slack_channel_id IS NOT NULL;
