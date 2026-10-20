-- A person marking a message answered must outlast the next sync.
--
-- Reconciliation recomputes `pending` from the rules every pass, so a manual
-- "Mark answered" was silently undone minutes later: the rules do not know a
-- human looked at it. Recording who answered it, and when, gives the rules
-- something to defer to.
ALTER TABLE slack_messages ADD COLUMN IF NOT EXISTS answered_at timestamptz;
ALTER TABLE slack_messages ADD COLUMN IF NOT EXISTS answered_by citext;
