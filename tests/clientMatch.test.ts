import { describe, expect, it } from 'vitest';
import { matchClient, type ClientIndex } from '../src/pipeline/clientMatch.js';

const index: ClientIndex = {
  byDomain: new Map([['acme.com', 1], ['globex.co', 3]]),
  byEmail: new Map([['zenith.founder@gmail.com', 4]]),
  freeDomains: new Set(['gmail.com', 'outlook.com']),
};

describe('client matching', () => {
  it('matches an exact sender domain', () => {
    expect(matchClient(index, 'ops@acme.com')).toMatchObject({ clientId: 1, matchedOn: 'domain' });
  });

  it('matches a subdomain to its parent', () => {
    expect(matchClient(index, 'dana@mail.globex.co')).toMatchObject({ clientId: 3, matchedOn: 'subdomain' });
  });

  it('matches a personal address through the contact override', () => {
    expect(matchClient(index, 'zenith.founder@gmail.com')).toMatchObject({ clientId: 4, matchedOn: 'email' });
  });

  it('never matches a free provider domain as a whole', () => {
    expect(matchClient(index, 'someone.else@gmail.com').clientId).toBeNull();
  });

  it('falls back to another external participant on the thread', () => {
    const m = matchClient(index, 'broker@unknown.io', ['ops@acme.com']);
    expect(m).toMatchObject({ clientId: 1, matchedOn: 'participant' });
  });

  it('returns unmatched when nothing lines up', () => {
    expect(matchClient(index, 'stranger@nowhere.test').clientId).toBeNull();
  });
});
