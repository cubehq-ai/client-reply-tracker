import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import type { NormalizedMessage } from './normalize.js';

export type RuleField = 'from_email' | 'from_domain' | 'subject' | 'body' | 'to_email' | 'any_recipient' | 'header';
export type RuleOp = 'regex' | 'contains' | 'equals' | 'ends_with';
export type RuleAction = 'assign_client' | 'ignore' | 'allow' | 'set_priority';

export interface MatchRule {
  id: number;
  name: string;
  enabled: boolean;
  priority: number;
  field: RuleField;
  headerName: string | null;
  op: RuleOp;
  pattern: string;
  action: RuleAction;
  clientId: number | null;
  filterReason: string | null;
  priorityValue: 'high' | 'normal' | 'low' | null;
}

export interface CompiledRule extends MatchRule {
  test: (value: string) => boolean;
  /** Set when the pattern would not compile; the rule is then skipped. */
  error?: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Turns an operator plus pattern into a predicate. */
export function compile(rule: MatchRule): CompiledRule {
  try {
    switch (rule.op) {
      case 'regex': {
        const re = new RegExp(rule.pattern, 'i');
        return { ...rule, test: (v) => re.test(v) };
      }
      case 'contains': {
        const needle = rule.pattern.toLowerCase();
        return { ...rule, test: (v) => v.toLowerCase().includes(needle) };
      }
      case 'equals': {
        const needle = rule.pattern.toLowerCase();
        return { ...rule, test: (v) => v.toLowerCase() === needle };
      }
      case 'ends_with': {
        const re = new RegExp(`${escapeRegex(rule.pattern.toLowerCase())}$`, 'i');
        return { ...rule, test: (v) => re.test(v) };
      }
      default:
        return { ...rule, test: () => false, error: `unknown operator ${rule.op}` };
    }
  } catch (err) {
    return { ...rule, test: () => false, error: String(err) };
  }
}

/** The values a rule's field can look at. A field may yield several. */
export function valuesFor(field: RuleField, msg: Pick<NormalizedMessage, 'fromEmail' | 'fromDomain' | 'subject' | 'cleanedBody' | 'bodyText' | 'to' | 'cc' | 'headers'>, headerName?: string | null): string[] {
  switch (field) {
    case 'from_email': return [msg.fromEmail];
    case 'from_domain': return [msg.fromDomain];
    case 'subject': return [msg.subject ?? ''];
    case 'body': return [msg.cleanedBody || msg.bodyText || ''];
    case 'to_email': return msg.to;
    case 'any_recipient': return [...msg.to, ...msg.cc];
    case 'header': return [msg.headers[(headerName ?? '').toLowerCase()] ?? ''];
    default: return [];
  }
}

export interface RuleVerdict {
  /** Client assigned by the first matching assign_client rule. */
  clientId: number | null;
  /** Set when an ignore rule matched and no allow rule overrode it. */
  ignoreReason: string | null;
  /** True when an allow rule matched; the standard filters are then skipped. */
  allowed: boolean;
  priority: 'high' | 'normal' | 'low' | null;
  matchedRuleIds: number[];
}

/**
 * Evaluates rules in priority order.
 *
 * `allow` wins over `ignore` whatever the order, so a rule can rescue one
 * sender from a broad ignore without having to reorder anything.
 */
export function evaluateRules(rules: CompiledRule[], msg: Parameters<typeof valuesFor>[1]): RuleVerdict {
  const verdict: RuleVerdict = { clientId: null, ignoreReason: null, allowed: false, priority: null, matchedRuleIds: [] };

  for (const rule of rules) {
    if (!rule.enabled || rule.error) continue;
    const values = valuesFor(rule.field, msg, rule.headerName);
    if (!values.some((v) => v && rule.test(v))) continue;

    verdict.matchedRuleIds.push(rule.id);
    switch (rule.action) {
      case 'assign_client':
        if (verdict.clientId === null) verdict.clientId = rule.clientId;
        break;
      case 'ignore':
        if (verdict.ignoreReason === null) verdict.ignoreReason = rule.filterReason || `rule:${rule.name}`;
        break;
      case 'allow':
        verdict.allowed = true;
        break;
      case 'set_priority':
        if (verdict.priority === null) verdict.priority = rule.priorityValue;
        break;
    }
  }

  if (verdict.allowed) verdict.ignoreReason = null;
  return verdict;
}

function toRule(r: any): MatchRule {
  return {
    id: Number(r.id),
    name: r.name,
    enabled: r.enabled,
    priority: r.priority,
    field: r.field,
    headerName: r.header_name,
    op: r.op,
    pattern: r.pattern,
    action: r.action,
    clientId: r.client_id === null ? null : Number(r.client_id),
    filterReason: r.filter_reason,
    priorityValue: r.priority_value,
  };
}

export async function loadMatchRules(): Promise<CompiledRule[]> {
  const rows = await query<any>(
    'SELECT * FROM match_rules WHERE enabled = true ORDER BY priority ASC, id ASC',
  );
  const compiled = rows.map((r) => compile(toRule(r)));
  for (const rule of compiled) {
    if (rule.error) logger.warn({ rule: rule.name, error: rule.error }, 'skipping a rule that does not compile');
  }
  return compiled;
}

export async function listMatchRules(): Promise<any[]> {
  return query(
    `SELECT r.*, c.name AS client_name
       FROM match_rules r LEFT JOIN clients c ON c.id = r.client_id
      ORDER BY r.priority ASC, r.id ASC`,
  );
}

/** Records that rules fired, so a dead rule is visible as such. */
export async function recordRuleMatches(ruleIds: number[]): Promise<void> {
  if (ruleIds.length === 0) return;
  await query(
    'UPDATE match_rules SET match_count = match_count + 1, last_matched_at = now() WHERE id = ANY($1::bigint[])',
    [ruleIds],
  );
}
