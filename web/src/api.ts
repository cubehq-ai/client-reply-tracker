export interface User { id: number; email: string; name: string | null; role: 'member' | 'manager' | 'admin'; canSendAsShared: boolean }

export interface QueueItem {
  id: number; conversationId: number; state: string; subject: string;
  clientId: number | null; clientName: string | null; ownerEmail: string | null;
  summary: string | null; reason: string | null;
  confidence: number | null; lowConfidence: boolean;
  lastExternalAt: string | null; slaDueAt: string | null;
  repliedAt: string | null; repliedBy: string | null;
  reopenCount: number; muted: boolean; filterReason: string | null;
  fromEmail: string | null; snippet: string | null;
  mailboxes: string[]; teamName: string | null; lockedBy: string | null;
}

export interface InboxFacets {
  needsReply: number;
  noReplyNeeded: number;
  reasons: Record<string, number>;
  unmatched: number;
  lowConfidence: number;
  notReplied: number;
  fresh: number;
  thresholdHours: number;
  total: number;
}

export interface ThreadMessage {
  id: number; rfcMessageId: string; from: string; to: string[]; cc: string[];
  bcc: string[];
  subject: string; date: string; direction: 'in' | 'out'; body: string;
  snippet: string; isDraft: boolean; filterReason: string | null;
  bodyHtml: string | null;
  attachments: { id: number; filename: string; mimeType: string; size: number; isInline: boolean; contentId: string | null }[];
}

export interface ThreadView {
  itemId: number; conversationId: number; subject: string; state: string; clientName: string | null;
  messages: ThreadMessage[];
  reply: { to: string[]; cc: string[]; subject: string; inReplyTo: string | null; references: string[]; threadId: string | null; sendAs: string[] };
  lockedBy: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw Object.assign(new Error(data.error ?? `request failed (${res.status})`), { status: res.status, data });
  return data as T;
}

export const api = {
  me: () => request<{ user: User | null; googleSso: boolean }>('/api/auth/me'),
  login: (email: string, password: string) =>
    request<{ ok: true }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  health: () => request<any>('/api/health'),

  counts: (view: string) => request<Record<string, number>>(`/api/counts?view=${view}`),
  queue: (name: string, params: Record<string, string>) =>
    request<{ items: QueueItem[]; total: number }>(`/api/queues/${name}?${new URLSearchParams(params)}`),
  inbox: (params: Record<string, string>) =>
    request<{ items: QueueItem[]; total: number; facets: InboxFacets }>(`/api/inbox?${new URLSearchParams(params)}`),
  teams: (view: string) => request<{ teams: any[] }>(`/api/teams?view=${view}`),

  savedViews: () => request<{ views: any[] }>('/api/saved-views'),
  createSavedView: (name: string, filters: Record<string, string>, shared = false) =>
    request<{ id: number }>('/api/saved-views', { method: 'POST', body: JSON.stringify({ name, filters, shared }) }),
  deleteSavedView: (id: number) => request<any>(`/api/saved-views/${id}`, { method: 'DELETE' }),

  settingsMailboxes: () => request<{ mailboxes: any[]; teams: any[] }>('/api/settings/mailboxes'),
  unwatched: () => request<{ people: any[]; error?: string }>('/api/settings/unwatched'),
  settingsClients: () => request<{ clients: any[]; unmatched: any[] }>('/api/settings/clients'),
  settingsPost: (path: string, body?: unknown) =>
    request<any>(`/api/settings/${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  settingsPatch: (path: string, body?: unknown) =>
    request<any>(`/api/settings/${path}`, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  settingsDelete: (path: string) => request<any>(`/api/settings/${path}`, { method: 'DELETE' }),

  rules: () => request<{ rules: any[] }>('/api/settings/rules'),
  createRule: (rule: unknown) => request<any>('/api/settings/rules', { method: 'POST', body: JSON.stringify(rule) }),
  updateRule: (id: number, patch: unknown) =>
    request<any>(`/api/settings/rules/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteRule: (id: number) => request<any>(`/api/settings/rules/${id}`, { method: 'DELETE' }),
  rulePreview: (rule: unknown) => request<any>('/api/settings/rules/preview', { method: 'POST', body: JSON.stringify(rule) }),
  reapplyRules: () => request<any>('/api/settings/rules/reapply', { method: 'POST' }),
  clients: (view: string) => request<{ clients: any[] }>(`/api/clients?view=${view}`),
  users: () => request<{ users: any[] }>('/api/users'),

  thread: (id: number, refresh = true) => request<ThreadView>(`/api/items/${id}/thread?refresh=${refresh}`),
  events: (id: number) => request<{ events: any[] }>(`/api/items/${id}/events`),

  act: (id: number, action: string, body?: unknown) =>
    request<any>(`/api/items/${id}/${action}`, { method: 'POST', body: JSON.stringify(body ?? {}) }),

  adminOverview: () => request<any>('/api/admin/overview'),
  adminPost: (path: string, body?: unknown) =>
    request<any>(`/api/admin/${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  adminDelete: (path: string) => request<any>(`/api/admin/${path}`, { method: 'DELETE' }),
};

export function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDue(iso: string | null): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return `overdue by ${timeAgo(iso).replace(' ago', '')}`;
  const hours = Math.round(ms / 3600000);
  return hours < 24 ? `due in ${hours}h` : `due in ${Math.round(hours / 24)}d`;
}
