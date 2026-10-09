-- Which external message the user was looking at when they ignored, snoozed or
-- marked an item handled. "Has the client written since?" compares against this
-- rather than against a wall-clock state_since: the two timestamps come from
-- different clocks (Postgres now() vs the Gmail internalDate), so the old
-- comparison could miss a message that arrived in the same millisecond.
ALTER TABLE items ADD COLUMN IF NOT EXISTS acted_on_external_at timestamptz;
