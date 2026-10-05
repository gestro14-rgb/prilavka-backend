// AI-сценарии Прилавки.
//
// Сейчас здесь две ручки:
//   POST /api/ai/test — проверка связи с OpenAI;
//   POST /api/ai/shop — сценарий «Собрать покупку» по реальному каталогу.
//
// Проверочная ручка нужна, чтобы отделить «ключ и сеть в порядке» от
// «сценарий работает неправильно»: при любой ошибке это первый вопрос, и
// отвечать на него проще отдельным эндпоинтом, чем отладкой боевого
// сценария.
//
// Отдельный модуль, а не дописка в server.js: монолит и так около 6000
// строк, и у партнёрки рядом уже есть тот же приём (partners.js). Доступ
// к базе приходит параметром по той же причине, что и там: иначе два
// файла импортировали бы друг друга.
//
// Ключ читается из окружения при каждом запросе, а не при импорте: на
// Railway переменные подставляются на старте контейнера, и модуль,
// запомнивший отсутствие ключа на этапе импорта, пришлось бы
// передеплоивать после каждой правки переменной. Сам ключ никуда не
// пишется и не возвращается — ни в лог, ни в ответ.
import express from 'express';
import multer from 'multer';
import OpenAI, { toFile } from 'openai';
import { randomUUID } from 'node:crypto';

// Модель задаётся переменной окружения, чтобы менять её без правки кода.
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Модель расшифровки голоса — отдельная от текстовой и тоже
// переопределяемая переменной окружения.
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

// Запись голоса приходит в память и сразу уходит в OpenAI — на диск
// её класть незачем. Потолок в 20 МБ с запасом покрывает минуту
// речи и отсекает попытки залить сюда что-то другое.
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// Потолок на ответ модели: корзина — это десяток позиций, и длиннее
// ответу быть незачем. Ограничение страхует от неожиданного счёта, если
// модель уйдёт в рассуждения.
const SHOP_MAX_OUTPUT_TOKENS = 900;

// Длина пользовательского запроса. Всё, что длиннее, — это уже не фраза
// «собери овощей на двоих», а чужой текст, и платить за него токенами не
// нужно.
const MAX_MESSAGE_LENGTH = 500;

// Сколько упаковок одного товара модель может положить в корзину.
// Защита от «20 кг помидоров» из-за ошибки в рассуждении.
const MAX_ITEM_QUANTITY = 10;

// Описание веса в каталоге — свободный текст, иногда с пояснением
// («примерно ~6 кг, хватит на 2-3 кастрюли борща»). Модели нужен размер
// упаковки, а не рекламный текст, поэтому длинные строки подрезаются.
const MAX_WEIGHT_CHARS = 42;

// Сколько позиций должно остаться после ужимания под бюджет. Ниже этого
// корзина перестаёт быть корзиной, и честнее вернуть «не уложились», чем
// отдать одну морковку.
const MIN_ITEMS_AFTER_FIT = 3;

// Оговорка к запросам про самочувствие. Дописывается кодом, а не
// доверяется модели: в проверке модель её то добавляла, то нет, а это
// ровно та часть ответа, которая не должна зависеть от удачи. По той же
// причине текст один и тот же — он не сочиняется заново каждый раз.
const WELLNESS_DISCLAIMER = 'Это подбор продуктов, а не медицинская '
  + 'рекомендация: при ограничениях или сохраняющихся симптомах лучше '
  + 'ориентироваться на советы врача.';

// Клиент создаётся один раз и переиспользуется: он держит пул соединений,
// и собирать его на каждый запрос незачем. Пересоздаётся только если
// ключ в окружении сменился.
let cachedClient = null;
let cachedKey = null;

function getClient(apiKey) {
  if (!cachedClient || cachedKey !== apiKey) {
    cachedClient = new OpenAI({ apiKey, timeout: 60_000, maxRetries: 1 });
    cachedKey = apiKey;
  }
  return cachedClient;
}

// OpenAI на неверной авторизации возвращает текст с огрызком ключа
// (sk-xxxx…1234). Он уже замаскирован ими, но в наш лог и наш ответ не
// должно попадать вообще ничего похожего на ключ — вырезаем.
function scrubKeys(text) {
  return String(text ?? '').replace(/sk-[A-Za-z0-9_*-]+/g, '[ключ скрыт]');
}

// Отсутствие ключа — не поломка сервера, а незаконченная настройка среды,
// поэтому 503 и прямым текстом что делать. Отдельный код reason нужен
// вызывающей стороне, чтобы отличить этот случай от ошибки самого OpenAI.
function requireApiKey(res) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) return apiKey;
  res.status(503).json({
    ok: false,
    reason: 'missing_api_key',
    error: 'OPENAI_API_KEY не задан в окружении backend. '
      + 'Добавьте переменную и перезапустите сервис.',
  });
  return null;
}

/* ── «Собрать покупку» ───────────────────────────────────────────────────
   Разделение обязанностей здесь жёсткое и намеренное.

   Модель делает ровно одно: читает фразу покупателя и выбирает товары из
   списка, который ей дали. Ни придумать товар, ни назвать цену она не
   может — у неё нет инструментов, нет доступа к базе, а productId
   перечислены в самой схеме ответа, так что выбрать что-то вне каталога
   структурно невозможно.

   Деньги считает только backend. Цена берётся из той же строки products,
   из которой товар попал в список, уже после ответа модели. Это не
   перестраховка: цены меняются, и сумма, придуманная моделью, была бы
   обещанием, которого магазин не давал.

   Бюджет держится в два прохода. Первый — обычный подбор; модель видит
   цены и старается уложиться, но арифметика у неё ненадёжная. Если после
   честного пересчёта корзина не влезла, делается ровно один
   корректирующий проход: модели показывают её же корзину с нашими
   ценами, итог и превышение и просят ужать. Второй пересчёт — снова наш.

   Проходов строго два, цикла нет: каждая итерация стоит полного каталога
   в промпте (~3 тыс. токенов), а выигрыш после второй попытки почти не
   растёт. Не уложились — отдаём флаг и честную сумму, подбор замен это
   задача следующего шага сценария.

   Проверка productId на нашей стороне остаётся даже при enum в схеме:
   каталог мог измениться между сборкой списка и ответом, а доверять
   чужому выводу как ключу к базе нельзя в принципе. */

// Активные товары каталога — тот же источник, что у /api/catalog:
// products + categories, is_active = true. Порядок как в каталоге, чтобы
// модель видела товары сгруппированными по категориям.
const CATALOG_QUERY = `
  SELECT p.id, p.title, p.price, p.weight, p.image_url, p.category, c.label AS category_label
  FROM products p
  LEFT JOIN categories c ON c.id = p.category
  WHERE p.is_active = true
  ORDER BY c.sort_order ASC NULLS LAST, p.sort_order ASC, p.title ASC
`;

