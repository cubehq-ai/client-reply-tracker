import { readFileSync } from 'node:fs';
import { google, type gmail_v1 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { config } from '../lib/config.js';
import { htmlToText } from '../lib/html.js';
import { logger } from '../lib/logger.js';
import type { DirectoryClient, DirectoryUser, GmailClient, HistoryPage, RawMessage, SendResult } from './types.js';

// Requested scopes come from config so they can be matched exactly to what the
// Workspace admin authorised; an unauthorised extra scope fails the whole
// token request, not just that capability.
const GMAIL_SCOPES = config.google.gmailScopes;
const DIRECTORY_SCOPES = config.google.directoryScopes;

interface KeyFile { client_email: string; private_key: string }

let cachedKey: KeyFile | null = null;
function keyFile(): KeyFile {
  if (cachedKey) return cachedKey;
  if (!config.google.serviceAccountFile) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_FILE is not set; cannot use the real Google backend');
  }
  cachedKey = JSON.parse(readFileSync(config.google.serviceAccountFile, 'utf8')) as KeyFile;
  return cachedKey;
}

/** One impersonated JWT per subject. Keys never leave the server (SPEC 11). */
const jwtCache = new Map<string, JWT>();
function authFor(subject: string, scopes: string[]): JWT {
  const cacheKey = `${subject}:${scopes.join(',')}`;
  const hit = jwtCache.get(cacheKey);
  if (hit) return hit;
  const key = keyFile();
  const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes, subject });
  jwtCache.set(cacheKey, jwt);
  return jwt;
}

function gmailFor(mailbox: string): gmail_v1.Gmail {
  return google.gmail({ version: 'v1', auth: authFor(mailbox, GMAIL_SCOPES) });
}

/** Retries 429/5xx with exponential backoff and jitter (SPEC 3.2 quotas). */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const code = err?.code ?? err?.response?.status;
      const retriable = code === 429 || code === 403 || (typeof code === 'number' && code >= 500);
      lastErr = err;
      if (!retriable || i === attempts - 1) throw err;
      const waitMs = Math.min(32_000, 2 ** i * 500) + Math.random() * 400;
      logger.warn({ label, code, waitMs, attempt: i + 1 }, 'gmail call throttled, backing off');
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

function flattenHeaders(headers: gmail_v1.Schema$MessagePartHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    if (!h.name) continue;
    const k = h.name.toLowerCase();
    out[k] = out[k] ? `${out[k]}, ${h.value ?? ''}` : (h.value ?? '');
  }
  return out;
}

function decodeBody(data?: string | null): string {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf8');
}

/** Depth-first walk collecting the plain-text body, calendar parts and attachment metadata. */
function walkParts(part: gmail_v1.Schema$MessagePart | undefined, acc: { text: string[]; html: string[]; calendar: boolean; attachments: RawMessage['attachments'] }): void {
  if (!part) return;
  const mime = part.mimeType ?? '';
  if (mime === 'text/plain') acc.text.push(decodeBody(part.body?.data));
  else if (mime === 'text/html') acc.html.push(decodeBody(part.body?.data));
  else if (mime === 'text/calendar' || mime === 'application/ics') acc.calendar = true;
  // An inline image has no filename in some clients, but always a Content-ID.
  const headers = flattenHeaders(part.headers);
  const contentId = (headers['content-id'] ?? '').replace(/^<|>$/g, '');
  const disposition = headers['content-disposition'] ?? '';
  if (part.filename || contentId) {
    acc.attachments!.push({
      filename: part.filename || contentId || 'attachment',
      mimeType: mime,
      size: part.body?.size ?? 0,
      attachmentId: part.body?.attachmentId ?? undefined,
      contentId: contentId || undefined,
      partId: part.partId ?? undefined,
      isInline: /inline/i.test(disposition) || Boolean(contentId),
    });
  }
  for (const child of part.parts ?? []) walkParts(child, acc);
}

const BODY_LIMIT = 4000; // SPEC 3.3
// HTML is markup-heavy, so it needs far more room than the text part.
const HTML_LIMIT = 200_000;

function toRawMessage(m: gmail_v1.Schema$Message, withBody: boolean): RawMessage {
  const acc = { text: [] as string[], html: [] as string[], calendar: false, attachments: [] as NonNullable<RawMessage['attachments']> };
  if (withBody) walkParts(m.payload, acc);
  const html = acc.html.join('\n').trim();
  const text = acc.text.join('\n').trim() || (withBody ? stripHtml(html) : '');
  return {
    id: m.id!,
    threadId: m.threadId!,
    labelIds: m.labelIds ?? [],
    internalDateMs: Number(m.internalDate ?? 0),
    headers: flattenHeaders(m.payload?.headers),
    snippet: m.snippet ?? '',
    bodyText: withBody ? text.slice(0, BODY_LIMIT) : undefined,
    bodyHtml: withBody && html ? html.slice(0, HTML_LIMIT) : undefined,
    hasCalendarPart: acc.calendar,
    attachments: acc.attachments,
    isDraft: (m.labelIds ?? []).includes('DRAFT'),
  };
}

