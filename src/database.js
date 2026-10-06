import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => readFileSync(resolve(root, 'database', name), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
export function openDatabase(path = resolve(root, 'data/magias.sqlite')) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) throw new Error('Banco possui versão mais recente que esta API.');
    if (version === 0) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) throw new Error('Banco sem versão contém tabelas. Use um banco novo ou o catálogo versão 1.');
      // Schema e carga são separados; numa falha de carga, o schema é removido.
      db.exec(read('001-catalog.sql'));
      try { db.exec(read('seed.sql')); }
      catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        db.exec('PRAGMA foreign_keys=OFF');
        for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) db.exec(`DROP TABLE "${name.replaceAll('"','""')}"`);
        db.exec('PRAGMA user_version=0; PRAGMA foreign_keys=ON');
        throw error;
      }
    }
    if (db.prepare('PRAGMA user_version').get().user_version === 1) db.exec(read('002-sessions.sql'));
    if (path !== ':memory:') db.exec('PRAGMA journal_mode=WAL;');
    return db;
  } catch (error) { db.close(); throw error; }
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
