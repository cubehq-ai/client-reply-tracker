import { config, fixturesEnabled, useRealGoogle } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { FakeDirectoryClient, FakeGmailClient } from './fake.js';
import { RealDirectoryClient, RealGmailClient } from './real.js';
import type { DirectoryClient, GmailClient } from './types.js';

let gmailSingleton: GmailClient | null = null;
let directorySingleton: DirectoryClient | null = null;

export function getGmailClient(): GmailClient {
  if (!gmailSingleton) {
    if (useRealGoogle()) {
      logger.info('using the real Gmail backend');
      gmailSingleton = new RealGmailClient();
    } else if (fixturesEnabled()) {
      logger.warn({ backend: config.google.backend }, 'using the FAKE Gmail backend WITH DEMO FIXTURES (FIXTURES_ENABLED=true)');
      gmailSingleton = new FakeGmailClient();
    } else {
      // Empty rather than seeded: an unconfigured deployment shows nothing,
      // not invented mail.
      logger.warn('no Gmail backend configured — running empty. Authorise domain-wide delegation and set GOOGLE_BACKEND=real.');
      gmailSingleton = new FakeGmailClient(new Map());
    }
  }
  return gmailSingleton;
}

export function getDirectoryClient(): DirectoryClient {
  if (!directorySingleton) {
    if (useRealGoogle()) directorySingleton = new RealDirectoryClient();
    // Without fixtures the directory is empty: mailboxes come from the roster
    // and from Settings, not from invented users.
    else directorySingleton = new FakeDirectoryClient(fixturesEnabled() ? undefined : []);
  }
  return directorySingleton;
}

/** Test seam: replace the process-wide clients. */
export function setClients(gmail: GmailClient | null, directory: DirectoryClient | null): void {
  gmailSingleton = gmail;
  directorySingleton = directory;
}

export * from './types.js';
