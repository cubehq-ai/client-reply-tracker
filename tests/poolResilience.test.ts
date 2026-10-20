import { describe, expect, it } from 'vitest';
import { isTransient, withRetry } from '../src/db/pool.js';

const err = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });

describe('transient failures', () => {
  it('treats a name-resolution blip and a dropped connection as transient', () => {
    for (const c of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', '57P01']) {
      expect(isTransient(err(c))).toBe(true);
    }
  });

  it('does not treat a real database error as transient', () => {
    // 28P01 is a bad password and 42703 a missing column; retrying either is
    // pointless and hides the cause.
    for (const c of ['28P01', '42703', '23505']) expect(isTransient(err(c))).toBe(false);
    expect(isTransient(new Error('plain'))).toBe(false);
  });
});

describe('retrying', () => {
  it('rides out a blip and returns the eventual success', async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw err('ENOTFOUND');
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the last attempt and reports the real error', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls += 1; throw err('ECONNRESET'); }, 2)).rejects.toThrow('ECONNRESET');
    expect(calls).toBe(2);
  });

  it('fails a genuine error immediately, without retrying', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls += 1; throw err('28P01'); })).rejects.toThrow('28P01');
    expect(calls).toBe(1);
  });
});

describe('a client that drops mid-query', () => {
  it('does not take the process down', async () => {
    // pg emits on the client, not the pool, when the client is checked out.
    // Unhandled, that is an uncaught 'error' event and the worker dies --
    // which is how a long job on a dropped connection killed it.
    const { getPool } = await import('../src/db/pool.js');
    const client = await getPool().connect();
    try {
      expect(client.listenerCount('error')).toBeGreaterThan(0);
      // Emitting with a listener attached must not throw.
      expect(() => client.emit('error', Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }))).not.toThrow();
    } finally {
      client.release();
    }
  });
});