// Компактная строка товара для модели. Цена в списке нужна, чтобы модель
// не предлагала корзину, заведомо выходящую за бюджет, — но считает
// итог всё равно backend.
function catalogLine(p) {
  const weight = String(p.weight ?? '').trim().slice(0, MAX_WEIGHT_CHARS);
  return `${p.id} | ${p.title} | ${p.price} ₽ | ${weight} | ${p.category_label || p.category}`;
}

function catalogBlock(products) {
  return [
    'Каталог (productId | название | цена за упаковку | размер упаковки | категория):',
    products.map(catalogLine).join('\n'),
  ].join('\n');
}

function itemRules(minItems, maxItems = 8) {
  return [
    `— items: обычно от ${minItems} до ${maxItems} позиций. Больше — только если`,
    '  человек прямо просит большую закупку (на неделю, на компанию, впрок).',
    '  productId — строго из каталога выше.',
    '— quantity — целое число упаковок, обычно 1. Две и больше — только когда это',
    `  оправдано числом едоков, сроком или объёмом запроса; потолок ${MAX_ITEM_QUANTITY}.`,
    '  Не клади ×3–×5 одного дорогого товара без явного основания.',
    '— reason — 2–5 слов: чем позиция отвечает цели запроса.',
    '',
    'Запреты:',
    '— не выдумывай productId: любой идентификатор вне списка — ошибка;',
    '— не называй в message цены и итоговую сумму: стоимость считает сервис',
    '  по своей базе, а не ты;',
    '— учитывай ограничения из запроса: если просили без какого-то продукта,',
    '  его в корзине быть не должно.',
  ].join('\n');
}

// Самые дешёвые позиции каждой категории. В корректирующем проходе
// каталог длинный, и дешёвые товары теряются в середине списка —
// отдельной короткой подсказкой они видны сразу.
function cheapestBlock(products, perCategory = 5) {
  const byCategory = new Map();
  for (const p of products) {
    const key = p.category_label || p.category;
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(p);
  }
  const lines = [];
  for (const [label, list] of byCategory) {
    const cheap = [...list].sort((a, b) => a.price - b.price).slice(0, perCategory);
    lines.push(`${label}: ` + cheap.map((p) => `${p.id} (${p.price} ₽)`).join(', '));
  }
  return ['Самые дешёвые товары по категориям:', ...lines].join('\n');
}

// ── Первый проход: понять запрос и подобрать ────────────────────────────
//
// Сценарий начинался как «собери корзину до N рублей», и промпт был про
// бюджет. Но люди пишут иначе: «хочу что-нибудь сезонное», «побольше
// клетчатки», «что взять на работу без готовки». Поэтому модель сперва
// разбирает цель запроса, и только потом подбирает товары под неё.
//
// Отдельно оговорены запросы про самочувствие. Ассистент продуктового
// магазина не врач: он может учесть контекст как пищевое предпочтение, но
// не ставит диагнозов, ничего не лечит и не объявляет корзину медицински
// безопасной. Жёстких фильтров «банан нельзя» в коде нет намеренно —
// это была бы медицинская база, которой у нас нет и которую нельзя
// подменять догадками.
function buildShopInstructions(products) {
  return [
    'Ты — помощник сервиса доставки продуктов «Прилавка».',
    'Покупатель пишет свободным текстом. Сначала пойми, чего он хочет,',
    'и только потом подбирай товары из каталога.',
    '',
    catalogBlock(products),
    '',
    '── Шаг 1. Разбери запрос ──',
    '— intent — главная цель, одно значение:',
    '  budget — главное уложиться в сумму;',
    '  seasonal — хочет сезонное, свежее;',
    '  nutrition — про состав рациона: клетчатка, витамины, углеводы, белок;',
    '  wellness — самочувствие, состояние, ограничения по здоровью;',
    '  taste — про вкус: вкусное, сладкое, освежающее, яркое;',
    '  convenience — удобство: на перекус, с собой, без готовки;',
    '  meal_planning — на приёмы пищи или на срок: завтраки, на три дня;',
    '  general — ничего конкретного не названо.',
    '  Если целей несколько — главную в intent, остальные в goals.',
    '— goals — остальные цели короткими фразами своими словами',
    '  («больше клетчатки», «сезонное», «на завтраки»). Нет — пустой массив.',
    '— avoid — чего избегать («без авокадо», «не слишком сладкое»).',
    '— preferences — прочие пожелания из запроса.',
    '— budget — бюджет в рублях целым числом, если назван; иначе null.',
    '— people — на скольких ЧЕЛОВЕК, и только если в запросе сказано именно',
    '  про людей («на двоих», «на одного»). Срок («на 3 дня») — это НЕ люди:',
    '  тогда people = null, а срок уходит в goals.',
    '',
    '── Шаг 2. Подбери товары под эту цель ──',
    'Опирайся на то, что реально известно о товаре: категорию, название,',
    'размер упаковки и цену. Ничего другого о товарах ты не знаешь.',
    '',
    '— клетчатка, «побольше овощей»: овощи и зелень в основе, фрукты дополняют;',
    '— углеводы, сытность: корнеплоды, картофель, более сытные фрукты;',
    '— витамин C, «освежающее»: цитрусовые, ягоды, болгарский перец, зелень;',
    '— перекус, «с собой», «без готовки»: то, что едят как есть и удобно',
    '  взять с собой — фрукты, томаты черри, молодая морковь;',
    '— завтраки: фрукты и ягоды, зелень к омлету;',
    '— «лёгкое», «нейтральное»: простые овощи и некислые фрукты, без',
    '  острого, пряного и тяжёлых сочетаний;',
    '— «сладкое, но не тяжёлое»: сладкие фрукты и ягоды небольшими упаковками.',
    '',
    'Про сезонность: признака сезона в каталоге нет, и выдумывать его нельзя.',
    'Не утверждай, что конкретный товар «сейчас в сезоне». Подбирай свежие',
    'овощи, фрукты и зелень и пиши мягко — «подходят под сезонный формат».',
    '',
    '── Запросы про самочувствие (intent: wellness) ──',
    'Ты ассистент продуктового магазина, а не врач. Это правило действует',
    'и в message, и в reason у каждой позиции.',
    '',
    'НЕЛЬЗЯ писать ничего в таком роде:',
    '  «поможет поддержать уровень сахара», «нормализует давление»,',
    '  «восстановит желудок», «улучшает пищеварение», «полезно при диабете»,',
    '  «эта корзина подходит при вашем состоянии», «снимет симптомы».',
    'То есть: никаких диагнозов, никакого влияния продукта на болезнь или',
    'показатели организма, никаких обещаний улучшения самочувствия.',
    '',
    'МОЖНО говорить только о самих продуктах и их составе:',
    '  «сделал упор на овощи и менее сладкие фрукты»,',
    '  «подобрал более нейтральные и простые продукты»,',
    '  «в корзине больше овощей и зелени».',
    'reason у позиции тоже описывает продукт («некислый фрукт», «простой',
    'овощ»), а не его действие на человека.',
    '',
    '── Шаг 3. Напиши message ──',
    'Одно-два предложения о том, ПОЧЕМУ выбраны эти продукты, а не формальное',
    '«вот ваша корзина». Например: «Сделал упор на овощи и зелень — они',
    'добавят больше клетчатки». Без цен и без сумм.',
    '',
    'Правила состава:',
    itemRules(4, 8),
    '',
    'Если бюджет назван — старайся уложиться в него по ценам из каталога,',
    'но никогда не подменяй и не пересчитывай сами цены.',
    'Если бюджета нет — собери разумную корзину под цель, а не максимально',
    'большую.',
  ].join('\n');
}

