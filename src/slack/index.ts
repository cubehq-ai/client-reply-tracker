import { config, slackEnabled } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { FakeSlackClient } from './fake.js';
import { RealSlackClient } from './real.js';
import type { SlackClient } from './types.js';

let singleton: SlackClient | null = null;
/** True once a client has been installed by hand, which tests do. */
let explicit = false;

/**
 * Whether Slack is usable at all: a token in the environment, or a client
 * someone installed. Sync and ingestion gate on this rather than on the token
 * alone, so a test with a fake workspace runs the real code paths while a
 * deployment without a token stays completely inert.
 */
export function slackConfigured(): boolean {
  return explicit || slackEnabled();
}

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
  explicit = client !== null;
}

export * from './types.js';
