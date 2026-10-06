import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresFixture } from './postgres-fixture.js';
import { migratePostgres } from '../src/postgres.js';
import { openDatabase } from '../src/database.js';
import { postgresQuery } from '../src/db-adapter.js';

test('PostgreSQL: migração repetível, sequências, texto intacto e rollback', async t => {
  const { adapter: db, client } = await postgresFixture();
  t.after(() => db.close());
  await migratePostgres(client);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM schema_migrations')).n, 1);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM spells')).n, 391);
  const sqlite = openDatabase(':memory:');
  try {
    const columns = 'id,name,components_text,casting_time_text,range_text,duration_text,description_text,source_school_text,original_entry_json';
    assert.deepEqual(await db.all(`SELECT ${columns} FROM spells ORDER BY id`), sqlite.prepare(`SELECT ${columns} FROM spells ORDER BY id`).all().map(row => ({ ...row })));
  } finally { sqlite.close(); }
  await assert.rejects(db.transaction(async () => {
    await db.run("INSERT INTO users(name,email,password_hash) VALUES('Rollback','rollback@example.test','hash')");
    throw new Error('rollback');
  }), /rollback/);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM users')).n, 0);
  const inserted = await db.run("INSERT INTO sources(name,kind) VALUES('Novo compêndio','compendium')");
  assert.ok(inserted.lastInsertRowid > 1);
  await assert.rejects(db.run('UPDATE spells SET source_id=? WHERE id=1', inserted.lastInsertRowid), /imutável/);
});

test('parâmetros PostgreSQL preservam literais e aliases do contrato', () => {
  assert.equal(postgresQuery("SELECT '?' AS text,owner_user_id AS ownerUserId FROM sources WHERE id=? AND name='It''s ?'"), "SELECT '?' AS text,owner_user_id AS \"ownerUserId\" FROM sources WHERE id=$1 AND name='It''s ?'");
});
