import { afterEach, describe, expect, it } from 'vitest';
import { assertDistinctFromTrackerDb, InternalDbWriteRisk } from '../src/sync/internalDbGuard.js';
import { config } from '../src/lib/config.js';

const originalInternal = config.internalDb.url;
const originalTracker = config.databaseUrl;

afterEach(() => {
  config.internalDb.url = originalInternal;
  config.databaseUrl = originalTracker;
});

describe('tracker / internal database separation', () => {
  it('does nothing when no internal database is configured', () => {
    config.internalDb.url = '';
    expect(() => assertDistinctFromTrackerDb()).not.toThrow();
  });

  it('refuses when both point at the same database', () => {
    config.databaseUrl = 'postgres://writer:pw@db.example.com:5432/appdb';
    config.internalDb.url = 'postgres://reader:other@db.example.com:5432/appdb';
    expect(() => assertDistinctFromTrackerDb()).toThrow(InternalDbWriteRisk);
  });

  it('ignores credentials and query strings when comparing', () => {
    config.databaseUrl = 'postgres://a:b@db.example.com/appdb?sslmode=require';
    config.internalDb.url = 'postgres://c:d@db.example.com:5432/appdb';
    expect(() => assertDistinctFromTrackerDb()).toThrow(/same database/);
  });

  it('allows a different database on the same host', () => {
    config.databaseUrl = 'postgres://a:b@db.example.com/tracker';
    config.internalDb.url = 'postgres://c:d@db.example.com/internal';
    expect(() => assertDistinctFromTrackerDb()).not.toThrow();
  });

  it('allows a different host entirely', () => {
    config.databaseUrl = 'postgres://a:b@tracker.example.com/appdb';
    config.internalDb.url = 'postgres://c:d@internal.example.com/appdb';
    expect(() => assertDistinctFromTrackerDb()).not.toThrow();
  });
});