// ── Второй проход: ужать под бюджет ─────────────────────────────────────
//
// Модели показывают её же корзину, но уже с нашими ценами и нашим итогом:
// без этого она «чинит» воображаемую сумму, которую посчитала сама.
function buildFitInstructions(products, { request, budget, basket, parsed }) {
  const lines = basket.items.map(
    (x) => `${x.productId} | ${x.title} | ${x.price} ₽ x ${x.quantity} = ${x.lineTotal} ₽`,
  );
  return [
    'Ты — помощник сервиса доставки продуктов «Прилавка».',
    'Корзина, которую ты собрал, не укладывается в бюджет покупателя.',
    '',
    `Запрос покупателя: «${request}»`,
    `Цель запроса: ${parsed.intent || 'general'}`      + (parsed.goals?.length ? `, также: ${parsed.goals.join(', ')}` : '')
      + (parsed.avoid?.length ? `. Избегать: ${parsed.avoid.join(', ')}` : ''),
    `Бюджет: ${budget} ₽`,
    '',
    'Текущая корзина (цены сервиса, не твои):',
    lines.join('\n'),
    `Итог по нашим ценам: ${basket.total} ₽. Превышение: ${basket.total - budget} ₽.`,
    '',
    catalogBlock(products),
    '',
    cheapestBlock(products),
    '',
    'Задача: собери корзину заново так, чтобы сумма (цена из каталога × количество)',
    `была НЕ БОЛЬШЕ ${budget} ₽. Считай по ценам каталога выше, они настоящие.`,
    '',
    'Как ужимать, по порядку:',
    '— уменьши количество упаковок там, где их больше одной;',
    '— замени дорогие позиции на более дешёвые из той же категории;',
    '— убери наименее нужные позиции, но оставь минимум ' + MIN_ITEMS_AFTER_FIT + ' штуки.',
    '',
    'Перед ответом сложи цены выбранных позиций и убедись, что сумма помещается',
    `в ${budget} ₽. Если не помещается — бери позиции из списка самых дешёвых выше.`,
    'Смысл запроса сохраняй: цель выше должна остаться выполненной.',
    'Если просили овощи и фрукты — оставь и то и другое, если просили без',
    'какого-то продукта — его быть не должно.',
    '',
    'Правила:',
    itemRules(MIN_ITEMS_AFTER_FIT, 8),
    '— message: одно короткое предложение о том, что корзину ужали. Без цифр и цен.',
    '',
    `Если уложиться в ${budget} ₽ невозможно даже минимальной корзиной —`,
    'верни самый дешёвый разумный набор, какой получается. Не выдумывай товары',
    'и не занижай количества до нуля.',
  ].join('\n');
}

// Схема первого прохода. strict требует, чтобы все поля были в required,
// а additionalProperties был false. productId перечислен enum'ом по
// реальному каталогу — так модель физически не может назвать товар,
// которого нет.
function buildBasketItemsSchema(productIds) {
  return {
    type: 'array',
    description: 'Позиции корзины — только товары каталога',
    items: {
      type: 'object',
      properties: {
        productId: { type: 'string', enum: productIds },
        quantity: { type: 'integer', description: 'Число упаковок' },
        reason: { type: 'string', description: 'Коротко, зачем позиция' },
      },
      required: ['productId', 'quantity', 'reason'],
      additionalProperties: false,
    },
  };
}

const SHOP_INTENTS = [
  'budget', 'seasonal', 'nutrition', 'wellness',
  'taste', 'convenience', 'meal_planning', 'general',
];

function buildShopSchema(productIds) {
  return {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Чем выбор отвечает запросу, без цен' },
      intent: {
        type: 'string',
        enum: SHOP_INTENTS,
        description: 'Главная цель запроса',
      },
      goals: {
        type: 'array',
        description: 'Остальные цели запроса',
        items: { type: 'string' },
      },
      avoid: {
        type: 'array',
        description: 'Чего избегать',
        items: { type: 'string' },
      },
      budget: { type: ['integer', 'null'], description: 'Бюджет в рублях или null' },
      people: { type: ['integer', 'null'], description: 'Число едоков или null' },
      preferences: {
        type: 'array',
        description: 'Пожелания из запроса',
        items: { type: 'string' },
      },
      items: buildBasketItemsSchema(productIds),
    },
    required: ['message', 'intent', 'goals', 'avoid', 'budget', 'people', 'preferences', 'items'],
    additionalProperties: false,
  };
}

// Схема корректирующего прохода: бюджет, едоки и пожелания уже разобраны
// первым проходом, второй раз их спрашивать незачем.
function buildFitSchema(productIds) {
  return {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Короткое сообщение покупателю, без цен' },
      items: buildBasketItemsSchema(productIds),
    },
    required: ['message', 'items'],
    additionalProperties: false,
  };
}

// Один проход к модели. Возвращает либо { parsed, response }, либо
// { failure } с готовыми полями ответа — вызывающий решает, падать ему
// или продолжать с тем, что уже есть.
async function runPass(client, { instructions, input, schema, schemaName }) {
  let response;
  try {
    response = await client.responses.create({
      model: OPENAI_MODEL,
      instructions,
      input,
      max_output_tokens: SHOP_MAX_OUTPUT_TOKENS,
      text: {
        format: { type: 'json_schema', name: schemaName, strict: true, schema },
      },
    });
  } catch (err) {
    const message = scrubKeys(err?.message ?? 'Неизвестная ошибка запроса к OpenAI');
    console.error('[ai] запрос к OpenAI не прошёл:', err?.status ?? '', message);
    return { failure: { reason: 'openai_error', status: err?.status ?? null, error: message } };
  }

  // Модель могла упереться в потолок токенов или отказаться отвечать.
  // В обоих случаях текста по схеме не будет, и разбирать нечего.
  if (response.status && response.status !== 'completed') {
    const why = response.incomplete_details?.reason ?? response.status;
    console.error('[ai] shop: ответ не завершён:', why);
    return { failure: { reason: 'incomplete_response', error: `Модель не завершила ответ (${why}).` }, response };
  }

  // Structured Outputs гарантирует схему, но страховка нужна: отказ
  // модели, обрыв генерации или смена модели на не поддерживающую схемы
  // дадут здесь не-JSON, и падать с 500 из-за этого нельзя.
  const text = response.output_text ?? '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('[ai] shop: модель вернула не JSON, первые 200 символов:', text.slice(0, 200));
    return { failure: { reason: 'bad_model_json', error: 'Модель вернула ответ не по схеме.' }, response };
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
    console.error('[ai] shop: в ответе нет items');
    return { failure: { reason: 'bad_model_json', error: 'В ответе модели нет списка позиций.' }, response };
  }

  return { parsed, response };
}

