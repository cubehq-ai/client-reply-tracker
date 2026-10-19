-- Marks a message as having had its parts read, so the backfill can revisit
-- rows processed before attachments were captured without looping forever.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS messages_attachments_pending
  ON messages(attachments_checked_at) WHERE attachments_checked_at IS NULL;
