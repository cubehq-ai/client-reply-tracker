import { describe, expect, it } from 'vitest';
import {
  cleanBody, domainOf, fallbackConversationKey, normalizeSubject,
  parseAddress, parseAddressList, parseReferences, threadIdentifiers,
} from '../src/pipeline/normalize.js';
import type { NormalizedMessage } from '../src/pipeline/normalize.js';

describe('address parsing', () => {
  it('pulls the address out of a display-name form', () => {
    expect(parseAddress('"Nair, Priya" <priya@cubehq.ai>')).toBe('priya@cubehq.ai');
    expect(parseAddress('ops@acme.com')).toBe('ops@acme.com');
    expect(parseAddress('OPS@ACME.COM')).toBe('ops@acme.com');
  });

  it('splits a list without breaking on commas inside display names', () => {
    const list = parseAddressList('"Nair, Priya" <priya@cubehq.ai>, ops@acme.com');
    expect(list).toEqual(['priya@cubehq.ai', 'ops@acme.com']);
  });

  it('returns nothing for an empty or malformed header', () => {
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddress('not an address')).toBe('');
  });

  it('reads the domain, including subdomains', () => {
    expect(domainOf('dana@mail.globex.co')).toBe('mail.globex.co');
  });
});

describe('subject normalization', () => {
  it('strips stacked reply and forward prefixes', () => {
    expect(normalizeSubject('Re: Fwd: RE: Q3 invoice')).toBe('q3 invoice');
    expect(normalizeSubject('Re[2]: Budget')).toBe('budget');
  });
});

describe('references parsing', () => {
  it('splits a chain into individual ids', () => {
    expect(parseReferences('<a@x> <b@y>\n <c@z>')).toEqual(['<a@x>', '<b@y>', '<c@z>']);
  });
});

describe('body cleaning', () => {
  it('drops quoted history and the signature', () => {
    const body = [
      'Can you confirm the invoice?',
      '',
      'On Mon, Oct 6, 2026 at 9:02 AM Priya <priya@cubehq.ai> wrote:',
      '> Here is the invoice',
      '--',
      'Dana, Globex',
    ].join('\n');
    expect(cleanBody(body)).toBe('Can you confirm the invoice?');
  });

  it('leaves a plain message untouched', () => {
    expect(cleanBody('Thanks!')).toBe('Thanks!');
  });
});

describe('thread identity', () => {
  const msg = {
    rfcMessageId: '<c@z>',
    inReplyTo: '<b@y>',
    references: ['<a@x>', '<b@y>'],
    fromEmail: 'ops@acme.com',
    to: ['priya@cubehq.ai'],
    cc: [],
    normalizedSubject: 'q3 invoice',
  } as unknown as NormalizedMessage;

  it('collects every id the message belongs to, without duplicates', () => {
    expect(threadIdentifiers(msg).sort()).toEqual(['<a@x>', '<b@y>', '<c@z>']);
  });

  it('keys the fallback on subject plus external participants only', () => {
    const key = fallbackConversationKey(msg, new Set(['cubehq.ai']));
    expect(key).toBe('subj:q3 invoice|ext:ops@acme.com');
  });
});
