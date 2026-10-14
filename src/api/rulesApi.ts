import { query, tx } from '../db/pool.js';
import { invalidateOrgContext } from '../pipeline/context.js';
import { logger } from '../lib/logger.js';
import { loadOrgContext } from '../pipeline/context.js';
import { recomputeItemState } from '../pipeline/stateMachine.js';
import { compile, evaluateRules, valuesFor, type MatchRule, type RuleField, type RuleOp } from '../pipeline/rules.js';
import { audit } from './actions.js';
import { HttpError, type SessionUser } from './auth.js';

export interface RuleInput {
  name: string;
  field: RuleField;
  headerName?: string | null;
  op: RuleOp;
  pattern: string;
  action: MatchRule['action'];
  clientId?: number | null;
  filterReason?: string | null;
  priorityValue?: 'high' | 'normal' | 'low' | null;
  priority?: number;
  enabled?: boolean;
  note?: string | null;
}

function validate(input: RuleInput): void {
  if (!input.name?.trim()) throw new HttpError(400, 'a rule needs a name');
  if (!input.pattern?.trim()) throw new HttpError(400, 'a rule needs a pattern');
  if (input.action === 'assign_client' && !input.clientId) throw new HttpError(400, 'choose the client to assign');
  if (input.action === 'set_priority' && !input.priorityValue) throw new HttpError(400, 'choose the priority to set');
  if (input.field === 'header' && !input.headerName?.trim()) throw new HttpError(400, 'name the header to match');

  if (input.op === 'regex') {
    try {
      new RegExp(input.pattern, 'i');
    } catch (err) {
      throw new HttpError(400, `not a valid regular expression: ${String(err)}`);
    }
  }
}

