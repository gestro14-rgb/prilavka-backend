// Разовое применение контент-аудита каталога: описания, БЖУ, бейджи.
//
// Пишет ТОЛЬКО перечисленные ниже товары и только те поля, которые для них
// заданы. Никаких массовых UPDATE по всей таблице: список закрытый,
// сверенный с аудит-файлом catalog_content_audit.csv.
//
// Что именно пишется и почему — в scripts/catalog-content-data.js.
//
// Запуск: node scripts/apply-catalog-content.js [--dry]
import jwt from 'jsonwebtoken';
import { pool, query } from '../db.js';
import { DESCRIPTIONS, NUTRITION, BADGES } from './catalog-content-data.js';

const DRY = process.argv.includes('--dry');

const url = 'http://127.0.0.1:' + (process.env.PORT || 3001);
const token = jwt.sign({ sub: 0, username: 'catalog-content' }, process.env.JWT_SECRET, { expiresIn: '20m' });
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

const run = async () => {
  const before = await query('SELECT COUNT(*)::int AS n FROM products');
  const beforeLinks = await query('SELECT COUNT(*)::int AS n FROM product_badges');
  console.log(`до: товаров ${before.rows[0].n}, связей с бейджами ${beforeLinks.rows[0].n}`);
  if (DRY) console.log('=== ПРОГОН БЕЗ ЗАПИСИ ===');

  // 1. Описания — подменяем только первую строку composition
  let descDone = 0;
  for (const [id, text] of Object.entries(DESCRIPTIONS)) {
    const r = await query('SELECT composition FROM products WHERE id = $1', [String(id)]);
    if (!r.rows[0]) { console.log('НЕТ ТОВАРА: ' + id); continue; }
    const comp = Array.isArray(r.rows[0].composition) ? [...r.rows[0].composition] : [];
    // Первая строка — описание, остальные (если есть) — состав, не трогаем.
    const rest = comp.length > 0 ? comp.slice(1) : [];
    const next = [[text, ''], ...rest];
    if (!DRY) await query('UPDATE products SET composition = $1 WHERE id = $2', [JSON.stringify(next), String(id)]);
    descDone += 1;
  }
  console.log('описаний записано: ' + descDone);

  // 2. БЖУ
  let nutDone = 0;
  for (const [id, n] of Object.entries(NUTRITION)) {
    const bad = [n.calories, n.protein, n.fat, n.carbs].some((v) => typeof v !== 'number' || v < 0);
    if (bad) { console.log('НЕВАЛИДНОЕ БЖУ: ' + id); continue; }
    if (!DRY) await query('UPDATE products SET nutrition = $1 WHERE id = $2', [JSON.stringify(n), String(id)]);
    nutDone += 1;
  }
  console.log('БЖУ записано: ' + nutDone);

  // 3. Бейджи — через admin API, как из формы товара
  const lib = await (await fetch(url + '/api/admin/badges', { headers: H })).json();
  const findId = (label, icon) => lib.find((b) => b.label === label && (b.icon || '') === icon)?.id;
  let badgeProducts = 0;
  let badgeLinks = 0;
  for (const [id, list] of Object.entries(BADGES)) {
    const ids = list.map(([l, i]) => findId(l, i)).filter(Boolean);
    if (ids.length !== list.length) { console.log('НЕ НАЙДЕН БЕЙДЖ для ' + id + ': ' + JSON.stringify(list)); continue; }
    if (!DRY) {
      const res = await fetch(url + '/api/admin/products/' + encodeURIComponent(id) + '/badges', {
        method: 'PUT', headers: H, body: JSON.stringify({ badgeIds: ids }),
      });
      if (res.status !== 200) { console.log('ОШИБКА бейджей ' + id + ': ' + res.status); continue; }
    }
    badgeProducts += 1;
    badgeLinks += ids.length;
  }
  console.log('товаров с бейджами: ' + badgeProducts + ', связей: ' + badgeLinks);

  const after = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE nutrition IS NOT NULL)::int AS with_nut
       FROM products WHERE category <> 'bundles'`
  );
  const afterLinks = await query('SELECT COUNT(*)::int AS n FROM product_badges');
  console.log(`после: товаров ${after.rows[0].total}, с БЖУ ${after.rows[0].with_nut}, связей ${afterLinks.rows[0].n}`);
  await pool.end();
};

run().catch((e) => { console.error('ОШИБКА:', e); process.exitCode = 1; });
