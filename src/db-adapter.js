import { AsyncLocalStorage } from 'node:async_hooks';

// A conexão da transação pertence ao contexto assíncrono da requisição.
export function sqliteAdapter(raw) {
  const context = new AsyncLocalStorage();
  let pending = Promise.resolve();
  async function exclusive(fn) {
    const previous = pending;
    let release;
    pending = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
  const execute = fn => context.getStore() ? Promise.resolve().then(fn) : exclusive(fn);
  return {
    dialect: 'sqlite',
    get: (sql, ...args) => execute(() => raw.prepare(sql).get(...args)),
    all: (sql, ...args) => execute(() => raw.prepare(sql).all(...args)),
    run: (sql, ...args) => execute(() => raw.prepare(sql).run(...args)),
    version: async () => raw.prepare('PRAGMA user_version').get().user_version,
    transaction: fn => exclusive(() => context.run(true, async () => {
      raw.exec('BEGIN IMMEDIATE');
      try { const result = await fn(); raw.exec('COMMIT'); return result; }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
    })),
    close: async () => raw.close(),
  };
}

export const adaptDatabase = db => db.dialect ? db : sqliteAdapter(db);

export function postgresQuery(sql) {
  let index = 0;
  // Preserva literais SQL, inclusive apóstrofos escapados, ao numerar parâmetros.
  return sql.replace(/'(?:''|[^'])*'|\?|\bAS\s+([a-zA-Z][a-zA-Z0-9]*)/g, (match, alias) => {
    if (match === '?') return `$${++index}`;
    return alias && /[A-Z]/.test(alias) ? `AS "${alias}"` : match;
  });
}

export function postgresAdapter(client) {
  const context = new AsyncLocalStorage();
  const query = (sql, args) => (context.getStore() ?? client).unsafe(postgresQuery(sql), args);
  return {
    dialect: 'postgres',
    get: async (sql, ...args) => (await query(sql, args))[0],
    all: async (sql, ...args) => Array.from(await query(sql, args)),
    run: async (sql, ...args) => {
      const insert = /^\s*INSERT\s+INTO\s+(users|sources|classes|spells|class_spells|characters)\b/i.test(sql);
      const rows = await query(insert ? `${sql} RETURNING id` : sql, args);
      return { lastInsertRowid: rows[0]?.id, changes: rows.count ?? rows.length };
    },
    version: async () => (await query('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations', []))[0].version,
    transaction: fn => client.begin(tx => context.run(tx, fn)),
    close: () => client.end({ timeout: 5 }),
  };
}
