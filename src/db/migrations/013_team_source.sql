-- Who decided a mailbox's team.
--
-- The daily dashboard sync was overwriting assignments made by hand here: a
-- mailbox moved into a team that exists only in this tool was silently pulled
-- back to the person's dashboard role the next evening.
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS team_source text NOT NULL DEFAULT 'dashboard'
  CHECK (team_source IN ('dashboard', 'manual'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS team_source text NOT NULL DEFAULT 'dashboard'
  CHECK (team_source IN ('dashboard', 'manual'));
