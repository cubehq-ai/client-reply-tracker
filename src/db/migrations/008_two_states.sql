-- Collapses the state machine to two states (CLAUDE.md override 1) and adds
-- the prior-contact tables that decide whether non-client mail is worth
-- showing at all (override 2).

-- ---------- items ----------
ALTER TABLE items ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE items ADD COLUMN IF NOT EXISTS low_confidence boolean NOT NULL DEFAULT false;
ALTER TABLE items ADD COLUMN IF NOT EXISTS unmatched_client boolean NOT NULL DEFAULT false;

-- Map the old states onto the new pair before the constraint is tightened.
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_state_check;

UPDATE items SET
  reason = CASE state
             WHEN 'replied'      THEN 'replied'
             WHEN 'fyi'          THEN 'not_needed'
             WHEN 'auto_ignored' THEN 'filtered'
             WHEN 'ignored'      THEN 'ignored'
             WHEN 'archived'     THEN 'filtered'
             ELSE NULL
           END,
  state = CASE state
            -- snoozed, handled_elsewhere and sending no longer exist; anything
            -- that was still open goes back to needing a reply.
            WHEN 'needs_reply'       THEN 'needs_reply'
            WHEN 'snoozed'           THEN 'needs_reply'
            WHEN 'handled_elsewhere' THEN 'needs_reply'
            WHEN 'sending'           THEN 'needs_reply'
            ELSE 'no_reply_needed'
          END;

UPDATE items SET unmatched_client = (client_id IS NULL);
UPDATE items SET low_confidence = true
  WHERE needs_reply_confidence IS NOT NULL AND needs_reply_confidence < 0.6;

ALTER TABLE items ADD CONSTRAINT items_state_check
  CHECK (state IN ('needs_reply', 'no_reply_needed'));
ALTER TABLE items ADD CONSTRAINT items_reason_check
  CHECK (reason IS NULL OR reason IN ('replied', 'not_needed', 'filtered', 'ignored'));
-- A closed item always says why it is closed.
ALTER TABLE items ADD CONSTRAINT items_reason_required
  CHECK (state <> 'no_reply_needed' OR reason IS NOT NULL);

ALTER TABLE items DROP COLUMN IF EXISTS snoozed_until;
ALTER TABLE items DROP COLUMN IF EXISTS awaiting_client;
ALTER TABLE items DROP COLUMN IF EXISTS awaiting_since;
ALTER TABLE items DROP COLUMN IF EXISTS intent;
ALTER TABLE items DROP COLUMN IF EXISTS priority;
ALTER TABLE items DROP COLUMN IF EXISTS sending_since;

DROP INDEX IF EXISTS items_snoozed_idx;
CREATE INDEX IF NOT EXISTS items_state_reason_idx ON items(state, reason);
CREATE INDEX IF NOT EXISTS items_unmatched_idx ON items(unmatched_client) WHERE state = 'needs_reply';

-- ---------- prior contact ----------
-- Whether we have ever written to a domain is the signal that separates a
-- real correspondent from cold outreach, and it is a lookup rather than a
-- model call.
CREATE TABLE IF NOT EXISTS contacted_domains (
  domain               citext PRIMARY KEY,
  first_sent_at        timestamptz NOT NULL,
  last_sent_at         timestamptz NOT NULL,
  is_free_email_domain boolean NOT NULL DEFAULT false,
  send_count           integer NOT NULL DEFAULT 1
);

-- Free providers are too broad to trust at domain level, so those are
-- recorded per address.
CREATE TABLE IF NOT EXISTS contacted_addresses (
  email         citext PRIMARY KEY,
  first_sent_at timestamptz NOT NULL,
  last_sent_at  timestamptz NOT NULL,
  send_count    integer NOT NULL DEFAULT 1
);
