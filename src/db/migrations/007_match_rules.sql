-- A general matching rule engine.
--
-- Until now the only tools were a per-client domain list and a per-client
-- regex. Neither can express "anything from *.figma.com is noise" or "this
-- one shared domain belongs to that client", which is what the unmatched
-- queue is actually full of.
CREATE TABLE IF NOT EXISTS match_rules (
  id             bigserial PRIMARY KEY,
  name           text NOT NULL,
  enabled        boolean NOT NULL DEFAULT true,
  -- Lower runs first.
  priority       integer NOT NULL DEFAULT 100,

  -- What to look at.
  field          text NOT NULL CHECK (field IN
                   ('from_email','from_domain','subject','body','to_email','any_recipient','header')),
  header_name    text,

  -- How to compare. `regex` is POSIX, case-insensitive.
  op             text NOT NULL DEFAULT 'regex' CHECK (op IN ('regex','contains','equals','ends_with')),
  pattern        text NOT NULL,

  -- What to do when it matches.
  action         text NOT NULL CHECK (action IN ('assign_client','ignore','allow','set_priority')),
  client_id      bigint REFERENCES clients(id) ON DELETE CASCADE,
  filter_reason  text,
  priority_value text CHECK (priority_value IN ('high','normal','low')),

  note           text,
  created_by     citext,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Cheap observability: a rule that never fires is usually wrong.
  match_count    bigint NOT NULL DEFAULT 0,
  last_matched_at timestamptz,

  -- An action must carry what it needs to act.
  CHECK (action <> 'assign_client' OR client_id IS NOT NULL),
  CHECK (action <> 'set_priority' OR priority_value IS NOT NULL),
  CHECK (field <> 'header' OR header_name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS match_rules_order_idx ON match_rules(enabled, priority, id);
