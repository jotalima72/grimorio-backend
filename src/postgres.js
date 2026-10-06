import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { postgresAdapter } from './db-adapter.js';

const read = name => readFileSync(new URL(`../database/${name}`, import.meta.url), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
export const postgresSchema = () => read('postgres/001-schema.sql');
export const postgresSeed = () => read('seed.sql').replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, '');

export async function migratePostgres(client) {
  await client.begin(async tx => {
    // Serializa migrações quando duas instâncias iniciam juntas.
    await tx.unsafe('SELECT pg_advisory_xact_lock(735501)');
    await tx.unsafe('CREATE SCHEMA IF NOT EXISTS grimorio');
    await tx.unsafe('SET LOCAL search_path TO grimorio');
    await tx.unsafe('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const schema = postgresSchema(), seed = postgresSeed();
    const checksum = createHash('sha256').update(schema).update(seed).digest('hex');
    const rows = await tx.unsafe('SELECT version,checksum FROM schema_migrations ORDER BY version');
    if (rows.some(row => row.version > 1)) throw new Error('Banco PostgreSQL possui versão mais recente que esta API.');
    if (rows.length) {
      if (rows[0].checksum !== checksum) throw new Error('A migração aplicada foi alterada. Crie uma nova migração.');
      return;
    }
    await tx.unsafe(schema);
    await tx.unsafe(seed);
    for (const table of ['users','sources','schools','classes','spells','class_spells','characters']) {
      await tx.unsafe(`SELECT setval(pg_get_serial_sequence('${table}','id'), COALESCE((SELECT MAX(id) FROM ${table}),1), EXISTS(SELECT 1 FROM ${table}))`);
    }
    await tx.unsafe('INSERT INTO schema_migrations(version,checksum) VALUES(1,$1)', [checksum]);
  });
}

export async function openPostgres(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('Configure DATABASE_URL para conectar ao PostgreSQL.');
  const max = Number(process.env.DATABASE_POOL_MAX ?? 5);
  if (!Number.isInteger(max) || max < 1 || max > 20) throw new Error('DATABASE_POOL_MAX deve estar entre 1 e 20.');
  const client = postgres(url, {
    ssl: process.env.DATABASE_SSL === 'disable' ? false : 'require',
    max, prepare: false, connect_timeout: 15, idle_timeout: 20,
    connection: { search_path: 'grimorio', application_name: 'grimorio-api' },
    types: { bigint: { to: 20, from: [20], serialize: String, parse: value => {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error('Inteiro fora do intervalo seguro.');
      return number;
    } } },
  });
  try { await migratePostgres(client); return postgresAdapter(client); }
  catch (error) { await client.end({ timeout: 5 }); throw error; }
}
