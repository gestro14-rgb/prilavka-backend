import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

// Railway предоставляет переменную DATABASE_URL автоматически при подключении PostgreSQL
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('ОШИБКА: переменная окружения DATABASE_URL не задана.');
  console.error('На Railway: добавьте сервис PostgreSQL в проект — переменная подключится автоматически.');
}

export const pool = new Pool({
  connectionString,
  ssl: connectionString && connectionString.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

export async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}
