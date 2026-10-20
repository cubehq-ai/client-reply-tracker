import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import type {
  PostResult, SlackChannel, SlackClient, SlackIdentity, SlackMessage, SlackPage, SlackUser,
} from './types.js';

const API = 'https://slack.com/api';

/** Slack's own shape, kept local so only this file knows it. */
interface SlackEnvelope {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
  [key: string]: unknown;
}

/**
 * Slack Web API over fetch.
 *
 * Two things every call needs: 429 is normal on Slack's tighter tiers and the
 * Retry-After header must be honoured rather than guessed at, and every
 * listing is cursor paginated with a cursor that is opaque and must be passed
 * back verbatim.
 */
export class RealSlackClient implements SlackClient {
  constructor(private readonly token: string = config.slack.userToken) {}

  private async call(method: string, params: Record<string, string | number | undefined> = {}): Promise<SlackEnvelope> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') body.set(k, String(v));
    }

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body,
      });

      if (res.status === 429) {
        // Slack states exactly how long to wait; anything else risks a ban.
        const wait = Number(res.headers.get('retry-after') ?? '1');
        logger.warn({ method, wait }, 'slack rate limited, waiting as instructed');
        await new Promise((r) => setTimeout(r, (Number.isFinite(wait) ? wait : 1) * 1000));
        continue;
      }

      const json = (await res.json()) as SlackEnvelope;
      if (!json.ok) {
        // ratelimited can arrive in the body rather than as a 429.
        if (json.error === 'ratelimited' && attempt < 5) {
          await new Promise((r) => setTimeout(r, attempt * 1000));
          continue;
        }
        throw new Error(`slack ${method} failed: ${json.error ?? 'unknown error'}`);
      }
      return json;
    }
    throw new Error(`slack ${method} failed: still rate limited after 5 attempts`);
  }

  private static cursorOf(env: SlackEnvelope): string | null {
    const next = env.response_metadata?.next_cursor;
    return next && next !== '' ? next : null;
  }

  async authTest(): Promise<SlackIdentity> {
    const r = await this.call('auth.test');
    return {
      userId: String(r.user_id ?? ''),
      userName: String(r.user ?? ''),
      teamId: String(r.team_id ?? ''),
      teamName: String(r.team ?? ''),
      url: String(r.url ?? ''),
    };
  }

  async listMemberChannels(cursor: string | null = null): Promise<SlackPage<SlackChannel>> {
    const r = await this.call('users.conversations', {
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: 200,
      cursor: cursor ?? undefined,
    });
    const items = ((r.channels as any[]) ?? []).map(toChannel);
    return { items, cursor: RealSlackClient.cursorOf(r) };
  }

  async listUsers(cursor: string | null = null): Promise<SlackPage<SlackUser>> {
    const r = await this.call('users.list', { limit: 200, cursor: cursor ?? undefined });
    const items = ((r.members as any[]) ?? []).map(toUser);
    return { items, cursor: RealSlackClient.cursorOf(r) };
  }

  async listMembers(channel: string, cursor: string | null = null): Promise<SlackPage<string>> {
    const r = await this.call('conversations.members', { channel, limit: 200, cursor: cursor ?? undefined });
    return { items: ((r.members as string[]) ?? []).map(String), cursor: RealSlackClient.cursorOf(r) };
  }

  async history(channel: string, opts: { oldest?: string | null; cursor?: string | null }): Promise<SlackPage<SlackMessage>> {
    const r = await this.call('conversations.history', {
      channel,
      limit: 200,
      oldest: opts.oldest ?? undefined,
      // oldest is inclusive by default, which would re-read the last message
      // on every pass and churn its item.
      inclusive: 'false',
      cursor: opts.cursor ?? undefined,
    });
    return { items: ((r.messages as any[]) ?? []).map(toMessage), cursor: RealSlackClient.cursorOf(r) };
  }

  async replies(channel: string, threadTs: string, cursor: string | null = null): Promise<SlackPage<SlackMessage>> {
    const r = await this.call('conversations.replies', {
      channel, ts: threadTs, limit: 200, cursor: cursor ?? undefined,
    });
    return { items: ((r.messages as any[]) ?? []).map(toMessage), cursor: RealSlackClient.cursorOf(r) };
  }

  async permalink(channel: string, ts: string): Promise<string | null> {
    try {
      const r = await this.call('chat.getPermalink', { channel, message_ts: ts });
      return (r.permalink as string) ?? null;
    } catch (err) {
      logger.warn({ channel, ts, err }, 'could not get a slack permalink');
      return null;
    }
  }

  async postMessage(channel: string, text: string, threadTs: string | null): Promise<PostResult> {
    if (!config.slack.sendEnabled) {
      logger.info({ channel, threadTs, text }, 'SLACK DRY RUN — not posting (SLACK_SEND_ENABLED=false)');
      return { ts: `dry-run-${Date.now()}`, channel, dryRun: true };
    }
    const r = await this.call('chat.postMessage', {
      channel, text, thread_ts: threadTs ?? undefined,
    });
    return { ts: String(r.ts ?? ''), channel: String(r.channel ?? channel), dryRun: false };
  }
}

function toChannel(c: any): SlackChannel {
  return {
    id: String(c.id),
    name: String(c.name ?? c.name_normalized ?? c.id),
    isPrivate: Boolean(c.is_private),
    isShared: Boolean(c.is_shared || c.is_ext_shared || c.is_pending_ext_shared),
    isArchived: Boolean(c.is_archived),
  };
}

function toUser(u: any): SlackUser {
  return {
    id: String(u.id),
    teamId: String(u.team_id ?? u.profile?.team ?? ''),
    email: (u.profile?.email as string) || null,
    name: String(u.profile?.real_name || u.real_name || u.name || u.id),
    isBot: Boolean(u.is_bot) || u.id === 'USLACKBOT',
    deleted: Boolean(u.deleted),
  };
}

function toMessage(m: any): SlackMessage {
  const reactions: Record<string, string[]> = {};
  for (const r of (m.reactions as any[]) ?? []) {
    reactions[String(r.name)] = ((r.users as string[]) ?? []).map(String);
  }
  return {
    ts: String(m.ts),
    threadTs: m.thread_ts ? String(m.thread_ts) : null,
    userId: m.user ? String(m.user) : null,
    text: String(m.text ?? ''),
    subtype: m.subtype ? String(m.subtype) : null,
    isBot: Boolean(m.bot_id) || Boolean(m.app_id),
    edited: Boolean(m.edited),
    reactions,
    replyCount: Number(m.reply_count ?? 0),
    latestReplyTs: m.latest_reply ? String(m.latest_reply) : null,
  };
}
