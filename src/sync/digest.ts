import { query } from '../db/pool.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

export interface DigestLine {
  subject: string;
  clientName: string | null;
  ageHours: number;
  itemId: number;
}

export interface OwnerDigest {
  ownerEmail: string;
  open: DigestLine[];
}

export interface ManagerDigest {
  managerEmail: string;
  byClient: { clientName: string; count: number; oldestHours: number }[];
}

/**
 * Notification sink (SPEC 8). The real implementation would send email or post
 * to Slack; the fake records what would have been sent so digests can be
 * inspected and tested without a provider.
 */
export interface Notifier {
  send(to: string, subject: string, body: string): Promise<void>;
}

export class LoggingNotifier implements Notifier {
  public sent: { to: string; subject: string; body: string }[] = [];
  async send(to: string, subject: string, body: string): Promise<void> {
    this.sent.push({ to, subject, body });
    logger.info({ to, subject }, 'digest (not actually delivered — no notifier configured)');
  }
}

let notifier: Notifier = new LoggingNotifier();
export function setNotifier(n: Notifier): void { notifier = n; }
export function getNotifier(): Notifier { return notifier; }

export async function buildOwnerDigests(): Promise<OwnerDigest[]> {
  const rows = await query<any>(
    `SELECT u.email AS owner_email, i.id, c.subject, cl.name AS client_name,
            i.last_external_at, i.sla_due_at
       FROM items i
       JOIN conversations c ON c.id = i.conversation_id
       JOIN users u ON u.id = i.owner_user_id
       LEFT JOIN clients cl ON cl.id = i.client_id
      WHERE i.state = 'needs_reply' AND u.status = 'active'
      ORDER BY u.email, i.last_external_at ASC`,
  );

  const byOwner = new Map<string, OwnerDigest>();
  for (const r of rows) {
    const entry: OwnerDigest = byOwner.get(r.owner_email) ?? { ownerEmail: r.owner_email, open: [] };
    const line: DigestLine = {
      itemId: Number(r.id),
      subject: r.subject ?? '(no subject)',
      clientName: r.client_name,
      ageHours: r.last_external_at ? Math.round((Date.now() - new Date(r.last_external_at).getTime()) / 3_600_000) : 0,
    };
    entry.open.push(line);
    byOwner.set(r.owner_email, entry);
  }
  return [...byOwner.values()];
}

export async function buildManagerDigests(): Promise<ManagerDigest[]> {
  const rows = await query<any>(
    `SELECT mgr.email AS manager_email, COALESCE(cl.name, '(unmatched)') AS client_name,
            count(*)::int AS cnt,
            MAX(EXTRACT(EPOCH FROM (now() - i.last_external_at)) / 3600)::int AS oldest_hours
       FROM items i
       JOIN users u ON u.id = i.owner_user_id
       JOIN users mgr ON mgr.email = u.manager_email
       LEFT JOIN clients cl ON cl.id = i.client_id
      WHERE i.state = 'needs_reply' AND mgr.status = 'active'
      GROUP BY mgr.email, cl.name
      ORDER BY mgr.email, cnt DESC`,
  );

  const byManager = new Map<string, ManagerDigest>();
  for (const r of rows) {
    const entry: ManagerDigest = byManager.get(r.manager_email) ?? { managerEmail: r.manager_email, byClient: [] };
    entry.byClient.push({ clientName: r.client_name, count: r.cnt, oldestHours: r.oldest_hours });
    byManager.set(r.manager_email, entry);
  }
  return [...byManager.values()];
}

function renderOwnerDigest(d: OwnerDigest): string {
  const lines = [`${d.open.length} item${d.open.length === 1 ? '' : 's'} waiting on a reply, longest first.`, ''];
  for (const l of d.open.slice(0, 25)) {
    lines.push(`  - [${l.clientName ?? 'unmatched'}] ${l.subject} (${l.ageHours}h)`);
  }
  return lines.join('\n');
}

export interface DigestRunResult { owners: number; managers: number; immediate: number }

/** Daily digests to owners and managers (SPEC 8). */
export async function sendDailyDigests(): Promise<DigestRunResult> {
  const [owners, managers] = await Promise.all([buildOwnerDigests(), buildManagerDigests()]);
  const n = getNotifier();

  for (const d of owners) {
    if (d.open.length === 0) continue;
    await n.send(d.ownerEmail, `ReplyQueue: ${d.open.length} waiting on a reply`, renderOwnerDigest(d));
  }
  for (const d of managers) {
    if (d.byClient.length === 0) continue;
    const body = d.byClient.map((c) => `  - ${c.clientName}: ${c.count} waiting, oldest ${c.oldestHours}h`).join('\n');
    await n.send(d.managerEmail, 'ReplyQueue: your team by client', `Waiting on a reply:\n\n${body}`);
  }

  logger.info({ owners: owners.length, managers: managers.length }, 'daily digests built');
  return { owners: owners.length, managers: managers.length, immediate: 0 };
}

/**
 * Immediate alert for high priority or a complaint (SPEC 8). Only fires once
 * per item, tracked through audit_log.
 */
export async function sendImmediateAlerts(): Promise<number> {
  const rows = await query<any>(
    `SELECT i.id, c.subject, cl.name AS client_name, u.email AS owner_email
       FROM items i
       JOIN conversations c ON c.id = i.conversation_id
       LEFT JOIN clients cl ON cl.id = i.client_id
       LEFT JOIN users u ON u.id = i.owner_user_id
      WHERE i.state = 'needs_reply'
        AND i.sla_due_at < now()
        AND NOT EXISTS (
          SELECT 1 FROM audit_log a WHERE a.item_id = i.id AND a.action = 'immediate_alert'
        )`,
  );

  const n = getNotifier();
  for (const r of rows) {
    const to = r.owner_email ?? config.server.devUserEmail;
    await n.send(to, `Overdue: ${r.client_name ?? 'unmatched'} — ${r.subject}`,
      `This has passed its SLA and is still waiting.\n\nClient: ${r.client_name ?? 'unmatched'}\nSubject: ${r.subject}`);
    await query("INSERT INTO audit_log (user_email, action, item_id, payload) VALUES (NULL,'immediate_alert',$1,$2)", [
      r.id, JSON.stringify({ to }),
    ]);
  }
  if (rows.length) logger.info({ count: rows.length }, 'immediate alerts sent');
  return rows.length;
}
