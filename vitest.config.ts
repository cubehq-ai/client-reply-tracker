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
      FIXTURES_ENABLED: 'true',
      ANTHROPIC_API_KEY: '',
      SEND_ENABLED: 'false',
      GMAIL_WRITE_ENABLED: 'false',
      ORG_DOMAINS: 'cubehq.ai',
      GROUP_ADDRESSES: 'support@cubehq.ai,hello@cubehq.ai',
      LOG_LEVEL: 'silent',
      // Tests must never reach a real external system. These are blanked
      // explicitly because .env.internal is loaded by src/lib/config.ts and
      // would otherwise point the client sync at the live dashboard.
      INTERNAL_MONGO_URL: '',
      MONGO_URL: '',
      INTERNAL_MONGO_DB: '',
      DB_NAME: '',
      INTERNAL_DB_URL: '',
      CLIENT_DB_URL: '',
      GOOGLE_SERVICE_ACCOUNT_FILE: '',
      // A real xoxp token sits in .env, which config.ts loads. Blank here, or
      // a test that forgets to install the fake client talks to the live
      // workspace -- and chat.postMessage would post into a client channel.
      SLACK_USER_TOKEN: '',
      SLACK_SEND_ENABLED: 'false',
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
