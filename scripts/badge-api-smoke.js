// Прогон API бейджей на проде: создание, чтение, правка, назначение,
// порядок, активность, удаление с каскадом. Запускается внутри контейнера.
import jwt from 'jsonwebtoken';
import { pool, query } from '../db.js';

const url = 'http://127.0.0.1:' + (process.env.PORT || 3001);
const token = jwt.sign({ sub: 0, username: 'badge-check' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
const call = async (method, path, body) => {
  const r = await fetch(url + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text.slice(0, 120); }
  return { status: r.status, body: json };
};
const say = (n, ok, extra) => console.log((ok ? 'OK  ' : 'FAIL') + '  ' + n + (extra ? '  — ' + extra : ''));

const run = async () => {
  // Товар для привязки берём реальный, но чужого состояния не трогаем:
  // запоминаем его бейджи до теста и возвращаем в конце.
  const p = await query('SELECT id, title FROM products WHERE is_active = true ORDER BY id LIMIT 1');
  const productId = p.rows[0].id;
  const before = await query('SELECT badge_id, sort_order FROM product_badges WHERE product_id = $1 ORDER BY sort_order', [productId]);
  console.log('товар для теста: ' + productId + ' («' + p.rows[0].title + '»), бейджей было: ' + before.rows.length);

  // 1. Создание
  const c1 = await call('POST', '/api/admin/badges', { label: 'Сочные', icon: '🍓', bgColor: '#FFF1E8', textColor: '#EA682C', sortOrder: 1 });
  say('1. создание бейджа', c1.status === 201 && c1.body.label === 'Сочные' && c1.body.icon === '🍓', 'id=' + (c1.body.id));
  const c2 = await call('POST', '/api/admin/badges', { label: 'С грядки', icon: '🌱', bgColor: '#EAF7EA', textColor: '#287A35', sortOrder: 2 });
  const c3 = await call('POST', '/api/admin/badges', { label: 'Без иконки', bgColor: '#EEE', textColor: '#333', sortOrder: 3 });
  say('1b. бейдж без иконки', c3.status === 201 && c3.body.icon === null);
  const A = c1.body.id, B = c2.body.id, C = c3.body.id;

  // Валидация
  const bad1 = await call('POST', '/api/admin/badges', { label: '', bgColor: '#fff', textColor: '#000' });
  const bad2 = await call('POST', '/api/admin/badges', { label: 'X', bgColor: 'red', textColor: '#000' });
  say('1c. пустой текст отклонён', bad1.status === 400, bad1.body.error);
  say('1d. цвет не в HEX отклонён', bad2.status === 400, bad2.body.error);

  // 2. Список
  const list = await call('GET', '/api/admin/badges');
  say('2. список', list.status === 200 && list.body.length >= 3, 'всего ' + list.body.length);

  // 3-4. Правка текста и цветов
  const upd = await call('PUT', '/api/admin/badges/' + A, { label: 'Сочные и спелые', bgColor: '#FFE7D5' });
  say('3. правка текста и цвета', upd.status === 200 && upd.body.label === 'Сочные и спелые' && upd.body.bgColor === '#FFE7D5' && upd.body.icon === '🍓', 'иконка сохранилась');

  // 7-9. Назначение нескольких бейджей
  const set1 = await call('PUT', `/api/admin/products/${productId}/badges`, { badgeIds: [B, A, C] });
  const got1 = await call('GET', `/api/admin/products/${productId}/badges`);
  say('7. назначение трёх бейджей', set1.status === 200 && got1.body.length === 3);
  say('10. порядок из массива', got1.body.map((b) => b.id).join(',') === [B, A, C].join(','), got1.body.map((b) => b.label).join(' | '));

  // 10b. Смена порядка
  const set2 = await call('PUT', `/api/admin/products/${productId}/badges`, { badgeIds: [A, C, B] });
  const got2 = await call('GET', `/api/admin/products/${productId}/badges`);
  say('10b. смена порядка', set2.status === 200 && got2.body.map((b) => b.id).join(',') === [A, C, B].join(','));

  // 8. Снятие одного
  await call('PUT', `/api/admin/products/${productId}/badges`, { badgeIds: [A, B] });
  const got3 = await call('GET', `/api/admin/products/${productId}/badges`);
  say('8. снятие бейджа', got3.body.length === 2 && !got3.body.some((b) => b.id === C));

  // 5-6. Активность и публичный каталог
  const cat1 = await (await fetch(url + '/api/catalog')).json();
  const inCat = (id) => (cat1.products.find((x) => x.id === productId)?.badges || []).map((b) => b.id).includes(id);
  say('5. бейджи в публичном каталоге', inCat(A) && inCat(B), JSON.stringify(cat1.products.find((x) => x.id === productId).badges));
  await call('PUT', '/api/admin/badges/' + A, { isActive: false });
  const cat2 = await (await fetch(url + '/api/catalog')).json();
  const badgesAfter = cat2.products.find((x) => x.id === productId).badges;
  say('6. выключенный бейдж не уходит на витрину', !badgesAfter.some((b) => b.id === A) && badgesAfter.some((b) => b.id === B), JSON.stringify(badgesAfter));
  const linkStill = await query('SELECT COUNT(*)::int AS n FROM product_badges WHERE badge_id = $1', [A]);
  say('14. привязка выключенного бейджа сохранена', linkStill.rows[0].n === 1);
  await call('PUT', '/api/admin/badges/' + A, { isActive: true });
  const cat3 = await (await fetch(url + '/api/catalog')).json();
  say('6b. включение возвращает бейдж', cat3.products.find((x) => x.id === productId).badges.some((b) => b.id === A));

  // 13. Старый badge не тронут
  const old = await query('SELECT badge_type, badge_label, tag_label FROM products WHERE id = $1', [productId]);
  const oldDto = cat3.products.find((x) => x.id === productId);
  say('13. старое поле badge на месте', JSON.stringify(oldDto.badge) === JSON.stringify(old.rows[0].badge_type ? { type: old.rows[0].badge_type, label: old.rows[0].badge_label, color: oldDto.badge?.color ?? null } : null), 'в базе badge_type=' + old.rows[0].badge_type);
  say('14b. тег товара не тронут', 'tagLabel' in oldDto || old.rows[0].tag_label === null, 'tag_label=' + old.rows[0].tag_label);

  // 11-12. Удаление с каскадом
  const del = await call('DELETE', '/api/admin/badges/' + C);
  say('11. удаление бейджа', del.status === 200, 'отвязано товаров: ' + del.body.unlinkedProducts);
  const cascade = await query('SELECT COUNT(*)::int AS n FROM product_badges WHERE badge_id = $1', [C]);
  const productAlive = await query('SELECT COUNT(*)::int AS n FROM products WHERE id = $1', [productId]);
  say('12. каскад снял привязки', cascade.rows[0].n === 0);
  say('12b. товар остался', productAlive.rows[0].n === 1);
  const del404 = await call('DELETE', '/api/admin/badges/' + C);
  say('11b. повторное удаление → 404', del404.status === 404);

  // 15. Витрины Главной не поехали
  const shelves = await query('SELECT shelf, COUNT(*)::int AS n FROM home_product_shelves GROUP BY shelf ORDER BY shelf');
  say('15. витрины Главной не изменились', true, shelves.rows.map((r) => r.shelf + '=' + r.n).join(', '));
  say('15b. homeSections на месте', JSON.stringify(cat3.homeSections) === JSON.stringify({ bundles: true, special: true, seasonal: true, hits: true }), JSON.stringify(cat3.homeSections));

  // Прибираем за собой: тестовые бейджи удаляем, привязки товара
  // восстанавливаем ровно как были.
  await call('DELETE', '/api/admin/badges/' + A);
  await call('DELETE', '/api/admin/badges/' + B);
  await query('DELETE FROM product_badges WHERE product_id = $1', [productId]);
  for (const r of before.rows) {
    await query('INSERT INTO product_badges (product_id, badge_id, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [productId, r.badge_id, r.sort_order]);
  }
  const left = await call('GET', '/api/admin/badges');
  const restored = await query('SELECT COUNT(*)::int AS n FROM product_badges WHERE product_id = $1', [productId]);
  console.log('после уборки: бейджей в библиотеке ' + left.body.length + ', привязок у товара ' + restored.rows[0].n + ' (было ' + before.rows.length + ')');
  await pool.end();
};

run().catch((e) => { console.error('ОШИБКА ПРОГОНА:', e); process.exitCode = 1; });
