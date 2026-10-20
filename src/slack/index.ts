import { config, slackEnabled } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { FakeSlackClient } from './fake.js';
import { RealSlackClient } from './real.js';
import type { SlackClient } from './types.js';

let singleton: SlackClient | null = null;

/**
 * Without a token Slack is off: an empty fake, so nothing reaches the network
 * and the UI can say "Not connected" rather than failing per request.
 */
export function getSlackClient(): SlackClient {
  if (!singleton) {
    if (slackEnabled()) {
      logger.info('using the real Slack backend');
      singleton = new RealSlackClient(config.slack.userToken);
    } else {
      logger.warn('no SLACK_USER_TOKEN — Slack ingestion disabled');
      singleton = new FakeSlackClient();
    }
  }
  return singleton;
}

/** Test seam: replace the process-wide client. */
export function setSlackClient(client: SlackClient | null): void {
  singleton = client;
}

export * from './types.js';
