import { closePool, query } from '../src/db/pool.js';

/**
 * Provisions an account, or changes an existing one's role.
 *
 * Sign-in itself is Google SSO: a first sign-in from an organisation domain
 * creates a plain member on its own, so this is only needed to grant a role
 * ahead of time -- an admin who must be an admin the first time they land.
 *
 *   npx tsx scripts/create-user.ts someone@cubehq.ai admin 'Their Name'
 */
const [email, role = 'admin', name] = process.argv.slice(2);
if (!email) {
  console.error("usage: tsx scripts/create-user.ts <email> [role] ['name']");
  process.exit(1);
}
if (!['member', 'manager', 'admin'].includes(role)) {
  console.error(`role must be member, manager or admin (got ${role})`);
  process.exit(1);
}

await query(
  `INSERT INTO users (email, name, role, status, can_send_as_shared)
   VALUES ($1,$2,$3,'active', $3 = 'admin')
   ON CONFLICT (email) DO UPDATE SET
     role = EXCLUDED.role,
     status = 'active',
     can_send_as_shared = EXCLUDED.can_send_as_shared,
     name = COALESCE(EXCLUDED.name, users.name)`,
  [email.toLowerCase(), name ?? null, role],
);
console.log(`user ready: ${email} (role=${role}) -- sign in with Continue with Google`);
await closePool();
