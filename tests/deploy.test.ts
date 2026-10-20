import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The deploy surface, pinned.
 *
 * Every one of these was missing when the app was first pointed at Railway:
 * no start script, tsx only a devDependency, nothing to run migrations, and
 * nothing saying the worker must not be scaled.
 */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('production entrypoints', () => {
  it('starts from compiled output, not from tsx', () => {
    // tsx is a devDependency; a start script that needs it works locally and
    // dies in a pruned production install.
    for (const script of ['start', 'start:worker', 'migrate:prod']) {
      expect(pkg.scripts[script], `${script} is missing`).toBeDefined();
      expect(pkg.scripts[script], `${script} must not use tsx`).not.toMatch(/\btsx\b/);
      expect(pkg.scripts[script]).toMatch(/^node dist\//);
    }
  });

  it('builds both halves: the server and the web bundle', () => {
    expect(pkg.scripts.build).toContain('tsc');
    expect(pkg.scripts.build).toContain('build:web');
  });

  it('declares a node version', () => {
    expect(pkg.engines?.node).toBeTruthy();
  });
});

describe('railway configuration', () => {
  const railway = JSON.parse(readFileSync(new URL('../railway.json', import.meta.url), 'utf8'));
  const procfile = readFileSync(new URL('../Procfile', import.meta.url), 'utf8');

  it('runs migrations before the server comes up', () => {
    expect(railway.deploy.startCommand).toMatch(/migrate:prod.*&&.*start/);
  });

  it('keeps the worker to one replica', () => {
    // guarded() stops a job overlapping itself inside one process. It cannot
    // stop two processes, so a second replica doubles every sync and sends
    // every digest twice.
    expect(railway.deploy.numReplicas).toBe(1);
  });

  it('health checks the endpoint that actually reports sync state', () => {
    expect(railway.deploy.healthcheckPath).toBe('/api/health');
  });

  it('declares a web and a worker process, and migrates in only one', () => {
    expect(procfile).toMatch(/^web:/m);
    expect(procfile).toMatch(/^worker:/m);
    expect(procfile.match(/migrate:prod/g) ?? []).toHaveLength(1);
  });

  it('declares exactly two processes and carries no comments', () => {
    // Railway reads any "name: command" line as a process. A comment that
    // happened to contain a colon became a third service called
    // "# Migrations run in the ...", which then tried to boot.
    const lines = procfile.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.startsWith('#'))).toBe(false);
    for (const l of lines) expect(l).toMatch(/^(web|worker): \S/);
  });
});

describe('a deployed service without DATABASE_URL', () => {
  it('says the variable is missing instead of dialling localhost', async () => {
    // Falling back to 127.0.0.1:5432 turned an unset variable into an
    // ECONNREFUSED crash-loop, which reads as a database problem.
    const { execFileSync } = await import('node:child_process');
    const script = "import('./dist/src/lib/config.js').catch((e) => { console.log(e.message); process.exit(0); });";
    const out = execFileSync('node', ['-e', script], {
      env: { ...process.env, DATABASE_URL: '', NODE_ENV: 'production', RAILWAY_ENVIRONMENT: 'production' },
      encoding: 'utf8',
    });
    expect(out).toContain('DATABASE_URL is not set');
    expect(out).toMatch(/every service has its own variables/);
  });
});

describe('.env.example matches what the app reads', () => {
  it('documents every variable, and documents nothing dead', async () => {
    // A sample file that drifts from the code is worse than none: it invites
    // people to set variables that do nothing, and hides ones that matter.
    const { readFileSync } = await import('node:fs');
    const cfg = readFileSync(new URL('../src/lib/config.ts', import.meta.url), 'utf8');
    const read = new Set([...cfg.matchAll(/(?:str|num|bool|list)\('([A-Z_]+)'/g)].map((m) => m[1]!));
    const example = new Set(
      [...readFileSync(new URL('../.env.example', import.meta.url), 'utf8').matchAll(/^([A-Z_]+)=/gm)]
        .map((m) => m[1]!),
    );

    // Read directly from process.env rather than through config helpers.
    read.add('DNS_FALLBACK_SERVERS');
    // Test-only or legacy aliases, deliberately undocumented.
    for (const k of ['FIXTURES_ENABLED', 'MONGO_URL', 'DB_NAME', 'CLIENT_DB_URL',
      'INTERNAL_DB_URL', 'INTERNAL_DB_CLIENTS_QUERY', 'INTERNAL_DB_EMPLOYEES_QUERY']) read.delete(k);

    expect([...example].filter((k) => !read.has(k)), 'documented but never read').toEqual([]);
    expect([...read].filter((k) => !example.has(k)), 'read but undocumented').toEqual([]);
  });
});

describe('no auth bypass ships', () => {
  it('has no development login shortcut left in the code', async () => {
    // It was double-gated, but a deployed app with a public URL should not
    // contain a path that signs someone in without a password at all.
    const { readFileSync } = await import('node:fs');
    const auth = readFileSync(new URL('../src/api/auth.ts', import.meta.url), 'utf8');
    expect(auth).not.toMatch(/DEV_AUTH_BYPASS|devUserEmail/);
  });
});
