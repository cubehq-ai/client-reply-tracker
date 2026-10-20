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
});
