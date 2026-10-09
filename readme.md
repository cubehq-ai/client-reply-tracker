# ReplyQueue

One dashboard showing every client email across the org that is still waiting
on a reply from us, grouped by client, with reply, ignore, snooze and reassign
in place.

Gmail only in v1. The data model is channel-agnostic (`source = gmail | slack`).

- **Spec**: [`docs/SPEC.md`](docs/SPEC.md)
- **Build status, how to run it, how to go live**: [`docs/STATUS.md`](docs/STATUS.md)
- **Decisions made without asking**: [`docs/DECISIONS.md`](docs/DECISIONS.md)

## Quick start

```bash
npm install
cp .env.example .env            # set DATABASE_URL
npm run migrate
npx tsx src/cli.ts bootstrap    # seed + ingest the fixture mailboxes
npm run build:web
npm run api                     # http://localhost:8787
```

Create a login:

```bash
npx tsx scripts/create-user.ts you@example.com 'password' admin 'Your Name'
```

By default this runs on **fixtures**, with sending disabled. No request is made
to Google, Anthropic or Slack until you configure them — see
[`docs/STATUS.md` §3](docs/STATUS.md).

## Layout

```
src/
  db/          schema migrations, pool, migration runner
  gmail/       Gmail + Directory clients (real and fake), fixtures
  llm/         classifier and draft clients (Anthropic, offline, local model)
  pipeline/    normalize, filter, client match, classify, ownership, state machine
  sync/        discovery, backfill/history sync, pubsub, reconcile, digests, retention
  api/         Fastify server, auth, queues, item actions, composer, metrics
  worker/      scheduled jobs
  sources/     channel-agnostic ingestion seam (Slack, phase 4)
web/           React dashboard
tests/         unit and integration tests (local Postgres, no network)
```

## Commands

| Command | Does |
|---|---|
| `npm run api` | HTTP API and dashboard |
| `npm run worker` | Scheduled sync, reconciliation, digests |
| `npm test` | Test suite (local Postgres) |
| `npm run typecheck` | TypeScript, no emit |
| `npx tsx src/cli.ts status` | Item counts by state, mailboxes, clients |
| `npx tsx src/cli.ts sync` | One sync pass over every active mailbox |
| `npx tsx src/cli.ts reconcile` | Recompute every open item from stored messages |
| `npx tsx src/cli.ts train-classifier` | Train the local model on team behaviour |

## Safety

Two switches, both off by default:

- `SEND_ENABLED=false` — a send logs the full MIME instead of calling Gmail.
- `GMAIL_WRITE_ENABLED=false` — no label, read-state or delete call is made.
