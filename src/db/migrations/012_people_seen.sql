-- Tracks when a person first appeared in the internal dashboard, so the
-- Settings page can show who is *new* rather than everyone who is not being
-- watched. The full list was 50 people against 19 watched, which is a backlog
-- to ignore rather than a prompt to act on.
CREATE TABLE IF NOT EXISTS internal_people_seen (
  email         citext PRIMARY KEY,
  name          text,
  role          text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  -- Set when an admin has dealt with the row; it then stops being offered.
  dismissed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS internal_people_first_seen_idx ON internal_people_seen(first_seen_at DESC);
