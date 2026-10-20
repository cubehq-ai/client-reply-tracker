-- Who a Slack item is addressed to.
--
-- owner_user_id points at `users`, which holds people with a ReplyQueue
-- account -- 26 of the 113 internal people in the workspace. The person a
-- client addresses in a channel is usually one of the other 87, so insisting
-- on a users row left every Slack row reading "owner: unowned". The Slack
-- identity is the honest answer: it names who is being asked, whether or not
-- they ever log in here.
ALTER TABLE items ADD COLUMN IF NOT EXISTS slack_owner_id text REFERENCES slack_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS items_slack_owner_idx ON items(slack_owner_id);
