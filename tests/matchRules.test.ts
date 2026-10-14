import { describe, expect, it } from 'vitest';
import { compile, evaluateRules, valuesFor, type MatchRule } from '../src/pipeline/rules.js';

function rule(over: Partial<MatchRule>): MatchRule {
  return {
    id: 1, name: 'r', enabled: true, priority: 100,
    field: 'from_domain', headerName: null, op: 'regex', pattern: '.*',
    action: 'ignore', clientId: null, filterReason: null, priorityValue: null,
    ...over,
  };
}

const msg = {
  fromEmail: 'daryl@norbot.ca',
  fromDomain: 'norbot.ca',
  subject: 'NorBot Site kickoff',
  cleanedBody: 'Can we start Monday?',
  bodyText: 'Can we start Monday?',
  to: ['sahana.k@cubehq.ai'],
  cc: ['garima@cubehq.ai'],
  headers: { 'list-id': '<news.figma.com>' },
};

describe('operators', () => {
  it('matches a regex case-insensitively', () => {
    expect(compile(rule({ pattern: '^norbot\\.ca$' })).test('NORBOT.CA')).toBe(true);
  });

  it('treats contains, equals and ends_with literally', () => {
    expect(compile(rule({ op: 'contains', pattern: 'norbot' })).test('mail.norbot.ca')).toBe(true);
    expect(compile(rule({ op: 'equals', pattern: 'norbot.ca' })).test('mail.norbot.ca')).toBe(false);
    expect(compile(rule({ op: 'ends_with', pattern: '.figma.com' })).test('news.figma.com')).toBe(true);
    // A dot in ends_with is literal, not a wildcard.
    expect(compile(rule({ op: 'ends_with', pattern: '.figma.com' })).test('newsXfigma.com')).toBe(false);
  });

  it('reports a bad regex instead of throwing', () => {
    const c = compile(rule({ pattern: '([unclosed' }));
    expect(c.error).toBeTruthy();
    expect(c.test('anything')).toBe(false);
  });
});

describe('fields', () => {
  it('reads each field from the message', () => {
    expect(valuesFor('from_email', msg)).toEqual(['daryl@norbot.ca']);
    expect(valuesFor('from_domain', msg)).toEqual(['norbot.ca']);
    expect(valuesFor('subject', msg)).toEqual(['NorBot Site kickoff']);
    expect(valuesFor('any_recipient', msg)).toEqual(['sahana.k@cubehq.ai', 'garima@cubehq.ai']);
    expect(valuesFor('header', msg, 'List-Id')).toEqual(['<news.figma.com>']);
  });
});

describe('evaluation', () => {
  it('assigns a client', () => {
    const v = evaluateRules([compile(rule({ action: 'assign_client', clientId: 7, pattern: 'norbot\\.ca' }))], msg);
    expect(v.clientId).toBe(7);
  });

  it('filters on an ignore rule, with the rule name as the reason', () => {
    const v = evaluateRules([compile(rule({ name: 'noise', pattern: 'norbot' }))], msg);
    expect(v.ignoreReason).toBe('rule:noise');
  });

  it('lets allow beat ignore regardless of order', () => {
    const ignoreFirst = evaluateRules([
      compile(rule({ id: 1, priority: 1, action: 'ignore', pattern: '.*' })),
      compile(rule({ id: 2, priority: 2, action: 'allow', pattern: 'norbot' })),
    ], msg);
    const allowFirst = evaluateRules([
      compile(rule({ id: 1, priority: 1, action: 'allow', pattern: 'norbot' })),
      compile(rule({ id: 2, priority: 2, action: 'ignore', pattern: '.*' })),
    ], msg);
    expect(ignoreFirst.ignoreReason).toBeNull();
    expect(allowFirst.ignoreReason).toBeNull();
  });

  it('keeps the first client when two rules both assign one', () => {
    const v = evaluateRules([
      compile(rule({ id: 1, action: 'assign_client', clientId: 7, pattern: 'norbot' })),
      compile(rule({ id: 2, action: 'assign_client', clientId: 9, pattern: 'norbot' })),
    ], msg);
    expect(v.clientId).toBe(7);
  });

  it('sets priority', () => {
    const v = evaluateRules([compile(rule({ field: 'subject', action: 'set_priority', priorityValue: 'high', pattern: 'kickoff' }))], msg);
    expect(v.priority).toBe('high');
  });

  it('skips disabled rules and rules that do not compile', () => {
    expect(evaluateRules([compile(rule({ enabled: false, pattern: '.*' }))], msg).ignoreReason).toBeNull();
    expect(evaluateRules([compile(rule({ pattern: '([bad' }))], msg).ignoreReason).toBeNull();
  });

  it('does nothing when nothing matches', () => {
    const v = evaluateRules([compile(rule({ pattern: '^example\\.com$' }))], msg);
    expect(v).toMatchObject({ clientId: null, ignoreReason: null, allowed: false, matchedRuleIds: [] });
  });
});
