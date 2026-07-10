// Разовый импорт пищевой ценности из product_nutrition.csv в products.nutrition
// (JSONB) — маппинг по id. Строки с пустыми calories/protein/fat/carbs (наборы —
// составные товары) пропускаются: nutrition остаётся NULL, блок на фронте не
// рендерится (см. migrations/022_product_nutrition.sql).
//
// Использование: node import-nutrition-csv.js [путь-к-csv]
import { pool, query } from './db.js';
import { readFileSync } from 'fs';

const csvPath = process.argv[2] || new URL('./product_nutrition.csv', import.meta.url);
const raw = readFileSync(csvPath, 'utf-8');
const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
const header = lines[0].split(',');
const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));

const rows = lines.slice(1).map((line) => {
  const cols = line.split(',');
  return {
    id: cols[idx.id],
    title: cols[idx.title],
    calories: cols[idx.calories_kcal_per_100g],
    protein: cols[idx.protein_g_per_100g],
    fat: cols[idx.fat_g_per_100g],
    carbs: cols[idx.carbs_g_per_100g],
  };
});

const toSkip = [];
const toUpdate = [];
for (const row of rows) {
  const values = [row.calories, row.protein, row.fat, row.carbs];
  const allEmpty = values.every((v) => v === undefined || v === '');
  if (allEmpty) {
    toSkip.push(row);
    continue;
  }
  const nutrition = {
    calories: Number(row.calories),
    protein: Number(row.protein),
    fat: Number(row.fat),
    carbs: Number(row.carbs),
  };
  toUpdate.push({ id: row.id, title: row.title, nutrition });
}

console.log(`Строк в CSV: ${rows.length}`);
console.log(`Пропущено (составные товары, nutrition остаётся NULL): ${toSkip.length}`);
toSkip.forEach((r) => console.log(`  · ${r.id} — ${r.title}`));
console.log(`К обновлению: ${toUpdate.length}`);

let updated = 0;
let notFound = [];
for (const row of toUpdate) {
  const result = await query(
    'UPDATE products SET nutrition = $1::jsonb WHERE id = $2',
    [JSON.stringify(row.nutrition), row.id]
  );
  if (result.rowCount === 0) {
    notFound.push(row.id);
  } else {
    updated++;
  }
}

console.log(`\nОбновлено строк в БД: ${updated}`);
if (notFound.length) {
  console.log(`НЕ найдено в products (id не совпал): ${notFound.length}`);
  notFound.forEach((id) => console.log(`  · ${id}`));
}

await pool.end();
