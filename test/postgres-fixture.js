import { PGlite } from '@electric-sql/pglite';
import { migratePostgres } from '../src/postgres.js';
import { postgresAdapter } from '../src/db-adapter.js';

export async function postgresFixture() {
  const engine = new PGlite();
  const wrap = connection => ({
    unsafe: async (sql, args = []) => {
      const results = args.length ? [await connection.query(sql, args)] : await connection.exec(sql);
      const last = results.at(-1);
      const rows = last?.rows ?? [];
      rows.count = last?.affectedRows ?? rows.length;
      return rows;
    },
    begin: fn => connection.transaction(tx => fn(wrap(tx))),
    end: () => engine.close(),
  });
  const client = wrap(engine);
  await migratePostgres(client);
  await client.unsafe('SET search_path TO grimorio');
  const adapter = postgresAdapter(client);
  adapter.prepare = sql => ({
    get: (...args) => adapter.get(sql, ...args),
    all: (...args) => adapter.all(sql, ...args),
    run: (...args) => adapter.run(sql, ...args),
  });
  return { adapter, client };
}