// Сборка корзины по ответу модели: цена и название берутся из базы, а не
// из того, что сказала модель. Товары вне каталога отбрасываются — их не
// должно быть благодаря enum, но проверка здесь дешевле любой гипотезы.
function buildBasket(modelItems, productById) {
  const items = [];
  const dropped = [];
  const seen = new Set();

  for (const raw of modelItems) {
    const id = typeof raw?.productId === 'string' ? raw.productId : '';
    const product = productById.get(id);

    if (!product) {
      dropped.push({ productId: id, reason: 'нет в каталоге' });
      continue;
    }
    // Один и тот же товар дважды — это ошибка модели, а не «две записи»:
    // складываем в одну позицию, чтобы корзина выглядела как корзина.
    if (seen.has(id)) {
      const existing = items.find((x) => x.productId === id);
      existing.quantity = Math.min(MAX_ITEM_QUANTITY, existing.quantity + 1);
      existing.lineTotal = existing.price * existing.quantity;
      continue;
    }
    seen.add(id);

    const asked = Number(raw?.quantity);
    const quantity = Number.isFinite(asked)
      ? Math.min(MAX_ITEM_QUANTITY, Math.max(1, Math.round(asked)))
      : 1;

    items.push({
      productId: product.id,
      title: product.title,
      imageUrl: product.image_url || null,
      // Цена — из базы. То, что модель могла бы сказать о цене, не
      // участвует в расчёте вообще.
      price: product.price,
      quantity,
      lineTotal: product.price * quantity,
      weight: product.weight,
      category: product.category,
      reason: typeof raw?.reason === 'string' ? raw.reason : '',
    });
  }

  const total = items.reduce((sum, x) => sum + x.lineTotal, 0);
  return { items, dropped, total };
}

/* ── Ужимание под бюджет без модели ──────────────────────────────────────
   Два прохода модели снижают сумму, но не гарантируют попадания: gpt-4o-mini
   считает ненадёжно и от запроса к запросу выдаёт разный результат. Поэтому
   последнее слово за арифметикой, а не за моделью.

   Работает только с тем, что модель уже выбрала: те же productId, те же
   цены из базы. Новых товаров не появляется, цены не меняются, третьего
   обращения к модели нет — иначе разброс вернулся бы вместе с ним.

   Порядок от менее разрушительного к более: сначала количества, потом
   позиции целиком. Внутри каждого шага первой страдает самая дорогая
   строка — она и приближает к бюджету быстрее всего.

   Разнообразие корзины бережётся на первом круге удаления: последнюю
   позицию своей категории не трогаем, чтобы из «овощей и фруктов» не
   осталось одних овощей. Если иначе в бюджет не попасть, второй круг снимает
   и эту защиту: уложиться важнее, чем сохранить состав. */
function fitToBudget(sourceItems, budget) {
  const items = sourceItems.map((x) => ({ ...x, fromQuantity: x.quantity }));
  const removed = [];
  const total = () => items.reduce((sum, x) => sum + x.lineTotal, 0);

  // Шаг 1: количества. По одной упаковке за раз, начиная с самой дорогой
  // строки — пересчёт после каждого шага, чтобы не срезать лишнего.
  while (total() > budget) {
    const candidates = items.filter((x) => x.quantity > 1);
    if (!candidates.length) break;
    candidates.sort((a, b) => b.lineTotal - a.lineTotal || b.price - a.price);
    const target = candidates[0];
    target.quantity -= 1;
    target.lineTotal = target.price * target.quantity;
  }

  // Шаг 2: позиции целиком. Первый круг щадит последнюю позицию каждой
  // категории, второй — уже нет.
  for (const keepDiversity of [true, false]) {
    while (total() > budget && items.length > MIN_ITEMS_AFTER_FIT) {
      const perCategory = new Map();
      for (const x of items) perCategory.set(x.category, (perCategory.get(x.category) ?? 0) + 1);

      const removable = keepDiversity
        ? items.filter((x) => perCategory.get(x.category) > 1)
        : items.slice();
      if (!removable.length) break;

      removable.sort((a, b) => b.lineTotal - a.lineTotal || b.price - a.price);
      const victim = removable[0];
      items.splice(items.indexOf(victim), 1);
      removed.push({
        productId: victim.productId,
        title: victim.title,
        price: victim.price,
        quantity: victim.quantity,
        lineTotal: victim.lineTotal,
      });
    }
  }

  // Урезанные количества считаем по тому, что осталось: позиция, которую
  // сначала ужали, а потом удалили целиком, числится только в removed.
  const reduced = items
    .filter((x) => x.quantity < x.fromQuantity)
    .map((x) => ({
      productId: x.productId,
      title: x.title,
      price: x.price,
      from: x.fromQuantity,
      to: x.quantity,
    }));

  return {
    items: items.map(({ fromQuantity, ...rest }) => rest),
    total: total(),
    removed,
    reduced,
  };
}

/* ── Потоковый ответ ─────────────────────────────────────────────────────
   Подбор занимает несколько секунд, и всё это время человек смотрел в
   пустоту: ответ приходил целиком и сразу. Поэтому рядом с /shop есть
   /chat/stream — та же логика, но отданная по мере готовности.

   Что именно стримится: первый проход модели идёт с stream: true, и его
   текстовые дельты приходят к нам по кускам. Схема ответа — JSON, поэтому
   наружу мы отдаём не сырые куски, а только растущее поле message:
   человеку нужен текст, а не разметка. Это настоящие дельты модели, а не
   побуквенная анимация на клиенте.

   Структурированная часть (корзина, суммы, флаги бюджета) уходит одним
   событием в конце: её нельзя показывать по частям — пока не отработали
   проверка бюджета и пересчёт по базе, любые числа были бы неверными. */

