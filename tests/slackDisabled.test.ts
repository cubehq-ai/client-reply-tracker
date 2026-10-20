import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealSlackClient } from '../src/slack/real.js';

/**
 * With no token Slack must be inert: the tab says "not connected" and nothing
 * reaches the network. tests/noExternalCalls.test.ts guards the suite as a
 * whole; this guards the decision that keeps it true in production.
 */
describe('slack without a token', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('reports itself disabled and builds no real client', async () => {
    vi.stubEnv('SLACK_USER_TOKEN', '');
    vi.resetModules();
    const { slackEnabled } = await import('../src/lib/config.js');
    expect(slackEnabled()).toBe(false);
  });

  it('syncs nothing rather than calling Slack', async () => {
    vi.stubEnv('SLACK_USER_TOKEN', '');
    vi.resetModules();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { syncSlackUsers, syncSlackChannels } = await import('../src/slack/sync.js');
    const { syncSlackChannelMessages } = await import('../src/slack/ingest.js');

    expect(await syncSlackUsers()).toEqual({ users: 0, internal: 0 });
    expect(await syncSlackChannels()).toEqual({ channels: 0, mapped: 0, unmapped: [] });
    expect(await syncSlackChannelMessages()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('slack rate limiting', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('waits the time Slack asks for and then retries', async () => {
    // Guessing the wait is how an app gets its token restricted, so the
    // Retry-After header has to be the thing that is honoured.
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls.push('call');
      if (calls.length === 1) {
        return new Response('', { status: 429, headers: { 'retry-after': '0' } }) as any;
      }
      return new Response(JSON.stringify({ ok: true, user_id: 'U1', user: 'bot', team_id: 'T1', team: 'Org', url: '' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }) as any;
    });

    const client = new RealSlackClient('xoxp-test');
    const me = await client.authTest();
    expect(me.userId).toBe('U1');
    expect(calls).toHaveLength(2);
  });

  it('surfaces a real API error rather than retrying forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }) as any,
    );
    await expect(new RealSlackClient('xoxp-bad').authTest()).rejects.toThrow('invalid_auth');
  });
});
