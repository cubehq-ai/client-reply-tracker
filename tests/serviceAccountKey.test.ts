import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveKeyMaterial } from '../src/gmail/real.js';

/**
 * A deployment that still carried a laptop's GOOGLE_SERVICE_ACCOUNT_FILE
 * alongside a pasted GOOGLE_SERVICE_ACCOUNT_JSON failed every mailbox on
 * every pass, for a file the build never ships. All 19 mailboxes sat on
 * "Could not read the service account key" for two weeks while the dashboard
 * reported the backend as real, because the variable was merely set.
 */
describe('choosing between the key file and the inline key', () => {
  const INLINE = JSON.stringify({ client_email: 'inline@test.iam.gserviceaccount.com', private_key: 'INLINE' });
  const missing = join(tmpdir(), `no-such-key-${Date.now()}.json`);

  it('falls back to the inline key when the file path does not exist', () => {
    expect(resolveKeyMaterial(missing, INLINE)).toBe(INLINE);
  });

  it('still prefers the file when it is readable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rq-key-'));
    const path = join(dir, 'key.json');
    const fromFile = JSON.stringify({ client_email: 'file@test.iam.gserviceaccount.com', private_key: 'FILE' });
    writeFileSync(path, fromFile);
    expect(resolveKeyMaterial(path, INLINE)).toBe(fromFile);
  });

  it('uses the inline key when no file is configured', () => {
    expect(resolveKeyMaterial('', INLINE)).toBe(INLINE);
  });

  it('still fails loudly when the file is missing and there is no inline key', () => {
    expect(() => resolveKeyMaterial(missing, '')).toThrow(/Could not read the service account key/);
  });
});
