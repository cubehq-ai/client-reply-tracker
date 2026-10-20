import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import type {
  PostResult, SlackChannel, SlackClient, SlackIdentity, SlackMessage, SlackPage, SlackUser,
} from './types.js';

export interface FakeWorkspace {
  identity: SlackIdentity;
  channels: SlackChannel[];
  users: SlackUser[];
  /** channel id -> messages, oldest first. */
  messages: Map<string, SlackMessage[]>;
  /** channel id -> member user ids. */
  members: Map<string, string[]>;
}

/**
 * In-memory Slack. Every test runs against this; no test may reach the network
 * (tests/noExternalCalls.test.ts enforces it).
 */
export class FakeSlackClient implements SlackClient {
  public posted: { channel: string; text: string; threadTs: string | null }[] = [];

  constructor(public workspace: FakeWorkspace = emptyWorkspace()) {}

  async authTest(): Promise<SlackIdentity> {
    return this.workspace.identity;
  }

  async listMemberChannels(): Promise<SlackPage<SlackChannel>> {
    return { items: this.workspace.channels.filter((c) => !c.isArchived), cursor: null };
  }

  async listUsers(): Promise<SlackPage<SlackUser>> {
    return { items: this.workspace.users, cursor: null };
  }

  async listMembers(channel: string): Promise<SlackPage<string>> {
    return { items: this.workspace.members.get(channel) ?? [], cursor: null };
  }

  async history(channel: string, opts: { oldest?: string | null }): Promise<SlackPage<SlackMessage>> {
    const all = this.workspace.messages.get(channel) ?? [];
    // Top-level only, matching Slack: thread replies come from replies().
    const top = all.filter((m) => m.threadTs === null || m.threadTs === m.ts);
    const after = opts.oldest ? top.filter((m) => Number(m.ts) > Number(opts.oldest)) : top;
    // Slack stamps a parent with its reply count, which is how a caller knows
    // a thread is worth re-reading. A fake that omits it lets a sync bug that
    // never fetches replies pass its tests.
    return {
      items: after.map((m) => {
        const replies = all.filter((r) => r.threadTs === m.ts && r.ts !== m.ts);
        if (replies.length === 0) return m;
        return {
          ...m,
          replyCount: replies.length,
          latestReplyTs: replies[replies.length - 1]!.ts,
        };
      }),
      cursor: null,
    };
  }

  async replies(channel: string, threadTs: string): Promise<SlackPage<SlackMessage>> {
    const all = this.workspace.messages.get(channel) ?? [];
    return { items: all.filter((m) => m.threadTs === threadTs || m.ts === threadTs), cursor: null };
  }

  async permalink(channel: string, ts: string): Promise<string | null> {
    return `https://example.slack.com/archives/${channel}/p${ts.replace('.', '')}`;
  }

  async postMessage(channel: string, text: string, threadTs: string | null): Promise<PostResult> {
    this.posted.push({ channel, text, threadTs });
    if (!config.slack.sendEnabled) {
      logger.info({ channel, threadTs }, 'SLACK DRY RUN — not posting (SLACK_SEND_ENABLED=false)');
      return { ts: `dry-run-${this.posted.length}`, channel, dryRun: true };
    }
    const ts = String(Date.now() / 1000);
    const list = this.workspace.messages.get(channel) ?? [];
    list.push(msg({ ts, threadTs, userId: this.workspace.identity.userId, text }));
    this.workspace.messages.set(channel, list);
    return { ts, channel, dryRun: false };
  }
}

export function emptyWorkspace(): FakeWorkspace {
  return {
    identity: { userId: 'U_OWNER', userName: 'replyqueue', teamId: 'T_ORG', teamName: 'CubeHQ', url: 'https://cubehq.slack.com/' },
    channels: [],
    users: [],
    messages: new Map(),
    members: new Map(),
  };
}

/** Builds one message, defaulting everything the tests do not care about. */
export function msg(p: Partial<SlackMessage> & { ts: string }): SlackMessage {
  return {
    ts: p.ts,
    threadTs: p.threadTs ?? null,
    userId: p.userId ?? null,
    text: p.text ?? '',
    subtype: p.subtype ?? null,
    isBot: p.isBot ?? false,
    edited: p.edited ?? false,
    reactions: p.reactions ?? {},
    replyCount: p.replyCount ?? 0,
    latestReplyTs: p.latestReplyTs ?? null,
  };
}
