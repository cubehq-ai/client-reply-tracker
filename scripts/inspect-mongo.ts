import { inspectInternalMongo } from '../src/sync/internalMongo.js';
const res = await inspectInternalMongo();
console.log('database:', res.database);
console.log('credential:', JSON.stringify(res.credential));
console.log('\nlikely clients  :', res.likelyClients.join(', ') || '(none)');
console.log('likely employees:', res.likelyEmployees.join(', ') || '(none)');
console.log('\ncollections:');
for (const c of res.collections) {
  console.log(`  ${c.name.padEnd(32)} ${String(c.count).padStart(7)} docs  ${c.fields.slice(0, 14).join(', ')}`);
}
