/**
 * Runs every scheduled job once, for real, against the configured database.
 *
 * The worker only proves a job is *scheduled*; this proves it runs. Several
 * of these had never executed successfully end to end -- a job that throws at
 * 04:00 is invisible until someone looks at job_runs weeks later.
 *
 *   QA_JOBS_WRITE=false node scripts/jobs-qa.mjs   # skip the ones that write
 */
import { config, slackEnabled } from '../src/lib/config.js';

const allowWrites = process.env.QA_JOBS_WRITE !== 'false';
/** The full 21-mailbox pull takes minutes; one mailbox proves the path. */
const heavy = process.env.QA_JOBS_HEAVY === 'true';
const results = [];

async function check(name, schedule, fn, opts = {}) {
  if (opts.skip) {
    results.push({ name, schedule, status: 'skip', detail: opts.skip });
    return;
  }
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, schedule, status: 'ok', ms: Date.now() - started, detail: summarise(detail) });
  } catch (err) {
    results.push({ name, schedule, status: 'FAIL', ms: Date.now() - started, detail: String(err?.message ?? err) });
  }
}

function summarise(d) {
  if (d == null) return '';
  if (typeof d !== 'object') return String(d);
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (Array.isArray(v)) out[k] = `${v.length} item(s)`;
    else if (v && typeof v === 'object') out[k] = Object.keys(v).length ? '{…}' : '{}';
    else out[k] = v;
  }
  return JSON.stringify(out).slice(0, 150);
}

const { syncAllMailboxes } = await import('../src/sync/mailboxSync.js');
void syncAllMailboxes;
const { syncClients } = await import('../src/sync/clients.js');
const { syncTeamsFromInternal } = await import('../src/sync/internalSync.js');
const { sendDailyDigests, sendImmediateAlerts } = await import('../src/sync/digest.js');
const { discoverMailboxes } = await import('../src/sync/discovery.js');
const { reconcileOpenItems } = await import('../src/sync/reconcile.js');
const { clearExpiredLocks } = await import('../src/sync/locks.js');
const { checkUnrespondedItems } = await import('../src/sync/hourly.js');
const { purgeOldBodies } = await import('../src/sync/retention.js');
const { renewWatches } = await import('../src/sync/watch.js');
const { syncSlackChannels, syncSlackUsers } = await import('../src/slack/sync.js');
const { syncSlackChannelMessages } = await import('../src/slack/ingest.js');
const { runSlackWindows } = await import('../src/slack/window.js');

await check('sync', '*/10 * * * *', async () => {
  if (heavy) return syncAllMailboxes();
  // One mailbox exercises the same path -- history, fetch, ingest, state --
  // without re-reading every mailbox in the org for a QA run.
  const { activeMailboxes, syncMailbox } = await import('../src/sync/mailboxSync.js');
  const { loadOrgContext } = await import('../src/pipeline/context.js');
  const boxes = await activeMailboxes();
  if (boxes.length === 0) throw new Error('no active mailboxes');
  return syncMailbox(boxes[0], await loadOrgContext());
});
await check('sync-clients', '*/15 * * * *', () => syncClients());
await check('sync-teams', '0 18 * * *', () => syncTeamsFromInternal());
await check('sweeps:locks', '*/5 * * * *', () => clearExpiredLocks());
await check('sweeps:alerts', '*/5 * * * *', () => sendImmediateAlerts());
// Capped so a QA run does not re-read the whole backlog from Gmail.
await check('hourly-status', '5 * * * *', () => checkUnrespondedItems(5));
await check('discover', '0 2 * * *', () => discoverMailboxes());
await check('renew-watches', '0 3 * * *', () => renewWatches());
await check('reconcile', '0 4 * * *', () => reconcileOpenItems());
await check('purge-bodies', '30 4 * * *', () => purgeOldBodies(), {
  skip: allowWrites ? undefined : 'writes disabled',
});
await check('digests', '0 8 * * 1-5', () => sendDailyDigests());

const slackSkip = slackEnabled() ? undefined : 'no SLACK_USER_TOKEN';
await check('slack-sync', '*/2 * * * *', () => syncSlackChannelMessages(), { skip: slackSkip });
await check('slack-window', '*/5 * * * *', () => runSlackWindows(), { skip: slackSkip });
await check('slack-channels', '17 * * * *', () => syncSlackChannels(), { skip: slackSkip });
await check('slack-users', '0 5 * * *', () => syncSlackUsers(), { skip: slackSkip });

console.log(`\ntimezone: ${config.sla.timezone}   gmail: ${config.google.backend}   slack: ${slackEnabled() ? 'on' : 'off'}\n`);
for (const r of results) {
  const mark = r.status === 'ok' ? ' ok ' : r.status === 'skip' ? 'skip' : 'FAIL';
  console.log(`  ${mark}  ${r.name.padEnd(16)} ${r.schedule.padEnd(14)} ${r.ms != null ? String(r.ms).padStart(6) + 'ms' : '        '}  ${r.detail}`);
}
const failed = results.filter((r) => r.status === 'FAIL');
console.log(failed.length ? `\n${failed.length} job(s) FAILED` : '\nall jobs ran');
process.exit(failed.length ? 1 : 0);
