import { withInternalDb } from '../src/sync/internalMongo.js';

const ORG = new Set(['cubehq.ai']);
const FREE = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com']);
const domainOf = (e: string) => e.toLowerCase().split('@')[1] ?? '';

await withInternalDb(async (db) => {
  const clients = await db.collection('clients').find({}, 500);
  let active = 0, churned = 0, withExternal = 0;
  const domains = new Map<string, string[]>();

  for (const c of clients as any[]) {
    if (c.is_churned) churned += 1;
    if (c.is_active) active += 1;
    const emails: string[] = Array.isArray(c.notification_emails) ? c.notification_emails : [];
    const external = emails.filter((e) => typeof e === 'string' && e.includes('@'))
      .map((e) => e.toLowerCase())
      .filter((e) => !ORG.has(domainOf(e)) && !FREE.has(domainOf(e)));
    if (external.length) {
      withExternal += 1;
      for (const e of external) {
        const d = domainOf(e);
        domains.set(d, [...(domains.get(d) ?? []), c.name]);
      }
    }
  }

  console.log(`clients: ${clients.length} (active ${active}, churned ${churned})`);
  console.log(`clients with an external contact email: ${withExternal}`);
  console.log(`distinct external domains derivable: ${domains.size}`);
  const shared = [...domains.entries()].filter(([, names]) => new Set(names).size > 1);
  console.log(`domains shared by >1 client (would be ambiguous): ${shared.length}`);
  for (const [d, names] of shared.slice(0, 8)) console.log(`   ${d} -> ${[...new Set(names)].join(' | ')}`);
  console.log('sample domains:', [...domains.keys()].slice(0, 12).join(', '));

  const members = await db.collection('team_members').find({}, 500);
  const roles = new Map<string, number>();
  let activeMembers = 0;
  for (const m of members as any[]) {
    if (m.is_active) activeMembers += 1;
    const r = m.role ?? '(none)';
    roles.set(r, (roles.get(r) ?? 0) + 1);
  }
  console.log(`\nteam_members: ${members.length} (active ${activeMembers})`);
  console.log('roles:', [...roles.entries()].map(([r, n]) => `${r}=${n}`).join(', '));
});
