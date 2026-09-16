// Рабочая таблица контент-аудита: что сейчас в БД и что предлагается записать.
//
// Печатает CSV в base64 — иначе кириллица и эмодзи по дороге через ssh
// превращаются в мусор. Локально: расшифровать в .csv и открыть.
//
// Запуск: node scripts/catalog-content-report.js
import { pool, query } from '../db.js';
import { DESCRIPTIONS, NUTRITION, BADGES, SOURCES, REASONS } from './catalog-content-data.js';

const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';

const run = async () => {
  const { rows } = await query(
    `SELECT p.id, p.title, p.category, p.weight, p.price, p.composition, p.nutrition,
            COALESCE(
              (SELECT string_agg(b.label || ' ' || COALESCE(b.icon, ''), ' + ' ORDER BY b.sort_order)
                 FROM product_badges pb JOIN badges b ON b.id = pb.badge_id
                WHERE pb.product_id = p.id),
              ''
            ) AS cur_badges
       FROM products p
      WHERE p.category <> 'bundles'
      ORDER BY p.category, p.title`
  );

  const head = ['ID', 'Название', 'Категория', 'Вес', 'Цена', 'Описание сейчас', 'Описание станет',
    'БЖУ сейчас', 'БЖУ станет', 'Бейджи сейчас', 'Бейджи станут', 'Почему', 'Источник'];
  const out = [head.map(cell).join(';')];

  const nutStr = (n) => (n && n.calories != null
    ? `${n.calories} ккал / Б ${n.protein} / Ж ${n.fat} / У ${n.carbs}` : '');

  for (const r of rows) {
    const curEntry = Array.isArray(r.composition) ? r.composition[0] : null;
    const curDesc = Array.isArray(curEntry) ? curEntry[0] : (curEntry || '');
    const newDesc = DESCRIPTIONS[r.id] || '';
    const newNut = NUTRITION[r.id];
    const newBadges = BADGES[r.id];
    out.push([
      r.id, r.title, r.category, r.weight, r.price,
      curDesc,
      newDesc || '— без изменений',
      nutStr(r.nutrition),
      newNut ? nutStr(newNut) : '— без изменений',
      r.cur_badges,
      newBadges ? newBadges.map(([l, i]) => l + ' ' + i).join(' + ') : '— не назначаем',
      REASONS[r.id] || '',
      [newDesc ? SOURCES.description : '', newNut ? SOURCES.nutrition : ''].filter(Boolean).join(' / '),
    ].map(cell).join(';'));
  }

  const csv = '\uFEFF' + out.join('\r\n');
  console.log('СТРОК: ' + rows.length);
  console.log('BASE64_START');
  console.log(Buffer.from(csv, 'utf8').toString('base64'));
  console.log('BASE64_END');
  await pool.end();
};

run().catch((e) => { console.error('ОШИБКА:', e); process.exitCode = 1; });
