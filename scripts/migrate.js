import { openPostgres } from '../src/postgres.js';
const db = await openPostgres();
try { console.log(`PostgreSQL pronto. Migração ${await db.version()}; ${(await db.get('SELECT COUNT(*) AS n FROM spells')).n} magias.`); }
finally { await db.close(); }
