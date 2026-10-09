import { pathToFileURL } from 'node:url';

/**
 * True when this module is the process entrypoint.
 * Compares file URLs rather than paths: a repo path containing a space
 * URL-encodes to %20 in import.meta.url and would never match argv[1].
 */
export function isEntrypoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return moduleUrl === pathToFileURL(entry).href;
}