function stripHtml(html: string): string {
  return htmlToText(html);
}

export class RealGmailClient implements GmailClient {
  async listMessageIds(mailbox: string, q: string, maxResults = 500): Promise<{ id: string; threadId: string }[]> {
    const gmail = gmailFor(mailbox);
    const out: { id: string; threadId: string }[] = [];
    let pageToken: string | undefined;
    do {
      const res = await withRetry('messages.list', () =>
        gmail.users.messages.list({ userId: 'me', q, maxResults: Math.min(500, maxResults - out.length), pageToken }),
      );
      for (const m of res.data.messages ?? []) {
        if (m.id && m.threadId) out.push({ id: m.id, threadId: m.threadId });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken && out.length < maxResults);
    return out;
  }

  async getMessage(mailbox: string, id: string, opts?: { withBody?: boolean }): Promise<RawMessage | null> {
    const gmail = gmailFor(mailbox);
    const withBody = opts?.withBody ?? false;
    try {
      const res = await withRetry('messages.get', () =>
        gmail.users.messages.get({ userId: 'me', id, format: withBody ? 'full' : 'metadata' }),
      );
      return toRawMessage(res.data, withBody);
    } catch (err: any) {
      if (err?.code === 404) return null;
      throw err;
    }
  }

  async getThreadMessages(mailbox: string, threadId: string): Promise<RawMessage[]> {
    const gmail = gmailFor(mailbox);
    try {
      const res = await withRetry('threads.get', () => gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' }));
      return (res.data.messages ?? []).map((m) => toRawMessage(m, true));
    } catch (err: any) {
      if (err?.code === 404) return [];
      throw err;
    }
  }

  async getAttachment(mailbox: string, messageId: string, attachmentId: string): Promise<Buffer | null> {
    const gmail = gmailFor(mailbox);
    try {
      const res = await withRetry('attachments.get', () =>
        gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId }),
      );
      const data = res.data.data;
      return data ? Buffer.from(data, 'base64url') : null;
    } catch (err: any) {
      if (err?.code === 404) return null;
      throw err;
    }
  }

  async getProfileHistoryId(mailbox: string): Promise<string> {
    const gmail = gmailFor(mailbox);
    const res = await withRetry('getProfile', () => gmail.users.getProfile({ userId: 'me' }));
    return String(res.data.historyId ?? '');
  }

  async listHistory(mailbox: string, startHistoryId: string): Promise<HistoryPage> {
    const gmail = gmailFor(mailbox);
    const messageIds = new Map<string, string>();
    const deletedIds = new Set<string>();
    let historyId = startHistoryId;
    let pageToken: string | undefined;
    try {
      do {
        const res = await withRetry('history.list', () =>
          gmail.users.history.list({ userId: 'me', startHistoryId, pageToken, historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'] }),
        );
        for (const h of res.data.history ?? []) {
          for (const a of h.messagesAdded ?? []) if (a.message?.id) messageIds.set(a.message.id, a.message.threadId ?? '');
          for (const a of h.labelsAdded ?? []) if (a.message?.id) messageIds.set(a.message.id, a.message.threadId ?? '');
          for (const a of h.labelsRemoved ?? []) if (a.message?.id) messageIds.set(a.message.id, a.message.threadId ?? '');
          for (const d of h.messagesDeleted ?? []) if (d.message?.id) deletedIds.add(d.message.id);
        }
        if (res.data.historyId) historyId = String(res.data.historyId);
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (err: any) {
      // 404 means the start id aged out of Gmail's history window (SPEC 3.2).
      if (err?.code === 404) return { messageIds: [], deletedIds: [], historyId: startHistoryId, expired: true };
      throw err;
    }
    for (const id of deletedIds) messageIds.delete(id);
    return {
      messageIds: [...messageIds].map(([id, threadId]) => ({ id, threadId })),
      deletedIds: [...deletedIds],
      historyId,
      expired: false,
    };
  }

  async send(mailbox: string, rawMime: string, threadId?: string): Promise<SendResult> {
    const rfcMessageId = extractHeader(rawMime, 'Message-ID');
    if (!config.safety.sendEnabled) {
      logger.warn({ mailbox, threadId, bytes: rawMime.length }, 'SEND_ENABLED=false — dry run, message not sent');
      logger.info({ mime: rawMime }, 'dry-run MIME');
      return { id: `dryrun-${Date.now()}`, threadId: threadId ?? 'dryrun-thread', rfcMessageId, dryRun: true };
    }
    const gmail = gmailFor(mailbox);
    const res = await withRetry('messages.send', () =>
      gmail.users.messages.send({ userId: 'me', requestBody: { raw: Buffer.from(rawMime).toString('base64url'), threadId } }),
    );
    return { id: res.data.id!, threadId: res.data.threadId!, rfcMessageId, dryRun: false };
  }

  async createDraft(mailbox: string, rawMime: string, threadId?: string): Promise<{ id: string }> {
    if (!config.safety.sendEnabled) {
      logger.warn({ mailbox }, 'SEND_ENABLED=false — draft not created');
      return { id: `dryrun-draft-${Date.now()}` };
    }
    const gmail = gmailFor(mailbox);
    const res = await withRetry('drafts.create', () =>
      gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: Buffer.from(rawMime).toString('base64url'), threadId } } }),
    );
    return { id: res.data.id! };
  }

