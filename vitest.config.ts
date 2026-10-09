import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests share one database, so files must not run in parallel.
    fileParallelism: false,
    maxWorkers: 1,
    // Tests run against a LOCAL Postgres: every assertion costs several
    // round trips, and a remote database turns the suite into minutes.
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/client_reply_tracker',
      GOOGLE_BACKEND: 'fake',
      ANTHROPIC_API_KEY: '',
      SEND_ENABLED: 'false',
      GMAIL_WRITE_ENABLED: 'false',
      ORG_DOMAINS: 'cubehq.ai',
      GROUP_ADDRESSES: 'support@cubehq.ai,hello@cubehq.ai',
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
