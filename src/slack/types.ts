/**
 * Slack shapes used by the pipeline.
 *
 * Deliberately narrow: only the fields the sync and reply detection need, so
 * the fake can produce them by hand and a change in Slack's payloads touches
 * one file.
 */

export interface SlackIdentity {
  /** The account the token belongs to. Read at startup, never assumed. */
  userId: string;
  userName: string;
  teamId: string;
  teamName: string;
  url: string;
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  /** Slack Connect: the channel is shared with an external workspace. */
  isShared: boolean;
  isArchived: boolean;
}

export interface SlackUser {
  id: string;
  teamId: string;
  email: string | null;
  name: string;
  isBot: boolean;
  deleted: boolean;
}

export interface SlackMessage {
  /** Slack's per-channel message id, and its timestamp. */
  ts: string;
  /** Set when the message belongs to a thread; equals ts on the parent. */
  threadTs: string | null;
  userId: string | null;
  text: string;
  /** channel_join, topic changes and the like, which are not conversation. */
  subtype: string | null;
  /** Posted by an app rather than a person. */
  isBot: boolean;
  edited: boolean;
  /** Reaction name -> user ids that added it. */
  reactions: Record<string, string[]>;
  /** True when the parent of a thread also has replies. */
  replyCount: number;
  latestReplyTs: string | null;
}

export interface SlackPage<T> {
  items: T[];
  /** Opaque cursor; absent when the listing is complete. */
  cursor: string | null;
}

export interface PostResult {
  ts: string;
  channel: string;
  /** True when SLACK_SEND_ENABLED=false and the payload was logged instead. */
  dryRun: boolean;
}

export interface SlackClient {
  /** Who the token belongs to. Nothing may depend on this being a given user. */
  authTest(): Promise<SlackIdentity>;
  /** Channels the token owner is a member of, public and private. */
  listMemberChannels(cursor?: string | null): Promise<SlackPage<SlackChannel>>;
  listUsers(cursor?: string | null): Promise<SlackPage<SlackUser>>;
  /** User ids in a channel. Membership, not authorship: a client who has not
   *  posted yet still identifies whose channel it is. */
  listMembers(channel: string, cursor?: string | null): Promise<SlackPage<string>>;
  /** Top-level channel history, oldest-exclusive. */
  history(channel: string, opts: { oldest?: string | null; cursor?: string | null }): Promise<SlackPage<SlackMessage>>;
  /** Every message in one thread, parent first. */
  replies(channel: string, threadTs: string, cursor?: string | null): Promise<SlackPage<SlackMessage>>;
  permalink(channel: string, ts: string): Promise<string | null>;
  postMessage(channel: string, text: string, threadTs: string | null): Promise<PostResult>;
}
