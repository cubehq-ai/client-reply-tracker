import 'dotenv/config';
import { config as loadEnv } from 'dotenv';

// Credentials for OTHER systems live in their own file, which Claude's Read
// tool is denied in .claude/settings.json. Node loads it at runtime, so the
// app can connect while the agent never sees the string.
loadEnv({ path: '.env.internal', override: false, quiet: true });

function str(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}
function num(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}
function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}
function list(key: string, fallback: string[] = []): string[] {
  const v = str(key);
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * The database URL, or a clear failure.
 *
 * It used to fall back to localhost, which is right on a laptop and wrong
 * everywhere else: deployed without the variable, the worker dialled
 * 127.0.0.1:5432 and crash-looped on ECONNREFUSED -- a stack trace about a
 * refused connection, when the actual problem was an unset variable.
 */
function requiredDatabaseUrl(): string {
  const url = str('DATABASE_URL');
  if (url) return url;

  // A laptop keeps the old convenience; anything deployed has to say so.
  const local = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
  if (local || (!process.env.NODE_ENV && !process.env.RAILWAY_ENVIRONMENT)) {
    return 'postgres://localhost:5432/client_reply_tracker';
  }
  throw new Error(
    'DATABASE_URL is not set. Set it on this service — on Railway every service has its own variables, '
    + 'so setting it on web does not set it on worker.',
  );
}

export const config = {
  databaseUrl: requiredDatabaseUrl(),

  google: {
    serviceAccountFile: str('GOOGLE_SERVICE_ACCOUNT_FILE'),
    /**
     * The key itself, for places with no filesystem to put it on.
     * A container has no file to point GOOGLE_SERVICE_ACCOUNT_FILE at
     * without a volume or a boot-time write, so the JSON can be pasted
     * into a variable instead. The file wins if both are set.
     */
    serviceAccountJson: str('GOOGLE_SERVICE_ACCOUNT_JSON'),
    adminSubject: str('GOOGLE_ADMIN_SUBJECT'),
    /** "real" only takes effect when a key file is actually configured. */
    backend: str('GOOGLE_BACKEND', 'fake') as 'real' | 'fake',
    /**
     * Scopes to request when impersonating a mailbox. Domain-wide delegation
     * rejects the whole token request if ANY requested scope is not authorised,
     * so this must match the Admin console entry exactly — asking for more is
     * not harmless. gmail.modify already covers reading and drafts.
     */
    gmailScopes: list('GOOGLE_GMAIL_SCOPES', [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
    ]).map((s) => s.trim()),
    directoryScopes: list('GOOGLE_DIRECTORY_SCOPES', [
      'https://www.googleapis.com/auth/admin.directory.user.readonly',
    ]).map((s) => s.trim()),
  },

  org: {
    domains: list('ORG_DOMAINS', ['cubehq.ai']),
    groupAddresses: list('GROUP_ADDRESSES'),
    watchedMailboxes: list('WATCHED_MAILBOXES'),
    excludedMailboxes: list('EXCLUDED_MAILBOXES'),
    excludedLabels: list('EXCLUDED_LABELS').map((s) => s.toUpperCase()),
    backfillDays: num('BACKFILL_DAYS', 30),
    bodyRetentionDays: num('BODY_RETENTION_DAYS', 90),
    /**
     * How long an unanswered client message may sit before it counts as
     * unresponded. Anything newer is still in normal working flow.
     */
    unrespondedAfterHours: num('UNRESPONDED_AFTER_HOURS', 12),
    /**
     * How long a closed item stays on the No reply needed tab. Older ones are
     * hidden, not deleted: the record still backs the classifier feedback and
     * the body purge handles actual retention.
     */
    closedVisibleDays: num('CLOSED_VISIBLE_DAYS', 14),
  },

  sla: {
    defaultHours: num('SLA_DEFAULT_HOURS', 24),
    timezone: str('SLA_TIMEZONE', 'Asia/Kolkata'),
    businessHoursOnly: bool('SLA_BUSINESS_HOURS_ONLY', true),
    startHour: num('SLA_BUSINESS_START_HOUR', 9),
    endHour: num('SLA_BUSINESS_END_HOUR', 18),
  },

  pubsub: {
    topic: str('PUBSUB_TOPIC'),
    verificationToken: str('PUBSUB_VERIFICATION_TOKEN'),
  },

  classifier: {
    apiKey: str('ANTHROPIC_API_KEY'),
    model: str('CLASSIFIER_MODEL', 'claude-haiku-5-5'),
    draftModel: str('DRAFT_MODEL', 'claude-sonnet-5-5'),
    threshold: num('NEEDS_REPLY_CONFIDENCE_THRESHOLD', 0.6),
  },

  clientDbUrl: str('CLIENT_DB_URL'),

  /** Read-only connection to the internal tool's MongoDB (agency dashboard). */
  internalMongo: {
    url: str('INTERNAL_MONGO_URL') || str('MONGO_URL'),
    db: str('INTERNAL_MONGO_DB') || str('DB_NAME'),
  },

  /** Optional read-only Postgres internal tool (unused when Mongo is set). */
  internalDb: {
    url: str('INTERNAL_DB_URL'),
    clientsQuery: str('INTERNAL_DB_CLIENTS_QUERY'),
    employeesQuery: str('INTERNAL_DB_EMPLOYEES_QUERY'),
  },

  /**
   * Slack ingestion. A user token (xoxp), never a bot token: the work is read
   * as the account that sits in the client channels. Which account that is
   * must not matter -- it is read from auth.test at startup and swapped later
   * for a shared one.
   */
  slack: {
    userToken: str('SLACK_USER_TOKEN'),
    sendEnabled: bool('SLACK_SEND_ENABLED', false),
    /** Minutes of quiet before the LLM window runs on a channel. */
    debounceMinutes: num('SLACK_DEBOUNCE_MINUTES', 15),
  },

  safety: {
    sendEnabled: bool('SEND_ENABLED', false),
    gmailWriteEnabled: bool('GMAIL_WRITE_ENABLED', false),
  },

  server: {
    port: num('PORT', 8787),
    logLevel: str('LOG_LEVEL', 'info'),
  },
};

/**
 * Whether the fake Gmail backend seeds demo fixtures. Off by default so a real
 * deployment never shows invented mailboxes or clients; tests opt in.
 */
export function fixturesEnabled(): boolean {
  return bool('FIXTURES_ENABLED', false);
}

/** The fake backend is used unless a key file is present AND backend=real. */
export function useRealGoogle(): boolean {
  return config.google.backend === 'real'
    && (config.google.serviceAccountFile !== '' || config.google.serviceAccountJson !== '');
}

/** Slack is off entirely without a token: no sync, no network, tab shows "Not connected". */
export function slackEnabled(): boolean {
  return config.slack.userToken !== '';
}

export function useRealClassifier(): boolean {
  return config.classifier.apiKey !== '';
}
