import { config, useRealGoogle } from '../lib/config.js';
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
    } else {
      logger.warn({ backend: config.google.backend }, 'using the FAKE Gmail backend (fixtures); set GOOGLE_BACKEND=real with a key file to go live');
      gmailSingleton = new FakeGmailClient();
    }
  }
  return gmailSingleton;
}

export function getDirectoryClient(): DirectoryClient {
  if (!directorySingleton) {
    directorySingleton = useRealGoogle() ? new RealDirectoryClient() : new FakeDirectoryClient();
  }
  return directorySingleton;
}

/** Test seam: replace the process-wide clients. */
export function setClients(gmail: GmailClient | null, directory: DirectoryClient | null): void {
  gmailSingleton = gmail;
  directorySingleton = directory;
}

export * from './types.js';
