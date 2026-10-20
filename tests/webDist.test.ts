import { describe, expect, it } from 'vitest';
import { resolveWebDist } from '../src/lib/webDist.js';

/**
 * The deployed app served "The dashboard is not built yet" because the bundle
 * path was resolved relative to the source layout, and compiled code runs one
 * directory deeper.
 */
describe('finding the built dashboard', () => {
  it('finds it from the source layout', () => {
    const found = resolveWebDist('/app/src/api', (p) => p === '/app/web/dist');
    expect(found).toBe('/app/web/dist');
  });

  it('finds it from the compiled layout, one level deeper', () => {
    // This is the case that broke: /app/dist/src/api → /app/dist/web/dist
    // does not exist, so it has to look further up.
    const found = resolveWebDist('/app/dist/src/api', (p) => p === '/app/web/dist');
    expect(found).toBe('/app/web/dist');
  });

  it('never silently picks a path that does not exist over one that does', () => {
    const found = resolveWebDist('/app/dist/src/api', (p) => p === '/app/web/dist');
    expect(found).not.toBe('/app/dist/web/dist');
  });

  it('falls back to the source-layout path when nothing is built', () => {
    // The server then shows its "not built yet" page, which is correct here.
    expect(resolveWebDist('/app/src/api', () => false)).toBe('/app/web/dist');
  });
});
