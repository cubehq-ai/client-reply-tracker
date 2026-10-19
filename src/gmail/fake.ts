import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { buildFixtureMessages, FIXTURE_USERS } from './fixtures.js';
import type { DirectoryClient, DirectoryUser, GmailClient, HistoryPage, RawMessage, SendResult } from './types.js';

interface MailboxState {
  messages: RawMessage[];
  /** Monotonic counter standing in for Gmail's historyId. */
  historyId: number;
  /** historyId at which each message became visible. */
  addedAt: Map<string, number>;
  deleted: Set<string>;
  watchExpiresMs?: number;
}

/**
 * In-memory Gmail. Used for every test and for local runs without Workspace
 * access. Models the behaviours the pipeline depends on: per-mailbox thread
 * ids, Message-ID dedupe across mailboxes, and an incrementing historyId.
 */
export class FakeGmailClient implements GmailClient {
  private state = new Map<string, MailboxState>();
  /** Messages produced by send(), exposed for assertions. */
  public sent: { mailbox: string; mime: string; threadId?: string }[] = [];
  public drafts: { mailbox: string; mime: string }[] = [];
  public labelWrites: { mailbox: string; threadId: string; add: string | null; remove: string[] }[] = [];

  constructor(seed = buildFixtureMessages()) {
    for (const [mailbox, messages] of seed) {
      const addedAt = new Map<string, number>();
      let h = 100;
      for (const m of [...messages].sort((a, b) => a.internalDateMs - b.internalDateMs)) {
        h += 1;
        addedAt.set(m.id, h);
      }
      this.state.set(mailbox.toLowerCase(), { messages: [...messages], historyId: h, addedAt, deleted: new Set() });
    }
  }

  private mb(mailbox: string): MailboxState {
    const key = mailbox.toLowerCase();
    let s = this.state.get(key);
    if (!s) {
      s = { messages: [], historyId: 100, addedAt: new Map(), deleted: new Set() };
      this.state.set(key, s);
    }
    return s;
  }

  /** Injects a new message, as if it had just arrived. Used by tests. */
  injectMessage(mailbox: string, message: RawMessage): void {
    const s = this.mb(mailbox);
    s.historyId += 1;
    s.addedAt.set(message.id, s.historyId);
    s.messages.unshift(message);
  }

  deleteMessage(mailbox: string, messageId: string): void {
    const s = this.mb(mailbox);
    s.historyId += 1;
    s.deleted.add(messageId);
    s.messages = s.messages.filter((m) => m.id !== messageId);
  }

  async listMessageIds(mailbox: string, q: string, maxResults = 500): Promise<{ id: string; threadId: string }[]> {
    const s = this.mb(mailbox);
    const newerThanDays = /newer_than:(\d+)d/.exec(q)?.[1];
    const cutoff = newerThanDays ? Date.now() - Number(newerThanDays) * 86_400_000 : 0;
    return s.messages
      .filter((m) => {
        // Mirror the backfill query `-in:chats -in:spam -in:trash`.
        if (q.includes('-in:spam') && m.labelIds.includes('SPAM')) return false;
        if (q.includes('-in:trash') && m.labelIds.includes('TRASH')) return false;
        if (q.includes('-in:chats') && m.labelIds.includes('CHAT')) return false;
        return m.internalDateMs >= cutoff;
      })
      .slice(0, maxResults)
      .map((m) => ({ id: m.id, threadId: m.threadId }));
  }

  async getMessage(mailbox: string, id: string, opts?: { withBody?: boolean }): Promise<RawMessage | null> {
    const m = this.mb(mailbox).messages.find((x) => x.id === id);
    if (!m) return null;
    return opts?.withBody ? { ...m } : { ...m, bodyText: undefined };
  }

  async getThreadMessages(mailbox: string, threadId: string): Promise<RawMessage[]> {
    return this.mb(mailbox).messages.filter((m) => m.threadId === threadId).sort((a, b) => a.internalDateMs - b.internalDateMs).map((m) => ({ ...m }));
  }

