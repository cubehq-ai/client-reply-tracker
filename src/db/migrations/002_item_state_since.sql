-- When the item last changed state. Transitions such as "ignored, then the
-- client wrote again" need to compare an incoming message against the moment
-- the user acted, not against the item's creation time (SPEC 5).
ALTER TABLE items ADD COLUMN IF NOT EXISTS state_since timestamptz NOT NULL DEFAULT now();

-- Which mailbox + thread we should reply into, resolved per sender at send
-- time; cached here so the composer can open without a Gmail round trip.
ALTER TABLE items ADD COLUMN IF NOT EXISTS last_external_message_id text;

-- Set when an item was auto-ignored but a user restored it, so the filter
-- audit can measure how aggressive the rules are (SPEC 14).
ALTER TABLE items ADD COLUMN IF NOT EXISTS restored_from_filter boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS items_state_since_idx ON items(state, state_since DESC);
