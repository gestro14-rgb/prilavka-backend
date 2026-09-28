// Проверка формирования Telegram-уведомления о заказе БЕЗ создания заказа и
// без единой записи в БД: вырезаем из server.js сами функции форматирования
// и прогоняем их на подготовленных позициях.
//
// Годится и локально, и внутри прод-контейнера (railway ssh): читается только
// исходник и, если попросить, каталог товаров — на чтение.
import fs from 'fs';

const src = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');

// Вырезаем ровно три функции. Границы — по сигнатурам: если их переименуют,
// скрипт упадёт здесь, а не тихо проверит пустоту.
function cut(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a === -1 || b === -1) throw new Error(`не найден фрагмент: ${from}`);
  return src.slice(a, b);
}
const code = [
  cut('function escapeHtml(text) {', '\n// Уведомление админу'),
  cut('function formatOrderItem(item, ambiguousTitles) {', '\n// Формирует читаемое'),
  cut('function formatOrderNotification(order) {', '\n// ============================================================\n// Публичные маршруты'),
].join('\n');

const { formatOrderNotification, formatOrderItem, ambiguousTitlesOf, escapeHtml } =
  new Function(`${code}\nreturn { formatOrderNotification, formatOrderItem, ambiguousTitlesOf, escapeHtml };`)();

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}${detail && !ok ? ' → ' + detail : ''}`);
  if (!ok) failed++;
};

const baseOrder = {
  id: 7777,
  total: 1119,
  discount_amount: 0,
  delivery_date: { day: 'Понедельник', date: '29 сентября' },
  delivery_slot: '18:00–21:00',
  address_street: 'Профсоюзная улица, 142',
  address_details: { entrance: '2', floor: '5', apartment: '77', intercom: '77K', comment: 'код <сломан>' },
  phone: '+79990000001',
  comment: 'позвонить за 10 минут',
  payment_method: 'cash',
  telegram_first_name: 'Тест',
  telegram_username: 'test_user',
};

// ── 1. Обычные позиции: вес, origin, ×2, штучная фасовка ─────────────────
const items = [
  { id: 'a', title: 'Помидоры Махитос', origin: 'Ростовская область', emoji: '🍅', weight: '500 г', qty: 2, sum: 360 },
  { id: 'b', title: 'Помидоры Махитос', origin: 'Азербайджан',        emoji: '🍅', weight: '1 кг',  qty: 1, sum: 240 },
  { id: 'c', title: 'Виноград кишмиш',  origin: 'Узбекистан',         emoji: '🍇', weight: '500 г', qty: 1, sum: 390 },
  { id: 'd', title: 'Яйцо куриное С1',  origin: null,                 emoji: '🥚', weight: '10 шт', qty: 1, sum: 129 },
];
const msg1 = formatOrderNotification({ ...baseOrder, items });

console.log('\n── Вес / фасовка / origin / количество ──');
check('фасовка «500 г» в скобках', msg1.includes('(500 г, Ростовская область) × 2'));
check('фасовка «1 кг» в скобках', msg1.includes('(1 кг, Азербайджан) × 1'));
check('штучная фасовка «10 шт» в скобках', msg1.includes('Яйцо куриное С1 (10 шт) × 1'));
check('origin показан у неоднозначного названия', msg1.includes('Ростовская область') && msg1.includes('Азербайджан'));
check('origin НЕ показан у однозначного названия', !msg1.includes('Виноград кишмиш (500 г, Узбекистан)') && msg1.includes('Виноград кишмиш (500 г) × 1'));
check('товар без origin не получил висячий разделитель', !/Яйцо куриное С1\s*·/.test(msg1));
check('два одинаковых названия различимы', msg1.includes('Помидоры Махитос (500 г, Ростовская область)') && msg1.includes('Помидоры Махитос (1 кг, Азербайджан)'));
check('×2 не превратилось в две строки', (msg1.match(/Ростовская область/g) || []).length === 1);
check('сумма позиции на месте', msg1.includes('× 2</b> — 360 ₽'));

// ── 2. Подарок: ровно один раз и только в своём блоке ────────────────────
const gift = { title: 'Бесплатная зелень', emoji: '🌿', qty: 1, sum: 0, isReward: true };
const msg2 = formatOrderNotification({ ...baseOrder, items: [...items, gift], total: 1119 });

console.log('\n── Подарок ──');
const giftMentions = (msg2.match(/Бесплатная зелень/g) || []).length;
check('подарок упомянут РОВНО один раз', giftMentions === 1, `найдено ${giftMentions}`);
check('блок подарка присутствует', msg2.includes('🎁 <b>ПОДАРОК — ПОЛОЖИТЬ В ЗАКАЗ:</b>'));
// Подарок обязан стоять ПОСЛЕ заголовка блока — то есть не попасть в список товаров выше.
check('подарок стоит внутри блока, а не в списке товаров',
  msg2.indexOf('Бесплатная зелень') > msg2.indexOf('ПОДАРОК — ПОЛОЖИТЬ В ЗАКАЗ'));
check('подарок не печатается строкой обычного товара', !msg2.includes('🌿 Бесплатная зелень\n<b>'));
check('без подарка блока нет', !msg1.includes('ПОДАРОК'));
check('нулевая сумма подарка не попала в разбивку как «— 0 ₽»', !msg2.includes('— 0 ₽'));

// Разделение — это раздел: ни одна позиция не может попасть в оба списка.
// Проверяем на всех вариантах флага, которые реально встречаются в снимках.
console.log('\n── Раздел товары / подарки (все варианты флага) ──');
for (const flag of [true, false, undefined, null, 'true', 0, 1]) {
  const probe = { title: `ПРОБА_${String(flag)}`, emoji: '🔸', weight: '1 шт', qty: 1, sum: 10, isReward: flag };
  const m = formatOrderNotification({ ...baseOrder, items: [probe] });
  const n = (m.match(/ПРОБА_/g) || []).length;
  check(`isReward=${JSON.stringify(flag)} → ровно одно вхождение`, n === 1, `найдено ${n}`);
}
// Только строгое true считается подарком — всё остальное остаётся товаром.
const strict = formatOrderNotification({ ...baseOrder, items: [{ title: 'X', qty: 1, sum: 1, weight: '1 шт', isReward: 'true' }] });
check('строковое "true" НЕ считается подарком (иначе платный товар станет бесплатным)', !strict.includes('ПОДАРОК'));

// ── 3. Изменённый набор ──────────────────────────────────────────────────
const bundle = {
  id: 'set', title: 'Овощной набор', emoji: '🧺', weight: '≈ 8 кг', qty: 1, sum: 2490, origin: null,
  selectedComposition: [
    { name: 'Картофель', emoji: '🥔', status: 'removed' },
    { name: 'Морковь',   emoji: '🥕', status: 'included' },
    { name: 'Лук',       emoji: '🧅', status: 'removed' },
  ],
};
const msg3 = formatOrderNotification({ ...baseOrder, items: [bundle], total: 2490 });
console.log('\n── Изменённый набор ──');
check('строка «↳ без: …» присутствует', msg3.includes('↳ без: Картофель, Лук'));
check('оставленные позиции в «без» не попали', !msg3.includes('Морковь'));
const plain = formatOrderNotification({ ...baseOrder, items: [{ ...bundle, selectedComposition: null }], total: 2490 });
check('у набора без изменений строки «без» нет', !plain.includes('↳ без'));

// ── 4. HTML в пользовательских полях ─────────────────────────────────────
console.log('\n── HTML-инъекция в пользовательских полях ──');
const nasty = '<b>жирный</b> & <script>alert(1)</script>';
const msg4 = formatOrderNotification({
  ...baseOrder,
  items: [{ id: 'a', title: nasty, origin: nasty, emoji: '🍅', weight: nasty, qty: 1, sum: 100 }],
  address_street: nasty,
  address_details: { entrance: nasty, floor: nasty, apartment: nasty, intercom: nasty, comment: nasty },
  comment: nasty,
  telegram_first_name: nasty,
  telegram_username: nasty,
  promo_code: nasty,
  discount_amount: 0,
});
// Разрешены только теги, которые ставит сам форматтер.
const tags = [...msg4.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g)].map((m) => m[1].toLowerCase());
const unexpected = [...new Set(tags)].filter((t) => t !== 'b');
check('в сообщении нет посторонних HTML-тегов', unexpected.length === 0, `найдены: ${unexpected.join(', ')}`);
check('<script> экранирован', !msg4.includes('<script>') && msg4.includes('&lt;script&gt;'));
check('амперсанд экранирован', msg4.includes('&amp;'));
const opens = (msg4.match(/<b>/g) || []).length, closes = (msg4.match(/<\/b>/g) || []).length;
check('теги <b> сбалансированы', opens === closes, `${opens} открывающих / ${closes} закрывающих`);

// ── 5. Точный состав production-заказа #0015 ─────────────────────────────
// Позиции скопированы из orders.items как они лежат в проде (снимок старого
// клиента: weight есть, origin/emoji нет — их достроит enrichOrderItems).
console.log('\n── Реальный состав заказа #0015 ──');
const o15 = formatOrderNotification({
  ...baseOrder,
  id: 15,
  total: 2209,
  items: [
    { id: 'perets-zelyonyy-salatnyy-1782676064138', qty: 10, sum: 1890, title: 'Перец, Градиент', weight: '500 г', origin: 'Краснодар', emoji: '🌿', unitPrice: 189 },
    { id: 'fasol-struchkovaya-1782676305948',       qty: 1,  sum: 319,  title: 'Фасоль стручковая', weight: '500 г', origin: 'Краснодар', emoji: '🥦', unitPrice: 319 },
    { qty: 1, sum: 0, emoji: '🥗', title: 'Бесплатная зелень', isReward: true },
  ],
});
console.log(o15.split('\n').slice(0, 8).join('\n'));
// toLocaleString('ru-RU') разделяет разряды неразрывным пробелом, а не обычным —
// сравниваем по нормализованным пробелам, иначе проверка ловит не формат, а юникод.
const flat = (s) => s.replace(/[\s  ]+/g, ' ');
check('строка перца ровно как просили', flat(o15).includes('• <b>Перец, Градиент (500 г) × 10</b> — 1 890 ₽'));
check('строка фасоли ровно как просили', o15.includes('• <b>Фасоль стручковая (500 г) × 1</b> — 319 ₽'));
check('origin «Краснодар» НЕ засоряет строки (названия разные)', !o15.includes('Краснодар'));
check('подарок отдельным блоком и один раз', (o15.match(/Бесплатная зелень/g) || []).length === 1 && o15.includes('🎁 <b>ПОДАРОК — ПОЛОЖИТЬ В ЗАКАЗ:</b>'));

// ── 6. Заказ с реальными данными каталога (только если есть БД) ──────────
if (process.env.VERIFY_WITH_CATALOG === '1') {
  console.log('\n── Прод-каталог (read-only SELECT, ничего не пишем) ──');
  const { query } = await import('./db.js');
  const res = await query(
    `SELECT id, title, weight, origin, emoji FROM products
      WHERE is_active = true AND weight <> '' ORDER BY origin NULLS LAST, id LIMIT 3`
  );
  const real = res.rows.map((r, i) => ({ ...r, qty: i === 0 ? 2 : 1, sum: 100 * (i + 1) }));
  const msg5 = formatOrderNotification({ ...baseOrder, items: [...real, gift], total: 600 });
  console.log(msg5);
  check('у каждой позиции есть непустая фасовка', real.every((r) => r.weight));
  check('подарок один раз', (msg5.match(/Бесплатная зелень/g) || []).length === 1);
  const dbOrders = await query('SELECT count(*)::int AS n FROM orders');
  console.log(`\n  (заказов в БД: ${dbOrders.rows[0].n} — скрипт ни одного не создал)`);
  process.exit(failed === 0 ? 0 : 1);
}

console.log(`\n${failed === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `ПРОВАЛЕНО ПРОВЕРОК: ${failed}`}`);
process.exit(failed === 0 ? 0 : 1);
