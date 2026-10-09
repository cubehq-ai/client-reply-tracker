import { useRealClassifier } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { AnthropicLlmClient } from './anthropic.js';
import { FakeLlmClient } from './fake.js';
import type { LlmClient } from './types.js';

let singleton: LlmClient | null = null;

export function getLlmClient(): LlmClient {
  if (!singleton) {
    if (useRealClassifier()) {
      logger.info('using the real Anthropic classifier');
      singleton = new AnthropicLlmClient();
    } else {
      logger.warn('ANTHROPIC_API_KEY unset — using the offline heuristic classifier');
      singleton = new FakeLlmClient();
    }
  }
  return singleton;
}

export function setLlmClient(client: LlmClient | null): void {
  singleton = client;
}

export * from './types.js';
