// Разовый экспорт товаров в CSV (id, name, category) — использует уже
// настроенный пул из db.js, не читает .env напрямую.
import { pool, query } from './db.js';
import { writeFileSync } from 'fs';

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const result = await query('SELECT id, title, category FROM products ORDER BY id');
const lines = ['id,name,category'];
for (const row of result.rows) {
  lines.push([csvEscape(row.id), csvEscape(row.title), csvEscape(row.category)].join(','));
}
writeFileSync(new URL('./products-export.csv', import.meta.url), lines.join('\n') + '\n', 'utf-8');
console.log(`Экспортировано товаров: ${result.rows.length}`);
await pool.end();