  async getAttachment(): Promise<Buffer | null> {
    return null;
  }

  async getProfileHistoryId(mailbox: string): Promise<string> {
    return String(this.mb(mailbox).historyId);
  }

  async listHistory(mailbox: string, startHistoryId: string): Promise<HistoryPage> {
    const s = this.mb(mailbox);
    const start = Number(startHistoryId);
    // Gmail drops history older than ~a week; model that as "far behind".
    if (!Number.isFinite(start) || s.historyId - start > 10_000) {
      return { messageIds: [], deletedIds: [], historyId: String(s.historyId), expired: true };
    }
    const added = s.messages.filter((m) => (s.addedAt.get(m.id) ?? 0) > start);
    return {
      messageIds: added.map((m) => ({ id: m.id, threadId: m.threadId })),
      deletedIds: [...s.deleted],
      historyId: String(s.historyId),
      expired: false,
    };
  }

  async send(mailbox: string, rawMime: string, threadId?: string): Promise<SendResult> {
    const rfcMessageId = /^message-id:\s*(.+)$/im.exec(rawMime)?.[1]?.trim() ?? `<fake-${Date.now()}@cubehq.ai>`;
    this.sent.push({ mailbox, mime: rawMime, threadId });
    if (!config.safety.sendEnabled) {
      logger.warn({ mailbox, threadId, bytes: rawMime.length }, 'SEND_ENABLED=false — dry run, message not sent');
      logger.info({ mime: rawMime }, 'dry-run MIME');
      return { id: `dryrun-${this.sent.length}`, threadId: threadId ?? 'dryrun-thread', rfcMessageId, dryRun: true };
    }
    // With sending enabled the fake also materialises the sent copy, so the
    // next sync observes it exactly as Gmail would.
    const s = this.mb(mailbox);
    s.historyId += 1;
    const id = `sent-${s.historyId}`;
    const headers: Record<string, string> = {};
    for (const line of rawMime.split(/\r?\n/)) {
      if (line === '') break;
      const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
      if (m && m[1] && m[2] !== undefined) headers[m[1].toLowerCase()] = m[2];
    }
    const msg: RawMessage = {
      id,
      threadId: threadId ?? `sent-thread-${s.historyId}`,
      labelIds: ['SENT'],
      internalDateMs: Date.now(),
      headers,
      snippet: '',
      bodyText: rawMime.split(/\r?\n\r?\n/).slice(1).join('\n\n').slice(0, 4000),
      attachments: [],
    };
    s.addedAt.set(id, s.historyId);
    s.messages.unshift(msg);
    return { id, threadId: msg.threadId, rfcMessageId, dryRun: false };
  }

  async createDraft(mailbox: string, rawMime: string): Promise<{ id: string }> {
    this.drafts.push({ mailbox, mime: rawMime });
    return { id: `fake-draft-${this.drafts.length}` };
  }

  async watch(mailbox: string, topic: string): Promise<{ historyId: string; expirationMs: number } | null> {
    if (!topic) return null;
    const s = this.mb(mailbox);
    s.watchExpiresMs = Date.now() + 7 * 86_400_000;
    return { historyId: String(s.historyId), expirationMs: s.watchExpiresMs };
  }

  async stopWatch(mailbox: string): Promise<void> {
    this.mb(mailbox).watchExpiresMs = undefined;
  }

  async setThreadLabel(mailbox: string, threadId: string, addLabel: string | null, removeLabels: string[]): Promise<void> {
    if (!config.safety.gmailWriteEnabled) return;
    this.labelWrites.push({ mailbox, threadId, add: addLabel, remove: removeLabels });
  }
}

export class FakeDirectoryClient implements DirectoryClient {
  constructor(private users: DirectoryUser[] = FIXTURE_USERS as DirectoryUser[]) {}
  async listUsers(): Promise<DirectoryUser[]> {
    return this.users.map((u) => ({ ...u }));
  }
}
