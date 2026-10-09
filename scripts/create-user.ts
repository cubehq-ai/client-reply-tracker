import { closePool, query } from '../src/db/pool.js';
import { hashPassword } from '../src/api/auth.js';

const [email, password, role = 'admin', name] = process.argv.slice(2);
if (!email || !password) {
  console.error('usage: tsx scripts/create-user.ts <email> <password> [role] [name]');
  process.exit(1);
}

const hash = await hashPassword(password);
await query(
  `INSERT INTO users (email, name, role, status, password_hash, password_set_at, can_send_as_shared)
   VALUES ($1,$2,$3,'active',$4, now(), true)
   ON CONFLICT (email) DO UPDATE SET
     password_hash = EXCLUDED.password_hash,
     password_set_at = now(),
     role = EXCLUDED.role,
     status = 'active',
     can_send_as_shared = true,
     name = COALESCE(EXCLUDED.name, users.name)`,
  [email.toLowerCase(), name ?? null, role, hash],
);
console.log(`user ready: ${email} (role=${role})`);
await closePool();
