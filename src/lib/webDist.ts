import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the built dashboard lives, from wherever this module is running.
 *
 * In development the server runs from `src/api/`, so the bundle is two
 * levels up. Compiled, it runs from `dist/src/api/`, and the same relative
 * path points at `dist/web/dist`, which does not exist -- so the deployed
 * app served the "dashboard is not built yet" placeholder instead of the UI.
 *
 * Checking the candidates in order is deliberate: it reads as "wherever it
 * actually is" rather than encoding an assumption about the layout that is
 * true in one of the two places it runs.
 */
export function resolveWebDist(here: string, exists: (p: string) => boolean = existsSync): string {
  const candidates = [
    join(here, '..', '..', 'web', 'dist'),        // src/api → repo root
    join(here, '..', '..', '..', 'web', 'dist'),  // dist/src/api → repo root
  ];
  return candidates.find(exists) ?? candidates[0]!;
}
