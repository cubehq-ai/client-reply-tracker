-- Attachments were parsed from Gmail but never stored, so a client sending a
-- document left no trace in the dashboard.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS gmail_attachment_id text;
-- Content-ID, for an image referenced inline by the HTML body as cid:<id>.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS content_id text;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS is_inline boolean NOT NULL DEFAULT false;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS part_id text;

CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments(message_id);
-- One row per part; re-ingesting a message must not duplicate them.
CREATE UNIQUE INDEX IF NOT EXISTS attachments_unique_part
  ON attachments(message_id, COALESCE(part_id, ''), COALESCE(filename, ''));
