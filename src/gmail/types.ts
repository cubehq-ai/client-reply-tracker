/** Provider-agnostic shapes used by the pipeline. Nothing below is Gmail-specific
 *  except the field names we borrow, so a Slack source can implement the same
 *  pipeline input later (SPEC 1). */

export interface RawMessage {
  /** Gmail message id, unique per mailbox. */
  id: string;
  /** Gmail thread id, unique per mailbox (SPEC 2). */
  threadId: string;
  labelIds: string[];
  /** Gmail internalDate in ms. Authoritative ordering source (SPEC 12). */
  internalDateMs: number;
  /** Header name (lowercased) -> value. Repeated headers are joined with ", ". */
  headers: Record<string, string>;
  snippet: string;
  /** Truncated plain-text body, when fetched. */
  bodyText?: string;
  /** Raw HTML part, when present. Rendered in preference to the text one. */
  bodyHtml?: string;
  /** True when a text/calendar part is present (SPEC 4 step 3). */
  hasCalendarPart?: boolean;
  attachments?: {
    filename: string;
    mimeType: string;
    size: number;
    /** Gmail's handle for fetching the bytes; absent for tiny inline parts. */
    attachmentId?: string;
    /** Content-ID, when the HTML body references it as cid:<id>. */
    contentId?: string;
    partId?: string;
    isInline?: boolean;
  }[];
  /** Gmail marks drafts with the DRAFT label; drafts never count as replies. */
  isDraft?: boolean;
}

export interface HistoryPage {
  /** Messages added or label-changed since the given historyId. */
  messageIds: { id: string; threadId: string }[];
  /** Messages removed from the mailbox. */
  deletedIds: string[];
  historyId: string;
  /** True when Gmail rejected the start id as too old (404) and a resync is needed. */
  expired: boolean;
}

export interface SendResult {
  id: string;
  threadId: string;
  rfcMessageId: string;
  /** True when SEND_ENABLED=false and the MIME was logged instead of sent. */
  dryRun: boolean;
}

export interface GmailClient {
  /** Message ids matching a Gmail search query, newest first. */
  listMessageIds(mailbox: string, q: string, maxResults?: number): Promise<{ id: string; threadId: string }[]>;
  getMessage(mailbox: string, id: string, opts?: { withBody?: boolean }): Promise<RawMessage | null>;
  getThreadMessages(mailbox: string, threadId: string): Promise<RawMessage[]>;
  /** Raw bytes of one attachment part. */
  getAttachment(mailbox: string, messageId: string, attachmentId: string): Promise<Buffer | null>;
  /** Current historyId for the mailbox, used to anchor the first sync. */
  getProfileHistoryId(mailbox: string): Promise<string>;
  listHistory(mailbox: string, startHistoryId: string): Promise<HistoryPage>;
  send(mailbox: string, rawMime: string, threadId?: string): Promise<SendResult>;
  createDraft(mailbox: string, rawMime: string, threadId?: string): Promise<{ id: string }>;
  /** Registers a push watch; no-op when Pub/Sub is not configured. */
  watch(mailbox: string, topic: string): Promise<{ historyId: string; expirationMs: number } | null>;
  stopWatch(mailbox: string): Promise<void>;
  /** Writes a tracker label back onto the thread. Gated by GMAIL_WRITE_ENABLED. */
  setThreadLabel(mailbox: string, threadId: string, addLabel: string | null, removeLabels: string[]): Promise<void>;
}

export interface DirectoryUser {
  email: string;
  name: string;
  suspended: boolean;
  archived?: boolean;
  managerEmail?: string;
  isAdmin?: boolean;
}

export interface DirectoryClient {
  listUsers(): Promise<DirectoryUser[]>;
}
