-- Bcc is stripped from received mail by every mail server, but it survives on
-- our own sent copies, which is exactly where someone needs to see it.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS bcc_emails text[] NOT NULL DEFAULT '{}';