// Достаёт из частично пришедшего JSON содержимое поля message. Полноценный
// потоковый парсер здесь не нужен: поле строковое и идёт первым, а всё,
// что после закрывающей кавычки, нас не касается.
function partialMessage(buffer) {
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(buffer);
  if (!m) return null;
  try {
    // Достраиваем кавычку, чтобы отдать JSON.parse корректную строку и
    // получить уже раскодированные \n и \".
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createAiRoutes({ query } = {}) {
  const router = express.Router();

  // POST /api/ai/test — один короткий запрос к модели и её ответ обратно.
  router.post('/test', async (req, res) => {
    const apiKey = requireApiKey(res);
    if (!apiKey) return undefined;

    // Текст запроса можно передать в теле — удобно для ручной проверки.
    // По умолчанию тот, на который ожидается односложный ответ.
    const prompt = typeof req.body?.prompt === 'string' && req.body.prompt.trim()
      ? req.body.prompt.trim()
      : 'Ответь одним словом: работает';

    const startedAt = Date.now();

    try {
      const response = await getClient(apiKey).responses.create({
        model: OPENAI_MODEL,
        input: prompt,
      });

      return res.json({
        ok: true,
        model: response.model || OPENAI_MODEL,
        prompt,
        // output_text — собранный текст ответа; у Responses API это
        // штатное удобное поле поверх структуры output[].
        answer: response.output_text ?? '',
        usage: response.usage ?? null,
        tookMs: Date.now() - startedAt,
      });
    } catch (err) {
      const message = scrubKeys(err?.message ?? 'Неизвестная ошибка запроса к OpenAI');
      console.error('[ai] запрос к OpenAI не прошёл:', err?.status ?? '', message);
      return res.status(502).json({
        ok: false, reason: 'openai_error', status: err?.status ?? null,
        error: message, tookMs: Date.now() - startedAt,
      });
    }
  });

  // POST /api/ai/shop — сценарий «Собрать покупку».
  router.post('/shop', async (req, res) => {
    const raw = req.body?.message;
    if (typeof raw !== 'string' || !raw.trim()) {
      return res.status(400).json({
        ok: false,
        reason: 'bad_request',
        error: 'Нужно поле message: строка с запросом покупателя.',
      });
    }
    if (raw.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        ok: false,
        reason: 'message_too_long',
        error: `Запрос длиннее ${MAX_MESSAGE_LENGTH} символов.`,
      });
    }

    const apiKey = requireApiKey(res);
    if (!apiKey) return undefined;

    const message = raw.trim();
    const image = req.body?.image && typeof req.body.image.dataUrl === 'string'
      && req.body.image.dataUrl.length <= 12_000_000 ? req.body.image : null;
    const startedAt = Date.now();
    const client = getClient(apiKey);

    // ── Каталог ───────────────────────────────────────────────────────
    let products;
    try {
      const result = await query(CATALOG_QUERY);
      products = result.rows;
    } catch (err) {
      console.error('[ai] shop: каталог не прочитался:', err?.message ?? err);
      return res.status(503).json({
        ok: false, reason: 'catalog_unavailable',
        error: 'Не удалось прочитать каталог.', tookMs: Date.now() - startedAt,
      });
    }

    if (!products.length) {
      return res.status(503).json({
        ok: false, reason: 'catalog_empty',
        error: 'В каталоге нет активных товаров.', tookMs: Date.now() - startedAt,
      });
    }

    const productById = new Map(products.map((p) => [p.id, p]));
    const productIds = products.map((p) => p.id);

    // ── Проход 1: подбор ──────────────────────────────────────────────
    const first = await runPass(client, {
      instructions: buildShopInstructions(products) + (image ? `\n\n${IMAGE_SHOP_INSTRUCTIONS}` : ''),
      input: imageAwareInput(message, image),
      schema: buildShopSchema(productIds),
      schemaName: 'shop_basket',
    });

    if (first.failure) {
      return res.status(502).json({
        ok: false, ...first.failure, tookMs: Date.now() - startedAt,
      });
    }

    let basket = buildBasket(first.parsed.items, productById);

    if (!basket.items.length) {
      return res.status(502).json({
        ok: false, reason: 'no_valid_items',
        error: 'Ни один выбранный товар не нашёлся в каталоге.',
        dropped: basket.dropped, tookMs: Date.now() - startedAt,
      });
    }

    const budget = Number.isInteger(first.parsed.budget) ? first.parsed.budget : null;
    let basketMessage = typeof first.parsed.message === 'string' ? first.parsed.message : '';

    // ── Проход 2: ужать под бюджет ────────────────────────────────────
    //
    // Запускается только при названном бюджете и только если наш
    // пересчёт показал превышение. Второго условия выхода нет и не
    // нужно: проход ровно один.
    let optimizationAttempted = false;
    let secondUsage = null;
    // Итог первого прохода запоминаем до ужимания: по нему видно, на
    // сколько корзина промахнулась и помог ли второй проход.
    let firstTotal = basket.total;

    if (budget != null && basket.total > budget) {
      optimizationAttempted = true;

      const second = await runPass(client, {
        instructions: buildFitInstructions(products, {
          request: message, budget, basket, parsed: first.parsed,
        }),
        input: message,
        schema: buildFitSchema(productIds),
        schemaName: 'shop_basket_fit',
      });
      secondUsage = second.response?.usage ?? null;

      // Сбой второго прохода не рушит ответ: у нас уже есть корректная
      // корзина первого, с ней и отдаём — просто без успеха оптимизации.
      if (second.failure) {
        console.error('[ai] shop: корректирующий проход не удался:', second.failure.reason);
      } else {
        const retry = buildBasket(second.parsed.items, productById);
        // Вторую корзину берём, только если она действительно лучше:
        // уложилась в бюджет или хотя бы дешевле первой. Иначе честнее
        // остаться с первой.
        const better = retry.items.length >= Math.min(MIN_ITEMS_AFTER_FIT, basket.items.length)
          && (retry.total <= budget || retry.total < basket.total);
        if (better) {
          basket = retry;
          if (typeof second.parsed.message === 'string' && second.parsed.message) {
            basketMessage = second.parsed.message;
          }
        }
      }
    }

    // ── Проход 3: арифметика вместо модели ────────────────────────────
    //
    // Если после обоих проходов корзина всё ещё не влезла, ужимаем её
    // сами. Это не ещё один запрос к OpenAI, а чистый расчёт по уже
    // выбранным товарам и их ценам из базы.
    const aiTotal = basket.total;
    let backendAdjustmentApplied = false;
    let backendAdjustmentRemovedItems = [];
    let backendAdjustmentReducedQuantities = [];

    if (budget != null && basket.total > budget) {
      const fitted = fitToBudget(basket.items, budget);
      // Берём результат, только если он действительно дешевле: иначе
      // отчитываться было бы не о чем.
      if (fitted.total < basket.total) {
        basket = { items: fitted.items, dropped: basket.dropped, total: fitted.total };
        backendAdjustmentApplied = true;
        backendAdjustmentRemovedItems = fitted.removed;
        backendAdjustmentReducedQuantities = fitted.reduced;
      }
    }

    // ── Итог ──────────────────────────────────────────────────────────
    const overBy = budget != null ? Math.max(0, basket.total - budget) : 0;
    const budgetStatus = budget == null ? 'unknown' : (overBy > 0 ? 'over' : 'ok');
    const optimizationSucceeded = optimizationAttempted && overBy === 0;

    // К запросам про самочувствие оговорка добавляется всегда. Если модель
    // написала её сама — второй раз не дублируем.
    const intent = SHOP_INTENTS.includes(first.parsed.intent) ? first.parsed.intent : 'general';
    if (intent === 'wellness' && !/врач/i.test(basketMessage)) {
      basketMessage = `${basketMessage.trim()} ${WELLNESS_DISCLAIMER}`.trim();
    }

    // Текст про деньги пишет backend, а не модель: модель не знает
    // итоговой суммы и легко пообещает то, чего нет.
    if (budgetStatus === 'ok' && backendAdjustmentApplied) {
      basketMessage = `Чтобы уложиться в ${budget} ₽, немного сократил корзину — `
        + `получилось ${basket.total} ₽.`;
    }
    if (budgetStatus === 'over') {
      basketMessage = `Собрал самую экономную корзину, но в ${budget} ₽ она не укладывается: `
        + `получилось ${basket.total} ₽, это на ${overBy} ₽ больше. `
        + 'Можно убрать часть позиций или увеличить бюджет.';
    }

    return res.json({
      ok: true,
      model: first.response.model || OPENAI_MODEL,
      request: message,
      catalogSize: products.length,
      // Сколько раз ходили к модели. Третьего обращения в этом сценарии
      // нет и не будет: бюджет дожимается расчётом.
      aiCalls: optimizationAttempted ? 2 : 1,
      optimizationAttempted,
      optimizationSucceeded,
      optimizationFromTotal: optimizationAttempted ? firstTotal : null,
      // Итог после обоих проходов модели — до того, как за дело взялась
      // арифметика.
      aiTotal,
      backendAdjustmentApplied,
      backendAdjustmentRemovedItems,
      backendAdjustmentReducedQuantities,
      result: {
        message: basketMessage,
        // Как сценарий понял запрос. Нужно не только для отладки:
        // следующий шаг (подбор замен, уточняющий вопрос) будет
        // опираться именно на цель, а не на исходную фразу.
        intent,
        goals: Array.isArray(first.parsed.goals) ? first.parsed.goals : [],
        avoid: Array.isArray(first.parsed.avoid) ? first.parsed.avoid : [],
        budget,
        people: Number.isInteger(first.parsed.people) ? first.parsed.people : null,
        preferences: Array.isArray(first.parsed.preferences) ? first.parsed.preferences : [],
        items: basket.items,
        total: basket.total,
        budgetStatus,
        withinBudget: budget == null ? null : overBy === 0,
        overBy,
        // Пусто при нормальной работе. Непустое — сигнал, что каталог
        // разъехался со списком, который видела модель.
        dropped: basket.dropped,
      },
      usage: {
        first: first.response.usage ?? null,
        second: secondUsage,
        totalTokens: (first.response.usage?.total_tokens ?? 0) + (secondUsage?.total_tokens ?? 0),
      },
      tookMs: Date.now() - startedAt,
    });
  });

  // Unified assistant route. A lightweight structured pass decides whether
  // the user needs advice, a recipe, nutrition guidance, photo analysis or
  // shopping. Only the shopping branch loads the full catalogue and invokes
  // the existing validated basket skill.
  router.post('/chat', async (req, res) => {
    const requestId = randomUUID();
    const logMeta = () => ({ requestId, durationMs: Date.now() - startedAt });
    const raw = req.body?.message;
    if (typeof raw !== 'string' || !raw.trim()) return res.status(400).json({ ok: false, reason: 'bad_request', error: 'Нужно поле message.' });
    if (raw.length > MAX_MESSAGE_LENGTH) return res.status(400).json({ ok: false, reason: 'message_too_long', error: `Запрос длиннее ${MAX_MESSAGE_LENGTH} символов.` });
    const apiKey = requireApiKey(res);
    if (!apiKey) return undefined;
    const image = req.body?.image && typeof req.body.image.dataUrl === 'string' && req.body.image.dataUrl.length <= 12_000_000 ? req.body.image : null;
    const conversation = Array.isArray(req.body?.conversation) ? req.body.conversation.slice(-8) : [];
    const startedAt = Date.now();
    const client = getClient(apiKey);
    let first;
    try {
      first = await runPass(client, {
        instructions: buildAssistantInstructions({ conversation }),
        input: imageAwareInput(raw.trim(), image),
        schema: assistantSchema,
        schemaName: 'assistant_intent',
      });
    } catch (err) {
      return res.status(502).json({ ok: false, reason: 'openai_error', error: scrubKeys(err?.message || 'Не удалось получить ответ.'), tookMs: Date.now() - startedAt });
    }
    if (first.failure) {
      console.error('[ai/chat] first pass failed', { ...logMeta(), reason: first.failure.reason, status: first.failure.status, imageBytes: image?.dataUrl?.length || 0 });
      return res.status(502).json({ ok: false, requestId, ...first.failure, tookMs: Date.now() - startedAt });
    }
    const parsed = first.parsed;
    if (parsed.type !== 'shopping') {
      return res.json({
        ok: true, model: first.response.model || OPENAI_MODEL, aiCalls: 1,
        usage: { first: first.response.usage || null, second: null, totalTokens: first.response.usage?.total_tokens || 0 },
        requestId, tookMs: Date.now() - startedAt,
        result: {
          type: parsed.type, intent: parsed.intent, message: parsed.message,
          recipe: { title: parsed.recipeTitle, description: parsed.recipeDescription, minutes: parsed.recipeMinutes, ingredients: parsed.recipeIngredients, steps: parsed.recipeSteps },
          nutrition: parsed.nutrition, seenProducts: parsed.seenProducts, detectedItems: parsed.detectedItems, items: [], total: 0, budget: null,
        },
      });
    }

    let products;
    try { products = (await query(CATALOG_QUERY)).rows; } catch (err) {
      return res.status(503).json({ ok: false, reason: 'catalog_unavailable', error: 'Не удалось прочитать каталог.', tookMs: Date.now() - startedAt });
    }
    if (!products.length) return res.status(503).json({ ok: false, reason: 'catalog_empty', error: 'В каталоге нет активных товаров.', tookMs: Date.now() - startedAt });
    const productById = new Map(products.map((p) => [p.id, p]));
    const productIds = products.map((p) => p.id);
    const shop = await runPass(client, {
      instructions: `${buildShopInstructions(products)}\n\nЭто подтверждённый shopping-запрос. Сохрани смысл исходного запроса и контекст: ${raw.trim()}\n${conversation.map((x) => `${x.role}: ${x.content}`).join('\n')}`,
      input: imageAwareInput(raw.trim(), image), schema: buildShopSchema(productIds), schemaName: 'assistant_shopping',
    });
    if (shop.failure) {
      console.error('[ai/chat] shopping pass failed', { ...logMeta(), reason: shop.failure.reason, status: shop.failure.status });
      return res.status(502).json({ ok: false, requestId, ...shop.failure, tookMs: Date.now() - startedAt });
    }
    const basket = buildBasket(shop.parsed.items, productById);
    const budget = Number.isInteger(shop.parsed.budget) ? shop.parsed.budget : null;
    return res.json({
      ok: true, model: shop.response.model || OPENAI_MODEL, aiCalls: 2,
      usage: { first: first.response.usage || null, second: shop.response.usage || null, totalTokens: (first.response.usage?.total_tokens || 0) + (shop.response.usage?.total_tokens || 0) },
      requestId, tookMs: Date.now() - startedAt,
      result: { type: 'shopping', intent: shop.parsed.intent, message: shop.parsed.message, items: basket.items, total: basket.total, budget, withinBudget: budget == null ? null : basket.total <= budget, overBy: budget == null ? 0 : Math.max(0, basket.total - budget), dropped: basket.dropped, recipe: null, nutrition: [], seenProducts: [] },
    });
  });

  /* POST /api/ai/chat/stream — тот же сценарий, что /shop, но по частям.
     Сначала статусы, потом живой текст ответа, в конце — собранный
     результат. /shop остаётся как есть: им пользуются те, кому поток не
     нужен. */
  router.post('/chat/stream', async (req, res) => {
    const raw = req.body?.message;
    if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ ok: false, reason: 'bad_request', error: 'Нужно поле message.' });
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ ok: false, reason: 'missing_api_key', error: 'OPENAI_API_KEY не задан.' });
    }

    const message = raw.trim();
    const image = req.body?.image && typeof req.body.image.dataUrl === 'string'
      && req.body.image.dataUrl.length <= 12_000_000 ? req.body.image : null;
    const startedAt = Date.now();
    const client = getClient(apiKey);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Прокси Railway иначе копит ответ в буфере, и поток перестаёт быть
      // потоком.
      'X-Accel-Buffering': 'no',
    });

    const fail = (reason, error) => {
      sse(res, 'error', { reason, error });
      sse(res, 'done', { tookMs: Date.now() - startedAt });
      res.end();
    };

    try {
      sse(res, 'stage', { stage: 'thinking' });

      const catalog = await query(CATALOG_QUERY);
      const products = catalog.rows;
      if (!products.length) return fail('catalog_empty', 'В каталоге нет активных товаров.');

      const productById = new Map(products.map((x) => [x.id, x]));
      const productIds = products.map((x) => x.id);

      sse(res, 'stage', { stage: 'picking' });

      // ── Проход 1, потоком ──────────────────────────────────────────
      const stream = await client.responses.create({
        model: OPENAI_MODEL,
        instructions: buildShopInstructions(products) + (image ? `\n\n${IMAGE_SHOP_INSTRUCTIONS}` : ''),
        input: imageAwareInput(message, image),
        max_output_tokens: SHOP_MAX_OUTPUT_TOKENS,
        text: {
          format: {
            type: 'json_schema', name: 'shop_basket', strict: true,
            schema: buildShopSchema(productIds),
          },
        },
        stream: true,
      });

      let buffer = '';
      let sent = '';
      let final = null;

      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          buffer += event.delta ?? '';
          const text = partialMessage(buffer);
          if (text && text.length > sent.length) {
            sse(res, 'delta', { text: text.slice(sent.length) });
            sent = text;
          }
        } else if (event.type === 'response.completed') {
          final = event.response;
        } else if (event.type === 'error' || event.type === 'response.failed') {
          return fail('openai_error', 'Модель прервала ответ.');
        }
      }

      if (!final) return fail('incomplete_response', 'Модель не завершила ответ.');

      let parsed;
      try {
        parsed = JSON.parse(final.output_text ?? buffer);
      } catch {
        return fail('bad_model_json', 'Ответ модели не разобрался.');
      }
      if (!Array.isArray(parsed.items)) return fail('bad_model_json', 'В ответе нет позиций.');

      sse(res, 'stage', { stage: 'pricing' });

      // ── Деньги и бюджет — как в /shop, тем же кодом ────────────────
      let basket = buildBasket(parsed.items, productById);
      if (!basket.items.length) return fail('no_valid_items', 'Товары не нашлись в каталоге.');

      const budget = Number.isInteger(parsed.budget) ? parsed.budget : null;
      const firstTotal = basket.total;
      let basketMessage = typeof parsed.message === 'string' ? parsed.message : '';
      let optimizationAttempted = false;
      let secondUsage = null;

      if (budget != null && basket.total > budget) {
        optimizationAttempted = true;
        const second = await runPass(client, {
          instructions: buildFitInstructions(products, {
            request: message, budget, basket, parsed,
          }),
          input: message,
          schema: buildFitSchema(productIds),
          schemaName: 'shop_basket_fit',
        });
        secondUsage = second.response?.usage ?? null;
        if (!second.failure) {
          const retry = buildBasket(second.parsed.items, productById);
          const better = retry.items.length >= Math.min(MIN_ITEMS_AFTER_FIT, basket.items.length)
            && (retry.total <= budget || retry.total < basket.total);
          if (better) {
            basket = retry;
            if (second.parsed.message) basketMessage = second.parsed.message;
          }
        }
      }

      const aiTotal = basket.total;
      let backendAdjustmentApplied = false;
      let backendAdjustmentRemovedItems = [];
      let backendAdjustmentReducedQuantities = [];
      if (budget != null && basket.total > budget) {
        const fitted = fitToBudget(basket.items, budget);
        if (fitted.total < basket.total) {
          basket = { items: fitted.items, dropped: basket.dropped, total: fitted.total };
          backendAdjustmentApplied = true;
          backendAdjustmentRemovedItems = fitted.removed;
          backendAdjustmentReducedQuantities = fitted.reduced;
        }
      }

      const overBy = budget != null ? Math.max(0, basket.total - budget) : 0;
      const budgetStatus = budget == null ? 'unknown' : (overBy > 0 ? 'over' : 'ok');
      const intent = SHOP_INTENTS.includes(parsed.intent) ? parsed.intent : 'general';

      if (intent === 'wellness' && !/врач/i.test(basketMessage)) {
        basketMessage = `${basketMessage.trim()} ${WELLNESS_DISCLAIMER}`.trim();
      }
      if (budgetStatus === 'ok' && backendAdjustmentApplied) {
        basketMessage = `Чтобы уложиться в ${budget} ₽, немного сократил корзину — `
          + `получилось ${basket.total} ₽.`;
      }
      if (budgetStatus === 'over') {
        basketMessage = `Собрал самую экономную корзину, но в ${budget} ₽ она не укладывается: `
          + `получилось ${basket.total} ₽, это на ${overBy} ₽ больше. `
          + 'Можно убрать часть позиций или увеличить бюджет.';
      }

      // Текст мог измениться после пересчёта — отдаём итоговый целиком,
      // клиент заменит им то, что успел показать потоком.
      sse(res, 'result', {
        ok: true,
        model: final.model || OPENAI_MODEL,
        request: message,
        catalogSize: products.length,
        aiCalls: optimizationAttempted ? 2 : 1,
        optimizationAttempted,
        optimizationSucceeded: optimizationAttempted && overBy === 0,
        optimizationFromTotal: optimizationAttempted ? firstTotal : null,
        aiTotal,
        backendAdjustmentApplied,
        backendAdjustmentRemovedItems,
        backendAdjustmentReducedQuantities,
        result: {
          message: basketMessage,
          intent,
          goals: Array.isArray(parsed.goals) ? parsed.goals : [],
          avoid: Array.isArray(parsed.avoid) ? parsed.avoid : [],
          budget,
          people: Number.isInteger(parsed.people) ? parsed.people : null,
          preferences: Array.isArray(parsed.preferences) ? parsed.preferences : [],
          items: basket.items,
          total: basket.total,
          budgetStatus,
          withinBudget: budget == null ? null : overBy === 0,
          overBy,
          dropped: basket.dropped,
        },
        usage: {
          first: final.usage ?? null,
          second: secondUsage,
          totalTokens: (final.usage?.total_tokens ?? 0) + (secondUsage?.total_tokens ?? 0),
        },
        tookMs: Date.now() - startedAt,
      });
      sse(res, 'done', { tookMs: Date.now() - startedAt });
      return res.end();
    } catch (err) {
      console.error('[ai] stream:', scrubKeys(err?.message ?? err));
      return fail('openai_error', 'Не удалось получить ответ.');
    }
  });

  /* POST /api/ai/transcribe — расшифровка надиктованного.
     Голос записывает сам чат и присылает сюда готовый файл; ключ, как и
     везде, остаётся на сервере. */
  router.post('/transcribe', audioUpload.single('audio'), async (req, res) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ ok: false, reason: 'missing_api_key', error: 'OPENAI_API_KEY не задан.' });
    }
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ ok: false, reason: 'bad_request', error: 'Нужен файл audio.' });
    }

    const startedAt = Date.now();
    try {
      const file = await toFile(
        req.file.buffer,
        req.file.originalname || 'voice.webm',
        { type: req.file.mimetype || 'audio/webm' },
      );
      const out = await getClient(apiKey).audio.transcriptions.create({
        file,
        model: OPENAI_TRANSCRIBE_MODEL,
        language: 'ru',
      });
      return res.json({ ok: true, text: out.text ?? '', tookMs: Date.now() - startedAt });
    } catch (err) {
      const msg = scrubKeys(err?.message ?? 'Не удалось расшифровать запись');
      console.error('[ai] transcribe:', err?.status ?? '', msg);
      return res.status(502).json({ ok: false, reason: 'transcribe_error', error: msg });
    }
  });

  return router;
}