export async function createRule(user: SessionUser, input: RuleInput): Promise<{ id: number }> {
  validate(input);
  const rows = await query<{ id: string }>(
    `INSERT INTO match_rules (name, field, header_name, op, pattern, action, client_id,
                              filter_reason, priority_value, priority, enabled, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      input.name.trim(), input.field, input.headerName ?? null, input.op, input.pattern,
      input.action, input.clientId ?? null, input.filterReason ?? null, input.priorityValue ?? null,
      input.priority ?? 100, input.enabled ?? true, input.note ?? null, user.email,
    ],
  );
  invalidateOrgContext();
  await audit(user, 'create_match_rule', null, { name: input.name, action: input.action });
  return { id: Number(rows[0]!.id) };
}

export async function updateRule(user: SessionUser, id: number, patch: Partial<RuleInput>): Promise<void> {
  const existing = await query<any>('SELECT * FROM match_rules WHERE id = $1', [id]);
  if (!existing[0]) throw new HttpError(404, 'rule not found');
  const merged = { ...existing[0], ...patch, name: patch.name ?? existing[0].name, pattern: patch.pattern ?? existing[0].pattern };
  validate(merged as RuleInput);

  await query(
    `UPDATE match_rules SET
       name = COALESCE($2, name), field = COALESCE($3, field), header_name = $4,
       op = COALESCE($5, op), pattern = COALESCE($6, pattern), action = COALESCE($7, action),
       client_id = $8, filter_reason = $9, priority_value = $10,
       priority = COALESCE($11, priority), enabled = COALESCE($12, enabled), note = $13
     WHERE id = $1`,
    [
      id, patch.name ?? null, patch.field ?? null, patch.headerName ?? merged.header_name ?? null,
      patch.op ?? null, patch.pattern ?? null, patch.action ?? null,
      patch.clientId ?? merged.client_id ?? null, patch.filterReason ?? merged.filter_reason ?? null,
      patch.priorityValue ?? merged.priority_value ?? null,
      patch.priority ?? null, patch.enabled ?? null, patch.note ?? merged.note ?? null,
    ],
  );
  invalidateOrgContext();
  await audit(user, 'update_match_rule', null, { id, ...patch });
}

export async function deleteRule(user: SessionUser, id: number): Promise<void> {
  await query('DELETE FROM match_rules WHERE id = $1', [id]);
  invalidateOrgContext();
  await audit(user, 'delete_match_rule', null, { id });
}

export interface RulePreview {
  valid: boolean;
  error?: string;
  matched: number;
  scanned: number;
  samples: { from: string; subject: string; currentState: string; client: string | null }[];
}

/**
 * Runs a candidate rule against stored mail and reports what it would catch.
 *
 * Writing a regex blind against real mail is how you end up silently hiding a
 * client, so a rule can be tried before it is saved.
 */
export async function previewRule(input: RuleInput, limit = 3000): Promise<RulePreview> {
  try {
    validate(input);
  } catch (err) {
    return { valid: false, error: err instanceof HttpError ? err.message : String(err), matched: 0, scanned: 0, samples: [] };
  }

  const rule = compile({
    id: 0, name: input.name || 'preview', enabled: true, priority: 0,
    field: input.field, headerName: input.headerName ?? null, op: input.op, pattern: input.pattern,
    action: input.action, clientId: input.clientId ?? null,
    filterReason: input.filterReason ?? null, priorityValue: input.priorityValue ?? null,
  });
  if (rule.error) return { valid: false, error: rule.error, matched: 0, scanned: 0, samples: [] };

  const rows = await query<any>(
    `SELECT m.from_email, m.from_domain, m.subject, m.body_text_trunc, m.snippet,
            m.to_emails, m.cc_emails, i.state, cl.name AS client_name
       FROM messages m
       LEFT JOIN items i ON i.conversation_id = m.conversation_id
       LEFT JOIN clients cl ON cl.id = i.client_id
      WHERE m.direction = 'in'
      ORDER BY m.internal_date DESC
      LIMIT $1`,
    [limit],
  );

  const samples: RulePreview['samples'] = [];
  let matched = 0;

  for (const r of rows) {
    const values = valuesFor(rule.field, {
      fromEmail: r.from_email ?? '',
      fromDomain: r.from_domain ?? '',
      subject: r.subject ?? '',
      cleanedBody: r.body_text_trunc ?? r.snippet ?? '',
      bodyText: r.body_text_trunc ?? '',
      to: r.to_emails ?? [],
      cc: r.cc_emails ?? [],
      headers: {},
    } as any, rule.headerName);

    if (!values.some((v) => v && rule.test(v))) continue;
    matched += 1;
    if (samples.length < 25) {
      samples.push({
        from: r.from_email,
        subject: (r.subject ?? '').slice(0, 90),
        currentState: r.state ?? 'none',
        client: r.client_name ?? null,
      });
    }
  }

  return { valid: true, matched, scanned: rows.length, samples };
}

export interface ReapplyResult { conversations: number; changed: number }

/**
 * Re-runs the rules over stored mail. Without this a new rule would only
 * affect future messages, which is useless when the backlog is the problem.
 */
export async function reapplyRules(user: SessionUser): Promise<ReapplyResult> {
  const ctx = await loadOrgContext();

  const rows = await query<any>(
    `SELECT m.id, m.conversation_id, m.from_email, m.from_domain, m.subject,
            m.body_text_trunc, m.snippet, m.to_emails, m.cc_emails, m.filter_reason
       FROM messages m WHERE m.direction = 'in'`,
  );

  const touched = new Set<number>();
  let changed = 0;

  for (const r of rows) {
    const msg = {
      fromEmail: r.from_email ?? '',
      fromDomain: r.from_domain ?? '',
      subject: r.subject ?? '',
      cleanedBody: r.body_text_trunc ?? r.snippet ?? '',
      bodyText: r.body_text_trunc ?? '',
      to: r.to_emails ?? [],
      cc: r.cc_emails ?? [],
      headers: {},
    } as any;

    const verdict = evaluateRules(ctx.matchRules, msg);
    if (verdict.matchedRuleIds.length === 0) continue;

    const nextReason = verdict.ignoreReason ?? (verdict.allowed ? null : r.filter_reason);
    if (nextReason !== r.filter_reason) {
      await query('UPDATE messages SET filter_reason = $2 WHERE id = $1', [r.id, nextReason]);
      changed += 1;
    }
    if (verdict.clientId !== null) {
      await query('UPDATE items SET client_id = $2 WHERE conversation_id = $1', [r.conversation_id, verdict.clientId]);
      await query('UPDATE conversations SET client_id = $2 WHERE id = $1', [r.conversation_id, verdict.clientId]);
    }
    if (verdict.priority !== null) {
      await query('UPDATE items SET priority = $2 WHERE conversation_id = $1', [r.conversation_id, verdict.priority]);
    }
    touched.add(Number(r.conversation_id));
  }

  for (const conversationId of touched) {
    await tx((c) => recomputeItemState(c, conversationId));
  }

  await audit(user, 'reapply_match_rules', null, { conversations: touched.size, changed });
  logger.info({ conversations: touched.size, changed }, 'reapplied match rules');
  return { conversations: touched.size, changed };
}