  async watch(mailbox: string, topic: string): Promise<{ historyId: string; expirationMs: number } | null> {
    if (!topic) return null;
    const gmail = gmailFor(mailbox);
    const res = await withRetry('users.watch', () =>
      gmail.users.watch({ userId: 'me', requestBody: { topicName: topic, labelFilterBehavior: 'INCLUDE' } }),
    );
    return { historyId: String(res.data.historyId ?? ''), expirationMs: Number(res.data.expiration ?? 0) };
  }

  async stopWatch(mailbox: string): Promise<void> {
    const gmail = gmailFor(mailbox);
    await withRetry('users.stop', () => gmail.users.stop({ userId: 'me' }));
  }

  async setThreadLabel(mailbox: string, threadId: string, addLabel: string | null, removeLabels: string[]): Promise<void> {
    if (!config.safety.gmailWriteEnabled) {
      logger.debug({ mailbox, threadId, addLabel }, 'GMAIL_WRITE_ENABLED=false — label write skipped');
      return;
    }
    const gmail = gmailFor(mailbox);
    const labelIds = await ensureLabels(gmail, [addLabel, ...removeLabels].filter(Boolean) as string[]);
    await withRetry('threads.modify', () =>
      gmail.users.threads.modify({
        userId: 'me',
        id: threadId,
        requestBody: {
          addLabelIds: addLabel ? [labelIds[addLabel]!] : [],
          removeLabelIds: removeLabels.map((l) => labelIds[l]).filter(Boolean) as string[],
        },
      }),
    );
  }
}

/** Creates any tracker labels that do not exist yet, returning name -> id. */
async function ensureLabels(gmail: gmail_v1.Gmail, names: string[]): Promise<Record<string, string>> {
  const res = await withRetry('labels.list', () => gmail.users.labels.list({ userId: 'me' }));
  const byName: Record<string, string> = {};
  for (const l of res.data.labels ?? []) if (l.name && l.id) byName[l.name] = l.id;
  for (const name of names) {
    if (byName[name]) continue;
    const created = await withRetry('labels.create', () =>
      gmail.users.labels.create({ userId: 'me', requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } }),
    );
    if (created.data.id) byName[name] = created.data.id;
  }
  return byName;
}

function extractHeader(mime: string, name: string): string {
  const re = new RegExp(`^${name}:\\s*(.+)$`, 'im');
  const m = mime.match(re);
  return m?.[1]?.trim() ?? '';
}

export class RealDirectoryClient implements DirectoryClient {
  async listUsers(): Promise<DirectoryUser[]> {
    if (!config.google.adminSubject) {
      throw new Error('GOOGLE_ADMIN_SUBJECT is required for Directory API access');
    }
    const admin = google.admin({ version: 'directory_v1', auth: authFor(config.google.adminSubject, DIRECTORY_SCOPES) });
    const out: DirectoryUser[] = [];
    let pageToken: string | undefined;
    do {
      const res = await withRetry('users.list', () =>
        admin.users.list({ customer: 'my_customer', maxResults: 500, pageToken, projection: 'full' }),
      );
      for (const u of res.data.users ?? []) {
        if (!u.primaryEmail) continue;
        const relations = (u.relations ?? []) as { type?: string; value?: string }[];
        out.push({
          email: u.primaryEmail.toLowerCase(),
          name: u.name?.fullName ?? u.primaryEmail,
          suspended: Boolean(u.suspended),
          archived: Boolean(u.archived),
          managerEmail: relations.find((r) => r.type === 'manager')?.value?.toLowerCase(),
          isAdmin: Boolean(u.isAdmin),
        });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }
}
