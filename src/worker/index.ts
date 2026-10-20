import cron from 'node-cron';
import { closePool, query } from '../db/pool.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { isEntrypoint } from '../lib/main.js';
import { syncClients } from '../sync/clients.js';
import { syncTeamsFromInternal } from '../sync/internalSync.js';
import { sendDailyDigests, sendImmediateAlerts } from '../sync/digest.js';
import { discoverMailboxes } from '../sync/discovery.js';
import { syncAllMailboxes } from '../sync/mailboxSync.js';
import { reconcileOpenItems } from '../sync/reconcile.js';
import { clearExpiredLocks } from '../sync/locks.js';
import { checkUnrespondedItems } from '../sync/hourly.js';
import { purgeOldBodies } from '../sync/retention.js';
import { renewWatches } from '../sync/watch.js';
import { syncSlackChannels, syncSlackUsers } from '../slack/sync.js';
import { syncSlackChannelMessages } from '../slack/ingest.js';
import { runSlackWindows } from '../slack/window.js';
import { slackEnabled } from '../lib/config.js';

/** Runs a job with a row in job_runs, so the admin page shows what happened. */
async function run(job: string, fn: () => Promise<unknown>): Promise<void> {
  const started = await query<{ id: string }>('INSERT INTO job_runs (job) VALUES ($1) RETURNING id', [job]);
  const id = started[0]!.id;
  try {
    const detail = await fn();
    await query('UPDATE job_runs SET finished_at = now(), ok = true, detail = $2 WHERE id = $1', [
      id, JSON.stringify(detail ?? {}),
    ]);
  } catch (err) {
    logger.error({ job, err }, 'job failed');
    await query('UPDATE job_runs SET finished_at = now(), ok = false, detail = $2 WHERE id = $1', [
      id, JSON.stringify({ error: String(err) }),
    ]);
  }
}

/** Prevents a slow pass from overlapping the next tick. */
function guarded(name: string, fn: () => Promise<unknown>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      logger.warn({ job: name }, 'previous run still in progress, skipping this tick');
      return;
    }
    running = true;
    try {
      await run(name, fn);
    } finally {
      running = false;
    }
  };
}

export function startWorker(): void {
  const tz = config.sla.timezone;

  // Fallback poller, in case a push notification was missed (SPEC 3.2).
  cron.schedule('*/10 * * * *', guarded('sync', syncAllMailboxes), { timezone: tz });

  // Client + domain sync from the dashboard DB (SPEC 10).
  //
  // Hourly, not every 15 minutes: the pass takes the better part of a minute
  // against the dashboard's Mongo, and clients and their domains change on
  // the order of days. Settings can sync on demand when something needs
  // picking up sooner.
  cron.schedule('0 * * * *', guarded('sync-clients', () => syncClients()), { timezone: tz });

  // Teams and membership from the same dashboard, once a day at 18:00. People
  // join, leave or change team rarely, and Settings can sync on demand when
  // something needs picking up sooner.
  cron.schedule('0 18 * * *', guarded('sync-teams', () => syncTeamsFromInternal()), { timezone: tz });

  // Short sweep: drop expired composer locks and send overdue alerts.
  cron.schedule('*/5 * * * *', guarded('sweeps', async () => ({
    locks: await clearExpiredLocks(),
    alerts: await sendImmediateAlerts(),
  })), { timezone: tz });

  // Hourly: re-read every still-unresponded thread from Gmail and update its
  // status. Catches replies sent from mailboxes outside the watch list.
  cron.schedule('5 * * * *', guarded('hourly-status', () => checkUnrespondedItems()), { timezone: tz });

  if (slackEnabled()) {
    // Watched channels every 2 minutes. Slack conversations move faster than
    // mail and the calls are cheap: one history call per channel.
    cron.schedule('*/2 * * * *', guarded('slack-sync', async () => ({
      channels: await syncSlackChannelMessages(),
    })), { timezone: tz });

    // The ambiguous groups, once a channel has gone quiet.
    cron.schedule('*/5 * * * *', guarded('slack-window', () => runSlackWindows()), { timezone: tz });

    // Membership and the channel list change rarely.
    cron.schedule('17 * * * *', guarded('slack-channels', () => syncSlackChannels()), { timezone: tz });
    cron.schedule('0 5 * * *', guarded('slack-users', () => syncSlackUsers()), { timezone: tz });
  }

  // Daily mailbox discovery (SPEC 3.1).
  cron.schedule('0 2 * * *', guarded('discover', discoverMailboxes), { timezone: tz });

  // Watches expire after 7 days, so renew daily (SPEC 3.2).
  cron.schedule('0 3 * * *', guarded('renew-watches', renewWatches), { timezone: tz });

  // Nightly reconciliation against stored messages (SPEC 3.2).
  cron.schedule('0 4 * * *', guarded('reconcile', reconcileOpenItems), { timezone: tz });

  // Retention purge (SPEC 11).
  cron.schedule('30 4 * * *', guarded('purge-bodies', purgeOldBodies), { timezone: tz });

  // Follow-up sweep and the daily digests (SPEC 6, 8).
  cron.schedule('0 8 * * 1-5', guarded('digests', () => sendDailyDigests()), { timezone: tz });

  logger.info({ timezone: tz, pubsub: config.pubsub.topic ? 'push + poll' : 'poll only' }, 'worker scheduled');
}

if (isEntrypoint(import.meta.url)) {
  startWorker();
  // Run one pass immediately so a fresh start is not blind for ten minutes.
  void run('sync:startup', syncAllMailboxes);
  if (slackEnabled()) {
    // Users and channels first: message storage needs to know who is internal
    // and which channels are a client's before any of it means anything.
    void run('slack:startup', async () => {
      await syncSlackUsers();
      const channels = await syncSlackChannels();
      const messages = await syncSlackChannelMessages();
      return { channels, messages };
    });
  }

  const shutdown = async (): Promise<void> => {
    logger.info('worker shutting down');
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
