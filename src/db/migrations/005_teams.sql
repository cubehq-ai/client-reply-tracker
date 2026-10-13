-- Teams, so mailboxes and items can be rolled up by the group that owns them.
CREATE TABLE IF NOT EXISTS teams (
  id         bigserial PRIMARY KEY,
  name       text UNIQUE NOT NULL,
  slug       text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id bigint REFERENCES teams(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS users_team_idx ON users(team_id);

-- Mailboxes are managed from Settings now, not only from an env allowlist.
-- `managed` marks a row a human added or edited, so Directory discovery does
-- not silently revert it.
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS team_id bigint REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS managed boolean NOT NULL DEFAULT false;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS added_by citext;
CREATE INDEX IF NOT EXISTS mailboxes_team_idx ON mailboxes(team_id);

-- Deterministic client matching for the awkward cases a plain domain lookup
-- cannot express, e.g. one domain shared by several clients distinguished by
-- the local part. Evaluated in priority order, lowest first. No model involved.
CREATE TABLE IF NOT EXISTS client_patterns (
  id         bigserial PRIMARY KEY,
  client_id  bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- POSIX regex matched against the full lowercased sender address.
  pattern    text NOT NULL,
  priority   integer NOT NULL DEFAULT 100,
  note       text,
  created_by citext,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, pattern)
);
CREATE INDEX IF NOT EXISTS client_patterns_priority_idx ON client_patterns(priority);

-- Saved views: a pinned set of inbox filters, per user or shared org-wide.
CREATE TABLE IF NOT EXISTS saved_views (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL,
  owner_email citext,
  shared     boolean NOT NULL DEFAULT false,
  filters    jsonb NOT NULL DEFAULT '{}',
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_email, name)
);
