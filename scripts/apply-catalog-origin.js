// Разовое применение происхождения: products.origin + чистка названий.
//
// Порядок жёсткий: сначала снимок текущего состояния в файл, потом запись.
// Снимок печатается в base64 — из него можно восстановить любое название,
// если что-то пойдёт не так.
//
// Трогает ровно две колонки: origin и title, и только у перечисленных в
// catalog-origin-data.js товаров. Ни цены, ни остатков, ни состава, ни
// бейджей, ни наборов. Наборы в выборку не попадают вовсе.
//
// Запуск: node scripts/apply-catalog-origin.js [--dry]
import { pool, query } from '../db.js';
import { ORIGINS, SKIPPED } from './catalog-origin-data.js';

const DRY = process.argv.includes('--dry');

const run = async () => {
  // 1. Снимок «до» — id, название, происхождение по всем обычным товарам.
  const before = await query(
    `SELECT id, title, origin, category FROM products WHERE category <> 'bundles' ORDER BY id`
  );
  const bundles = await query(`SELECT COUNT(*)::int AS n FROM products WHERE category = 'bundles'`);
  console.log(`обычных товаров: ${before.rows.length}, наборов: ${bundles.rows[0].n} (их не трогаем)`);
  console.log('с origin до записи: ' + before.rows.filter((r) => r.origin).length);
  console.log('СНИМОК_ДО_START');
  console.log(Buffer.from(JSON.stringify(before.rows), 'utf8').toString('base64'));
  console.log('СНИМОК_ДО_END');

  const known = new Map(before.rows.map((r) => [r.id, r]));
  if (DRY) console.log('=== ПРОГОН БЕЗ ЗАПИСИ ===');

  // 2. Запись. LOW не пишем вовсе — но в данных таких и нет, проверяем явно.
  let originsSet = 0;
  let titlesCleaned = 0;
  const changes = [];
  for (const [id, plan] of Object.entries(ORIGINS)) {
    const cur = known.get(id);
    if (!cur) { console.log('НЕТ ТАКОГО ТОВАРА (или это набор): ' + id); continue; }
    if (plan.confidence === 'LOW') { console.log('ПРОПУСК, уверенность LOW: ' + id); continue; }

    const newTitle = plan.title && plan.title !== cur.title ? plan.title : null;
    if (!DRY) {
      // Два поля одним UPDATE: title меняем только когда он реально другой,
      // иначе COALESCE оставляет прежний.
      await query('UPDATE products SET origin = $1, title = COALESCE($2, title) WHERE id = $3',
        [plan.origin, newTitle, id]);
    }
    originsSet += 1;
    if (newTitle) titlesCleaned += 1;
    changes.push({ id, was: cur.title, now: newTitle || cur.title, origin: plan.origin, conf: plan.confidence });
  }

  console.log('origin записан: ' + originsSet);
  console.log('названий очищено: ' + titlesCleaned);
  for (const c of changes.filter((x) => x.was !== x.now)) {
    console.log('  «' + c.was + '» → «' + c.now + '»  [' + c.origin + ']');
  }
  console.log('осознанно без origin: ' + Object.keys(SKIPPED).length);

  // 3. Контроль: у скольких товаров origin есть теперь.
  const after = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE origin IS NOT NULL AND origin <> '')::int AS with_origin
       FROM products WHERE category <> 'bundles'`
  );
  const bundleOrigin = await query(
    `SELECT COUNT(*)::int AS n FROM products WHERE category = 'bundles' AND origin IS NOT NULL`
  );
  console.log(`после: товаров ${after.rows[0].total}, с origin ${after.rows[0].with_origin}`);
  console.log('наборов с origin: ' + bundleOrigin.rows[0].n + ' (должно быть 0)');
  await pool.end();
};

run().catch((e) => { console.error('ОШИБКА:', e); process.exitCode = 1; });
