import { readFileSync } from 'node:fs';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import { config } from '../lib/config.js';

/**
 * Diagnoses Google access end to end and reports what is actually wrong,
 * rather than failing silently into the fake backend.
 *
 * Prints the numeric client ID, which is what a Workspace super admin needs in
 * Admin console -> Security -> API controls -> Domain-wide delegation.
 */

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
];
const DIRECTORY_SCOPES = ['https://www.googleapis.com/auth/admin.directory.user.readonly'];

export interface GoogleCheck {
  keyFile: { found: boolean; path: string; clientEmail?: string; clientId?: string; projectId?: string; error?: string };
  directory: { ok: boolean; users?: number; error?: string };
  gmail: { mailbox: string; ok: boolean; messagesLast48h?: number; error?: string }[];
  verdict: string;
  nextStep: string;
}

function describe(err: any): string {
  const status = err?.response?.status ?? err?.code;
  const data = err?.response?.data;
  const detail = data?.error_description ?? data?.error?.message ?? data?.error ?? err?.message;
  return [status ? `HTTP ${status}` : null, typeof detail === 'string' ? detail : JSON.stringify(detail)]
    .filter(Boolean).join(' — ');
}

export async function checkGoogleAccess(mailboxes: string[] = []): Promise<GoogleCheck> {
  const out: GoogleCheck = {
    keyFile: { found: false, path: config.google.serviceAccountFile },
    directory: { ok: false },
    gmail: [],
    verdict: '',
    nextStep: '',
  };

  if (!config.google.serviceAccountFile) {
    out.keyFile.error = 'GOOGLE_SERVICE_ACCOUNT_FILE is not set';
    out.verdict = 'No service account key configured.';
    out.nextStep = 'Set GOOGLE_SERVICE_ACCOUNT_FILE to the key path and GOOGLE_BACKEND=real.';
    return out;
  }

  let key: { client_email: string; private_key: string; client_id?: string; project_id?: string };
  try {
    key = JSON.parse(readFileSync(config.google.serviceAccountFile, 'utf8'));
    out.keyFile = {
      found: true,
      path: config.google.serviceAccountFile,
      clientEmail: key.client_email,
      clientId: key.client_id,
      projectId: key.project_id,
    };
  } catch (err) {
    out.keyFile.error = describe(err);
    out.verdict = 'The service account key could not be read.';
    out.nextStep = 'Check the path in GOOGLE_SERVICE_ACCOUNT_FILE.';
    return out;
  }

  // Directory API, impersonating the configured admin.
  if (!config.google.adminSubject) {
    out.directory.error = 'GOOGLE_ADMIN_SUBJECT is not set, so there is no admin to impersonate';
  } else {
    try {
      const auth = new JWT({ email: key.client_email, key: key.private_key, scopes: DIRECTORY_SCOPES, subject: config.google.adminSubject });
      const admin = google.admin({ version: 'directory_v1', auth });
      const res = await admin.users.list({ customer: 'my_customer', maxResults: 5 });
      out.directory = { ok: true, users: res.data.users?.length ?? 0 };
    } catch (err) {
      out.directory = { ok: false, error: describe(err) };
    }
  }

  // Gmail, impersonating each mailbox.
  for (const mailbox of mailboxes) {
    try {
      const auth = new JWT({ email: key.client_email, key: key.private_key, scopes: GMAIL_SCOPES, subject: mailbox });
      const gmail = google.gmail({ version: 'v1', auth });
      const res = await gmail.users.messages.list({ userId: 'me', q: '-in:chats -in:spam -in:trash newer_than:2d', maxResults: 10 });
      out.gmail.push({ mailbox, ok: true, messagesLast48h: res.data.resultSizeEstimate ?? res.data.messages?.length ?? 0 });
    } catch (err) {
      out.gmail.push({ mailbox, ok: false, error: describe(err) });
    }
  }

  const anyGmail = out.gmail.some((g) => g.ok);
  if (anyGmail && out.directory.ok) {
    out.verdict = 'Domain-wide delegation is working.';
    out.nextStep = 'Set GOOGLE_BACKEND=real and run: npx tsx src/cli.ts sync';
  } else if (!anyGmail) {
    out.verdict = 'Domain-wide delegation is NOT authorised for this service account.';
    out.nextStep =
      `In Google Workspace Admin console -> Security -> Access and data control -> API controls -> ` +
      `Domain-wide delegation, add client ID ${key.client_id} with scopes: ${[...GMAIL_SCOPES, ...DIRECTORY_SCOPES].join(', ')}`;
  } else {
    out.verdict = 'Gmail works but the Directory API does not.';
    out.nextStep = 'Add the admin.directory.user.readonly scope, and set GOOGLE_ADMIN_SUBJECT to a super admin.';
  }
  return out;
}
