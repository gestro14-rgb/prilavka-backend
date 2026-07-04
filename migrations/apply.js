// Ручной прогон одного SQL-файла миграции через уже настроенный пул (db.js),
// раз автораннера миграций нет. Использование: node migrations/apply.js 014_fix_supplier_data_and_hit_badge.sql
import { readFileSync } from 'fs';
import { pool, query } from '../db.js';

const file = process.argv[2];
if (!file) {
  console.error('Использование: node migrations/apply.js <файл.sql>');
  process.exit(1);
}

const sql = readFileSync(new URL(file, import.meta.url), 'utf-8');
query(sql)
  .then(() => console.log(`Применено: ${file}`))
  .catch((e) => { console.error('Ошибка миграции:', e); process.exitCode = 1; })
  .finally(() => pool.end());
