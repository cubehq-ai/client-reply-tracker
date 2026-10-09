import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.server.logLevel,
  redact: {
    paths: ['private_key', '*.private_key', 'apiKey', '*.apiKey', 'authorization'],
    censor: '[redacted]',
  },
  transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});
