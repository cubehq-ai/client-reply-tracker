import type { Filters } from './Inbox';

export type PageKind = 'inbox' | 'clients' | 'teams' | 'settings';

export interface AppState {
  page: PageKind;
  /** Saved-view name, when the inbox is showing one. */
  title?: string;
  filters: Filters;
  openItem?: number;
  openSource?: 'gmail' | 'slack';
}

/** Params that describe where you are rather than what you are filtering. */
const RESERVED = new Set(['page', 'title', 'item', 'itemSource']);

/**
 * Where you are lives in the URL.
 *
 * All of it used to live in React state, so a reload dropped you back on the
 * Email tab with the drawer closed -- which is wrong twice over: a refresh
 * should refresh what you are looking at, not navigate, and the browser's
 * back button should work.
 */
export function readState(search: string = window.location.search): AppState | null {
  const q = new URLSearchParams(search);
  if ([...q.keys()].length === 0) return null;

  const page = (q.get('page') ?? 'inbox') as PageKind;
  const filters: Filters = {};
  for (const [k, v] of q.entries()) {
    if (!RESERVED.has(k) && v !== '') filters[k] = v;
  }

  const item = Number(q.get('item'));
  return {
    page: ['inbox', 'clients', 'teams', 'settings'].includes(page) ? page : 'inbox',
    title: q.get('title') ?? undefined,
    filters,
    openItem: Number.isFinite(item) && item > 0 ? item : undefined,
    openSource: q.get('itemSource') === 'slack' ? 'slack' : 'gmail',
  };
}

/** Rewrites the address bar in place: navigating is the user's job, not ours. */
export function writeState(state: AppState): void {
  const q = new URLSearchParams();
  q.set('page', state.page);
  if (state.title && state.title !== 'Inbox') q.set('title', state.title);
  if (state.page === 'inbox') {
    for (const [k, v] of Object.entries(state.filters)) {
      if (v !== '' && v != null) q.set(k, String(v));
    }
  }
  if (state.openItem != null) {
    q.set('item', String(state.openItem));
    q.set('itemSource', state.openSource ?? 'gmail');
  }
  const next = `${window.location.pathname}?${q.toString()}`;
  if (next !== `${window.location.pathname}${window.location.search}`) {
    window.history.replaceState(null, '', next);
  }
}
