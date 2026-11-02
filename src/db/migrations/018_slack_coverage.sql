-- Slack coverage, membership counts and retention bookkeeping.
--
-- Three things the first cut got wrong against the real workspace:
--
-- 1. Channels were discovered with users.conversations, which lists only the
--    channels the token owner has joined -- four of them. Every client channel
--    (#balancegrille-cube, #reviews-california, ...) is a public channel the
--    owner had not joined, and a user token with channels:history can read
--    those without joining. Discovery now reads the workspace, so swapping the
--    token changes nothing about what is covered.
-- 2. Watching was gated on a client mapping. Only 2 of 48 channels map through
--    client_domains, because the dashboard has no domain rows for most of the
--    Slack-only accounts, so gating on it hid every real conversation. A
--    channel with an external human in it is a client conversation whether or
--    not we can name the client; the item carries unmatched_client instead.
-- 3. Nothing ever deleted a Slack message. #connector-statuses alone is 16k
--    messages in 30 days.

ALTER TABLE slack_channels ADD COLUMN IF NOT EXISTS member_count integer NOT NULL DEFAULT 0;
-- External humans in the channel: the signal that it is a client conversation.
ALTER TABLE slack_channels ADD COLUMN IF NOT EXISTS external_member_count integer NOT NULL DEFAULT 0;
-- 'auto' watch decisions are revisited by the channel sync; once a person
-- toggles watched in Settings the choice is theirs and sync leaves it alone.
ALTER TABLE slack_channels ADD COLUMN IF NOT EXISTS watch_source text NOT NULL DEFAULT 'auto'
  CHECK (watch_source IN ('auto','manual'));
-- How the client mapping was arrived at, for the Settings list: a name match
-- is a weaker claim than an email-domain match and should read as one.
ALTER TABLE slack_channels ADD COLUMN IF NOT EXISTS mapping_basis text;
ALTER TABLE slack_channels ADD COLUMN IF NOT EXISTS purged_through_ts text;
ALTER TABLE slack_channels ADD COLUMN IF NOT EXISTS messages_purged integer NOT NULL DEFAULT 0;

-- The retention sweep deletes by (channel, ts) and always keeps everything at
-- or after the oldest pending message, so it needs that ordering cheaply.
CREATE INDEX IF NOT EXISTS slack_messages_purge_idx ON slack_messages(channel_id, posted_at);

-- A channel watched by hand before this migration keeps that decision.
UPDATE slack_channels SET watch_source = 'manual' WHERE watched;