const ASSISTANT_TYPES = ['text', 'recipe', 'nutrition', 'shopping', 'photo', 'vision'];
const assistantSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ASSISTANT_TYPES },
    intent: { type: 'string' },
    message: { type: 'string' },
    recipeTitle: { type: 'string' },
    recipeDescription: { type: 'string' },
    recipeMinutes: { type: 'integer' },
    recipeIngredients: { type: 'array', items: { type: 'string' } },
    recipeSteps: { type: 'array', items: { type: 'string' } },
    nutrition: { type: 'array', items: { type: 'string' } },
    seenProducts: { type: 'array', items: { type: 'string' } },
    detectedItems: { type: 'array', items: { type: 'string' } },
    items: { type: 'array', items: { type: 'object', properties: {
      productId: { type: 'string' }, quantity: { type: 'integer' }, reason: { type: 'string' },
    }, required: ['productId', 'quantity', 'reason'], additionalProperties: false } },
    budget: { type: ['integer', 'null'] },
  },
  required: ['type', 'intent', 'message', 'recipeTitle', 'recipeDescription', 'recipeMinutes', 'recipeIngredients', 'recipeSteps', 'nutrition', 'seenProducts', 'detectedItems', 'items', 'budget'],
  additionalProperties: false,
};

function buildAssistantInstructions({ catalog = '', conversation = [] } = {}) {
  return [
    'Ты — полноценный продуктовый AI-ассистент «Прилавки», отвечай по-русски.',
    'Сначала определи намерение: text, recipe, nutrition, shopping или photo.',
    'Не создавай корзину для обычного вопроса, совета, рецепта или сравнения.',
    'Корзина нужна только при явной просьбе собрать, купить, подобрать, что докупить.',
    'Рецепт должен быть компактным: название, описание, время, продукты, 3–6 шагов.',
    'Для фото используй type=vision для запроса «изучи/что здесь», а для «что приготовить» — type=recipe. Перечисляй только уверенно видимые продукты в detectedItems; сомнительное отмечай «Не уверен, что это …».',
    'Питательные значения называй приблизительными, если в данных нет точной записи товара.',
    'При заболеваниях и аллергиях дай полезную общую информацию и коротко напомни, что врач учитывает индивидуальные ограничения.',
    catalog ? `Для подбора покупок используй только этот реальный каталог:\n${catalog}` : '',
    conversation.length ? `Контекст последних сообщений:\n${conversation.map((x) => `${x.role}: ${x.content}`).join('\n')}` : '',
    'Верни все поля схемы. Для неприменимых полей используй пустую строку, [] или null.',
  ].filter(Boolean).join('\n\n');
}

function imageAwareInput(message, image) {
  if (!image?.dataUrl || typeof image.dataUrl !== 'string') return message;
  const mimeType = typeof image.mimeType === 'string' && image.mimeType.startsWith('image/')
    ? image.mimeType : 'image/jpeg';
  return [{
    role: 'user',
    content: [
      { type: 'input_text', text: message },
      { type: 'input_image', image_url: image.dataUrl, detail: 'low' },
    ],
  }];
}

const IMAGE_SHOP_INSTRUCTIONS = `Если приложено изображение, сначала перечисли только продукты, которые уверенно видны.
Для неразличимых объектов используй осторожную формулировку «Не уверен, что это …» и не добавляй такой продукт в корзину.
Если запрос просит приготовить блюдо, выбери ингредиенты именно этого блюда из переданного каталога.
Для рататуя приоритет: баклажан, кабачок/цукини, сладкий перец, помидоры, лук, зелень/базилик.
Не добавляй случайные товары ради количества. Если ингредиента нет в каталоге, упомяни это в message и используй только доступные реальные товары.`;
