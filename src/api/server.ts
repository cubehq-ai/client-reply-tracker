import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { one, query } from '../db/pool.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { isEntrypoint } from '../lib/main.js';
import { loadOrgContext } from '../pipeline/context.js';
import { syncAllMailboxes } from '../sync/mailboxSync.js';
import { syncClients } from '../sync/clients.js';
import { discoverMailboxes } from '../sync/discovery.js';
import { reconcileOpenItems } from '../sync/reconcile.js';
import { handlePubSubPush } from '../sync/pubsub.js';
import { computeMetrics } from './metrics.js';
import { modelStatus, trainLocalClassifier } from '../llm/localClassifier.js';
import { sendDailyDigests } from '../sync/digest.js';
import {
  acquireLock, handledElsewhere, ignoreItem, linkToClient, markNeedsReply,
  reassignItem, releaseLock, setAwaitingClient, snoozeItem, undoIgnore,
  type IgnoreReason, type IgnoreScope,
} from './actions.js';
import {
  clearSessionCookie, createSession, currentUser, destroySession, googleSsoConfigured,
  HttpError, requireRole, requireUser, setSessionCookie, verifyPassword,
} from './auth.js';
import { draftReply, getThread, sendReply } from './compose.js';
import { clientOverview, inboxFacets, listQueue, queueCounts, teamOverview, type QueueFilters, type QueueName } from './queues.js';
import {
  addClientDomain, addClientPattern, addMailbox, addMailboxesBulk, createClient, createSavedView,
  createTeam, deleteSavedView, deleteTeam, listClientsDetailed, listMailboxes, listSavedViews,
  listTeams, removeClientDomain, removeClientPattern, removeMailbox, renameTeam, testClientPattern,
  unmatchedSenders, updateMailbox,
} from './settings.js';
import { applyRoster } from '../sync/roster.js';
import { inspectInternalDb, testInternalDb } from '../sync/internalDb.js';
import { checkUnrespondedItems } from '../sync/hourly.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, '..', '..', 'web', 'dist');

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    logger.error({ err }, 'unhandled route error');
    return reply.code(500).send({ error: 'internal error' });
  });

  app.get('/api/health', async () => {
    const db = await one<{ ok: number }>('SELECT 1 AS ok');
    return {
      ok: db?.ok === 1,
      googleBackend: config.google.serviceAccountFile ? config.google.backend : 'fake',
      sendEnabled: config.safety.sendEnabled,
      gmailWriteEnabled: config.safety.gmailWriteEnabled,
      classifier: config.classifier.apiKey ? 'anthropic' : 'heuristic',
      pubsub: config.pubsub.topic ? 'configured' : 'polling-only',
    };
  });

  // ---------- auth ----------
  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const user = await one<{ id: string; password_hash: string | null; status: string }>(
      'SELECT id, password_hash, status FROM users WHERE email = $1',
      [body.email.toLowerCase()],
    );
    // Same message either way, so the form cannot be used to enumerate accounts.
    if (!user || user.status !== 'active' || !(await verifyPassword(body.password, user.password_hash))) {
      return reply.code(401).send({ error: 'invalid email or password' });
    }
    const session = await createSession(Number(user.id), req);
    setSessionCookie(reply, session.id, session.expiresAt);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(req);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const user = await currentUser(req);
    return { user, googleSso: googleSsoConfigured() };
  });

  app.get('/api/auth/google', async (_req, reply) => {
    if (!googleSsoConfigured()) {
      return reply.code(503).send({
        error: 'Google sign-in is not configured yet',
        hint: 'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, then restart the server.',
      });
    }
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI ?? `http://localhost:${config.server.port}/api/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      hd: config.org.domains[0] ?? '',
      prompt: 'select_account',
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  // ---------- queues ----------
  app.get('/api/counts', async (req) => {
    const user = await requireUser(req);
    const view = (req.query as any)?.view as QueueFilters['view'];
    return queueCounts(user, view ?? 'all');
  });

  function parseFilters(q: Record<string, string>): QueueFilters {
    return {
      clientId: q.clientId ? Number(q.clientId) : undefined,
      ownerUserId: q.ownerUserId ? Number(q.ownerUserId) : undefined,
      teamId: q.teamId ? Number(q.teamId) : undefined,
      mailbox: q.mailbox,
      age: q.age as QueueFilters['age'],
      priority: q.priority as QueueFilters['priority'],
      intent: q.intent,
      view: (q.view as QueueFilters['view']) ?? 'all',
      search: q.search,
      source: (q.source as QueueFilters['source']) ?? undefined,
      status: q.status ? q.status.split(',').filter(Boolean) : undefined,
      overdue: q.overdue === 'true',
      unmatched: q.unmatched === 'true',
      lowConfidence: q.lowConfidence === 'true',
      awaitingClient: q.awaitingClient === 'true',
      muted: q.muted === 'true',
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    };
  }

  app.get('/api/queues/:name', async (req) => {
    const user = await requireUser(req);
    const name = (req.params as any).name as QueueName;
    return listQueue(user, name, parseFilters(req.query as Record<string, string>));
  });

  // The unified inbox: one list, everything else is a filter.
  app.get('/api/inbox', async (req) => {
    const user = await requireUser(req);
    const filters = parseFilters(req.query as Record<string, string>);
    const [list, facets] = await Promise.all([
      listQueue(user, 'inbox', filters),
      inboxFacets(user, filters),
    ]);
    return { ...list, facets };
  });

  app.get('/api/teams', async (req) => {
    const user = await requireUser(req);
    const view = (req.query as any)?.view as QueueFilters['view'];
    return { teams: await teamOverview(user, view ?? 'all') };
  });

  // ---------- saved views ----------
  app.get('/api/saved-views', async (req) => ({ views: await listSavedViews(await requireUser(req)) }));
  app.post('/api/saved-views', async (req) => {
    const user = await requireUser(req);
    const body = z.object({ name: z.string(), filters: z.record(z.string(), z.any()), shared: z.boolean().optional() }).parse(req.body);
    return createSavedView(user, body.name, body.filters, body.shared ?? false);
  });
  app.delete('/api/saved-views/:id', async (req) => {
    await deleteSavedView(await requireUser(req), Number((req.params as any).id));
    return { ok: true };
  });

  app.get('/api/clients', async (req) => {
    const user = await requireUser(req);
    const view = (req.query as any)?.view as QueueFilters['view'];
    return { clients: await clientOverview(user, view ?? 'all') };
  });

  app.get('/api/users', async (req) => {
    await requireUser(req);
    return { users: await query("SELECT id, email, name, role FROM users WHERE status = 'active' ORDER BY email") };
  });

  app.get('/api/metrics', async (req) => {
    await requireUser(req);
    return computeMetrics();
  });

  // ---------- one item ----------
  app.get('/api/items/:id/thread', async (req) => {
    const user = await requireUser(req);
    const id = Number((req.params as any).id);
    const refresh = (req.query as any)?.refresh !== 'false';
    return getThread(user, id, { refresh });
  });

  app.get('/api/items/:id/events', async (req) => {
    await requireUser(req);
    const id = Number((req.params as any).id);
    return { events: await query('SELECT * FROM item_events WHERE item_id = $1 ORDER BY created_at DESC LIMIT 100', [id]) };
  });

  const itemId = (req: any): number => Number(req.params.id);

  app.post('/api/items/:id/ignore', async (req) => {
    const user = await requireUser(req);
    const body = z.object({
      reason: z.enum(['not_needed', 'spam', 'not_a_client', 'other']),
      scope: z.enum(['message', 'thread', 'sender', 'domain']).default('message'),
    }).parse(req.body);
    return ignoreItem(user, itemId(req), body.reason as IgnoreReason, body.scope as IgnoreScope);
  });

  app.post('/api/items/:id/undo-ignore', async (req) => undoIgnore(await requireUser(req), itemId(req)));

  app.post('/api/items/:id/snooze', async (req) => {
    const user = await requireUser(req);
    const body = z.object({ until: z.string() }).parse(req.body);
    return snoozeItem(user, itemId(req), new Date(body.until));
  });

  app.post('/api/items/:id/handled', async (req) => {
    const user = await requireUser(req);
    const body = z.object({ note: z.string().optional() }).parse(req.body ?? {});
    return handledElsewhere(user, itemId(req), body.note);
  });

  app.post('/api/items/:id/reassign', async (req) => {
    const user = await requireUser(req);
    const body = z.object({ ownerEmail: z.string().email() }).parse(req.body);
    return reassignItem(user, itemId(req), body.ownerEmail);
  });

  app.post('/api/items/:id/needs-reply', async (req) => markNeedsReply(await requireUser(req), itemId(req)));

  app.post('/api/items/:id/link-client', async (req) => {
    const user = await requireUser(req);
    const body = z.object({ clientId: z.number(), mode: z.enum(['email', 'domain']) }).parse(req.body);
    return linkToClient(user, itemId(req), body.clientId, body.mode);
  });

  app.post('/api/items/:id/awaiting', async (req) => {
    const user = await requireUser(req);
    const body = z.object({ awaiting: z.boolean() }).parse(req.body);
    return setAwaitingClient(user, itemId(req), body.awaiting);
  });

  app.post('/api/items/:id/lock', async (req) => acquireLock(await requireUser(req), itemId(req)));
  app.post('/api/items/:id/unlock', async (req) => {
    await releaseLock(await requireUser(req), itemId(req));
    return { ok: true };
  });

  app.post('/api/items/:id/draft', async (req) => draftReply(await requireUser(req), itemId(req)));

  app.post('/api/items/:id/send', async (req) => {
    const user = await requireUser(req);
    const body = z.object({
      sendAs: z.string().email().optional(),
      to: z.array(z.string().email()).min(1),
      cc: z.array(z.string().email()).optional(),
      subject: z.string(),
      body: z.string(),
      force: z.boolean().optional(),
      saveAsDraft: z.boolean().optional(),
    }).parse(req.body);
    return sendReply(user, { itemId: itemId(req), ...body });
  });

  // ---------- admin ----------
  app.get('/api/admin/overview', async (req) => {
    const user = await requireUser(req);
    requireRole(user, ['admin']);
    const [mailboxes, domains, rules, exclusions, jobs] = await Promise.all([
      query('SELECT email, status, kind, last_synced_at, last_history_id, watch_expiration, last_error FROM mailboxes ORDER BY email'),
      query('SELECT domain, is_group FROM org_domains ORDER BY domain'),
      query('SELECT id, type, value, created_by, created_at FROM rules ORDER BY created_at DESC'),
      query('SELECT id, kind, value, reason FROM exclusions ORDER BY kind, value'),
      query('SELECT job, started_at, finished_at, ok, detail FROM job_runs ORDER BY started_at DESC LIMIT 20'),
    ]);
    return { mailboxes, domains, rules, exclusions, jobs, config: {
      sendEnabled: config.safety.sendEnabled,
      gmailWriteEnabled: config.safety.gmailWriteEnabled,
      backend: config.google.serviceAccountFile ? config.google.backend : 'fake',
      classifier: config.classifier.apiKey ? 'anthropic' : 'heuristic',
      backfillDays: config.org.backfillDays,
      slaHours: config.sla.defaultHours,
    } };
  });

  app.post('/api/admin/org-domains', async (req) => {
    const user = await requireUser(req);
    requireRole(user, ['admin']);
    const body = z.object({ domain: z.string().min(3), isGroup: z.boolean().default(false) }).parse(req.body);
    await query('INSERT INTO org_domains (domain, is_group) VALUES ($1,$2) ON CONFLICT (domain) DO UPDATE SET is_group = EXCLUDED.is_group', [
      body.domain.toLowerCase(), body.isGroup,
    ]);
    return { ok: true };
  });

  app.delete('/api/admin/rules/:ruleId', async (req) => {
    const user = await requireUser(req);
    requireRole(user, ['admin']);
    await query('DELETE FROM rules WHERE id = $1', [Number((req.params as any).ruleId)]);
    return { ok: true };
  });

  app.post('/api/admin/rules', async (req) => {
    const user = await requireUser(req);
    requireRole(user, ['admin']);
    const body = z.object({
      type: z.enum(['block_sender', 'block_domain', 'allow_sender']),
      value: z.string().min(3),
    }).parse(req.body);
    await query(
      `INSERT INTO rules (type, value, created_by, scope) VALUES ($1,$2,$3,'org')
       ON CONFLICT (type, value, scope, created_by) DO NOTHING`,
      [body.type, body.value.toLowerCase(), user.email],
    );
    return { ok: true };
  });

  app.post('/api/admin/exclusions', async (req) => {
    const user = await requireUser(req);
    requireRole(user, ['admin']);
    const body = z.object({ kind: z.enum(['mailbox', 'label']), value: z.string().min(1), reason: z.string().optional() }).parse(req.body);
    await query('INSERT INTO exclusions (kind, value, reason, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (kind, value) DO NOTHING', [
      body.kind, body.kind === 'label' ? body.value.toUpperCase() : body.value.toLowerCase(), body.reason ?? null, user.email,
    ]);
    return { ok: true };
  });

  for (const [path, fn] of [
    ['sync', syncAllMailboxes],
    ['sync-clients', () => syncClients()],
    ['discover', discoverMailboxes],
    ['reconcile', reconcileOpenItems],
    ['train-classifier', trainLocalClassifier],
    ['digests', sendDailyDigests],
  ] as const) {
    app.post(`/api/admin/${path}`, async (req) => {
      const user = await requireUser(req);
      requireRole(user, ['admin']);
      const started = Date.now();
      const result = await fn();
      await query('INSERT INTO job_runs (job, finished_at, ok, detail) VALUES ($1, now(), true, $2)', [
        `manual:${path}`, JSON.stringify({ ms: Date.now() - started }),
      ]);
      return result as object;
    });
  }

  app.get('/api/admin/classifier', async (req) => {
    const user = await requireUser(req);
    requireRole(user, ['admin']);
    return modelStatus();
  });

  app.get('/api/admin/context', async (req) => {
    const user = await requireUser(req);
    requireRole(user, ['admin']);
    const ctx = await loadOrgContext();
    return {
      orgDomains: [...ctx.orgDomains],
      groupAddresses: [...ctx.groupAddresses],
      excludedMailboxes: [...ctx.excludedMailboxes],
      excludedLabels: [...ctx.excludedLabels],
      clientDomains: ctx.clients.byDomain.size,
      clientContacts: ctx.clients.byEmail.size,
    };
  });

  // ---------- settings: mailboxes, teams, clients ----------
  const adminOnly = async (req: any) => {
    const user = await requireUser(req);
    requireRole(user, ['admin']);
    return user;
  };

  app.get('/api/settings/mailboxes', async (req) => {
    await requireUser(req);
    return { mailboxes: await listMailboxes(), teams: await listTeams() };
  });

  app.post('/api/settings/mailboxes', async (req) => {
    const user = await adminOnly(req);
    const body = z.object({
      email: z.string().optional(),
      emails: z.array(z.string()).optional(),
      team: z.string().nullable().optional(),
      kind: z.enum(['user', 'shared']).optional(),
      role: z.enum(['member', 'manager', 'admin']).optional(),
    }).parse(req.body);

    if (body.emails?.length) return addMailboxesBulk(user, body.emails, body.team ?? null);
    if (!body.email) throw new HttpError(400, 'email or emails is required');
    return addMailbox(user, { email: body.email, team: body.team ?? null, kind: body.kind, role: body.role });
  });

  app.patch('/api/settings/mailboxes/:id', async (req) => {
    const user = await adminOnly(req);
    const body = z.object({
      team: z.string().nullable().optional(),
      status: z.enum(['active', 'paused', 'excluded']).optional(),
      kind: z.enum(['user', 'shared']).optional(),
    }).parse(req.body);
    await updateMailbox(user, Number((req.params as any).id), body);
    return { ok: true };
  });

  app.delete('/api/settings/mailboxes/:id', async (req) => {
    const user = await adminOnly(req);
    return removeMailbox(user, Number((req.params as any).id));
  });

  app.post('/api/settings/roster', async (req) => {
    await adminOnly(req);
    return applyRoster();
  });

  app.get('/api/settings/teams', async (req) => {
    await requireUser(req);
    return { teams: await listTeams() };
  });

  app.post('/api/settings/teams', async (req) => {
    const user = await adminOnly(req);
    const body = z.object({ name: z.string() }).parse(req.body);
    return createTeam(user, body.name);
  });

  app.patch('/api/settings/teams/:id', async (req) => {
    const user = await adminOnly(req);
    const body = z.object({ name: z.string() }).parse(req.body);
    await renameTeam(user, Number((req.params as any).id), body.name);
    return { ok: true };
  });

  app.delete('/api/settings/teams/:id', async (req) => {
    const user = await adminOnly(req);
    await deleteTeam(user, Number((req.params as any).id));
    return { ok: true };
  });

  app.get('/api/settings/clients', async (req) => {
    await requireUser(req);
    return { clients: await listClientsDetailed(), unmatched: await unmatchedSenders() };
  });

  app.post('/api/settings/clients', async (req) => {
    const user = await adminOnly(req);
    const body = z.object({
      name: z.string(),
      tier: z.string().nullable().optional(),
      domains: z.array(z.string()).optional(),
      contacts: z.array(z.string()).optional(),
      accountManagerEmail: z.string().nullable().optional(),
    }).parse(req.body);
    return createClient(user, body);
  });

  app.post('/api/settings/clients/:id/domains', async (req) => {
    const user = await adminOnly(req);
    const body = z.object({ domain: z.string() }).parse(req.body);
    await addClientDomain(user, Number((req.params as any).id), body.domain);
    return { ok: true };
  });

  app.delete('/api/settings/client-domains/:id', async (req) => {
    const user = await adminOnly(req);
    await removeClientDomain(user, Number((req.params as any).id));
    return { ok: true };
  });

  app.post('/api/settings/clients/:id/patterns', async (req) => {
    const user = await adminOnly(req);
    const body = z.object({ pattern: z.string(), priority: z.number().optional(), note: z.string().optional() }).parse(req.body);
    await addClientPattern(user, Number((req.params as any).id), body.pattern, body.priority, body.note);
    return { ok: true };
  });

  app.delete('/api/settings/client-patterns/:id', async (req) => {
    const user = await adminOnly(req);
    await removeClientPattern(user, Number((req.params as any).id));
    return { ok: true };
  });

  app.post('/api/settings/test-pattern', async (req) => {
    await requireUser(req);
    const body = z.object({ pattern: z.string() }).parse(req.body);
    return testClientPattern(body.pattern);
  });

  app.get('/api/settings/internal-db', async (req) => {
    await adminOnly(req);
    return testInternalDb();
  });

  app.post('/api/settings/internal-db/inspect', async (req) => {
    await adminOnly(req);
    return inspectInternalDb();
  });

  app.post('/api/admin/hourly-status', async (req) => {
    await adminOnly(req);
    return checkUnrespondedItems();
  });

  // ---------- Gmail push (SPEC 3.2) ----------
  app.post('/pubsub/push', async (req, reply) => {
    const token = (req.query as any)?.token;
    if (config.pubsub.verificationToken && token !== config.pubsub.verificationToken) {
      return reply.code(401).send({ error: 'bad verification token' });
    }
    const result = await handlePubSubPush(req.body as any);
    // Always 200: a non-2xx makes Pub/Sub redeliver forever.
    return reply.code(200).send(result);
  });

  // ---------- static SPA ----------
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/pubsub')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/html').send('<h1>ReplyQueue API</h1><p>The dashboard is not built yet. Run <code>npm run build:web</code>.</p>'),
    );
  }

  return app;
}

if (isEntrypoint(import.meta.url)) {
  const app = await buildServer();
  app.listen({ port: config.server.port, host: '0.0.0.0' })
    .then(() => logger.info({ url: `http://localhost:${config.server.port}` }, 'ReplyQueue API listening'))
    .catch((err) => {
      logger.error({ err }, 'failed to start server');
      process.exit(1);
    });
}
