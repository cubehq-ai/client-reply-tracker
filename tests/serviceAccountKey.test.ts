import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A container has nowhere to keep a key file without a volume, so the key can
 * be given as JSON in a variable instead. Pointing at a path that does not
 * exist used to surface as a bare ENOENT from readFileSync.
 */
describe('loading the service account key', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  const load = async (): Promise<any> => {
    const { RealGmailClient } = await import('../src/gmail/real.js');
    return new RealGmailClient();
  };

  it('accepts the key as JSON in a variable', async () => {
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_FILE', '');
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_JSON',
      JSON.stringify({ client_email: 'svc@example.iam.gserviceaccount.com', private_key: 'x' }));
    vi.resetModules();
    const { useRealGoogle } = await import('../src/lib/config.js');
    expect(useRealGoogle()).toBe(false); // backend is 'fake' in tests
    // The key itself is enough to satisfy the "configured" check.
    const { config } = await import('../src/lib/config.js');
    expect(config.google.serviceAccountJson).toContain('client_email');
  });

  it('names the path when the file cannot be read', async () => {
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_FILE', '/nope/missing-key.json');
    vi.stubEnv('GOOGLE_BACKEND', 'real');
    vi.resetModules();
    const client = await load();
    await expect(client.listMessageIds('a@b.test', '', 1)).rejects.toThrow(/\/nope\/missing-key\.json/);
    await expect(client.listMessageIds('a@b.test', '', 1)).rejects.toThrow(/GOOGLE_SERVICE_ACCOUNT_JSON/);
  });

  it('rejects a key that is not valid JSON', async () => {
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_FILE', '');
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_JSON', 'not json at all');
    vi.stubEnv('GOOGLE_BACKEND', 'real');
    vi.resetModules();
    const client = await load();
    await expect(client.listMessageIds('a@b.test', '', 1)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a key missing the fields it needs', async () => {
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_FILE', '');
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_JSON', JSON.stringify({ project_id: 'p' }));
    vi.stubEnv('GOOGLE_BACKEND', 'real');
    vi.resetModules();
    const client = await load();
    await expect(client.listMessageIds('a@b.test', '', 1)).rejects.toThrow(/client_email or private_key/);
  });
});
