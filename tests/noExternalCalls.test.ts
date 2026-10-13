import { describe, expect, it } from 'vitest';
import { config, fixturesEnabled, useRealClassifier, useRealGoogle } from '../src/lib/config.js';
import { getClientSource } from '../src/sync/clients.js';

/**
 * A standing guard. The internal dashboard credentials live in .env.internal,
 * which src/lib/config.ts loads, so without this the test suite would quietly
 * start reading a production database.
 */
describe('tests are isolated from real systems', () => {
  it('has no internal dashboard configured', () => {
    expect(config.internalMongo.url).toBe('');
    expect(config.internalDb.url).toBe('');
    expect(config.clientDbUrl).toBe('');
  });

  it('resolves the client source to fixtures, never a live database', () => {
    expect(getClientSource().constructor.name).toBe('FixtureClientSource');
  });

  it('never uses the real Google or Anthropic backends', () => {
    expect(useRealGoogle()).toBe(false);
    expect(useRealClassifier()).toBe(false);
  });

  it('runs against a local database', () => {
    expect(config.databaseUrl).toMatch(/localhost|127\.0\.0\.1/);
  });

  it('has fixtures switched on, since the suite depends on them', () => {
    expect(fixturesEnabled()).toBe(true);
  });
});
