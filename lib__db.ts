import { Pool, PoolClient } from 'pg';

let pool: Pool | null = null;
export function getPool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada.');
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8, idleTimeoutMillis: 30000, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  return pool;
}
export async function query<T = any>(text: string, params: unknown[] = []) {
  return getPool().query<T>(text, params);
}
export async function tx<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
