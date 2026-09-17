import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
const { Pool } = pg;
const url = process.env.DATABASE_URL;
if (!url) { console.warn('DATABASE_URL ausente: migração adiada.'); process.exit(0); }
const pool = new Pool({ connectionString: url, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
try {
  const sql = await fs.readFile(path.join(process.cwd(), 'sql/001_init.sql'), 'utf8');
  await pool.query(sql);
  console.log('Database schema ready.');
} catch (e) { console.error('Migration failed:', e); process.exit(1); } finally { await pool.end(); }
